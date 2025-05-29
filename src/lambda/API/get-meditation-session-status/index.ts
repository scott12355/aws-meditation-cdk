import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({});

export const handler = async (event: any) => {
    console.log('Event received:', JSON.stringify(event));
    
    try {
        // Get the sessionID from the event
        const { sessionID } = event.arguments;
        console.log('Session ID:', sessionID);

        if (!sessionID) {
            return {
                status: 'FAILED',
                errorMessage: 'sessionID is required'
            };
        }

        // Get session details from DynamoDB
        console.log('Fetching session data from DynamoDB...');
        const tableName = process.env.MEDITATION_TABLE;
        console.log('Table name:', tableName);

        const getSessionParams = {
            TableName: tableName,
            Key: {
                sessionID: { S: sessionID },
            },
        };
        console.log('DynamoDB params:', JSON.stringify(getSessionParams));

        const sessionData = await client.send(new GetItemCommand(getSessionParams));
        console.log('Session data response:', JSON.stringify(sessionData));

        if (!sessionData.Item) {
            console.log('No session found');
            return {
                status: 'FAILED',
                errorMessage: 'Meditation session not found'
            };
        }

        // Extract the status from the DynamoDB item
        const status = sessionData.Item.status?.S;
        console.log('Session status:', status);

        if (!status) {
            return {
                status: 'FAILED',
                errorMessage: 'Session status not found'
            };
        }

        // Return the status (no error message for successful cases)
        return {
            status: status,
            errorMessage: null
        };

    } catch (error: any) {
        console.error('Error getting meditation session status:', error);
        return {
            status: 'FAILED',
            errorMessage: `Error retrieving session status: ${error.message}`
        };
    }
};
