import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';

export interface MeditationWorkflowProps {
    stage: string;
    generateScriptLambda: lambda_nodejs.NodejsFunction;
    textToSpeechLambda: lambda_nodejs.NodejsFunction;
    joinSpeechAndMusicLambda: lambda_nodejs.NodejsFunction;
}

export class MeditationWorkflow extends Construct {
    public readonly stateMachine: cdk.aws_stepfunctions.StateMachine;

    constructor(scope: Construct, id: string, props: MeditationWorkflowProps) {
        super(scope, id);

        // Define LambdaInvoke tasks
        const generateScriptInvoke = new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'GenerateScript', {
            lambdaFunction: props.generateScriptLambda,
            outputPath: '$.Payload',
        });

        const textToSpeechInvoke = new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'StartTTS', {
            lambdaFunction: props.textToSpeechLambda,
            outputPath: '$.Payload',
        });

        const joinSpeechAndMusicInvoke = new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'MixAudio', {
            lambdaFunction: props.joinSpeechAndMusicLambda,
            outputPath: '$.Payload',
        });

        // Define Fail states for non-200 responses
        const generateScriptFailedState = new cdk.aws_stepfunctions.Fail(this, 'GenerateScriptFailed', {
            comment: 'GenerateScript Lambda returned a non-200 status code.',
            error: 'GenerateScriptNon200Error',
            cause: 'The GenerateScript Lambda function completed but returned a status code other than 200. Check its output in the execution history.',
        });

        const textToSpeechFailedState = new cdk.aws_stepfunctions.Fail(this, 'TextToSpeechFailed', {
            comment: 'TextToSpeech Lambda returned a non-200 status code.',
            error: 'TextToSpeechNon200Error',
            cause: 'The TextToSpeech Lambda function completed but returned a status code other than 200. Check its output in the execution history.',
        });

        const joinAudioFailedState = new cdk.aws_stepfunctions.Fail(this, 'JoinAudioFailed', {
            comment: 'JoinSpeechAndMusic Lambda returned a non-200 status code.',
            error: 'JoinAudioNon200Error',
            cause: 'The JoinSpeechAndMusic Lambda function completed but returned a status code other than 200. Check its output in the execution history.',
        });

        // Define a Success state for the end of the workflow
        const workflowSucceededState = new cdk.aws_stepfunctions.Succeed(this, 'WorkflowSucceeded', {
            comment: 'Meditation audio generation workflow completed successfully.',
        });

        // Define the state machine definition with Choice states to check statusCode
        const definition = cdk.aws_stepfunctions.Chain.start(
            generateScriptInvoke.next(
                new cdk.aws_stepfunctions.Choice(this, 'CheckGenerateScriptStatusCode')
                    .when(
                        cdk.aws_stepfunctions.Condition.numberEquals('$.statusCode', 200),
                        textToSpeechInvoke.next(
                            new cdk.aws_stepfunctions.Choice(this, 'CheckTextToSpeechStatusCode')
                                .when(
                                    cdk.aws_stepfunctions.Condition.numberEquals('$.statusCode', 200),
                                    joinSpeechAndMusicInvoke.next(
                                        new cdk.aws_stepfunctions.Choice(this, 'CheckJoinAudioStatusCode')
                                            .when(
                                                cdk.aws_stepfunctions.Condition.numberEquals('$.statusCode', 200),
                                                workflowSucceededState
                                            )
                                            .otherwise(joinAudioFailedState)
                                    )
                                )
                                .otherwise(textToSpeechFailedState)
                        )
                    )
                    .otherwise(generateScriptFailedState)
            )
        );

        // Create the state machine
        this.stateMachine = new cdk.aws_stepfunctions.StateMachine(this, `${props.stage}-MeditationWorkflow`, {
            definition: definition,
            timeout: cdk.Duration.minutes(15),
        });
    }
}
