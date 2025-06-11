import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, QueryCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SFN } from '@aws-sdk/client-sfn';
import { v4 as uuidv4 } from 'uuid';

const dynamoDbClient = new DynamoDBClient({});
const dynamoDb = DynamoDBDocumentClient.from(dynamoDbClient);
const stepFunctions = new SFN({});

// Helper function to get recent user insights
const getRecentUserInsights = async (userID: string, days: number = 7) => {
    try {
        const userInsightsTable = process.env.USER_INSIGHTS_TABLE;
        if (!userInsightsTable) {
            console.log('USER_INSIGHTS_TABLE environment variable not set');
            return null;
        }

        // Calculate date range (last N days)
        const endDate = new Date().toISOString().split('T')[0]; // Today: YYYY-MM-DD
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        console.log(`Querying user insights from ${startDate} to ${endDate}`);

        const queryParams = {
            TableName: userInsightsTable,
            KeyConditionExpression: 'userID = :userID AND #dateField BETWEEN :startDate AND :endDate',
            ExpressionAttributeNames: {
                '#dateField': 'date'
            },
            ExpressionAttributeValues: {
                ':userID': userID,
                ':startDate': startDate,
                ':endDate': endDate
            },
            ScanIndexForward: false, // Sort by date descending (most recent first)
            Limit: 10 // Limit to most recent 10 entries
        };

        const result = await dynamoDb.send(new QueryCommand(queryParams));
        console.log(`Found ${result.Items?.length || 0} recent insights for user ${userID}`);

        return result.Items || [];
    } catch (error) {
        console.error('Error fetching user insights:', error);
        return null;
    }
};

export const handler = async (event: any) => {
    console.log('Event received:', JSON.stringify(event, null, 2));

    try {
        // Get the user ID - either from Cognito claims or from arguments
        let userID;
        // If using API Key auth or passing userID explicitly
        if (event.arguments && event.arguments.userID) {
            userID = event.arguments.userID;
        }
        // If using Cognito auth
        else if (event.identity && event.identity.claims && event.identity.claims.sub) {
            userID = event.identity.claims.sub;
        } else {
            throw new Error('User is not authenticated or userID not provided');
        }

        const sessionID = uuidv4();
        const timestamp = Date.now();

        // Get user's recent daily insights
        const recentInsights = await getRecentUserInsights(userID);

        // Combine provided session insights with recent user insights
        const sessionInsights = event?.arguments?.sessionInsights;
        console.log('Provided session insights:', sessionInsights);
        console.log('Recent user insights:', recentInsights);

        // Create enhanced insights object
        const enhancedInsights = {
            providedInsights: sessionInsights,
            recentDailyInsights: recentInsights,
            insightsContext: recentInsights ?
                `User has ${recentInsights.length} recent daily insights entries. Recent mood trends and notes can inform personalization.` :
                'No recent daily insights available for this user.'
        };

        console.log('Enhanced session insights:', enhancedInsights);



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
                sessionInsights: enhancedInsights,
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