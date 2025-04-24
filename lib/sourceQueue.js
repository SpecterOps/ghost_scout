// lib/sourceQueue.js
const Queue = require('bee-queue');
const axios = require('axios');

// Initialize source scraping queue
const sourceQueue = new Queue('source-scraper', {
    redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
    },
    isWorker: true,
});

let db;
let io;

// Get target emails associated with a source
async function getTargetEmailsForSource(sourceId) {
    try {
        return await db.all(
            'SELECT target_email FROM TargetSourceMap WHERE source_id = ?',
            [sourceId]
        );
    } catch (error) {
        console.error(`Error getting target emails for source ${sourceId}:`, error.message);
        return [];
    }
}

// Check and update target status if all sources are processed
async function checkAndUpdateTargetStatus(targetEmail) {
    try {
        // Check if this target has any remaining pending sources
        const pendingSources = await db.get(
            `SELECT COUNT(*) as count 
             FROM SourceData sd 
             JOIN TargetSourceMap tsm ON sd.id = tsm.source_id 
             WHERE tsm.target_email = ? AND sd.status = 'pending'`,
            [targetEmail]
        );

        // If no pending sources left, update the target status to 'enriched'
        if (pendingSources && pendingSources.count === 0) {
            // Get current status to avoid unnecessary updates
            const currentTarget = await db.get(
                'SELECT status FROM Target WHERE email = ?',
                [targetEmail]
            );

            if (currentTarget && currentTarget.status !== 'enriched') {
                await db.run(
                    'UPDATE Target SET status = ? WHERE email = ?',
                    ['enriched', targetEmail]
                );

                // Notify clients about the target status update
                io.emit('targetStatusUpdated', {
                    email: targetEmail,
                    status: 'enriched',
                    message: `Target ${targetEmail} has been marked as enriched`
                });

                console.log(`Target ${targetEmail} has been updated to 'enriched' status`);
                return true;
            }
        }
        return false;
    } catch (error) {
        console.error(`Error checking/updating target status for ${targetEmail}:`, error.message);
        return false;
    }
}

// Initialize the queue processor
function initSourceQueueProcessor(database, socketio) {
    db = database;
    io = socketio;

    // Process jobs in the queue
    sourceQueue.process(5, async (job) => {
        const { sourceId, sourceDomain, sourceUrl } = job.data;

        try {
            // Update source status to indicate it's being processed
            await db.run(
                'UPDATE SourceData SET status = ?, status_message = ? WHERE id = ?',
                ['processing', 'Source scraping in progress', sourceId]
            );

            // Notify clients that source scraping has started
            io.emit('sourceUpdate', {
                sourceId,
                status: 'processing',
                message: `Started scraping source: ${sourceUrl}`
            });

            // Make HTTP request to fetch source content
            const response = await axios.get(sourceUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                },
                timeout: 10000, // 10 second timeout
            });

            // Store response data in the database
            const sourceData = {
                statusCode: response.status,
                contentType: response.headers['content-type'],
                content: response.data.substring(0, 10000), // Truncate content to avoid storing too much data
                scrapedAt: new Date().toISOString()
            };

            // Update the source with the scraped data
            await db.run(
                'UPDATE SourceData SET status = ?, data = ?, status_message = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?',
                ['mined', JSON.stringify(sourceData), 'Successfully scraped source', sourceId]
            );

            // Get all targets associated with this source
            const targetEmails = await getTargetEmailsForSource(sourceId);

            // Check and update status for each target
            for (const target of targetEmails) {
                await checkAndUpdateTargetStatus(target.target_email);

                // Notify clients about source mining completion for this target
                io.emit('sourceMined', {
                    sourceId,
                    targetEmail: target.target_email,
                    status: 'mined'
                });
            }

            // Notify clients that source scraping is complete
            io.emit('sourceUpdate', {
                sourceId,
                status: 'mined',
                message: `Completed scraping source: ${sourceUrl}`
            });

            //log the scrape result and url
            console.log(`Scraped source ${sourceId} (${sourceUrl}):`);
            // Return success
            return { success: true, sourceId, message: 'Source scraped successfully' };
        } catch (error) {
            console.error(`Error scraping source ${sourceId} (${sourceUrl}):`, error.message);

            // Update the source with error details
            await db.run(
                'UPDATE SourceData SET status = ?, status_message = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?',
                ['failed', `Error: ${error.message}`, sourceId]
            );

            // Get all targets associated with this source
            const targetEmails = await getTargetEmailsForSource(sourceId);

            // Check and update status for each target, even if scraping failed
            for (const target of targetEmails) {
                await checkAndUpdateTargetStatus(target.target_email);

                // Notify clients about the failed source for this target
                io.emit('sourceFailed', {
                    sourceId,
                    targetEmail: target.target_email,
                    status: 'failed'
                });
            }

            // Notify clients about the error
            io.emit('sourceUpdate', {
                sourceId,
                status: 'failed',
                message: `Failed to scrape source: ${sourceUrl} - ${error.message}`
            });

            // Return failure
            return { success: false, sourceId, error: error.message };
        }
    });

    sourceQueue.on('failed', (job, err) => {
        console.error(`Job ${job.id} failed with error: ${err.message}`);
    });

    console.log('Source scraping queue processor initialized');
}

// Queue a single source for scraping
async function queueSourceForScraping(sourceId, sourceUrl, sourceDomain) {
    return await sourceQueue.createJob({
        sourceId,
        sourceUrl,
        sourceDomain
    }).save();
}

// Queue multiple sources for scraping
async function queueMultipleSourcesForScraping(sources) {
    const jobs = [];
    for (const source of sources) {
        const job = await queueSourceForScraping(source.id, source.url, source.source_domain_name);
        jobs.push(job);
    }
    return jobs;
}

// Queue sources for targets
async function queueSourcesForTargets(targetEmails, db) {
    try {
        let sources = [];

        if (targetEmails && targetEmails.length > 0) {
            // Use a parameterized query with multiple placeholders for the IN clause
            const placeholders = targetEmails.map(() => '?').join(',');

            // Get all sources for these targets that are not yet mined
            sources = await db.all(`
          SELECT sd.id, sd.url, sd.source_domain_name
          FROM SourceData sd
          JOIN TargetSourceMap tsm ON sd.id = tsm.source_id
          WHERE tsm.target_email IN (${placeholders}) AND sd.status != 'mined'
        `, targetEmails);
        } else {
            // If no target emails provided, get all pending sources
            sources = await db.all(`
          SELECT id, url, source_domain_name
          FROM SourceData
          WHERE status != 'mined'
        `);
        }

        if (sources.length === 0) {
            return {
                success: true,
                message: targetEmails && targetEmails.length > 0
                    ? `No sources to scrape for ${targetEmails.length} target(s)`
                    : 'No sources to scrape',
                count: 0
            };
        }

        // Queue all sources for scraping
        const jobs = await queueMultipleSourcesForScraping(sources);

        return {
            success: true,
            message: targetEmails && targetEmails.length > 0
                ? `Queued ${jobs.length} sources for ${targetEmails.length} target(s)`
                : `Queued ${jobs.length} sources for scraping`,
            count: jobs.length
        };
    } catch (error) {
        console.error(`Error queuing sources for targets:`, error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initSourceQueueProcessor,
    queueSourceForScraping,
    queueMultipleSourcesForScraping,
    queueSourcesForTargets
};