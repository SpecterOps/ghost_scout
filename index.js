// index.js
const path = require('path');
const fastify = require('fastify')({ logger: false });
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
// Import DNS queue module
const dnsQueue = require('./lib/dnsQueue');
// Import the autodiscover service
const autodiscoverService = require('./lib/autodiscover');

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

                socket.on('startRecon', (data) => {
                    console.log(`Starting recon for domain: ${data.domain}`);

                    // Here you would start your recon process
                    // For now, we'll just emit some fake updates

                    socket.emit('reconUpdate', {
                        message: `Scanning domain ${data.domain} for email format...`
                    });

                    setTimeout(() => {
                        socket.emit('reconUpdate', {
                            message: `Found potential email format for ${data.domain}: {first}.{last}@${data.domain}`
                        });
                    }, 2000);

                    setTimeout(() => {
                        socket.emit('reconComplete', {
                            domain: data.domain,
                            targetsCount: 5
                        });
                    }, 5000);
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