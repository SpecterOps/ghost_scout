// index.js
const path = require('path');
const fastify = require('fastify')({ logger: false });
const fs = require('fs');
require('dotenv').config();
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
// Import DNS queue module
const dnsQueue = require('./lib/dnsQueue');
// Import the autodiscover service
const autodiscoverService = require('./lib/autodiscover');
const hunterService = require('./lib/hunterService');

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
   
    CREATE TABLE IF NOT EXISTS Target (
      email TEXT PRIMARY KEY,
      name TEXT,
      profile TEXT,
      domain_name TEXT,
      status TEXT DEFAULT 'pending', -- pending, enriched, failed
      FOREIGN KEY (domain_name) REFERENCES Domain(name)
    );
   
    CREATE TABLE IF NOT EXISTS SourceData (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      discovery_method TEXT NOT NULL,
      data TEXT,
      status TEXT DEFAULT 'pending', -- pending, mined, failed
      status_message TEXT,
      last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS TargetSourceMap (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_email TEXT,
      source_id INTEGER,
      FOREIGN KEY (target_email) REFERENCES Target(email),
      FOREIGN KEY (source_id) REFERENCES SourceData(id)
    );
   
    CREATE TABLE IF NOT EXISTS Pretext (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_email TEXT,
      prompt TEXT,
      subject TEXT,
      body TEXT,
      link TEXT,
      status TEXT DEFAULT 'draft', -- draft, approved, rejected
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (target_email) REFERENCES Target(email)
    );
  `);
    return db;
};

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

            // CHANGE 2: Update the email_format using data.pattern
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
                // CHANGE 3: Mark all emails as pending and don't fill out profiles
                await db.run(
                    `INSERT INTO Target (email, name, domain_name, status) 
             VALUES (?, ?, ?, ?) 
             ON CONFLICT(email) DO UPDATE SET 
             name = ?, 
             domain_name = ?, 
             status = ?`,
                    [
                        email.value,
                        `${email.first_name} ${email.last_name}`,
                        domain,
                        'pending',  // Mark as pending instead of enriched
                        `${email.first_name} ${email.last_name}`,
                        domain,
                        'pending'   // Mark as pending instead of enriched
                    ]
                );

                // Process sources for this email
                if (email.sources && email.sources.length > 0) {
                    for (const source of email.sources) {
                        // CHANGE 4: Mark all sourcedata urls as pending
                        let sourceResult = await db.run(
                            `INSERT OR IGNORE INTO SourceData 
                 (url, discovery_method, data, status) 
                 VALUES (?, ?, ?, ?)`,
                            [
                                source.uri,
                                'hunter.io',
                                JSON.stringify({
                                    domain: source.domain,
                                    extracted_on: source.extracted_on,
                                    last_seen_on: source.last_seen_on,
                                    still_on_page: source.still_on_page
                                }),
                                'pending'  // Mark as pending instead of mined
                            ]
                        );

                        // Get the source ID (either newly inserted or existing)
                        let sourceId;
                        if (sourceResult.lastID) {
                            sourceId = sourceResult.lastID;
                        } else {
                            const existingSource = await db.get(
                                'SELECT id FROM SourceData WHERE url = ?',
                                [source.uri]
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
                            url: source.uri,
                            domain: source.domain
                        });
                    }
                }

                // Emit progress update
                fastify.io.emit('reconUpdate', {
                    message: `Processed contact: ${email.first_name} ${email.last_name} (${email.value})`
                });
            }
        }

        // CHANGE 1: Don't update the mx record with organization data
        // We'll leave the existing DNS records alone

        fastify.io.emit('domainUpdated', { domain });

        return results;
    } catch (error) {
        console.error(`Error processing Hunter.io results: ${error.message}`);
        throw error;
    }
}

// Start the server
const start = async () => {
    try {
        await setupDb();

        // Setup Socket.io event handlers
        fastify.ready(err => {
            if (err) throw err;

            // Initialize the DNS queue processor with db and io
            dnsQueue.initDnsQueueProcessor(db, fastify.io);

            fastify.io.on('connection', (socket) => {
                console.log('Client connected');

                socket.on('startRecon', async (data) => {
                    console.log(`Starting recon for domain: ${data.domain}`);

                    socket.emit('reconUpdate', {
                        message: `Starting reconnaissance for ${data.domain}...`
                    });

                    try {
                        // Call our API endpoint to start the recon
                        const response = await fetch(`http://localhost:${fastify.server.address().port}/api/recon/start`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ domain: data.domain }),
                        });

                        // We don't need to handle the response here as the Socket.io
                        // events will already be emitted during processing
                    } catch (error) {
                        console.error(`Error starting recon: ${error.message}`);
                        socket.emit('reconUpdate', {
                            message: `Error starting reconnaissance: ${error.message}`
                        });
                    }
                });

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