// lib/pretextQueue.js
const Queue = require('bee-queue');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

// Initialize Anthropic client
const anthropicClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || 'dummy-key',
});

function extractJsonFromText(text) {
    // Look for the first occurrence of { and the last occurrence of }
    const startIndex = text.indexOf('{');
    const endIndex = text.lastIndexOf('}');

    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
        throw new Error('No valid JSON found in the response');
    }

    // Extract the potential JSON string
    const jsonStr = text.substring(startIndex, endIndex + 1);

    try {
        // Attempt to parse the extracted string
        return JSON.parse(jsonStr);
    } catch (err) {
        // If parsing fails, try to clean up the string
        // This handles cases where there might be line breaks or other characters inside the JSON
        const cleanedStr = jsonStr.replace(/[\r\n]+/g, ' ').trim();
        return JSON.parse(cleanedStr);
    }
}

// Initialize queue
const pretextQueue = new Queue('pretext-generation', {
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
    },
    removeOnSuccess: true,
    removeOnFailure: false,
    storeSuccessfulJobs: false
});

let db;
let io;

// Initialize queue processor
const initPretextQueueProcessor = (database, socketIo) => {
    db = database;
    io = socketIo;

    pretextQueue.process(3, async (job) => {
        const { email, promptId } = job.data;

        try {
            io.emit('reconUpdate', {
                message: `Starting pretext generation for ${email} using prompt ID ${promptId}...`
            });

            // Get target information
            const target = await db.get('SELECT * FROM Target WHERE email = ?', [email]);
            if (!target) {
                throw new Error(`Target not found: ${email}`);
            }

            // Check if target status is complete
            if (target.status !== 'complete') {
                throw new Error(`Target ${email} status is ${target.status}, not complete`);
            }

            // Get the prompt from the database
            const prompt = await db.get('SELECT * FROM Prompt WHERE id = ?', [promptId]);
            if (!prompt) {
                throw new Error(`Prompt not found: ${promptId}`);
            }

            // Generate pretext using Claude
            const pretext = await generatePretext(target, prompt);

            // Parse the pretext as JSON
            let pretextData;
            try {
                // If pretext is already an object (from our modified generatePretext function)
                if (typeof pretext === 'object' && pretext !== null) {
                    pretextData = pretext;
                } else {
                    // Otherwise try to parse it or extract JSON from it
                    try {
                        pretextData = JSON.parse(pretext);
                    } catch (error) {
                        console.log(`Direct JSON parsing failed, attempting to extract JSON from text...`);
                        console.log(`Raw pretext: ${pretext}`);
                        pretextData = extractJsonFromText(pretext);
                    }
                }
            } catch (error) {
                console.error(`Error processing pretext: ${error.message}`);
                console.log(`Raw pretext: ${pretext}`);
                throw new Error(`Failed to process pretext: ${error.message}`);
            }

            // Insert the pretext into the database
            const result = await db.run(
                `INSERT INTO Pretext (
                    target_email, 
                    prompt_id, 
                    prompt_text, 
                    subject, 
                    body, 
                    link,
                    status
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    email,
                    promptId,
                    `System Prompt:\n${prompt.system_prompt}\n\nPrompt:\n${prompt.template}`,
                    pretextData.subject,
                    pretextData.body,
                    pretextData.resource_description || '', // Store resource description in link field for now
                    'draft'
                ]
            );

            // Get the inserted pretext ID
            const pretextId = result.lastID;

            // Emit event to notify clients
            io.emit('pretextGenerated', {
                email: email,
                pretextId: pretextId,
                subject: pretextData.subject
            });

            return {
                success: true,
                email,
                pretextId,
                subject: pretextData.subject,
                body: pretextData.body
            };
        } catch (error) {
            io.emit('reconUpdate', {
                message: `Error generating pretext for ${email}: ${error.message}`
            });

            throw error;
        }
    });

    pretextQueue.on('failed', (job, err) => {
        console.error(`Pretext generation job ${job.id} failed: ${err.message}`);
    });

    console.log('Pretext generation queue processor initialized');
};

// Function to generate pretext using Claude
async function generatePretext(target, prompt) {
    try {
        console.log(`Starting pretext generation for ${target.email}...`);

        // Check if Anthropic client is properly initialized
        if (!anthropicClient || typeof anthropicClient.messages !== 'object' || typeof anthropicClient.messages.create !== 'function') {
            throw new Error('Anthropic client not properly initialized. Check your API key.');
        }

        // Replace placeholders in the prompt template
        let promptText = prompt.template.replace('{{target_profile}}', target.profile || 'No profile available');

        // Construct system prompt with dos and don'ts
        let systemPrompt = prompt.system_prompt || "You are an expert at writing highly personalized emails. ";

        // Add explicit instruction to return JSON only
        systemPrompt += "\n\nIMPORTANT: Respond with ONLY a JSON object. Do not include any explanatory text before or after the JSON.";

        if (prompt.dos) {
            systemPrompt += "\n\nDO:\n" + prompt.dos;
        }

        if (prompt.donts) {
            systemPrompt += "\n\nDON'T:\n" + prompt.donts;
        }

        console.log(`System prompt: ${systemPrompt}`);
        console.log(`Prompt text: ${promptText}`);

        // Send request to Claude API
        const response = await anthropicClient.messages.create({
            model: "claude-3-opus-20240229",
            system: systemPrompt,
            messages: [{ role: "user", content: promptText }],
            temperature: 0.7,
            max_tokens: 4000
        });

        // Extract the response text
        let responseText = '';
        if (response.content && response.content.length > 0 && response.content[0].type === 'text') {
            responseText = response.content[0].text;
        } else {
            throw new Error('No valid response received from Claude');
        }

        // Try to parse the response as JSON first
        try {
            return JSON.parse(responseText);
        } catch (error) {
            // If direct parsing fails, try to extract JSON from the text
            console.log('Direct JSON parsing failed, attempting to extract JSON from text...');
            return extractJsonFromText(responseText);
        }
    } catch (error) {
        console.error(`Error generating pretext with Claude: ${error.message}`);
        throw new Error(`Claude API error: ${error.message}`);
    }
}

// Queue a job to generate pretext for a target
const queuePretextGeneration = async (email, promptId) => {
    try {
        // Create a new job
        const job = pretextQueue.createJob({ email, promptId });

        // Queue the job and get the job ID
        const jobId = await job.save();

        return { success: true, message: `Pretext generation queued for ${email}`, jobId };
    } catch (error) {
        console.error(`Error queuing pretext generation for ${email}:`, error);
        return { success: false, error: error.message };
    }
};

// Queue pretext generation for multiple targets
const queuePretextsForTargets = async (targetEmails, promptId, domainName) => {
    try {
        let count = 0;

        for (const email of targetEmails) {
            // Create a new job for each target
            const job = pretextQueue.createJob({ email, promptId });
            await job.save();
            count++;
        }

        return {
            success: true,
            message: `Pretext generation queued for ${count} targets in ${domainName}`,
            count
        };
    } catch (error) {
        console.error(`Error queuing pretext generation for targets:`, error);
        return { success: false, error: error.message };
    }
};

module.exports = {
    initPretextQueueProcessor,
    queuePretextGeneration,
    queuePretextsForTargets
};