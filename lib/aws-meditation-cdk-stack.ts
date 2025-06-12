import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { join } from 'path';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { MeditationWorkflow } from '../src/meditation-workflow';
import { MeditationGraphqlApi } from './graphql-api-construct';
import { CognitoAuthConstruct } from './cognito-auth-construct';

// import * as sqs from 'aws-cdk-lib/aws-sqs';

const STAGE = process.env.STAGE || 'dev';
export class AwsMeditationCdkStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // The code that defines your stack goes here

    // audio bucket
    const userMeditationSessionsBucket = new cdk.aws_s3.Bucket(this, `${STAGE}-User-Meditation-Sessions-Bucket`, {
      bucketName: `${STAGE}-user-meditation-sessions-bucket`,
      removalPolicy: STAGE === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: STAGE !== 'prod',
    });

    const musicBucket = new cdk.aws_s3.Bucket(this, `${STAGE}-Music-Bucket`, {
      bucketName: `${STAGE}-music-bucket`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Deploy music files to the bucket
    new s3deploy.BucketDeployment(this, `${STAGE}-DeployMusicFiles`, {
      sources: [s3deploy.Source.asset(join(__dirname, '..', 'assets', 'music'))],
      destinationBucket: musicBucket,
      retainOnDelete: false, // Set to true if you want to keep files when stack is deleted
    });


    // table for storing meditation sessions
    const meditationTable = new cdk.aws_dynamodb.Table(this, `${STAGE}-MeditationTable`, {
      partitionKey: { name: 'sessionID', type: cdk.aws_dynamodb.AttributeType.STRING },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    meditationTable.addGlobalSecondaryIndex({
      indexName: 'userID-index',
      partitionKey: { name: 'userID', type: cdk.aws_dynamodb.AttributeType.STRING },
      projectionType: cdk.aws_dynamodb.ProjectionType.ALL, // Or choose KEYS_ONLY or INCLUDE
    });

    // table - user insights
    const userInsightsTable = new cdk.aws_dynamodb.Table(this, `${STAGE}-UserInsightsTable`, {
      partitionKey: { name: 'userID', type: cdk.aws_dynamodb.AttributeType.STRING },
      sortKey: { name: 'date', type: cdk.aws_dynamodb.AttributeType.STRING }, // Format: YYYY-MM-DD
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });



    // lambda - generate script
    const generateScriptLambda = new lambda_nodejs.NodejsFunction(this, `${STAGE}-GenerateScriptLambda`, {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      entry: join(__dirname, '..', 'src', 'lambda', 'meditationStateMachine', 'generate-script', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(3),
      bundling: {
        externalModules: ['aws-sdk'],
      },
      environment: {
        CREATION_BUCKET_NAME: userMeditationSessionsBucket.bucketName,
        DEEPSEEK_KEY: process.env.DEEPSEEK_KEY || '',
      },
    });
    generateScriptLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 's3:PutObject'],
      resources: [
        'arn:aws:bedrock:us-east-1::foundation-model/*', // <-- allow all models in us-east-1

        userMeditationSessionsBucket.bucketArn,
        `${userMeditationSessionsBucket.bucketArn}/*`
      ],
    }));





    // lambda - generate audio
    const textToSpeechLambda = new lambda_nodejs.NodejsFunction(this, `${STAGE}-TextToSpeechLambda`, {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      entry: join(__dirname, '..', 'src', 'lambda', 'meditationStateMachine', 'text-to-speech', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      bundling: {
        externalModules: ['aws-sdk'],
      },
      environment: {
        CREATION_BUCKET_NAME: userMeditationSessionsBucket.bucketName,
      },
    });

    textToSpeechLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: [
        'polly:SynthesizeSpeech'
      ],
      resources: ['*'],
    }));



    textToSpeechLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
      resources: [
        userMeditationSessionsBucket.bucketArn,
        `${userMeditationSessionsBucket.bucketArn}/*`
      ],
    }));


    // layer for ffmpeg
    const ffmpegLayer = new cdk.aws_lambda.LayerVersion(this, `${STAGE}-FFmpegLayer`, {
      code: cdk.aws_lambda.Code.fromAsset(join(__dirname, '..', 'src', 'lambda', 'ffmpeg-layer')),
      compatibleRuntimes: [cdk.aws_lambda.Runtime.NODEJS_22_X],
      description: 'A layer to provide ffmpeg and ffprobe for audio processing',
    });

    // lambda - Join text and music
    const joinSpeechAndMusicLambda = new lambda_nodejs.NodejsFunction(this, `${STAGE}-JoinTextAndMusicLambda`, {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      entry: join(__dirname, '..', 'src', 'lambda', 'meditationStateMachine', 'join-speech-and-music', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(3),
      memorySize: 2048, // or higher, depending on your needs
      layers: [ffmpegLayer],
      bundling: {
        externalModules: ['aws-sdk'],
      },
      environment: {
        BACKING_TRACK_BUCKET_NAME: musicBucket.bucketName,
        USER_SESSION_BUCKET_NAME: userMeditationSessionsBucket.bucketName,
        MEDITATION_TABLE_NAME: meditationTable.tableName,
      },
    });
    joinSpeechAndMusicLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
      resources: [musicBucket.bucketArn, `${musicBucket.bucketArn}/*`, userMeditationSessionsBucket.bucketArn, `${userMeditationSessionsBucket.bucketArn}/*`],
    }));
    joinSpeechAndMusicLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [meditationTable.tableArn],
    }));

    // lambda - creation failed
    const creationFailedLambda = new lambda_nodejs.NodejsFunction(this, `${STAGE}-CreationFailedLambda`, {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      entry: join(__dirname, '..', 'src', 'lambda', 'meditationStateMachine', 'creation-failed', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        MEDITATION_TABLE_NAME: meditationTable.tableName,
      },
      bundling: {
        externalModules: ['aws-sdk'],
      },
    });
    creationFailedLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [meditationTable.tableArn],
    }));




    // Create Cognito Auth
    const cognitoAuth = new CognitoAuthConstruct(this, 'CognitoAuth', {
      stage: STAGE,
      appName: 'meditation-app'
    });

    // Create the meditation workflow using the extracted class
    const meditationWorkflow = new MeditationWorkflow(this, 'MeditationWorkflow', {
      stage: STAGE,
      generateScriptLambda,
      textToSpeechLambda,
      joinSpeechAndMusicLambda,
      creationFailedLambda
    });

    // Add GraphQL API
    const graphqlApi = new MeditationGraphqlApi(this, 'MeditationGraphqlApi', {
      stage: STAGE,
      meditationTable,
      stateMachine: meditationWorkflow.stateMachine,
      userPool: cognitoAuth.userPool,
      meditationBucket: userMeditationSessionsBucket,
      userInsightsTable: userInsightsTable,
    });
  }
}
