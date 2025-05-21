import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface CognitoAuthProps {
    stage: string;
    appName: string;
}

export class CognitoAuthConstruct extends Construct {
    public readonly userPool: cognito.UserPool;
    public readonly userPoolClient: cognito.UserPoolClient;
    public readonly identityPool: cognito.CfnIdentityPool;
    public readonly authenticatedRole: iam.Role;
    public readonly unauthenticatedRole: iam.Role;

    constructor(scope: Construct, id: string, props: CognitoAuthProps) {
        super(scope, id);

        const { stage, appName } = props;

        // Create User Pool
        this.userPool = new cognito.UserPool(this, `${stage}-${appName}-UserPool`, {
            userPoolName: `${stage}-${appName}-user-pool`,
            selfSignUpEnabled: true,
            signInAliases: {
                email: true,
                // username: true, // <-- Add this line
            },
            autoVerify: {
                email: true,
            },
            standardAttributes: {
                email: {
                    required: true,
                    mutable: true,
                },
                givenName: {
                    required: true,
                    mutable: true,
                },
                familyName: {
                    required: true,
                    mutable: true,
                },
            },
            passwordPolicy: {
                minLength: 8,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: true,
            },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            removalPolicy: stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        // Create User Pool Client
        this.userPoolClient = this.userPool.addClient(`${stage}-${appName}-app-client`, {
            userPoolClientName: `${stage}-${appName}-app-client`,
            authFlows: {
                userPassword: true,
                userSrp: true,
            },
            oAuth: {
                flows: {
                    implicitCodeGrant: true,
                },
                scopes: [
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.PROFILE,
                ],
                callbackUrls: ['http://localhost:3000/', 'http://localhost:5173/'],
                logoutUrls: ['http://localhost:3000/', 'http://localhost:5173/'],
            },
        });

        // Create Identity Pool
        this.identityPool = new cognito.CfnIdentityPool(this, `${stage}-${appName}-IdentityPool`, {
            identityPoolName: `${stage}${appName}IdentityPool`,
            allowUnauthenticatedIdentities: true,
            cognitoIdentityProviders: [
                {
                    clientId: this.userPoolClient.userPoolClientId,
                    providerName: this.userPool.userPoolProviderName,
                },
            ],
        });

        // Create IAM roles for authenticated and unauthenticated users
        this.authenticatedRole = new iam.Role(this, `${stage}-${appName}-AuthenticatedRole`, {
            assumedBy: new iam.FederatedPrincipal(
                'cognito-identity.amazonaws.com',
                {
                    StringEquals: {
                        'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
                    },
                    'ForAnyValue:StringLike': {
                        'cognito-identity.amazonaws.com:amr': 'authenticated',
                    },
                },
                'sts:AssumeRoleWithWebIdentity'
            ),
        });

        this.unauthenticatedRole = new iam.Role(this, `${stage}-${appName}-UnauthenticatedRole`, {
            assumedBy: new iam.FederatedPrincipal(
                'cognito-identity.amazonaws.com',
                {
                    StringEquals: {
                        'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
                    },
                    'ForAnyValue:StringLike': {
                        'cognito-identity.amazonaws.com:amr': 'unauthenticated',
                    },
                },
                'sts:AssumeRoleWithWebIdentity'
            ),
        });

        // Attach the roles to the Identity Pool
        new cognito.CfnIdentityPoolRoleAttachment(this, `${stage}-${appName}-IdentityPoolRoleAttachment`, {
            identityPoolId: this.identityPool.ref,
            roles: {
                authenticated: this.authenticatedRole.roleArn,
                unauthenticated: this.unauthenticatedRole.roleArn,
            },
        });

        // Output the User Pool ID and Client ID
        new cdk.CfnOutput(this, 'UserPoolId', {
            value: this.userPool.userPoolId,
        });

        new cdk.CfnOutput(this, 'UserPoolClientId', {
            value: this.userPoolClient.userPoolClientId,
        });

        new cdk.CfnOutput(this, 'IdentityPoolId', {
            value: this.identityPool.ref,
        });
    }
}
