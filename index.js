// index.js
const path = require('path');
const fastify = require('fastify')({ logger: false });
const fs = require('fs');
require('dotenv').config();
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const yaml = require('js-yaml');
// Import DNS queue module
const dnsQueue = require('./lib/dnsQueue');
// Import the autodiscover service
const autodiscoverService = require('./lib/autodiscover');
const hunterService = require('./lib/hunterService');
const sourceQueue = require('./lib/sourceQueue');
const profileQueue = require('./lib/profileQueue');
const pretextQueue = require('./lib/pretextQueue');

// Ensure db directory exists
if (!fs.existsSync('./db')) {
    fs.mkdirSync('./db');
}

// Setup static file serving for resources
fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'resources'),
    prefix: '/resources/',
});

// Register Fastify Socket.io plugin
fastify.register(require('fastify-socket.io'));

async function loadDefaultPrompts() {
    try {
        const promptLibraryDir = path.join(__dirname, 'prompt_library');

        // Check if prompt_library directory exists
        if (!fs.existsSync(promptLibraryDir)) {
            console.log('Prompt library directory does not exist, creating it...');
            fs.mkdirSync(promptLibraryDir, { recursive: true });
            return; // Exit if no directory (likely first run)
        }

        // Read all YAML files in the prompt_library directory
        const files = fs.readdirSync(promptLibraryDir);
        const yamlFiles = files.filter(file => file.endsWith('.yaml') || file.endsWith('.yml'));

        if (yamlFiles.length === 0) {
            console.log('No prompt templates found in prompt_library');
            return;
        }

        console.log(`Found ${yamlFiles.length} prompt templates`);

        // Process each YAML file
        for (const file of yamlFiles) {
            const filePath = path.join(promptLibraryDir, file);
            const fileContent = fs.readFileSync(filePath, 'utf8');

            try {
                // Parse YAML content
                const promptData = yaml.load(fileContent);

                // Check if this prompt already exists in the database
                const existingPrompt = await db.get('SELECT id FROM Prompt WHERE name = ?', [promptData.name]);

                if (existingPrompt) {
                    console.log(`Prompt "${promptData.name}" already exists, skipping`);
                    continue;
                }

                // Insert new prompt into the database
                await db.run(
                    `INSERT INTO Prompt (name, template, system_prompt, dos, donts, created_at, updated_at) 
                     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [
                        promptData.name,
                        promptData.template,
                        promptData.system_prompt || '',
                        promptData.dos || '',
                        promptData.donts || ''
                    ]
                );

                console.log(`Inserted prompt template: ${promptData.name}`);
            } catch (error) {
                console.error(`Error loading prompt from ${file}:`, error.message);
            }
        }

        console.log('Finished loading prompt templates');
    } catch (error) {
        console.error('Error loading default prompts:', error.message);
    }
}

// Setup database connection
let db;
const setupDb = async () => {
    db = await open({
        filename: './db/recon.db',
        driver: sqlite3.Database
    });
    // Create tables if they don't exist
    await db.exec(`
    CREATE TABLE IF NOT EXISTS Domain (
      name TEXT PRIMARY KEY,
      mx TEXT,
      spf TEXT,
      dmarc TEXT,
      email_format TEXT
    );
    
    CREATE TABLE IF NOT EXISTS SourceDomain (
      name TEXT PRIMARY KEY,
      mx TEXT,
      spf TEXT,
      dmarc TEXT,
      last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS Target (
      email TEXT PRIMARY KEY,
      name TEXT,
      profile TEXT,
      domain_name TEXT,
      tenure_start TIMESTAMP,
      status TEXT DEFAULT 'pending', -- pending, enriched, failed
      FOREIGN KEY (domain_name) REFERENCES Domain(name)
    );
    
    CREATE TABLE IF NOT EXISTS SourceData (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      source_domain_name TEXT,
      discovery_method TEXT NOT NULL,
      data TEXT,
      status TEXT DEFAULT 'pending', -- pending, mined, failed
      status_message TEXT,
      last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_domain_name) REFERENCES SourceDomain(name)
    );
    
    CREATE TABLE IF NOT EXISTS TargetSourceMap (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_email TEXT,
      source_id INTEGER,
      FOREIGN KEY (target_email) REFERENCES Target(email),
      FOREIGN KEY (source_id) REFERENCES SourceData(id)
    );
    
    CREATE TABLE IF NOT EXISTS Prompt (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      template TEXT NOT NULL,
      system_prompt TEXT,
      dos TEXT,
      donts TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS Pretext (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_email TEXT,
      prompt_id INTEGER,
      prompt_text TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      link TEXT,
      status TEXT DEFAULT 'draft', -- draft, approved, rejected
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (target_email) REFERENCES Target(email),
      FOREIGN KEY (prompt_id) REFERENCES Prompt(id)
    );
  `);
    // Load and insert default prompts
    await loadDefaultPrompts();
    return db;
};

// favicon.ico route
fastify.get('/favicon.ico', async (request, reply) => {
    return reply.sendFile('images/favicon.ico');
});

// Setup routes
fastify.get('/', async (request, reply) => {
    return reply.sendFile('pages/index.html');
});

// API route to add a new domain
fastify.post('/api/domain', async (request, reply) => {
    const { domain } = request.body;

    try {
        // First add the domain to the database with minimal info
        await db.run(
            'INSERT OR IGNORE INTO Domain (name) VALUES (?)',
            [domain]
        );

        // Queue the domain for DNS lookups
        await dnsQueue.queueDomainForDnsLookup(domain);

        return {
            success: true,
            domain,
            message: "Domain added and queued for DNS lookups"
        };
    } catch (error) {
        fastify.log.error(error);
        return { success: false, error: error.message };
    }
});

// API route to get domains
fastify.get('/api/domains', async (request, reply) => {
    try {
        const domains = await db.all('SELECT * FROM Domain');
        return { success: true, domains };
    } catch (error) {
        fastify.log.error(error);
        return { success: false, error: error.message };
    }
});

// API route to get related domains via Microsoft Autodiscover
fastify.post('/api/domain/related', async (request, reply) => {
    const { domain } = request.body;

    if (!domain) {
        return reply.code(400).send({
            success: false,
            error: 'Domain is required'
        });
    }

    try {
        // Get related domains using Autodiscover
        const result = await autodiscoverService.getRelatedDomains(domain);

        // Save related domains to the database (if found)
        if (result.domains && result.domains.length > 0) {
            // First, make sure the primary domain exists
            await db.run(
                'INSERT OR IGNORE INTO Domain (name) VALUES (?)',
                [domain]
            );

            // Save each related domain if it doesn't exist yet
            for (const relatedDomain of result.domains) {
                if (relatedDomain !== domain) {  // Skip the original domain
                    await db.run(
                        'INSERT OR IGNORE INTO Domain (name) VALUES (?)',
                        [relatedDomain]
                    );

                    // Queue the newly discovered domain for DNS lookups
                    await dnsQueue.queueDomainForDnsLookup(relatedDomain);
                }
            }

            // Notify clients about the newly found domains
            fastify.io.emit('relatedDomainsFound', {
                primaryDomain: domain,
                relatedDomains: result.domains.filter(d => d !== domain)
            });
        }

        return {
            success: true,
            domain,
            applicationUri: result.applicationUri,
            relatedDomains: result.domains.filter(d => d !== domain) // Filter out the primary domain
        };
    } catch (error) {
        fastify.log.error(`Autodiscover error for ${domain}: ${error.message}`);
        return {
            success: false,
            domain,
            error: error.message
        };
    }
});

fastify.post('/api/recon/start', async (request, reply) => {
    const { domain } = request.body;
    const hunterApiKey = process.env.HUNTER_API_KEY;

    if (!domain) {
        return reply.code(400).send({
            success: false,
            error: 'Domain is required'
        });
    }

    if (!hunterApiKey) {
        return reply.code(500).send({
            success: false,
            error: 'Hunter API key not configured'
        });
    }

    try {
        // Notify clients that recon has started
        fastify.io.emit('reconUpdate', {
            message: `Starting reconnaissance for ${domain} using Hunter.io...`
        });

        // Get domain info from Hunter.io
        const hunterData = await hunterService.searchDomain(domain, hunterApiKey);

        // Process the results
        const results = await processHunterResults(domain, hunterData);

        // Notify clients that recon has completed
        fastify.io.emit('reconComplete', {
            domain,
            targetsCount: results.targetsCount
        });

        return {
            success: true,
            domain,
            results
        };

    } catch (error) {
        fastify.log.error(`Recon error for ${domain}: ${error.message}`);

        // Notify clients that recon failed
        fastify.io.emit('reconUpdate', {
            message: `Reconnaissance for ${domain} failed: ${error.message}`
        });

        return {
            success: false,
            domain,
            error: error.message
        };
    }
});

// Function to process and store Hunter.io results
async function processHunterResults(domain, hunterData) {
    // Initialize results object
    const results = {
        emailFormat: null,
        targetsCount: 0,
        sources: []
    };

    try {
        // Make sure domain exists in our DB
        await db.run(
            'INSERT OR IGNORE INTO Domain (name) VALUES (?)',
            [domain]
        );

        // Update domain with email format if available
        if (hunterData.data && hunterData.data.pattern) {
            results.emailFormat = hunterData.data.pattern;

            await db.run(
                'UPDATE Domain SET email_format = ? WHERE name = ?',
                [hunterData.data.pattern, domain]
            );

            fastify.io.emit('reconUpdate', {
                message: `Found email format for ${domain}: ${hunterData.data.pattern}`
            });
        }

        // Process each email found
        if (hunterData.data && hunterData.data.emails && hunterData.data.emails.length > 0) {
            results.targetsCount = hunterData.data.emails.length;

            fastify.io.emit('reconUpdate', {
                message: `Found ${results.targetsCount} potential contacts for ${domain}`
            });

            // Process each email
            for (const email of hunterData.data.emails) {
                // Find the earliest extraction date for tenure calculation
                let earliestExtraction = null;

                if (email.sources && email.sources.length > 0) {
                    // Sort sources by extraction date to find earliest
                    const sortedSources = [...email.sources].sort((a, b) =>
                        new Date(a.extracted_on) - new Date(b.extracted_on)
                    );

                    earliestExtraction = sortedSources[0].extracted_on;
                }

                // Convert to timestamp format for database
                const tenureStart = earliestExtraction ? new Date(earliestExtraction).toISOString() : null;

                await db.run(
                    `INSERT INTO Target (email, name, domain_name, status, tenure_start) 
                    VALUES (?, ?, ?, ?, ?) 
                    ON CONFLICT(email) DO UPDATE SET 
                    name = ?, 
                    domain_name = ?, 
                    status = ?,
                    tenure_start = COALESCE(?, tenure_start)`,
                    [
                        email.value,
                        `${email.first_name} ${email.last_name}`,
                        domain,
                        'pending',
                        tenureStart,
                        `${email.first_name} ${email.last_name}`,
                        domain,
                        'pending',
                        tenureStart
                    ]
                );

                // Process sources for this email
                if (email.sources && email.sources.length > 0) {
                    for (const source of email.sources) {
                        // Check if this is a LinkedIn source via Google Search
                        let sourceUrl = source.uri;

                        // First ensure the source domain exists in our DB
                        const sourceDomain = new URL(source.uri).hostname;
                        await db.run(
                            'INSERT OR IGNORE INTO SourceDomain (name) VALUES (?)',
                            [source.domain]
                        );

                        // Special case for LinkedIn: use the profile URL instead of Google search URL
                        if (source.domain === 'linkedin.com' &&
                            source.uri.includes('google.com/search') &&
                            email.linkedin) {
                            // Use the actual LinkedIn profile URL instead
                            sourceUrl = email.linkedin;

                            fastify.io.emit('reconUpdate', {
                                message: `Using LinkedIn profile URL for ${email.first_name} ${email.last_name} instead of Google search URL`
                            });
                        }

                        let sourceResult = await db.run(
                            `INSERT OR IGNORE INTO SourceData 
                            (url, source_domain_name, discovery_method, data, status) 
                            VALUES (?, ?, ?, ?, ?)`,
                            [
                                sourceUrl,
                                source.domain,
                                'hunter.io',
                                JSON.stringify({
                                    extracted_on: source.extracted_on,
                                    last_seen_on: source.last_seen_on,
                                    still_on_page: source.still_on_page,
                                    // Store both URLs if we're using LinkedIn profile instead of Google search
                                    original_uri: source.uri !== sourceUrl ? source.uri : null
                                }),
                                'pending'
                            ]
                        );

                        // Get the source ID (either newly inserted or existing)
                        let sourceId;
                        if (sourceResult.lastID) {
                            sourceId = sourceResult.lastID;
                        } else {
                            const existingSource = await db.get(
                                'SELECT id FROM SourceData WHERE url = ?',
                                [sourceUrl]
                            );
                            sourceId = existingSource.id;
                        }

                        // Map the target to the source
                        await db.run(
                            `INSERT OR IGNORE INTO TargetSourceMap (target_email, source_id)
                            VALUES (?, ?)`,
                            [email.value, sourceId]
                        );

                        // Add to results for reporting
                        results.sources.push({
                            url: sourceUrl,
                            domain: source.domain,
                            // Also track if we're using a LinkedIn profile instead
                            original_url: source.uri !== sourceUrl ? source.uri : null
                        });
                    }
                }

                // Emit progress update
                fastify.io.emit('reconUpdate', {
                    message: `Processed contact: ${email.first_name} ${email.last_name} (${email.value}) with tenure starting ${tenureStart || 'unknown'}`
                });
            }
        }

        fastify.io.emit('domainUpdated', { domain });

        return results;
    } catch (error) {
        console.error(`Error processing Hunter.io results: ${error.message}`);
        throw error;
    }
}

// Route to serve the domain details page
fastify.get('/domain/:domain', async (request, reply) => {
    return reply.sendFile('pages/domain.html');
});

// API route to get specific domain information
fastify.get('/api/domain/:domain', async (request, reply) => {
    const { domain } = request.params;

    try {
        const domainData = await db.get('SELECT * FROM Domain WHERE name = ?', [domain]);

        if (!domainData) {
            return {
                success: false,
                error: 'Domain not found'
            };
        }

        return {
            success: true,
            domain: domainData
        };
    } catch (error) {
        fastify.log.error(error);
        return {
            success: false,
            error: error.message
        };
    }
});

// API route to get targets for a specific domain
fastify.get('/api/domain/:domain/targets', async (request, reply) => {
    const { domain } = request.params;

    try {
        // Get all targets for this domain
        const targets = await db.all(`
            SELECT t.*, 
                   COUNT(tsm.source_id) as sourceCount
            FROM Target t
            LEFT JOIN TargetSourceMap tsm ON t.email = tsm.target_email
            WHERE t.domain_name = ?
            GROUP BY t.email
        `, [domain]);

        return {
            success: true,
            targets
        };
    } catch (error) {
        fastify.log.error(error);
        return {
            success: false,
            error: error.message
        };
    }
});

// API route to get target details with sources
fastify.get('/api/target/:email', async (request, reply) => {
    const { email } = request.params;

    try {
        // Get target details
        const target = await db.get('SELECT * FROM Target WHERE email = ?', [email]);

        if (!target) {
            return {
                success: false,
                error: 'Target not found'
            };
        }

        // Get sources for this target
        const sources = await db.all(`
            SELECT sd.*
            FROM SourceData sd
            JOIN TargetSourceMap tsm ON sd.id = tsm.source_id
            WHERE tsm.target_email = ?
        `, [email]);

        return {
            success: true,
            target,
            sources
        };
    } catch (error) {
        fastify.log.error(error);
        return {
            success: false,
            error: error.message
        };
    }
});

// API route to delete a target
fastify.delete('/api/target/:email', async (request, reply) => {
    const { email } = request.params;

    try {
        // First check if the target exists
        const target = await db.get('SELECT * FROM Target WHERE email = ?', [email]);

        if (!target) {
            return {
                success: false,
                error: 'Target not found'
            };
        }

        // Begin a transaction to ensure all related data is deleted properly
        await db.run('BEGIN TRANSACTION');

        try {
            // First delete mapping entries
            await db.run('DELETE FROM TargetSourceMap WHERE target_email = ?', [email]);

            // Then delete any pretexts associated with this target
            await db.run('DELETE FROM Pretext WHERE target_email = ?', [email]);

            // Finally delete the target itself
            await db.run('DELETE FROM Target WHERE email = ?', [email]);

            // Commit the transaction
            await db.run('COMMIT');

            // Notify clients via Socket.io about the deletion
            fastify.io.emit('targetDeleted', {
                email,
                domain: target.domain_name
            });

            return {
                success: true,
                message: `Target ${email} has been deleted`
            };
        } catch (error) {
            // Rollback if any error occurs
            await db.run('ROLLBACK');
            throw error;
        }
    } catch (error) {
        fastify.log.error(`Error deleting target ${email}: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
});

// API route to scrape sources for targets
fastify.post('/api/targets/scrape-sources', async (request, reply) => {
    const { targetEmails } = request.body;

    try {
        if (!Array.isArray(targetEmails)) {
            return {
                success: false,
                error: 'targetEmails must be an array'
            };
        }

        // Queue sources for the specified targets
        const result = await sourceQueue.queueSourcesForTargets(targetEmails, db);

        // Notify clients about the queued job
        fastify.io.emit('scrapeUpdate', {
            message: result.message,
            targetCount: targetEmails.length,
            sourceCount: result.count
        });

        return {
            success: true,
            ...result
        };
    } catch (error) {
        fastify.log.error(`Error queuing sources for targets: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
});

// API route to get all sources
fastify.get('/api/sources', async (request, reply) => {
    try {
        const sources = await db.all(`
            SELECT sd.*, COUNT(tsm.target_email) as targetCount 
            FROM SourceData sd
            LEFT JOIN TargetSourceMap tsm ON sd.id = tsm.source_id
            GROUP BY sd.id
            ORDER BY sd.last_checked DESC
        `);

        return { success: true, sources };
    } catch (error) {
        fastify.log.error(error);
        return { success: false, error: error.message };
    }
});

// API route to generate profile for a single target
fastify.post('/api/target/generate-profile', async (request, reply) => {
    const { email } = request.body;

    if (!email) {
        return reply.code(400).send({
            success: false,
            error: 'Email is required'
        });
    }

    try {
        // Check if the target exists and is in the enriched state
        const target = await db.get('SELECT * FROM Target WHERE email = ?', [email]);

        if (!target) {
            return reply.code(404).send({
                success: false,
                error: 'Target not found'
            });
        }

        if (target.status !== 'enriched') {
            return reply.code(400).send({
                success: false,
                error: `Target status is ${target.status}, not enriched`
            });
        }

        // Queue the profile generation
        const result = await profileQueue.queueProfileGeneration(email);

        return {
            success: true,
            email,
            jobId: result.jobId
        };
    } catch (error) {
        fastify.log.error(`Error queueing profile generation for ${email}: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
});

// API route to generate profiles for multiple targets
fastify.post('/api/targets/generate-profiles', async (request, reply) => {
    const { targetEmails, domainName } = request.body;

    if (!Array.isArray(targetEmails) || targetEmails.length === 0) {
        return reply.code(400).send({
            success: false,
            error: 'targetEmails must be a non-empty array'
        });
    }

    if (!domainName) {
        return reply.code(400).send({
            success: false,
            error: 'domainName is required'
        });
    }

    try {
        // Get all targets with enriched status from the provided emails
        const enrichedTargets = await Promise.all(
            targetEmails.map(async (email) => {
                const target = await db.get('SELECT * FROM Target WHERE email = ? AND status = ?', [email, 'enriched']);
                return target;
            })
        );

        // Filter out any null values (targets that don't exist or aren't enriched)
        const validTargets = enrichedTargets.filter(target => target !== null);

        if (validTargets.length === 0) {
            return reply.code(400).send({
                success: false,
                error: 'No valid enriched targets found'
            });
        }

        // Queue profile generation for all valid targets
        const result = await profileQueue.queueProfilesForTargets(
            validTargets.map(target => target.email),
            domainName
        );

        // Notify clients that profile generation has been queued
        fastify.io.emit('reconUpdate', {
            message: `Queued profile generation for ${result.count} targets in ${domainName}`
        });

        return {
            success: true,
            count: result.count,
            domain: domainName
        };
    } catch (error) {
        fastify.log.error(`Error queueing profile generation for multiple targets: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
});

// API route to get all available prompts 
fastify.get('/api/prompts', async (request, reply) => {
    try {
        const prompts = await db.all('SELECT id, name FROM Prompt ORDER BY name');
        return { success: true, prompts };
    } catch (error) {
        fastify.log.error(error);
        return { success: false, error: error.message };
    }
});

// API route to get a specific prompt by ID
fastify.get('/api/prompt/:id', async (request, reply) => {
    const { id } = request.params;

    try {
        const prompt = await db.get('SELECT * FROM Prompt WHERE id = ?', [id]);

        if (!prompt) {
            return {
                success: false,
                error: 'Prompt not found'
            };
        }

        return { success: true, prompt };
    } catch (error) {
        fastify.log.error(error);
        return { success: false, error: error.message };
    }
});

// API route to generate pretext for a single target
fastify.post('/api/target/generate-pretext', async (request, reply) => {
    const { email, promptId } = request.body;

    if (!email || !promptId) {
        return reply.code(400).send({
            success: false,
            error: 'Email and promptId are required'
        });
    }

    try {
        // Check if the target exists and is in the complete state
        const target = await db.get('SELECT * FROM Target WHERE email = ?', [email]);

        if (!target) {
            return reply.code(404).send({
                success: false,
                error: 'Target not found'
            });
        }

        if (target.status !== 'complete') {
            return reply.code(400).send({
                success: false,
                error: `Target status is ${target.status}, not complete`
            });
        }

        // Queue the pretext generation
        const result = await pretextQueue.queuePretextGeneration(email, promptId);

        return {
            success: true,
            email,
            promptId,
            jobId: result.jobId
        };
    } catch (error) {
        fastify.log.error(`Error queueing pretext generation for ${email}: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
});

// API route to generate pretexts for multiple targets
fastify.post('/api/targets/generate-pretexts', async (request, reply) => {
    const { targetEmails, promptId, domainName } = request.body;

    if (!Array.isArray(targetEmails) || targetEmails.length === 0) {
        return reply.code(400).send({
            success: false,
            error: 'targetEmails must be a non-empty array'
        });
    }

    if (!promptId) {
        return reply.code(400).send({
            success: false,
            error: 'promptId is required'
        });
    }

    if (!domainName) {
        return reply.code(400).send({
            success: false,
            error: 'domainName is required'
        });
    }

    try {
        // Get all targets with complete status from the provided emails
        const completeTargets = await Promise.all(
            targetEmails.map(async (email) => {
                const target = await db.get('SELECT * FROM Target WHERE email = ? AND status = ?', [email, 'complete']);
                return target;
            })
        );

        // Filter out any null values (targets that don't exist or aren't complete)
        const validTargets = completeTargets.filter(target => target !== null);

        if (validTargets.length === 0) {
            return reply.code(400).send({
                success: false,
                error: 'No valid complete targets found'
            });
        }

        // Queue pretext generation for all valid targets
        const result = await pretextQueue.queuePretextsForTargets(
            validTargets.map(target => target.email),
            promptId,
            domainName
        );

        // Notify clients that pretext generation has been queued
        fastify.io.emit('reconUpdate', {
            message: `Queued pretext generation for ${result.count} targets in ${domainName}`
        });

        return {
            success: true,
            count: result.count,
            domain: domainName
        };
    } catch (error) {
        fastify.log.error(`Error queueing pretext generation for multiple targets: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
});

// API route to get all pretexts for a domain
fastify.get('/api/domain/:domain/pretexts', async (request, reply) => {
    const { domain } = request.params;

    try {
        // Get all pretexts for targets in this domain
        const pretexts = await db.all(`
            SELECT p.*, t.name as target_name, pr.name as prompt_name
            FROM Pretext p
            JOIN Target t ON p.target_email = t.email
            JOIN Prompt pr ON p.prompt_id = pr.id
            WHERE t.domain_name = ?
            ORDER BY p.created_at DESC
        `, [domain]);

        return {
            success: true,
            pretexts
        };
    } catch (error) {
        fastify.log.error(error);
        return {
            success: false,
            error: error.message
        };
    }
});

// API route to get pretexts for a specific target
fastify.get('/api/target/:email/pretexts', async (request, reply) => {
    const { email } = request.params;

    try {
        // Get all pretexts for this target
        const pretexts = await db.all(`
            SELECT p.*, pr.name as prompt_name
            FROM Pretext p
            JOIN Prompt pr ON p.prompt_id = pr.id
            WHERE p.target_email = ?
            ORDER BY p.created_at DESC
        `, [email]);

        return {
            success: true,
            pretexts
        };
    } catch (error) {
        fastify.log.error(error);
        return {
            success: false,
            error: error.message
        };
    }
});

// Route to serve the pretexts page
fastify.get('/pretexts/:domain', async (request, reply) => {
    return reply.sendFile('pages/pretexts.html');
});

// API route to update pretext status
fastify.put('/api/pretext/:id/status', async (request, reply) => {
    const { id } = request.params;
    const { status } = request.body;

    if (!id || !status) {
        return reply.code(400).send({
            success: false,
            error: 'Pretext ID and status are required'
        });
    }

    // Validate status value
    const validStatuses = ['draft', 'approved', 'rejected'];
    if (!validStatuses.includes(status)) {
        return reply.code(400).send({
            success: false,
            error: 'Invalid status. Must be one of: draft, approved, rejected'
        });
    }

    try {
        // Check if the pretext exists
        const pretext = await db.get('SELECT * FROM Pretext WHERE id = ?', [id]);

        if (!pretext) {
            return reply.code(404).send({
                success: false,
                error: 'Pretext not found'
            });
        }

        // Update the pretext status
        await db.run(
            'UPDATE Pretext SET status = ? WHERE id = ?',
            [status, id]
        );

        // Notify clients about the status update
        fastify.io.emit('pretextStatusUpdated', {
            id: parseInt(id),
            status: status
        });

        return {
            success: true,
            id: parseInt(id),
            status: status
        };
    } catch (error) {
        fastify.log.error(`Error updating pretext status: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
});

// Start the server
const start = async () => {
    try {
        await setupDb();

        // Setup Socket.io event handlers
        fastify.ready(err => {
            if (err) throw err;

            // Initialize the DNS queue processor with db and io
            dnsQueue.initDnsQueueProcessor(db, fastify.io);

            //Initialize the source queue processor with db and io
            sourceQueue.initSourceQueueProcessor(db, fastify.io);

            // Initialize the profile queue processor with db and io
            profileQueue.initProfileQueueProcessor(db, fastify.io);

            // Initialize the pretext queue processor with db and io
            pretextQueue.initPretextQueueProcessor(db, fastify.io);

            fastify.io.on('connection', (socket) => {
                console.log('Client connected');

                socket.on('disconnect', () => {
                    console.log('Client disconnected');
                });
            });
        });

        // Start Fastify server
        await fastify.listen({ port: 3000, host: '0.0.0.0' });
        console.log(`Server listening at ${fastify.server.address().port}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();