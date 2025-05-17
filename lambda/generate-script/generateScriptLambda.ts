import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';

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

        const { userID } = event;
        if (!userID) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'userID is required',
                }),
            };
        }


        // date from unix timestamp
        const date = new Date();
        const currentDate = date.toISOString().split('T')[0];
        const systemPrompt = `Generate a meditation script that will then be put through a text to speech process. Use SSML that will work with AWS Polly. No need for any titles or section headers. Only output the script in a valid SSML format. Be use to only use SSML tags supported by AWS Polly.`;
        // Generate a unique ID for this meditation script
        const scriptId = randomUUID();
        const modelInput = {
            "modelId": "anthropic.claude-3-5-sonnet-20240620-v1:0",
            "contentType": "application/json",
            "accept": "application/json",
            "body": JSON.stringify({
                "anthropic_version": "bedrock-2023-05-31",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": systemPrompt
                            }
                        ]
                    }
                ],
                "max_tokens": 1000
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

                // Fix response parsing for Claude 3.5 Sonnet structure
                const { text } = responseJson.content[0];
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
            Key: `${userID}/${currentDate}/${scriptId}.json`,
            Body: JSON.stringify({
                id: scriptId,
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
                scriptId: scriptId,
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
            }),
        };
    }
};

const cleanScript = (input: string): string => {
    let cleanedText = input;

    // Remove all markdown code block syntax (```xml, ```ssml, or ```) anywhere in the string, including extra whitespace
    cleanedText = cleanedText.replace(/```(?:xml|ssml)?\s*|```/gi, '');

    // Replace newlines with spaces and normalize whitespace
    cleanedText = cleanedText.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

    return cleanedText;
}
