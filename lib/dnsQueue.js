// lib/dnsQueue.js
const Queue = require('bee-queue');
const dnsService = require('./dns');

// Create DNS lookup queue
const dnsLookupQueue = new Queue('dns_lookups', {
    // You can add Redis configuration here if needed
    redis: {
        host: '127.0.0.1',
        port: 6379
    },
});

// Initialize the queue processor
function initDnsQueueProcessor(db, io) {
    // Process jobs from the queue
    dnsLookupQueue.process(async (job) => {
        const { domain } = job.data;
        console.log(`Processing DNS lookups for domain: ${domain}`);

        try {
            // Get DNS records
            const dnsRecords = await dnsService.getAllDnsRecords(domain);

            // Insert or update domain with DNS records in DB
            await db.run(
                'INSERT INTO Domain (name, mx, spf, dmarc) VALUES (?, ?, ?, ?) ' +
                'ON CONFLICT(name) DO UPDATE SET mx = ?, spf = ?, dmarc = ?',
                [domain, dnsRecords.mx, dnsRecords.spf, dnsRecords.dmarc,
                    dnsRecords.mx, dnsRecords.spf, dnsRecords.dmarc]
            );

            // Notify clients about the update via Socket.io
            if (io) {
                io.emit('domainUpdated', {
                    domain,
                    dnsRecords
                });
            }

            // Return the results
            return { success: true, domain, dnsRecords };
        } catch (error) {
            console.error(`DNS lookup error for ${domain}:`, error);
            return { success: false, domain, error: error.message };
        }
    });

    // Handle queue events
    dnsLookupQueue.on('succeeded', (job, result) => {
        console.log(`DNS lookup job ${job.id} completed for domain: ${job.data.domain}`);
    });

    dnsLookupQueue.on('failed', (job, error) => {
        console.error(`DNS lookup job ${job.id} failed for domain: ${job.data.domain}:`, error);
    });

    dnsLookupQueue.on('error', (error) => {
        console.error('DNS lookup queue error:', error);
    });
}

// Function to queue a domain for DNS lookups
async function queueDomainForDnsLookup(domain) {
    // Create a new job for the domain
    const job = dnsLookupQueue.createJob({ domain });

    // Save the job to the queue
    await job.save();
    console.log(`Added domain ${domain} to DNS lookup queue, job ID: ${job.id}`);

    return job;
}

module.exports = {
    initDnsQueueProcessor,
    queueDomainForDnsLookup
};