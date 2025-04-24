// lib/profileQueue.js
const Queue = require('bee-queue');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

// Initialize Anthropic client
const anthropicClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || 'dummy-key',
});

// Initialize queue
const profileQueue = new Queue('profile-generation', {
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
const initProfileQueueProcessor = (database, socketIo) => {
    db = database;
    io = socketIo;

    profileQueue.process(3, async (job) => {
        const { email } = job.data;

        try {
            io.emit('reconUpdate', {
                message: `Starting profile generation for ${email}...`
            });

            // Get target information
            const target = await db.get('SELECT * FROM Target WHERE email = ?', [email]);
            if (!target) {
                throw new Error(`Target not found: ${email}`);
            }

            // Check if target status is enriched
            if (target.status !== 'enriched') {
                throw new Error(`Target ${email} status is ${target.status}, not enriched`);
            }

            // Get all sources for this target
            const sources = await db.all(`
                SELECT sd.* 
                FROM SourceData sd
                JOIN TargetSourceMap tsm ON sd.id = tsm.source_id
                WHERE tsm.target_email = ?
                AND sd.status = 'mined'
            `, [email]);

            if (sources.length === 0) {
                throw new Error(`No mined sources found for ${email}`);
            }

            // Generate profile using Claude
            const profile = await generateProfile(target, sources, io);

            // Update target with profile
            await db.run(
                'UPDATE Target SET profile = ? WHERE email = ?',
                [profile, email]
            );

            // Update target status to 'complete' after successful profile generation
            await updateTargetStatusToComplete(email);

            // Emit event to notify clients
            io.emit('profileGenerated', {
                email: email,
                profile: profile
            });

            return { success: true, email, profile };
        } catch (error) {
            io.emit('reconUpdate', {
                message: `Error generating profile for ${email}: ${error.message}`
            });

            throw error;
        }
    });

    profileQueue.on('failed', (job, err) => {
        console.error(`Job ${job.id} failed: ${err.message}`);
    });

    console.log('Profile generation queue processor initialized');
};

// Update target status to 'complete' after successful profile generation
async function updateTargetStatusToComplete(email) {
    try {
        // Get domain name for the target for notification purposes
        const target = await db.get('SELECT domain_name FROM Target WHERE email = ?', [email]);
        if (!target) {
            throw new Error(`Target not found: ${email}`);
        }

        // Update target status to 'complete'
        await db.run(
            'UPDATE Target SET status = ? WHERE email = ?',
            ['complete', email]
        );

        // Notify clients about the target status update
        io.emit('targetStatusUpdated', {
            email: email,
            status: 'complete',
            message: `Target ${email} has been marked as complete`,
            domain: target.domain_name
        });

        console.log(`Target ${email} has been updated to 'complete' status`);
        return true;
    } catch (error) {
        console.error(`Error updating target status for ${email}:`, error.message);
        return false;
    }
}

// Queue a job to generate profile for a target
const queueProfileGeneration = async (email) => {
    try {
        // Create a new job
        const job = profileQueue.createJob({ email });

        // Queue the job and get the job ID
        const jobId = await job.save();

        return { success: true, message: `Profile generation queued for ${email}`, jobId };
    } catch (error) {
        console.error(`Error queuing profile generation for ${email}:`, error);
        return { success: false, error: error.message };
    }
};

// Queue profile generation for multiple targets
const queueProfilesForTargets = async (targetEmails, domainName) => {
    try {
        let count = 0;

        for (const email of targetEmails) {
            // Create a new job for each target
            const job = profileQueue.createJob({ email });
            await job.save();
            count++;
        }

        return {
            success: true,
            message: `Profile generation queued for ${count} targets in ${domainName}`,
            count
        };
    } catch (error) {
        console.error(`Error queuing profile generation for targets:`, error);
        return { success: false, error: error.message };
    }
};

// Function to generate profile using Claude
async function generateProfile(target, sources, io) {
    try {
        console.log(`Starting profile generation for ${target.email}...`);

        // Check if Anthropic client is properly initialized
        if (!anthropicClient || typeof anthropicClient.messages !== 'object' || typeof anthropicClient.messages.create !== 'function') {
            throw new Error('Anthropic client not properly initialized. Check your API key.');
        }

        // Prepare source data for Claude - similar to the Python implementation
        const sourceData = sources.map((source, index) => {
            let parsedData;
            if (typeof source.data === 'string') {
                try {
                    parsedData = JSON.parse(source.data);
                } catch (e) {
                    // If we can't parse it as JSON, just use it as is
                    parsedData = { content: source.data };
                }
            } else {
                parsedData = source.data || { content: 'No data available' };
            }

            return {
                index: index + 1,
                id: source.id,
                url: source.url,
                domain: source.source_domain_name,
                method: source.discovery_method,
                content: parsedData && parsedData.content ? parsedData.content : 'No content available'
            };
        });

        console.log(`Prepared ${sourceData.length} sources for profile generation`);
        io.emit('reconUpdate', {
            message: `Processing ${sourceData.length} sources for ${target.email}...`
        });

        // First, try the direct approach for faster results (no tools)
        try {
            console.log(`Attempting direct profile generation for ${target.email}...`);

            // Build a rich prompt with all source content directly included
            let directPrompt = `Generate a professional profile for ${target.email} based on the following sources:\n\n`;

            for (const source of sourceData) {
                directPrompt += `SOURCE ${source.index}: ${source.url}\n`;
                directPrompt += `CONTENT: ${typeof source.content === 'string' ?
                    source.content.substring(0, 5000) :
                    JSON.stringify(source.content).substring(0, 5000)}\n\n`;
            }

            directPrompt += `\nCreate a structured profile with sections for basic information, professional roles, education, skills, and connections. Add [Source: URL] after each claim.`;

            // Keep prompt within Claude's maximum context
            if (directPrompt.length > 100000) {
                directPrompt = directPrompt.substring(0, 100000);
            }

            const directResponse = await anthropicClient.messages.create({
                model: "claude-3-opus-20240229",
                max_tokens: 4000,
                temperature: 0.2,
                system: "You are generating a professional profile for an individual based on the source data provided. Create a structured profile with name, email, professional roles, education, skills, and connections. Add [Source: URL] after each claim. Provide ONLY the final profile, no explanation of your process or thinking.",
                messages: [{ role: "user", content: directPrompt }]
            });

            console.log(`Direct profile generation completed with status: ${directResponse.stop_reason}`);

            if (directResponse.content && directResponse.content.length > 0 && directResponse.content[0].type === 'text') {
                return directResponse.content[0].text;
            }
        } catch (directError) {
            console.error(`Direct profile generation failed: ${directError.message}`);
            io.emit('reconUpdate', {
                message: `Direct approach failed, trying alternative method for ${target.email}...`
            });
            // Fall through to the tool-based approach
        }

        // If direct approach failed, try the tool-based approach with a max iteration limit
        console.log(`Trying tool-based approach for ${target.email}...`);

        const systemPrompt = `Generate a profile based on these sources WITHOUT going into great detail on the content. Include these sections:
- Name and email
- Professional experience
- Education and skills
- Connections

Add [Source: URL] after each claim. Keep the profile concise.

If the sources don't contain enough information for a complete profile, create a simple profile with the available information.`;

        // Initial user message
        const userMessage = `Generate a profile for ${target.email} based on ${sourceData.length} sources. I'll provide content through the read_source_data tool.`;

        // Define the tool to read source data
        const readSourceDataTool = {
            name: "read_source_data",
            description: "Reads content of a source by index (1-based)",
            input_schema: {
                type: "object",
                properties: {
                    sourceIndex: {
                        type: "number",
                        description: "Index of the source (1 to " + sourceData.length + ")"
                    }
                },
                required: ["sourceIndex"]
            }
        };

        const tools = [readSourceDataTool];

        // Conversation history
        let messages = [{ role: "user", content: userMessage }];
        let maxIterations = sourceData.length * 2 + 3; // Allow for each source to be read, plus a few extra iterations
        let iterations = 0;

        while (iterations < maxIterations) {
            iterations++;

            console.log(`Iteration ${iterations}/${maxIterations}: Sending request with ${messages.length} messages`);

            // Send request to Claude API
            const response = await anthropicClient.messages.create({
                model: "claude-3-opus-20240229",
                system: systemPrompt,
                messages: messages,
                tools: tools,
                temperature: 0.2,
                max_tokens: 4000
            });

            console.log(`Response received, stop_reason: ${response.stop_reason}, content type: ${response.content[0].type}`);

            // If we get text content, we're done
            if (response.content[0].type === 'text') {
                console.log(`Profile generation complete, text response received`);
                return response.content[0].text;
            }

            // Process tool calls
            const toolCalls = response.content[0].tool_calls;
            console.log(`Processing ${toolCalls ? toolCalls.length : 0} tool calls`);

            // Add assistant's message with tool calls
            messages.push({
                role: "assistant",
                content: response.content
            });

            // If we have tool calls, process them
            if (toolCalls && toolCalls.length > 0) {
                for (const call of toolCalls) {
                    if (call.name === "read_source_data") {
                        const sourceIndex = call.input.sourceIndex;
                        console.log(`Processing tool call for source ${sourceIndex}`);

                        const source = sourceData.find(s => s.index === sourceIndex);

                        if (source) {
                            io.emit('reconUpdate', {
                                message: `Reading source ${sourceIndex}/${sourceData.length} for ${target.email}...`
                            });

                            // Add tool response
                            messages.push({
                                role: "tool",
                                tool_call_id: call.id,
                                name: "read_source_data",
                                content: `Content from ${source.url}:\n\n${typeof source.content === 'string' ?
                                    source.content.substring(0, 8000) :
                                    JSON.stringify(source.content).substring(0, 8000)}`
                            });

                            console.log(`Added content for source ${sourceIndex}`);
                        } else {
                            console.log(`Source index ${sourceIndex} not found, valid range is 1-${sourceData.length}`);

                            messages.push({
                                role: "tool",
                                tool_call_id: call.id,
                                name: "read_source_data",
                                content: `Error: Source index ${sourceIndex} is out of range. Valid range is 1-${sourceData.length}.`
                            });
                        }
                    }
                }
            } else {
                // If we don't have tool calls but also don't have text, something weird happened
                console.log(`No tool calls in response, but not a text response either. Breaking loop.`);
                break;
            }

            // After all sources have been read, try to force a final response
            const allSourcesRead = sourceData.every(source =>
                messages.some(msg =>
                    msg.role === "tool" &&
                    msg.name === "read_source_data" &&
                    msg.content.includes(source.url)
                )
            );

            if (allSourcesRead && iterations > sourceData.length) {
                console.log(`All sources appear to have been read, requesting final profile`);

                messages.push({
                    role: "user",
                    content: "You have now read all the available sources. Please provide the final profile based on this information."
                });
            }
        }

        console.log(`Reached max iterations (${maxIterations}). Generating fallback profile.`);

        // If we've reached max iterations without getting a profile, try one last direct approach
        try {
            const finalAttempt = await anthropicClient.messages.create({
                model: "claude-3-opus-20240229",
                messages: [
                    {
                        role: "user",
                        content: `Generate a brief professional profile for ${target.email} based on these sources: ${sourceData.map(s => s.url).join(", ")}. Include whatever information you can find from these sources.`
                    }
                ],
                max_tokens: 2000,
                temperature: 0.2
            });

            if (finalAttempt.content && finalAttempt.content.length > 0 && finalAttempt.content[0].type === 'text') {
                return finalAttempt.content[0].text;
            }
        } catch (finalError) {
            console.error(`Final attempt failed: ${finalError.message}`);
        }

        // If all else fails, create a minimal profile
        return `Profile for ${target.email}\n\nBased on sources: ${sourceData.map(s => s.url).join(", ")}\n\nUnable to generate a complete profile from the available sources. The collected data may not contain sufficient personal or professional information.`;
    } catch (error) {
        console.error(`Error generating profile with Claude: ${error.message}`);
        throw new Error(`Claude API error: ${error.message}`);
    }
}

module.exports = {
    initProfileQueueProcessor,
    queueProfileGeneration,
    queueProfilesForTargets
};