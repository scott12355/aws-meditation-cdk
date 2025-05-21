import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sf from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';

export interface MeditationWorkflowProps {
    stage: string;
    generateScriptLambda: lambda_nodejs.NodejsFunction;
    textToSpeechLambda: lambda_nodejs.NodejsFunction;
    joinSpeechAndMusicLambda: lambda_nodejs.NodejsFunction;
    creationFailedLambda: lambda_nodejs.NodejsFunction;
}

export class MeditationWorkflow extends Construct {
    public readonly stateMachine: sf.StateMachine;

    constructor(scope: Construct, id: string, props: MeditationWorkflowProps) {
        super(scope, id);

        const isStatus200 = sf.Condition.numberEquals('$.statusCode', 200);

        // Shared failure handler: passes original input + error info
        const handleFailure = new tasks.LambdaInvoke(this, 'HandleFailure', {
            lambdaFunction: props.creationFailedLambda,
            payload: sf.TaskInput.fromObject({
                error: sf.JsonPath.stringAt('$.body'), // Pass the body string (contains error info)
                statusCode: sf.JsonPath.numberAt('$.statusCode'),
                input: sf.JsonPath.stringAt('$$.Execution.Input'),
            }),
            outputPath: '$.Payload',
        }).next(
            new sf.Fail(this, 'WorkflowFailed', {
                comment: 'Workflow failed and failure handler executed.',
            })
        );

        // Step 1: GenerateScript
        const generateScript = new tasks.LambdaInvoke(this, 'GenerateScript', {
            lambdaFunction: props.generateScriptLambda,
            outputPath: '$.Payload',
        }).addCatch(handleFailure, {
            resultPath: '$', // <--- Change here
        });

        const checkGenerateScript = new sf.Choice(this, 'CheckGenerateScriptStatus')
            .when(isStatus200, new sf.Pass(this, 'GenerateScriptOK'))
            .otherwise(handleFailure);

        // Step 2: TextToSpeech
        const textToSpeech = new tasks.LambdaInvoke(this, 'TextToSpeech', {
            lambdaFunction: props.textToSpeechLambda,
            outputPath: '$.Payload',
        }).addCatch(handleFailure, {
            resultPath: '$', // <--- Change here
        });

        const checkTTS = new sf.Choice(this, 'CheckTTSStatus')
            .when(isStatus200, new sf.Pass(this, 'TextToSpeechOK'))
            .otherwise(handleFailure);

        // Step 3: JoinAudio
        const joinAudio = new tasks.LambdaInvoke(this, 'JoinAudio', {
            lambdaFunction: props.joinSpeechAndMusicLambda,
            outputPath: '$.Payload',
        }).addCatch(handleFailure, {
            resultPath: '$', // <--- Change here
        });

        const checkJoinAudio = new sf.Choice(this, 'CheckJoinAudioStatus')
            .when(isStatus200, new sf.Succeed(this, 'WorkflowSucceeded'))
            .otherwise(handleFailure);

        // Build the workflow chain
        const definition = sf.Chain
            .start(generateScript)
            .next(checkGenerateScript.afterwards({ includeErrorHandlers: true }).next(textToSpeech))
            .next(checkTTS.afterwards({ includeErrorHandlers: true }).next(joinAudio))
            .next(checkJoinAudio);

        // Create the state machine
        this.stateMachine = new sf.StateMachine(this, `${props.stage}-MeditationWorkflow`, {
            definition,
            timeout: cdk.Duration.minutes(15),
        });
    }
}
