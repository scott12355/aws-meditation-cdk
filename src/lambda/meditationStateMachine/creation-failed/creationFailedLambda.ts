import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({});

export const handler = async (event: any) => {

    // Support Step Functions and direct Lambda invocation
    let eventBody: any = {};
    if (event.body) {
        eventBody = JSON.parse(event.body);
    } else if (event.input && event.input.body) {
        eventBody = JSON.parse(event.input.body);
    } else if (event.input) {
        eventBody = event.input;
    }

    const { sessionID, userID } = eventBody;
    const tableName = process.env.MEDITATION_TABLE_NAME;

    console.log("Parsed eventBody:", eventBody);
    console.log("sessionID:", sessionID);

    if (!sessionID) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: "sessionID required" }),
        };
    }

    try {
        await dynamo.send(new UpdateItemCommand({
            TableName: tableName,
            Key: {
                sessionID: { S: sessionID },
            },
            UpdateExpression: "SET #status = :failed",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":failed": { S: "FAILED" } }
        }));

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Status updated to failed" }),
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: "Failed to update status",
                error: (error instanceof Error) ? error.message : String(error)
            }),
        };
    }
};