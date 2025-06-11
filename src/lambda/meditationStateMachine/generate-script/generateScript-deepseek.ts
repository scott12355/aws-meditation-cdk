import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Initialize the S3 client
const s3Client = new S3Client({});
// Define the Lambda handler function
export const handler = async (event: any) => {
    try {
        console.log('Starting meditation script generation... DeepSeek V3');

        const { userID, sessionID, sessionInsights } = event;
        if (!userID || !sessionID) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'userID & sessionID are required',
                }),
            };
        }


        // date from unix timestamp
        const date = new Date();
        const currentDate = date.toISOString().split('T')[0];
        const systemPrompt = `Generate a meditation script using valid SSML for AWS Polly's generative voices.

Use only tags that are supported by AWS Polly's generative voices: <speak> and <break>.

Do not use unsupported tags like <p>, <s>, <audio>, <voice>, or any custom or non-standard tags.

Structure the script with calm pacing, using <break> tags where natural pauses would occur.
Use <prosody rate="slow"> for slower speech if needed.
Wrap the entire script in a <speak> tag.

Start with a 5-second pause using a <break> tag.

Output only the SSML code — no explanations or titles.

The script should be between 700 and 1400 words. Ensure sufficient content to meet this duration.
Incorporate detailed guidance, descriptive imagery, thematic sections (such as body scans, visualizations, and affirmations), and strategic pauses to enhance the meditative experience.
Try to make each session unique.
Use the following session insights to personalize the script:
${typeof sessionInsights === 'string' ? sessionInsights : JSON.stringify(sessionInsights, null, 2)}

Each script should be unique and not repeat previous scripts. Do not use the same script for different sessions.
Remember only output the SSML code, no explanations or titles.
`;

        let GeneratedScript: string | null = null;
        // Call the DeepSeek API to generate a meditation script
        try {
            console.log('Attempting to invoke DeepSeek API...');

            const deepSeekApiKey = process.env.DEEPSEEK_KEY;
            if (!deepSeekApiKey) {
                throw new Error('DEEPSEEK_KEY environment variable is not set');
            }

            const requestBody = {
                model: "deepseek-reasoner",
                messages: [
                    {
                        role: "user",
                        content: systemPrompt
                    }
                ],
                max_tokens: 8192,
                temperature: 0.8,
                top_p: 0.9,
                stream: false
            };

            // Log the request for debugging
            console.log('DeepSeek API request:', JSON.stringify(requestBody, null, 2));

            const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${deepSeekApiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('DeepSeek API error response:', errorText);
                throw new Error(`DeepSeek API request failed with status ${response.status}: ${errorText}`);
            }

            console.log('Response received from DeepSeek API');

            // Parse the response
            try {
                const responseJson = await response.json();
                console.log('Response body parsed:', JSON.stringify(responseJson, null, 2));

                // Extract the generated text from DeepSeek response structure
                const text = responseJson.choices?.[0]?.message?.content;

                if (!text) {
                    throw new Error('No content found in DeepSeek API response');
                }

                GeneratedScript = cleanScript(text);
                console.log('DeepSeek API response text:', text);
            } catch (parseError) {
                console.error('Error parsing DeepSeek response:', parseError);
                throw parseError;
            }
        } catch (error) {
            console.error('Error invoking DeepSeek API:', error);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    message: 'Error invoking DeepSeek API',
                    error: error instanceof Error ? error.message : 'An unknown error occurred',
                    userID,
                    sessionID,
                }),
            };
        }

        // Save the script to S3
        const bucketName = process.env.CREATION_BUCKET_NAME;
        if (!bucketName) {
            throw new Error('CREATION_BUCKET_NAME environment variable is not set');
        }

        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: `${userID}/${currentDate}/${sessionID}.json`,
            Body: JSON.stringify({
                id: sessionID,
                timestamp: Date.now(),
                script: GeneratedScript,
            }),
            ContentType: 'application/json',
        }));

        // Return success response
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Meditation script generated successfully',
                sessionID: sessionID,
                script: GeneratedScript,
                userID: userID,
            }),
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'Error generating meditation script',
                error: error instanceof Error ? error.message : 'An unknown error occurred',
                userID: event.userID,
                sessionID: event.sessionID,
            }),
        };
    }
};

const cleanScript = (input: string): string => {
    let cleanedText = input;

    // Remove all markdown code block syntax (```xml, ```ssml, or ```) anywhere in the string
    cleanedText = cleanedText.replace(/```(?:xml|ssml)?\s*|```/gi, '');

    // Preserve line breaks within SSML tags but ensure proper spacing
    cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

    // Make sure the script is wrapped in <speak> tags
    if (!cleanedText.includes('<speak>')) {
        cleanedText = `<speak>${cleanedText}</speak>`;
    }

    // Ensure proper spacing around SSML tags
    cleanedText = cleanedText.replace(/>\s+</g, '><');
    cleanedText = cleanedText.replace(/>\s+/g, '> ');
    cleanedText = cleanedText.replace(/\s+</g, ' <');

    return cleanedText;
}
