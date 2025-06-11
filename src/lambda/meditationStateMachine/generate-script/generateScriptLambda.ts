import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

// Initialize the S3 client
const s3Client = new S3Client({});
// Specify a region where the model is available
const bedrockClient = new BedrockRuntimeClient({
    region: "us-east-1" // Change this to a region where Nova Micro is available
});
// Define the Lambda handler function
export const handler = async (event: any) => {
    try {
        console.log('Starting meditation script generation...');

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

Do not use unsupported tags like <p>, <s>, <audio>, <voice>, <prosody>, or any custom or non-standard tags.

Structure the script with calm pacing, using <break> tags where natural pauses would occur.

Wrap the entire script in a <speak> tag.

Start with a 5-second pause using a <break> tag.

Output only the SSML code — no explanations or titles.

For example, the script should look like this:
<speak>
  <break time="5s"/>
  Welcome to your meditation session.
  <break time="1s"/>
  Find a comfortable position and gently close your eyes.
  <break time="1s"/>
  Take a deep breath in...
  <break time="2s"/>
  ...and exhale slowly.
  <break time="2s"/>
  Let go of any tension in your body.
  <break time="1s"/>
  Allow your mind to settle and focus on the present moment.
  <break time="2s"/>
  Continue to breathe naturally and observe your thoughts without judgment.
  <break time="2s"/>
  When you're ready, gently bring your awareness back to your surroundings.
  <break time="1s"/>
  Open your eyes and carry this sense of calm with you.
</speak>

The script should be between 4 and 10 minutes long, approximately 600 - 1500 words. Try to make each session unique.
Use the following session insights to personalize the script:
${typeof sessionInsights === 'string' ? sessionInsights : JSON.stringify(sessionInsights, null, 2)}

Each script should be unique and not repeat previous scripts. Do not use the same script for different sessions.
`;
        // Generate a unique ID for this meditation script
        const modelInput = {
            modelId: "amazon.nova-pro-v1:0",
            contentType: "application/json",
            accept: "application/json",
            maxTokens: 9000,
            temperature: 0.8,
            body: JSON.stringify({
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                text: systemPrompt // just "text", no "type"
                            }
                        ]
                    }
                ]
            })
        };


        let GeneratedScript: string | null = null;
        // Call the Bedrock API to generate a meditation script
        try {
            console.log('Attempting to invoke Bedrock model...');

            // Log the model input for debugging
            console.log('Model input:', JSON.stringify(modelInput, null, 2));

            const response = await bedrockClient.send(new InvokeModelCommand(modelInput));

            console.log('Response received from Bedrock');

            // Wrap the JSON parsing in a try/catch to debug potential format issues
            try {
                const responseJson = JSON.parse(new TextDecoder().decode(response.body));
                console.log('Response body parsed:', JSON.stringify(responseJson, null, 2));

                // Fix for Amazon Nova Pro response structure
                const text = responseJson.output.message.content[0].text;

                GeneratedScript = cleanScript(text);
                console.log('Bedrock model response text:', text);
            } catch (parseError) {
                console.error('Error parsing Bedrock response:', parseError);
                console.log('Raw response body:', new TextDecoder().decode(response.body));
                throw parseError;
            }
        } catch (error) {
            console.error('Error invoking Bedrock model:', error);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    message: 'Error invoking Bedrock model',
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
