import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

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

    const common = {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset('assets/python/_lambda/v2'),
      environment: { TABLE_NAME: table.tableName },
    };

    const apiFn = new lambda.Function(this, 'ApiFn', {
      ...common,
      handler: 'api.lambda_handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
    });

    const collectFn = new lambda.Function(this, 'CollectFn', {
      ...common,
      handler: 'collect_today.lambda_handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
    });

    table.grantReadWriteData(apiFn);
    table.grantReadWriteData(collectFn);

    const api = new apigw.HttpApi(this, 'QuartoApi', {
      corsPreflight: {
        allowOrigins: ['https://daviddimitrov.github.io', 'http://localhost:8000'],
        allowMethods: [apigw.CorsHttpMethod.ANY],
        allowHeaders: ['Content-Type'],
      },
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', apiFn);
    const M = apigw.HttpMethod;
    const routes: [string, apigw.HttpMethod[]][] = [
      ['/user', [M.GET]],
      ['/user/{userId}/tasks', [M.GET]],
      ['/user/{userId}/tasks/today', [M.GET, M.PATCH]],
      ['/task', [M.POST]],
      ['/user/{userId}/task/{taskId}', [M.GET, M.PUT, M.DELETE]],
      ['/user/{userId}/task/{taskId}/done', [M.PATCH]],
      ['/user/{userId}/task/{taskId}/today', [M.PATCH]],
      ['/user/{userId}/task/{taskId}/tomorrow', [M.PATCH]],
      ['/user/{userId}/task/{taskId}/next-week', [M.PATCH]],
    ];
    for (const [path, methods] of routes) {
      api.addRoutes({ path, methods, integration });
    }

    new events.Rule(this, 'NightlyCollect', {
      schedule: events.Schedule.cron({ minute: '0', hour: '3' }),
      targets: [new targets.LambdaFunction(collectFn)],
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
