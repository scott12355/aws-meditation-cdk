import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SFN } from '@aws-sdk/client-sfn';
import { v4 as uuidv4 } from 'uuid';

const dynamoDbClient = new DynamoDBClient({});
const dynamoDb = DynamoDBDocumentClient.from(dynamoDbClient);
const stepFunctions = new SFN({});

export const handler = async (event: any) => {
    console.log('Event received:', JSON.stringify(event, null, 2));

    try {
        // Extract authentication info
        if (!event.identity || !event.identity.claims || !event.identity.claims.sub) {
            throw new Error('User is not authenticated');
        }

        // Get the user ID from Cognito claims
        const userID = event.identity.claims.sub;
        const sessionID = uuidv4();
        const timestamp = Date.now();


        // Create new meditation session in DynamoDB
        const item = {
            userID,
            sessionID,
            status: 'REQUESTED',
            timestamp,
        }

        await dynamoDb.send(new PutCommand({
            TableName: process.env.MEDITATION_TABLE!,
            Item: item
        }));

        console.log(`Created meditation session in DynamoDB: ${sessionID}`);

        // Start the meditation workflow state machine
        const sfnResponse = await stepFunctions.startExecution({
            stateMachineArn: process.env.STATE_MACHINE_ARN!,
            input: JSON.stringify({
                userID,
                sessionID,
            }),
            name: `meditation-${sessionID.substring(0, 8)}`
        });

        console.log(`Started state machine execution: ${sfnResponse.executionArn}`);

        return item;
    } catch (error) {
        console.error('Error creating meditation session:', error);
        throw error;
    }
};