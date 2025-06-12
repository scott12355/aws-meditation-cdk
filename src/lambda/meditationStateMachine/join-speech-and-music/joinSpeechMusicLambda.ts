import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';


const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
export const handler = async (event: any) => {
    try {
        console.log('Event received:', JSON.stringify(event, null, 2));
        const body = event.body ? JSON.parse(event.body) : {};
        const { sessionID, userID, speechAudioPath } = body;
        console.log('sessionID:', sessionID);
        console.log('userID:', userID);
        if (!userID) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'userID is required',
                }),
            };
        }
        if (!sessionID) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'sessionID is required',
                }),
            };
        }
        if (!speechAudioPath) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'speechAudioPath is required',
                    userID: event.userID,
                    sessionID: event.sessionID,
                }),
            };
        }


        // Get the speech file from S3
        const meditationBucket = process.env.USER_SESSION_BUCKET_NAME;
        if (!meditationBucket) {
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
                Bucket: meditationBucket,
                Key: speechAudioPath
            }));
        }
        catch (error) {
            console.error('Error downloading speech audio:', error);
            return createErrorResponse(500, 'Error downloading speech audio', error, userID, sessionID);
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
        const albumArtPath = path.join(musicDir, 'album-art.jpg');
        const outputFilePath = path.join(outputDir, 'final-meditation.mp3');

        // Write speech file to temp directory
        fs.writeFileSync(speechFilePath, await streamToBuffer(speechData.Body));


        // Get actual duration
        const speechDuration = await getAudioDuration(speechFilePath);

        // Select and download music track based on actual duration
        const selectedMusicTrack = selectRandomMusicTrack(speechDuration);
        if (!selectedMusicTrack) {
            return createErrorResponse(400, 'No suitable music track found for speech duration', null, userID, sessionID);
        }

        let musicData;
        try {
            musicData = await s3Client.send(new GetObjectCommand({
                Bucket: musicBucket,
                Key: selectedMusicTrack
            }));
        }
        catch (error) {
            console.error('Error downloading music audio:', error);
            return createErrorResponse(500, 'Error downloading music audio', error, userID, sessionID);
        }

        fs.writeFileSync(musicFilePath, await streamToBuffer(musicData.Body));

        // Download album art (optional)
        let albumArtFilePath: string | undefined;
        try {
            const albumArtData = await s3Client.send(new GetObjectCommand({
                Bucket: musicBucket,
                Key: 'cover_art.jpg' // Store your album art in the music bucket
            }));
            fs.writeFileSync(albumArtPath, await streamToBuffer(albumArtData.Body));
            albumArtFilePath = albumArtPath;
            console.log('Album art downloaded successfully:', albumArtFilePath);
        } catch (error) {
            console.warn('Album art not found, proceeding without it:', error);
        }
        // Use ffmpeg to mix audio
        await mixAudio(speechFilePath, musicFilePath, outputFilePath, albumArtFilePath);

        // Upload final audio to meditation audio bucket
        const currentDate = new Date().toISOString().split('T')[0];
        const finalAudioKey = `${userID}/${currentDate}/${sessionID}.mp3`;

        await s3Client.send(new PutObjectCommand({
            Bucket: meditationBucket,
            Key: finalAudioKey,
            Body: fs.readFileSync(outputFilePath),
            ContentType: 'audio/mpeg',
        }));

        // update the session in DynamoDB
        const tableName = process.env.MEDITATION_TABLE_NAME;

        const params = {
            TableName: tableName,
            Key: {
                sessionID: { S: sessionID },
            },
            UpdateExpression: 'set #status = :status, #audioPath = :audioPath',
            ExpressionAttributeNames: {
                '#status': 'status',
                '#audioPath': 'audioPath',
            },
            ExpressionAttributeValues: {
                ':status': { S: 'COMPLETED' },
                ':audioPath': { S: finalAudioKey },
            },
        };
        try {
            await dynamoClient.send(new UpdateItemCommand(params));
        }
        catch (error) {
            console.error('Error updating DynamoDB:', error);
            return createErrorResponse(500, 'Error updating DynamoDB', error, userID, sessionID);
        }

        console.log(`Updated meditation session in DynamoDB: ${sessionID}`);


        // Clean up temp files/directories to avoid wasted Lambda time/disk
        try {
            fs.rmSync(speechDir, { recursive: true, force: true });
            fs.rmSync(musicDir, { recursive: true, force: true });
            fs.rmSync(outputDir, { recursive: true, force: true });
        } catch (cleanupErr) {
            console.warn('Error cleaning up temp files:', cleanupErr);
        }



        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Meditation audio created successfully',
                meditationAudioKey: finalAudioKey,
            }),
        };
    } catch (error) {
        console.error('Error:', error);
        return createErrorResponse(500, 'Error joining speech and music', error, event.userID, event.sessionID);
    }
};

// Helper function to create consistent error responses
function createErrorResponse(statusCode: number, message: string, error: any, userID?: string, sessionID?: string) {
    return {
        statusCode,
        body: JSON.stringify({
            message,
            error: error instanceof Error ? error.message : 'An unknown error occurred',
            userID,
            sessionID,
        }),
    };
}

// Helper function to convert stream to buffer
async function streamToBuffer(stream: any): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

// Mix speech and background music using ffmpeg with album art
async function mixAudio(speechPath: string, musicPath: string, outputPath: string, albumArtPath?: string): Promise<void> {
    // Set PATH to include the Lambda layer bin directory
    process.env.PATH = `${process.env.PATH}:/opt/bin`;

    return new Promise((resolve, reject) => {
        const ffmpegArgs = [
            '-i', speechPath,
            '-i', musicPath,
        ];

        // Add album art if provided
        if (albumArtPath) {
            ffmpegArgs.push('-i', albumArtPath);
        }

        // Build filter complex
        let filterComplex = '[1:a]volume=0.5[music];[0:a][music]amix=inputs=2:duration=longest[mixed]';

        ffmpegArgs.push('-filter_complex', filterComplex);

        // Add mapping for album art if provided
        if (albumArtPath) {
            ffmpegArgs.push(
                '-map', '[mixed]',  // Map the mixed audio output
                '-map', '2:v',      // Map video (image) from album art (third input)
                '-c:v', 'mjpeg',    // Use mjpeg codec for cover art
                '-disposition:v:0', 'attached_pic' // Mark as album art
            );
        } else {
            ffmpegArgs.push('-map', '[mixed]'); // Just map the mixed audio
        }

        ffmpegArgs.push(
            '-c:a', 'libmp3lame',
            '-q:a', '4',
            '-y', // Overwrite output file
            outputPath
        );

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);

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

        ffmpeg.on('error', (error) => {
            reject(new Error(`ffmpeg spawn error: ${error.message}`));
        });
    });
}

// function to select a random music track based on the length of the speech
function selectRandomMusicTrack(speechLength: number): string | null {
    const musicTracks = [
        { path: 'backing-track-1.mp3', duration: 300 },
        { path: 'backing-track-2.mp3', duration: 300 },
        { path: 'backing-track-3.mp3', duration: 480 },
        { path: 'backing-track-3.mp3', duration: 600 },
    ];

    // Filter tracks that are longer than the speech
    const suitableTracks = musicTracks.filter(track => track.duration > speechLength);

    if (suitableTracks.length === 0) {
        console.warn(`No suitable music tracks found for speech duration: ${speechLength}s`);
        return null;
    }

    // Select a random track from the suitable ones
    const randomIndex = Math.floor(Math.random() * suitableTracks.length);
    return suitableTracks[randomIndex].path;
}

// Get audio duration using ffprobe
async function getAudioDuration(filePath: string): Promise<number> {
    // Set PATH to include the Lambda layer bin directory
    process.env.PATH = `${process.env.PATH}:/opt/bin`;

    return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'quiet',
            '-show_entries', 'format=duration',
            '-of', 'csv=p=0',
            filePath
        ]);

        let duration = '';
        let errorOutput = '';

        ffprobe.stdout.on('data', (data) => {
            duration += data.toString();
        });

        ffprobe.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        ffprobe.on('error', (error) => {
            if (error.code === 'ENOENT') {
                reject(new Error('ffprobe not found. Ensure ffmpeg layer is properly configured.'));
            } else {
                reject(new Error(`ffprobe spawn error: ${error.message}`));
            }
        });

        ffprobe.on('close', (code) => {
            if (code === 0) {
                const parsedDuration = parseFloat(duration.trim());
                if (isNaN(parsedDuration)) {
                    reject(new Error(`Invalid duration returned: ${duration.trim()}`));
                } else {
                    resolve(parsedDuration);
                }
            } else {
                reject(new Error(`ffprobe failed with code ${code}. Error: ${errorOutput}`));
            }
        });
    });
}