import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

// Initialize the S3 client
const s3Client = new S3Client({});

// Define the Lambda handler function
export const handler = async (event: any) => {
    try {
        console.log('Event received:', JSON.stringify(event, null, 2));


        // Get meditation parameters from the event
        const { duration = 10, theme = 'relaxation', voiceType = 'calm' } = event;

        // Generate a unique ID for this meditation script
        const scriptId = randomUUID();

        // Generate a simple meditation script based on parameters
        // This is where you would integrate with an AI service or use templates
        const script = generateMeditationScript(duration, theme, voiceType);

        // Save the script to S3
        const bucketName = process.env.SCRIPT_BUCKET_NAME;
        if (!bucketName) {
            throw new Error('SCRIPT_BUCKET_NAME environment variable is not set');
        }

        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: `scripts/${scriptId}.json`,
            Body: JSON.stringify({
                id: scriptId,
                timestamp: Date.now(),
                duration,
                theme,
                voiceType,
                script,
            }),
            ContentType: 'application/json',
        }));

        // Return success response
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Meditation script generated successfully',
                scriptId: scriptId,
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

// Simple function to generate a basic meditation script
function generateMeditationScript(duration: number, theme: string, voiceType: string): string[] {
    // Basic script template // replace with AI generation logic
    const introLines = [
        "Welcome to your meditation session.",
        `This will be a ${duration}-minute ${theme} meditation.`,
        "Find a comfortable position and close your eyes.",
        "Take a deep breath in... and out.",
    ];

    const bodyLines = [
        "Focus on your breath as it flows in and out.",
        "Let go of any tension in your body.",
        "Allow your thoughts to come and go without judgment.",
        `Feel a sense of ${theme === 'relaxation' ? 'calm spreading through your body' : 'energy filling you with vitality'}.`,
    ];

    const closingLines = [
        "Begin to deepen your breath.",
        "Slowly become aware of your surroundings.",
        "When you're ready, gently open your eyes.",
        "Thank you for taking this time for yourself.",
    ];

    return [...introLines, ...bodyLines, ...closingLines];
}