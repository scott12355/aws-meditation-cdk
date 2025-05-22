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

        const { userID, sessionID } = event;
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
        const systemPrompt = `Generate a meditation script using valid SSML for AWS Polly.
Use only tags that are supported by AWS Polly: <speak>, <prosody>, and <break>.
Do not use unsupported tags like <p>, <s>, <audio>, <voice>, or any custom or non-standard tags.
Structure the script with calm pacing, using <break> tags where natural pauses would occur.
Wrap the entire script in a <speak> tag.
Use <prosody> to gently slow down the rate. Do not use <prosody> to change the pitch or volume.
Start with a 5 second pause.
Output only the SSML code — no explanations or titles.`;
        // Generate a unique ID for this meditation script
        const modelInput = {
            modelId: "amazon.nova-pro-v1:0",
            contentType: "application/json",
            accept: "application/json",
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
