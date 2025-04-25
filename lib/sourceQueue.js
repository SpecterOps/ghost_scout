const Queue = require('bee-queue');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Initialize puppeteer with stealth plugin
puppeteer.use(StealthPlugin());

// Initialize source scraping queue
const sourceQueue = new Queue('source-scraper', {
    redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
    },
    isWorker: true,
});

// User agent
const user_agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.54 Safari/537.36";

// User data directory for browser persistence
const userDataDir = path.join(__dirname, 'user_data');

// Ensure user_data directory exists
if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir);
    console.log(`Created user data directory: ${userDataDir}`);
}

let db;
let io;
let browser;

// Helper function for waiting with randomization
function wait(timeout) {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve();
        }, (timeout + Math.random() * 1000));
    });
}

// Function to handle LinkedIn login
async function handleLinkedInLogin() {
    console.log("Opening LinkedIn login page for manual authentication...");

    // Launch browser with user_data_dir for persistence
    const puppet_options = ["--no-sandbox", "--ignore-certificate-errors", "--disable-blink-features=AutomationControlled"]
    const tempBrowser = await puppeteer.launch({
        headless: false,
        ignoreHTTPSErrors: true,
        ignoreDefaultArgs: ["--enable-automation"],
        defaultViewport: null,
        args: puppet_options,
        userDataDir: userDataDir
    });

    try {
        const page = await tempBrowser.newPage();
        await page.setUserAgent(user_agent);

        // Navigate to LinkedIn login page
        const response = await page.goto('https://www.linkedin.com/login', {
            waitUntil: 'networkidle2',
            timeout: 60000
        }).catch(e => {
            console.log("Navigation encountered an issue, but continuing to check if we're logged in...");
            return null;
        });

        // Check if we're already logged in by checking the URL
        const currentUrl = page.url();
        if (currentUrl.includes('/feed') || currentUrl.includes('/mynetwork') || currentUrl.includes('/home')) {
            console.log("Already logged in to LinkedIn! Detected redirect to feed/home page.");

            // Just to verify the session is valid
            const profileLinkSelector = 'a[data-control-name="identity_profile_photo"]';
            try {
                await page.waitForSelector(profileLinkSelector, { timeout: 5000 });
                console.log("Verified that LinkedIn session is active.");
            } catch (e) {
                console.log("Unable to verify LinkedIn session. You may still need to log in.");
            }

            await wait(200); // Give user time to see the page
            await tempBrowser.close();
            return;
        }

        console.log("Please login to LinkedIn and close the browser when finished.");

        // Wait for browser to be closed by the user after logging in
        await new Promise(resolve => {
            tempBrowser.on('disconnected', resolve);
        });

    } catch (error) {
        console.log(`LinkedIn login preparation encountered an error: ${error.message}`);
        console.log("Continuing with the process, as we may already be logged in...");
        try {
            await tempBrowser.close();
        } catch (closeError) {
            console.log("Browser was already closed.");
        }
    }

    console.log("LinkedIn login browser closed. Proceeding with scraping...");
}

// Convert HTML to Markdown using the MarkItDown API
function convertHtmlToMarkdown(html) {
    return new Promise((resolve, reject) => {
        // Create a boundary for the multipart form data
        const boundary = 'MarkItDownBoundary' + Math.random().toString().substr(2);
        // Prepare the multipart form data
        const postData =
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="webpage.html"\r\n` +
            `Content-Type: text/html\r\n\r\n` +
            `${html}\r\n` +
            `--${boundary}--\r\n`;
        console.log('Sending request to MarkItDown API...');
        // Set up the request options
        const options = {
            hostname: '127.0.0.1',
            port: 8490,
            path: '/process_file',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        // Make the request
        const req = http.request(options, (res) => {
            let data = '';
            // A chunk of data has been received
            res.on('data', (chunk) => {
                data += chunk;
            });
            // The whole response has been received
            res.on('end', () => {
                console.log(`MarkItDown API responded with status code: ${res.statusCode}`);
                if (res.statusCode !== 200) {
                    reject(new Error(`API returned status code ${res.statusCode}: ${data}`));
                    return;
                }
                try {
                    const result = JSON.parse(data);
                    if (!result.markdown) {
                        reject(new Error(`API response missing markdown field: ${data}`));
                        return;
                    }
                    resolve(result.markdown);
                } catch (e) {
                    reject(new Error(`Failed to parse response: ${data}`));
                }
            });
        });
        // Handle error
        req.on('error', (e) => {
            reject(new Error(`API request failed: ${e.message}`));
        });
        // Set timeout for the request
        req.setTimeout(30000, () => {
            req.abort();
            reject(new Error('API request timed out'));
        });
        // Write data to request body
        req.write(postData);
        req.end();
    });
}

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

// Initialize puppeteer browser
async function initBrowser() {
    const puppet_options = ["--no-sandbox", "--ignore-certificate-errors", "--disable-blink-features=AutomationControlled"];
    browser = await puppeteer.launch({
        headless: true, // Set to false for debugging
        ignoreHTTPSErrors: true,
        ignoreDefaultArgs: ["--enable-automation"],
        defaultViewport: null,
        args: puppet_options,
        userDataDir: userDataDir
    });
    console.log('Puppeteer browser initialized');
    return browser;
}

// Scrape a URL using puppeteer
async function scrapeUrl(url, timeout = 7) {
    let page;
    try {
        console.log(`Scraping: ${url}`);
        page = await browser.newPage();
        await page.setUserAgent(user_agent);

        // Dismiss dialogs
        page.on('dialog', async dialog => {
            await dialog.dismiss();
        });

        // Setup timeout and navigation promises
        const navigationTimeoutMs = timeout * 1000;

        // Navigate to URL with a basic timeout
        console.log(`Navigating to: ${url}`);
        await page.goto(url, {
            waitUntil: 'domcontentloaded', // Just wait for DOM, not full load
            timeout: navigationTimeoutMs
        });

        // Then set up a race for the networkidle2 vs timeout
        console.log(`Waiting for network idle or timeout (${timeout}s)`);
        try {
            await Promise.race([
                page.waitForNavigation({
                    waitUntil: 'networkidle2',
                    timeout: navigationTimeoutMs
                }),
                new Promise(resolve => setTimeout(resolve, navigationTimeoutMs))
            ]);
        } catch (e) {
            // If there's an error in waitForNavigation, we'll just continue
            console.log(`Navigation wait timed out or errored for ${url}: ${e.message}`);
        }

        console.log(`Initial page load complete (or timed out): ${url}`);

        // Scroll to middle of the page first
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight / 2);
        });

        // Wait for any AJAX content to load after first scroll
        await wait(2000);

        // Scroll to the bottom of the page
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });

        // Wait for any AJAX content to load after final scroll
        await wait(2000);

        console.log(`Finished scrolling and waiting: ${url}`);

        // Get rendered DOM HTML after scrolling
        let bodyHTML = null;

        // If it's a LinkedIn page, define bodyHTML as the main element
        if (url.includes('linkedin.com')) {
            bodyHTML = await page.evaluate(() => {
                const element = document.getElementsByTagName('main')[0];
                return element ? element.innerHTML : null;
            });
            if (!bodyHTML) {
                throw new Error("No content found in LinkedIn page.");
            }
        } else {
            bodyHTML = await page.evaluate(() => document.documentElement.innerHTML);
            if (!bodyHTML) {
                throw new Error("No content found in the page.");
            }
        }

        // Get page status and title for metadata
        const status = await page.evaluate(() => document.readyState);
        const title = await page.title();

        console.log(`Converting HTML to Markdown for: ${url}`);
        // Convert HTML to Markdown
        let markdown;
        try {
            markdown = await convertHtmlToMarkdown(bodyHTML);
            console.log(`Successfully converted HTML to Markdown for: ${url}`);
        } catch (markdownError) {
            console.error(`Error converting HTML to Markdown: ${markdownError.message}`);
            // If markdown conversion fails, use a basic fallback
            markdown = `Failed to convert to markdown. Title: ${title}\nURL: ${url}\nStatus: ${status}`;
        }

        // Close the page
        await page.close();

        return {
            success: true,
            markdown: markdown,
            status: status,
            title: title,
            url: url
        };
    } catch (err) {
        console.error(`Error processing ${url}: ${err.message}`);
        if (page) await page.close().catch(() => { });
        throw err;
    }
}

// Initialize the queue processor
async function initSourceQueueProcessor(database, socketio) {
    db = database;
    io = socketio;

    // Handle LinkedIn login first
    //await handleLinkedInLogin();

    // Initialize browser
    await initBrowser();

    // Process jobs in the queue
    sourceQueue.process(3, async (job) => { // Reduced concurrency for puppeteer
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

            // Scrape the URL using puppeteer
            const scrapedData = await scrapeUrl(sourceUrl);

            // Store only the markdown in the data field
            const sourceData = {
                scrapedAt: new Date().toISOString(),
                title: scrapedData.title,
                url: scrapedData.url,
                content: scrapedData.markdown  // Store the markdown as the main content
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

    // Handle cleanup on process exit
    process.on('SIGINT', async () => {
        console.log('Closing browser before exit...');
        if (browser) await browser.close();
        process.exit();
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

async function clearQueue() {
    try {
        // Use destroy() to remove all Redis keys for this queue
        const jobs = await sourceQueue.destroy();
        console.log('Source scraping queue successfully cleared with jobs:', jobs);
        return { cleared: jobs };
    } catch (error) {
        console.error('Error clearing source scraping queue:', error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initSourceQueueProcessor,
    queueSourceForScraping,
    queueMultipleSourcesForScraping,
    queueSourcesForTargets,
    clearQueue,
};