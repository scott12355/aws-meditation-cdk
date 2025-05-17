import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const s3Client = new S3Client({});

export const handler = async (event: any) => {
    try {
        console.log('Event received:', JSON.stringify(event, null, 2));
        const body = event.body ? JSON.parse(event.body) : {};
        const { scriptId, userID, speechAudioPath } = body;
        console.log('scriptId:', scriptId);
        console.log('userID:', userID);
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
                body: JSON.stringify({
                    message: 'scriptId is required',
                }),
            };
        }
        if (!speechAudioPath) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'speechAudioPath is required',
                }),
            };
        }


        // // Create temp directory for processing
        // const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meditation-'));
        // const speechFilePath = path.join(tempDir, 'speech.mp3');
        // const musicFilePath = path.join(tempDir, 'background.mp3');
        // const outputFilePath = path.join(tempDir, 'final-meditation.mp3');

        // Get the speech file from S3
        const MediationBucket = process.env.USER_SESSION_BUCKET_NAME;
        if (!MediationBucket) {
            throw new Error('USER_SESSION_BUCKET_NAME environment variable is not set');
        }
        const musicBucket = process.env.BACKING_TRACK_BUCKET_NAME;
        if (!musicBucket) {
            throw new Error('BACKING_TRACK_BUCKET_NAME environment variable is not set');
        }

        // Download speech file
        let speechData;
        try {
            speechData = await s3Client.send(new GetObjectCommand({
                Bucket: MediationBucket,
                Key: speechAudioPath
            }));
        }
        catch (error) {
            console.error('Error downloading speech audio:', error);
            throw new Error('Error downloading speech audio');
        }

        // Music file
        let musicData;
        try {
            musicData = await s3Client.send(new GetObjectCommand({
                Bucket: musicBucket,
                Key: 'backing-track-1.mp3' // Default music track
            }));
        }
        catch (error) {
            console.error('Error downloading music audio:', error);
            throw new Error('Error downloading music audio');
        }



        // Create temp file paths with proper directory creation
        const speechDir = path.join(os.tmpdir(), randomUUID());
        const musicDir = path.join(os.tmpdir(), randomUUID());
        const outputDir = path.join(os.tmpdir(), randomUUID());

        // Create directories if they don't exist
        fs.mkdirSync(speechDir, { recursive: true });
        fs.mkdirSync(musicDir, { recursive: true });
        fs.mkdirSync(outputDir, { recursive: true });

        const speechFilePath = path.join(speechDir, 'speech.mp3');
        const musicFilePath = path.join(musicDir, 'background.mp3');
        const outputFilePath = path.join(outputDir, 'final-meditation.mp3');
        // // Write files to temp directory
        fs.writeFileSync(speechFilePath, await streamToBuffer(speechData.Body));
        fs.writeFileSync(musicFilePath, await streamToBuffer(musicData.Body));

        // // Use ffmpeg to mix audio (this assumes ffmpeg is available in the Lambda environment)
        // // NOTE: For actual deployment, you would need to include ffmpeg in your Lambda package
        // // or use a Lambda layer with ffmpeg
        await mixAudio(speechFilePath, musicFilePath, outputFilePath);

        // // Upload final audio to meditation audio bucket

        // current date from unix timestamp
        const currentDate = new Date().toISOString().split('T')[0];

        const finalAudioKey = `${userID}/${currentDate}/${scriptId}.mp3`;
        await s3Client.send(new PutObjectCommand({
            Bucket: MediationBucket,
            Key: finalAudioKey,
            Body: fs.readFileSync(outputFilePath),
            ContentType: 'audio/mpeg',
        }));


        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Meditation audio created successfully',
                meditationAudioKey: finalAudioKey,
            }),
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'Error joining speech and music',
                error: error instanceof Error ? error.message : 'An unknown error occurred',
            }),
        };
    }
};

// Helper function to convert stream to buffer
async function streamToBuffer(stream: any): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

// Mix speech and background music using ffmpeg
async function mixAudio(speechPath: string, musicPath: string, outputPath: string): Promise<void> {
    // Set PATH to include the Lambda layer bin directory
    process.env.PATH = `${process.env.PATH}:/opt/bin`;

    return new Promise((resolve, reject) => {
        // This command overlays speech on music, reducing music volume to 20%
        const ffmpeg = spawn('ffmpeg', [
            '-i', speechPath,
            '-i', musicPath,
            '-filter_complex', '[1:a]volume=0.2[music];[0:a][music]amix=inputs=2:duration=longest',
            '-c:a', 'libmp3lame',
            '-q:a', '4',
            outputPath
        ]);

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg process exited with code ${code}`));
            }
        });

        ffmpeg.stderr.on('data', (data) => {
            console.log(`ffmpeg: ${data}`);
        });
    });
}