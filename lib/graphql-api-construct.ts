import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { join } from 'path';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as cognito from 'aws-cdk-lib/aws-cognito';

export interface GraphqlApiProps {
    stage: string;
    meditationTable: cdk.aws_dynamodb.Table;
    stateMachine: sfn.StateMachine;
    userPool: cognito.UserPool;
}

export class MeditationGraphqlApi extends Construct {
    public readonly api: appsync.GraphqlApi;

    constructor(scope: Construct, id: string, props: GraphqlApiProps) {
        super(scope, id);

        const { stage, meditationTable, stateMachine, userPool } = props;

        // Create the AppSync API
        this.api = new appsync.GraphqlApi(this, `${stage}-MeditationAPI`, {
            name: `${stage}-meditation-api`,
            schema: appsync.SchemaFile.fromAsset(join(__dirname, '..', 'src', 'graphQL', 'schema.graphql')),
            authorizationConfig: {
                defaultAuthorization: {
                    authorizationType: appsync.AuthorizationType.USER_POOL,
                    userPoolConfig: {
                        userPool,
                        defaultAction: appsync.UserPoolDefaultAction.ALLOW
                    }
                }
            },
            xrayEnabled: true,
        });

        // Create DynamoDB data source
        const meditationTableDS = this.api.addDynamoDbDataSource(
            `${stage}-MeditationTableDS`,
            meditationTable
        );

        // Query: Get meditation session
        meditationTableDS.createResolver(
            `${stage}-GetMeditationSessionResolver`,
            {
                typeName: 'Query',
                fieldName: 'getMeditationSession',
                requestMappingTemplate: appsync.MappingTemplate.dynamoDbGetItem('sessionID', 'sessionID'),
                responseMappingTemplate: appsync.MappingTemplate.dynamoDbResultItem(),
            });


        meditationTableDS.createResolver(
            `${stage}-ListMeditationSessionsResolver`,
            {
                typeName: 'Query',
                fieldName: 'listMeditationSessions',
                requestMappingTemplate: appsync.MappingTemplate.dynamoDbScanTable(),
                responseMappingTemplate: appsync.MappingTemplate.dynamoDbResultList(),
            }
        );

        // Create Lambda data source for creating meditations
        const createMeditationLambda = new lambda_nodejs.NodejsFunction(this, `${stage}-CreateMeditationLambda`, {
            runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
            entry: join(__dirname, '..', 'src', 'lambda', 'create-meditation', 'index.ts'),
            handler: 'handler',
            timeout: cdk.Duration.minutes(1),
            environment: {
                MEDITATION_TABLE: meditationTable.tableName,
                STATE_MACHINE_ARN: stateMachine.stateMachineArn,
            },
            bundling: {
                externalModules: ['aws-sdk'],
            },
        });

        // Grant permissions to start execution of the state machine
        stateMachine.grantStartExecution(createMeditationLambda);
        meditationTable.grantReadWriteData(createMeditationLambda);

        // Add Lambda data source to API
        const createMeditationDS = this.api.addLambdaDataSource(
            `${stage}-CreateMeditationLambdaDS`,
            createMeditationLambda
        );

        // Mutation: Create meditation
        createMeditationDS.createResolver(
            `${stage}-CreateMeditationSessionResolver`,
            {
                typeName: 'Mutation',
                fieldName: 'createMeditationSession',
            }
        );




        // Create a resolver for getting user's meditation sessions
        meditationTableDS.createResolver(
            `${stage}-GetMyMeditationSessionsResolver`,
            {
                typeName: 'Query',
                fieldName: 'getMyMeditationSessions',
                requestMappingTemplate: appsync.MappingTemplate.fromString(`
                    {
                        "version": "2017-02-28",
                        "operation": "Scan",
                        "filter": {
                            "expression": "UserID = :UserID",
                            "expressionValues": {
                                ":UserID": $util.dynamodb.toDynamoDBJson($ctx.identity.sub)
                            }
                        },
                        "limit": $util.defaultIfNull($ctx.args.limit, 20),
                        "nextToken": $util.toJson($util.defaultIfNull($ctx.args.nextToken, null))
                    }
                `),
                responseMappingTemplate: appsync.MappingTemplate.fromString(`
                    {
                        "items": $util.toJson($ctx.result.items),
                        "nextToken": $util.toJson($ctx.result.nextToken)
                    }
                `),
            }
        );

        // Output the GraphQL API URL
        new cdk.CfnOutput(this, 'GraphQLAPIURL', {
            value: this.api.graphqlUrl
        });
    }
}