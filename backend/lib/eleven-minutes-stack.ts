import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { execSync } from 'child_process';

export class ElevenMinutesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.TableV2(this, 'QuartoTable', {
      tableName: 'quarto',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // cryptography für Web Push, lokal per pip für ARM64 gebaut, ohne Docker
    const cryptoLayer = new lambda.LayerVersion(this, 'CryptoLayer', {
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_13],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      code: lambda.Code.fromAsset('assets/python/layer', {
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          command: ['bash', '-c', 'pip install -r requirements.txt -t /asset-output/python'],
          local: {
            tryBundle(outputDir: string) {
              execSync(
                'python3 -m pip install -q -r assets/python/layer/requirements.txt ' +
                '--platform manylinux2014_aarch64 --only-binary=:all: --python-version 3.13 ' +
                `--implementation cp -t "${outputDir}/python"`,
                { stdio: 'inherit' },
              );
              return true;
            },
          },
        },
      }),
    });

    // TMDB-Lesezugriffs-Token für Kino & TV, einmalig von Hand angelegt (siehe README)
    const tmdbToken = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'Tmdb', {
      parameterName: '/quarto/tmdb',
    });

    // VAPID-Schlüssel, einmalig von Hand angelegt (siehe README)
    const vapid = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'Vapid', {
      parameterName: '/quarto/vapid',
    });

    const common = {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset('assets/python/_lambda/v2'),
      environment: {
        TABLE_NAME: table.tableName,
        VAPID_PARAM: '/quarto/vapid',
        TMDB_PARAM: '/quarto/tmdb',
        // Kommt beim Deploy aus dem GitHub-Secret TMDB_TOKEN, lokal per export TMDB_TOKEN=...
        TMDB_TOKEN: process.env.TMDB_TOKEN ?? '',
      },
      layers: [cryptoLayer],
    };

    const apiFn = new lambda.Function(this, 'ApiFn', {
      ...common,
      handler: 'api.lambda_handler',
      memorySize: 512,
      // Vorschläge fragen TMDB mehrfach ab, das HTTP-API-Limit liegt bei 30 s
      timeout: cdk.Duration.seconds(25),
    });

    const collectFn = new lambda.Function(this, 'CollectFn', {
      ...common,
      handler: 'collect_today.lambda_handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
    });

    const pushFn = new lambda.Function(this, 'PushFn', {
      ...common,
      handler: 'push.lambda_handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
    });

    table.grantReadWriteData(apiFn);
    table.grantReadWriteData(collectFn);
    table.grantReadWriteData(pushFn);
    vapid.grantRead(apiFn);
    tmdbToken.grantRead(apiFn);
    tmdbToken.grantRead(pushFn);
    vapid.grantRead(pushFn);

    // Benachrichtigungen nach deutscher Zeit, Sommerzeit inklusive
    const schedulerRole = new iam.Role(this, 'MorningPushRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    pushFn.grantInvoke(schedulerRole);
    new scheduler.CfnSchedule(this, 'MorningPush', {
      // Alle 15 Minuten, push.py prüft die Uhrzeiten der Nutzer
      scheduleExpression: 'cron(0/15 * * * ? *)',
      scheduleExpressionTimezone: 'Europe/Berlin',
      flexibleTimeWindow: { mode: 'OFF' },
      target: { arn: pushFn.functionArn, roleArn: schedulerRole.roleArn },
    });

    const userPool = new cognito.UserPool(this, 'QuartoUsers', {
      userPoolName: 'quarto',
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      signInCaseSensitive: false,
      passwordPolicy: { minLength: 10, requireSymbols: false, requireUppercase: false },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const webClient = userPool.addClient('QuartoWeb', {
      authFlows: { userPassword: true },
      generateSecret: false,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(365),
    });

    const authorizer = new HttpJwtAuthorizer('CognitoAuthorizer', 'https:' + '//cognito-idp.' + this.region + '.amazonaws.com/' + userPool.userPoolId, {
      jwtAudience: [webClient.userPoolClientId],
    });

    const api = new apigw.HttpApi(this, 'QuartoApi', {
      corsPreflight: {
        allowOrigins: ['https://daviddimitrov.github.io', 'http://localhost:8000'],
        allowMethods: [apigw.CorsHttpMethod.ANY],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Quarto-Device'],
      },
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', apiFn);
    const M = apigw.HttpMethod;
    const routes: [string, apigw.HttpMethod[]][] = [
      ['/user', [M.GET]],
      ['/user/{userId}/profile', [M.GET, M.PUT]],
      ['/user/{userId}/quick-key', [M.POST]],
      ['/push/key', [M.GET]],
      ['/user/{userId}/push', [M.POST, M.DELETE]],
      ['/user/{userId}/push/test', [M.POST]],
      ['/user/{userId}/notifications', [M.PUT]],
      ['/user/{userId}/redistribute', [M.POST]],
      ['/media/search', [M.GET]],
      ['/media/tv/{tmdbId}/seasons', [M.GET]],
      ['/user/{userId}/media', [M.GET, M.POST]],
      ['/user/{userId}/media/refresh', [M.POST]],
      ['/user/{userId}/media/suggestions', [M.GET]],
      ['/user/{userId}/media/dismiss', [M.POST]],
      ['/user/{userId}/media/{mediaId}', [M.DELETE]],
      ['/user/{userId}/media/{mediaId}/watched', [M.PATCH]],
      ['/user/{userId}/tasks', [M.GET]],
      ['/user/{userId}/tasks/today', [M.GET, M.PATCH]],
      ['/user/{userId}/tasks/long', [M.GET]],
      ['/task', [M.POST]],
      ['/user/{userId}/task/{taskId}', [M.GET, M.PUT, M.DELETE]],
      ['/user/{userId}/task/{taskId}/done', [M.PATCH]],
      ['/user/{userId}/task/{taskId}/today', [M.PATCH]],
      ['/user/{userId}/task/{taskId}/tomorrow', [M.PATCH]],
      ['/user/{userId}/task/{taskId}/next-week', [M.PATCH]],
    ];
    for (const [path, methods] of routes) {
      api.addRoutes({ path, methods, integration, authorizer });
    }

    // Siri-Kurzbefehl: ohne Cognito, geprüft wird ein eigener Schlüssel in api.py
    api.addRoutes({ path: '/quick', methods: [M.POST], integration });

    new events.Rule(this, 'NightlyCollect', {
      schedule: events.Schedule.cron({ minute: '0', hour: '3' }),
      targets: [new targets.LambdaFunction(collectFn)],
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });

    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: webClient.userPoolClientId });
  }
}
