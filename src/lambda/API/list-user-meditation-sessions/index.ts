import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const client = new DynamoDBClient({});
const tableName = process.env.MEDITATION_TABLE!;

export const handler = async (event: any) => {
    console.log('Event received:', JSON.stringify(event));
    const userId = event.arguments?.userID;
    if (!userId) {
        console.error('userId is required');
        return { error: 'userId is required' };
    }


    // Query DynamoDB for sessions with the given userId
    const params = {
        TableName: tableName,
        IndexName: 'userID-index', // Assumes a GSI on userID exists
        KeyConditionExpression: 'userID = :uid',
        ExpressionAttributeValues: {
            ':uid': { S: userId },
        },
    };

    try {
        const data = await client.send(new QueryCommand(params));
        const sessions = data.Items ? data.Items.map(item => unmarshall(item)) : [];
        // console.log('Sessions found:', sessions);
        return sessions; // Directly return the array
    } catch (err: any) {
        console.error('Error querying DynamoDB:', err);
        return { error: err.message || 'An unknown error occurred' };
    }
};
