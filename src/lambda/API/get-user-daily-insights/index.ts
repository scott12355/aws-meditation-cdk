import { AppSyncResolverEvent, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamoDocClient = DynamoDBDocumentClient.from(dynamoClient);

interface UserDailyInsights {
    userID: string;
    date: string;
    notes: string | null;
    mood: number | null;
}

export const handler = async (
    event: AppSyncResolverEvent<{ userID: string; date: string }>,
    context: Context
): Promise<UserDailyInsights | null> => {
    console.log('Event:', JSON.stringify(event, null, 2));

    const { userID, date } = event.arguments;
    const tableName = process.env.USER_INSIGHTS_TABLE;

    if (!tableName) {
        throw new Error('USER_INSIGHTS_TABLE environment variable is not set');
    }

    try {
        // Get the daily insights from DynamoDB
        const result = await dynamoDocClient.send(new GetCommand({
            TableName: tableName,
            Key: {
                userID,
                date
            }
        }));

        if (!result.Item) {
            console.log(`No daily insights found for user ${userID} on ${date}`);
            return null;
        }

        const insights: UserDailyInsights = {
            userID: result.Item.userID,
            date: result.Item.date,
            notes: result.Item.notes || null,
            mood: result.Item.mood || null,
        };

        console.log('Successfully retrieved user daily insights:', insights);
        return insights;

    } catch (error: any) {
        console.error('Error retrieving user daily insights:', error);
        throw new Error(`Failed to retrieve user daily insights: ${error.message}`);
    }
};
