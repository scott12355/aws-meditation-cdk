import { AppSyncResolverEvent, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamoDocClient = DynamoDBDocumentClient.from(dynamoClient);
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

// Helper function to get user's first name from Cognito
const getUserFirstName = async (username: string): Promise<string | null> => {
    try {
        const userPoolId = process.env.USER_POOL_ID;
        if (!userPoolId) {
            console.log('USER_POOL_ID environment variable not set');
            return null;
        }

        const command = new AdminGetUserCommand({
            UserPoolId: userPoolId,
            Username: username
        });

        const response = await cognitoClient.send(command);

        // Look for first name in user attributes
        const attributes = response.UserAttributes || [];
        const firstNameAttr = attributes.find(attr =>
            attr.Name === 'given_name' ||
            attr.Name === 'custom:firstName' ||
            attr.Name === 'first_name'
        );

        if (firstNameAttr?.Value) {
            return firstNameAttr.Value;
        }

        // Fallback: try to extract from 'name' attribute
        const nameAttr = attributes.find(attr => attr.Name === 'name');
        if (nameAttr?.Value) {
            return nameAttr.Value.split(' ')[0];
        }

        console.log('No first name found in user attributes');
        return null;
    } catch (error) {
        console.error('Error fetching user from Cognito:', error);
        return null;
    }
};

interface UserDailyInsightsInput {
    userID: string;
    date: string;
    notes?: string;
    mood?: number;
}

interface UserDailyInsights {
    userID: string;
    date: string;
    notes: string | null;
    mood: number | null;
    firstName?: string | null;
}

export const handler = async (
    event: AppSyncResolverEvent<{ UserDailyInsightsInput: UserDailyInsightsInput }>,
    context: Context
): Promise<UserDailyInsights> => {
    console.log('Event:', JSON.stringify(event, null, 2));

    const { UserDailyInsightsInput } = event.arguments;
    const tableName = process.env.USER_INSIGHTS_TABLE;

    if (!tableName) {
        throw new Error('USER_INSIGHTS_TABLE environment variable is not set');
    }

    // Extract user's first name from Cognito user pool
    let firstName: string | null = null;

    // Get username from identity
    let username: string | undefined;
    if (event.identity && 'username' in event.identity) {
        username = (event.identity as any).username;
    } else if (event.identity && 'sub' in event.identity) {
        username = (event.identity as any).sub;
    }

    if (username) {
        console.log('Fetching user profile for username:', username);
        firstName = await getUserFirstName(username);
    } else {
        console.log('No username found in event.identity');
    }

    console.log('User first name extracted:', firstName);

    // Validate mood range if provided
    if (UserDailyInsightsInput.mood !== undefined &&
        (UserDailyInsightsInput.mood < 1 || UserDailyInsightsInput.mood > 5)) {
        throw new Error('Mood must be between 1 and 5');
    }

    // Create the item to store
    const timestamp = new Date().toISOString();
    const item: UserDailyInsights = {
        userID: UserDailyInsightsInput.userID,
        date: UserDailyInsightsInput.date,
        notes: UserDailyInsightsInput.notes || null,
        mood: UserDailyInsightsInput.mood || null,
        firstName: firstName,
    };

    try {
        // Store the daily insights in DynamoDB (allow updates)
        await dynamoDocClient.send(new PutCommand({
            TableName: tableName,
            Item: {
                ...item,
                createdAt: timestamp,
                updatedAt: timestamp
            }
            // Remove the ConditionExpression to allow updates
        }));

        console.log('Successfully added/updated user daily insights:', item);
        return item;

    } catch (error: any) {
        console.error('Error adding user daily insights:', error);

        if (error.name === 'ConditionalCheckFailedException') {
            throw new Error(`Daily insights already exist for user ${UserDailyInsightsInput.userID} on ${UserDailyInsightsInput.date}`);
        }

        throw new Error(`Failed to add user daily insights: ${error.message}`);
    }
};