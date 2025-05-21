import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { join } from 'path';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
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


    // table for storing meditation sessions
    const meditationTable = new cdk.aws_dynamodb.Table(this, `${STAGE}-MeditationTable`, {
      partitionKey: { name: 'sessionID', type: cdk.aws_dynamodb.AttributeType.STRING },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // lambda - generate script
    const generateScriptLambda = new lambda_nodejs.NodejsFunction(this, `${STAGE}-GenerateScriptLambda`, {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      entry: join(__dirname, '..', 'src', 'lambda', 'meditationStateMachine', 'generate-script', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(1),
      bundling: {
        externalModules: ['aws-sdk'],
      },
      environment: {
        CREATION_BUCKET_NAME: userMeditationSessionsBucket.bucketName,
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
      timeout: cdk.Duration.minutes(1),
      bundling: {
        externalModules: ['aws-sdk'],
      },
      environment: {
        CREATION_BUCKET_NAME: userMeditationSessionsBucket.bucketName,
      },
    });
    textToSpeechLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['polly:SynthesizeSpeech'],
      resources: ['*'], // required for Polly
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
      description: 'A layer to provide ffmpeg for audio processing',
    });

    // lambda - Join text and music
    const joinSpeechAndMusicLambda = new lambda_nodejs.NodejsFunction(this, `${STAGE}-JoinTextAndMusicLambda`, {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      entry: join(__dirname, '..', 'src', 'lambda', 'meditationStateMachine', 'join-speech-and-music', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(2),
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

    // meditationTable.grantWriteData(creationFailedLambda);




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
      userPool: cognitoAuth.userPool
    });
  }
}
