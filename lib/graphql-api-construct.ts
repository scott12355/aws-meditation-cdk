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
    meditationBucket: cdk.aws_s3.Bucket;
}

export class MeditationGraphqlApi extends Construct {
    public readonly api: appsync.GraphqlApi;

    constructor(scope: Construct, id: string, props: GraphqlApiProps) {
        super(scope, id);

        const { stage, meditationTable, meditationBucket, stateMachine, userPool } = props;

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

        // Create Lambda data source for creating meditations
        const createMeditationLambda = new lambda_nodejs.NodejsFunction(this, `${stage}-CreateMeditationLambda`, {
            runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
            entry: join(__dirname, '..', 'src', 'lambda', 'API', 'create-meditation', 'index.ts'),
            handler: 'handler',
            timeout: cdk.Duration.seconds(10),
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


        // Create Lambda data source for listing a user's meditation sessions
        const listUserMeditationSessionsLambda = new lambda_nodejs.NodejsFunction(this, `${stage}-ListUserMeditationSessionsLambda`, {
            runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
            entry: join(__dirname, '..', 'src', 'lambda', 'API', 'list-user-meditation-sessions', 'index.ts'),
            description: 'List user meditation sessions',
            handler: 'handler',
            timeout: cdk.Duration.seconds(10),
            environment: {
                MEDITATION_TABLE: meditationTable.tableName,
            },
            bundling: {
                externalModules: ['aws-sdk'],
            },
        });

        // Grant read data permissions to the Lambda function
        meditationTable.grantReadData(listUserMeditationSessionsLambda);

        // Explicitly allow query on the index
        listUserMeditationSessionsLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
            actions: ['dynamodb:Query'],
            resources: [
                `${meditationTable.tableArn}/index/userID-index` // Index ARN
            ],
            effect: cdk.aws_iam.Effect.ALLOW, // Explicitly allow the action
        }));

        // Add Lambda data source to API for listing a user's sessions
        const listUserMeditationSessionsDS = this.api.addLambdaDataSource(
            `${stage}-ListUserMeditationSessionsLambdaDS`,
            listUserMeditationSessionsLambda
        );

        // Query: List a user's meditation sessions
        listUserMeditationSessionsDS.createResolver(
            `${stage}-ListUserMeditationSessionsResolver`,
            {
                typeName: 'Query',
                fieldName: 'listUserMeditationSessions',
            }
        );

        // Query: Get a meditation session presigned URL to audio file
        const getMeditationSessionPresignedUrlLambda = new lambda_nodejs.NodejsFunction(this, `${stage}-GetMeditationSessionPresignedUrlLambda`, {
            runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
            functionName: `${stage}-GetMeditationSessionPresignedUrlLambda`,
            entry: join(__dirname, '..', 'src', 'lambda', 'API', 'get-meditation-session-presigned-url', 'index.ts'),
            description: 'Get presigned URL for meditation session audio',
            handler: 'handler',
            timeout: cdk.Duration.seconds(10),
            environment: {
                MEDITATION_BUCKET: meditationBucket.bucketName,
                MEDITATION_TABLE_NAME: meditationTable.tableName,
            },
            bundling: {
                externalModules: ['aws-sdk'],
            },
        });

        // Grant read data permissions to the Lambda function
        meditationTable.grantReadData(getMeditationSessionPresignedUrlLambda);

        // Fix the S3 permissions - this is the key change needed
        getMeditationSessionPresignedUrlLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [
                `${meditationBucket.bucketArn}/*` // Grant access to all objects in the bucket
            ],
            effect: cdk.aws_iam.Effect.ALLOW,
        }));

        getMeditationSessionPresignedUrlLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
            actions: ['dynamodb:GetItem', 'dynamodb:Scan'],
            resources: [
                meditationTable.tableArn
            ],
            effect: cdk.aws_iam.Effect.ALLOW,
        }));


        // Add Lambda data source to API for getting presigned URL
        const getMeditationSessionPresignedUrlDS = this.api.addLambdaDataSource(
            `${stage}-GetMeditationSessionPresignedUrlLambdaDS`,
            getMeditationSessionPresignedUrlLambda
        );
        // Query: Get a meditation session presigned URL
        getMeditationSessionPresignedUrlDS.createResolver(
            `${stage}-GetMeditationSessionPresignedUrlResolver`,
            {
                typeName: 'Query',
                fieldName: 'getMeditationSessionPresignedUrl',
            }
        );

        // Query: Get a meditation session status
        const getMeditationSessionStatusLambda = new lambda_nodejs.NodejsFunction(this, `${stage}-GetMeditationSessionStatusLambda`, {
            runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
            functionName: `${stage}-GetMeditationSessionStatusLambda`,
            entry: join(__dirname, '..', 'src', 'lambda', 'API', 'get-meditation-session-status', 'index.ts'),
            description: 'Get meditation session status',
            handler: 'handler',
            timeout: cdk.Duration.seconds(10),
            environment: {
                MEDITATION_TABLE: meditationTable.tableName,
            },
            bundling: {
                externalModules: ['aws-sdk'],
            },
        });

        // Grant read data permissions to the Lambda function
        meditationTable.grantReadData(getMeditationSessionStatusLambda);

        getMeditationSessionStatusLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
            actions: ['dynamodb:GetItem'],
            resources: [
                meditationTable.tableArn
            ],
            effect: cdk.aws_iam.Effect.ALLOW,
        }));

        // Add Lambda data source to API for getting session status
        const getMeditationSessionStatusDS = this.api.addLambdaDataSource(
            `${stage}-GetMeditationSessionStatusLambdaDS`,
            getMeditationSessionStatusLambda
        );

        // Query: Get a meditation session status
        getMeditationSessionStatusDS.createResolver(
            `${stage}-GetMeditationSessionStatusResolver`,
            {
                typeName: 'Query',
                fieldName: 'getMeditationSessionStatus',
            }
        );


        // Output the GraphQL API URL
        new cdk.CfnOutput(this, 'GraphQLAPIURL', {
            value: this.api.graphqlUrl
        });

        // Output the API key for reference
        if (this.api.apiKey) {
            new cdk.CfnOutput(this, 'GraphQLAPIKey', {
                value: this.api.apiKey
            });
        }
    }
}