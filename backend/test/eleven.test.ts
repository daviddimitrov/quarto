import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ElevenMinutesStack } from '../lib/eleven-minutes-stack';

// Ohne Bundling, sonst baut jeder Testlauf den Crypto-Layer per pip
const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
const template = Template.fromStack(new ElevenMinutesStack(app, 'TestStack'));

test('Tabelle mit PK/SK bleibt beim Löschen des Stacks erhalten', () => {
  template.hasResource('AWS::DynamoDB::GlobalTable', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    }),
  });
});

test('Alle Lambdas laufen mit Python 3.13 auf ARM', () => {
  const fns = template.findResources('AWS::Lambda::Function', {
    Properties: { Runtime: 'python3.13' },
  });
  expect(Object.keys(fns).length).toBeGreaterThanOrEqual(4);
  for (const fn of Object.values(fns)) {
    expect((fn as { Properties: { Architectures: string[] } }).Properties.Architectures).toEqual(['arm64']);
  }
});

test('Zeitpläne nach deutscher Zeit', () => {
  template.resourceCountIs('AWS::Scheduler::Schedule', 2);
  template.allResourcesProperties('AWS::Scheduler::Schedule', {
    ScheduleExpressionTimezone: 'Europe/Berlin',
  });
});

test('Nur /quick ist ohne Cognito erreichbar', () => {
  const routes = template.findResources('AWS::ApiGatewayV2::Route');
  const open = Object.values(routes).filter(
    (r) => (r as { Properties: { AuthorizationType?: string } }).Properties.AuthorizationType !== 'JWT',
  );
  expect(open.map((r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey)).toEqual(['POST /quick']);
});
