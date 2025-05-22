import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PresignedPost } from 'aws-sdk/clients/s3';


const client = new DynamoDBClient({});
const s3Client = new S3Client({});

export const handler = async (event: any) => {
    console.log('Event received:', JSON.stringify(event));
    try {
        // get the sessionID from the event
        const { sessionID } = event.arguments;
        console.log('Session ID:', sessionID);

        if (!sessionID) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'sessionID is required',
                }),
            };
        }

        // get session details from DynamoDB
        let sessionData;
        console.log('Fetching session data from DynamoDB...');
        try {
            const tableName = process.env.MEDITATION_TABLE_NAME;
            console.log('Table name:', tableName);

            const getSessionParams = {
                TableName: tableName,
                Key: {
                    sessionID: { S: sessionID },
                },
            };
            console.log('DynamoDB params:', JSON.stringify(getSessionParams));

            sessionData = await client.send(new GetItemCommand(getSessionParams));
            console.log('Full session data response:', JSON.stringify(sessionData));

            if (!sessionData.Item) {
                console.log('No item found in response');
                return {
                    statusCode: 404,
                    body: JSON.stringify({
                        message: 'Meditation session not found',
                    }),
                };
            }

            console.log('Session item details:', JSON.stringify(sessionData.Item));
        } catch (error) {
            console.error('Error fetching session from DynamoDB:', error);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    message: 'Failed to retrieve meditation session',
                    error: error.message
                }),
            };
        }

        console.log('Fetching presigned URL for audio file...');
        // get object from S3
        try {
            const bucketName = process.env.MEDITATION_BUCKET;
            console.log('S3 bucket name:', bucketName);

            const objectKey = sessionData.Item?.audioPath?.S;
            console.log('Audio path:', objectKey);

            if (!objectKey) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        message: 'audioPath is required',
                    }),
                };
            }

            const getObjectParams = {
                Bucket: bucketName,
                Key: objectKey,
            };
            console.log('S3 params:', JSON.stringify(getObjectParams));

            const command = new GetObjectCommand(getObjectParams);
            const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // URL expires in 1 hour
            console.log('Presigned URL:', url);

            // Return all the required fields for the MeditationSessionAudioUrl type
            return {
                presignedUrl: url,
                userID: sessionData.Item.userID?.S || '',
                timestamp: sessionData.Item.timestamp?.S || sessionData.Item.timestamp?.N || '',
                status: sessionData.Item.status?.S || '',
                sessionID: sessionID,
                audioPath: objectKey
            };
        }
        catch (error) {
            console.error('Error generating presigned URL:', error);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    message: 'Failed to generate audio access URL',
                    error: error.message
                }),
            };
        }
    }
    catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'An error occurred',
                error: error.message
            }),
        };
    }
};