import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { join } from 'path';

// import * as sqs from 'aws-cdk-lib/aws-sqs';

const STAGE = process.env.STAGE || 'dev';
export class AwsMeditationCdkStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // The code that defines your stack goes here

    // audio bucket
    const creatonBucket = new cdk.aws_s3.Bucket(this, `${STAGE}-CreatonBucket`);
    // script bucket
    const meditationAudioBucket = new cdk.aws_s3.Bucket(this, `${STAGE}-MeditationAudioBucket`);

    // table for storing meditation sessions
    const meditationTable = new cdk.aws_dynamodb.Table(this, `${STAGE}-MeditationTable`, {
      partitionKey: { name: 'sessionId', type: cdk.aws_dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: cdk.aws_dynamodb.AttributeType.NUMBER },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // lambda - generate script
    const generateScriptLambda = new cdk.aws_lambda.Function(this, `${STAGE}-GenerateScriptLambda`, {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      code: cdk.aws_lambda.Code.fromAsset('lambda/generate-script'),
      handler: 'generateScriptLambda.handler',
    });


    // lambda - generate audio
    const textToSpeechLambda = new cdk.aws_lambda.Function(this, `${STAGE}-TextToSpeechLambda`, {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      code: cdk.aws_lambda.Code.fromAsset('lambda/text-to-speech'),
      handler: 'textToSpeechLambda.handler',
      environment: {
        CREATION_BUCKET_NAME: creatonBucket.bucketName,
      },
    });
    textToSpeechLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['polly:SynthesizeSpeech'],
      resources: ['*'], // You can restrict this to specific Polly voices if needed
    }));

    // lambda - Join text and music
    const joinSpeechAndMusicLambda = new cdk.aws_lambda.Function(this, `${STAGE}-JoinTextAndMusicLambda`, {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      code: cdk.aws_lambda.Code.fromAsset('lambda/join-speech-and-music'),
      handler: 'joinSpeechMusicLambda.handler',
      environment: {
        CREATION_BUCKET_NAME: creatonBucket.bucketName,
        MEDITATION_AUDIO_BUCKET_NAME: meditationAudioBucket.bucketName
      },
    });

    // meditation audio workflow
    // Example Step Function definition in your CDK stack
    const meditationWorkflow = new cdk.aws_stepfunctions.StateMachine(this, `${STAGE}-MeditationWorkflow`, {
      definition: cdk.aws_stepfunctions.Chain.start(
        new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'GenerateScript', {
          lambdaFunction: generateScriptLambda,
          outputPath: '$.Payload',
        }).next(
          new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'StartTTS', {
            lambdaFunction: textToSpeechLambda,
            outputPath: '$.Payload',
          }).next(
            new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'MixAudio', {
              lambdaFunction: joinSpeechAndMusicLambda,
              outputPath: '$.Payload',
            })
          )
        )
      ),
      timeout: cdk.Duration.minutes(30),
    });
  }
}
