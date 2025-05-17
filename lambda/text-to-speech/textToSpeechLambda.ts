import { LanguageCode, PollyClient, SynthesizeSpeechCommand, Engine, OutputFormat, VoiceId, TextType } from '@aws-sdk/client-polly';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

// TODO 
// Polly only supports upto 3000 characters per request so chunking is needed


// Helper function to convert stream to buffer
const streamToBuffer = async (stream: Readable): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        const chunks: any[] = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
};

// Initialize with explicit region to avoid configuration issues
const polly = new PollyClient({ region: 'us-east-1' });
const s3client = new S3Client({ region: process.env.AWS_REGION });

export const handler = async (event: any) => {
    try {
        console.log('Event received:', JSON.stringify(event, null, 2));

        // Parse the request body if it exists
        const body = event.body ? JSON.parse(event.body) : {};
        const { scriptId, script, userID } = body;
        if (!userID) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'userID is required',
                }),
            };
        }


        if (!scriptId) {
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Credentials': true
                },
                body: JSON.stringify({ message: 'scriptId is required' })
            };
        }
        // date from unix timestamp
        const date = new Date();
        const currentDate = date.toISOString().split('T')[0];


        // Validate script content
        if (!script || script.trim().length === 0) {
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Credentials': true
                },
                body: JSON.stringify({ message: 'Script content is empty' })
            };
        }

        // Limit script size if needed (Polly has limits)
        const maxChars = 3000; // Polly can handle around 3000 characters per request
        const truncatedScript = script.length > maxChars ? script.substring(0, maxChars) : script;

        console.log('Sending to Polly, script length:', truncatedScript.length);

        // invoke AWS Polly to convert text to speech
        const params = {
            Engine: Engine.GENERATIVE,
            Text: truncatedScript,
            LanguageCode: LanguageCode.en_US,
            VoiceId: VoiceId.Danielle,
            TextType: TextType.SSML,
            OutputFormat: OutputFormat.MP3,
            SampleRate: '44100',
        };

        try {
            // Create a command object and send it
            const synthesizeCommand = new SynthesizeSpeechCommand(params);
            const pollyResponse = await polly.send(synthesizeCommand);

            if (!pollyResponse.AudioStream) {
                throw new Error('No audio stream returned from Polly');
            }

            // Convert stream to buffer
            const audioBuffer = await streamToBuffer(pollyResponse.AudioStream as Readable);

            // Save the audio buffer to S3
            const speechAudioPath = `${userID}/${currentDate}/${scriptId}.mp3`;
            const putObjectCommand = new PutObjectCommand({
                Bucket: process.env.CREATION_BUCKET_NAME,
                Key: speechAudioPath,
                Body: audioBuffer,
                ContentType: 'audio/mpeg',

            });

            await s3client.send(putObjectCommand);
            console.log('Audio saved to S3:', speechAudioPath);

            // Return success response
            return {
                statusCode: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Credentials': true
                },
                body: JSON.stringify({
                    message: 'Text-to-speech conversion successful',
                    scriptId,
                    speechAudioPath: speechAudioPath,
                    userID,
                })
            };
        }
        catch (error) {
            console.error('Error synthesizing speech:', error);
            return {
                statusCode: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Credentials': true
                },
                body: JSON.stringify({ message: 'Error synthesizing speech', error: error.message })
            };
        }
    } catch (error) {
        console.error('Error processing request:', error);
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': true
            },
            body: JSON.stringify({ message: 'Internal server error', error: error.message })
        };
    }
};
