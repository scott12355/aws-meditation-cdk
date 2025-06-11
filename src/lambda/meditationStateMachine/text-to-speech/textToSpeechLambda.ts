import {
    LanguageCode,
    PollyClient,
    SynthesizeSpeechCommand,
    Engine,
    OutputFormat,
    VoiceId,
    TextType
} from '@aws-sdk/client-polly';
import {
    S3Client,
    PutObjectCommand
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

// Convert stream to buffer
const streamToBuffer = async (stream: Readable): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        const chunks: any[] = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
};

// Chunk long SSML text
const chunkSSMLText = (ssml: string, maxLength: number = 3000): string[] => {
    const chunks: string[] = [];
    
    // Remove existing speak tags if present
    const cleanedSSML = ssml.replace(/<\/?speak>/g, '').trim();
    
    // Check if prosody rate is already set
    const hasRateControl = /<prosody[^>]*rate\s*=/i.test(cleanedSSML);
    
    const speakWrapperLength = `<speak></speak>`.length; // 15 chars
    const prosodyWrapperLength = hasRateControl ? 0 : `<prosody rate="slow"></prosody>`.length; // 32 chars if we need to add it
    const safeMaxLength = maxLength - speakWrapperLength - prosodyWrapperLength;

    // Wrap content in prosody tags for slow speech if not already present
    const wrappedContent = hasRateControl ? cleanedSSML : `<prosody rate="slow">${cleanedSSML}</prosody>`;

    // If the entire content fits in one chunk, return it
    if (wrappedContent.length <= safeMaxLength) {
        chunks.push(`<speak>${wrappedContent}</speak>`);
        return chunks;
    }

    // Extract any opening tags that need to be preserved across chunks
    const openingTags: string[] = [];
    const prosodyMatch = wrappedContent.match(/<prosody[^>]*>/);
    if (prosodyMatch) {
        openingTags.push(prosodyMatch[0]);
    }

    // For content that needs splitting, split on break tags which are safe boundaries
    const breakPattern = /<break[^>]*\/>/g;
    const parts = wrappedContent.split(breakPattern);
    const breaks = wrappedContent.match(breakPattern) || [];

    let current = '';
    let breakIndex = 0;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const nextBreak = breaks[breakIndex] || '';
        const candidate = current + part + nextBreak;

        if (candidate.length > safeMaxLength && current.trim()) {
            // Close any open tags and add the current chunk
            let chunkContent = current.trim();
            if (openingTags.length > 0) {
                chunkContent += '</prosody>';
            }
            chunks.push(`<speak>${chunkContent}</speak>`);
            
            // Start new chunk with opening tags if needed
            current = '';
            if (openingTags.length > 0) {
                current = openingTags.join('') + ' ';
            }
            current += part + nextBreak;
        } else {
            current = candidate;
        }

        if (nextBreak) breakIndex++;
    }

    if (current.trim()) {
        let chunkContent = current.trim();
        // The last chunk should include any closing tags naturally from the original content
        chunks.push(`<speak>${chunkContent}</speak>`);
    }

    return chunks;
};



// Clients
const polly = new PollyClient({ region: 'us-east-1' });
const s3client = new S3Client({ region: process.env.AWS_REGION });

export const handler = async (event: any) => {
    try {
        console.log('Event received:', JSON.stringify(event, null, 2));

        const body = event.body ? JSON.parse(event.body) : {};
        let { sessionID, script, userID } = body;

        if (!userID || !sessionID) {
            return {
                statusCode: 400,
                headers: corsHeaders(),
                body: JSON.stringify({
                    message: !userID ? 'userID is required' : 'sessionID is required'
                })
            };
        }

        const currentDate = new Date().toISOString().split('T')[0];

        if (!script || script.trim().length === 0) {
            return {
                statusCode: 400,
                headers: corsHeaders(),
                body: JSON.stringify({ message: 'Script content is empty' })
            };
        }

        // Normalize script
        script = script.replace(/\"/g, '"').replace(/'/g, '&apos;');
        console.log('Normalized script:', script);

        // Split into chunks
        const chunks = chunkSSMLText(script);
        const audioBuffers: Buffer[] = [];

        console.log(`Synthesizing ${chunks.length} chunk(s)`);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            console.log(`Processing chunk ${i + 1} (length ${chunk.length})`);
            console.log(`Chunk content: ${chunk}`); // Added console log

            const synthesizeCommand = new SynthesizeSpeechCommand({
                Engine: Engine.GENERATIVE,
                Text: chunk,
                LanguageCode: LanguageCode.en_US,
                VoiceId: VoiceId.Danielle,
                TextType: TextType.SSML,
                OutputFormat: OutputFormat.MP3,
                SampleRate: '44100',
            });

            console.log('Sending SynthesizeSpeechCommand to Polly...'); // Added console log
            const pollyResponse = await polly.send(synthesizeCommand);
            console.log('Polly response received. ContentType:', pollyResponse.ContentType, 'RequestCharacters:', pollyResponse.RequestCharacters); // Fixed console log

            if (!pollyResponse.AudioStream) {
                console.error(`No audio stream returned for chunk ${i + 1}. ContentType:`, pollyResponse.ContentType); // Fixed console log
                throw new Error(`No audio stream returned for chunk ${i + 1}`);
            }

            console.log(`AudioStream found for chunk ${i + 1}. Converting to buffer...`); // Added console log
            const buffer = await streamToBuffer(pollyResponse.AudioStream as Readable);
            audioBuffers.push(buffer);
            console.log(`Buffer created for chunk ${i + 1}. Buffer length: ${buffer.length}`); // Added console log
        }

        // Merge all audio buffers
        const finalAudioBuffer = Buffer.concat(audioBuffers);

        // S3 upload
        const speechAudioPath = `${userID}/${currentDate}/${sessionID}.mp3`;
        await s3client.send(new PutObjectCommand({
            Bucket: process.env.CREATION_BUCKET_NAME,
            Key: speechAudioPath,
            Body: finalAudioBuffer,
            ContentType: 'audio/mpeg',
        }));

        console.log('Audio saved to S3:', speechAudioPath);

        return {
            statusCode: 200,
            headers: corsHeaders(),
            body: JSON.stringify({
                message: 'Text-to-speech conversion successful',
                sessionID,
                speechAudioPath,
                userID
            })
        };

    } catch (error: any) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers: corsHeaders(),
            body: JSON.stringify({
                message: 'Internal server error',
                error: error.message || 'Unknown error'
            })
        };
    }
};

function corsHeaders() {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true
    };
}
