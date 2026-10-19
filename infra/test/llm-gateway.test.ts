import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { describe, expect, it } from 'vitest';
import { LlmGatewayConstruct } from '../lib/constructs/llm-gateway.js';

function synth(context: Record<string, unknown> = {}) {
  const app = new App({ context });
  const stack = new Stack(app, 'TestLlmGateway', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const anthropicSecret = secretsmanager.Secret.fromSecretNameV2(
    stack,
    'AnthropicSecret',
    'medadhere/anthropic',
  );
  new LlmGatewayConstruct(stack, 'LlmGateway', { anthropicSecret });
  return Template.fromStack(stack);
}

describe('LlmGatewayConstruct', () => {
  it('creates one non-VPC nodejs24/arm64 gateway with the pinned 60-second timeout', () => {
    const template = synth();
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Timeout: 60,
      Handler: 'index.handler',
      // Wave 1b: the gateway now serves interpretation + composition (invocations double) —
      // memory reviewed up from the 128 MB default, concurrency fenced so a runaway can never
      // starve the small account's pool.
      MemorySize: 512,
      ReservedConcurrentExecutions: 10,
      Environment: {
        Variables: {
          ANTHROPIC_SECRET_ARN: Match.anyValue(),
        },
      },
    });
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0]!;
    expect((fn.Properties as { VpcConfig?: unknown }).VpcConfig).toBeUndefined();
    expect(JSON.stringify(fn)).toContain('medadhere/anthropic');
  });

  it('omits CLINICAL_COMPOSER_MODEL by default and sets it only via the shared config-only context key', () => {
    const withoutModel = synth();
    const fnWithoutModel = Object.values(withoutModel.findResources('AWS::Lambda::Function'))[0]!;
    const envWithoutModel = (
      fnWithoutModel.Properties as { Environment: { Variables: Record<string, unknown> } }
    ).Environment.Variables;
    expect('CLINICAL_COMPOSER_MODEL' in envWithoutModel).toBe(false);

    const withModel = synth({ clinicalComposerModel: 'claude-sonnet-5' });
    const fnWithModel = Object.values(withModel.findResources('AWS::Lambda::Function'))[0]!;
    const envWithModel = (
      fnWithModel.Properties as { Environment: { Variables: Record<string, unknown> } }
    ).Environment.Variables;
    expect(envWithModel.CLINICAL_COMPOSER_MODEL).toBe('claude-sonnet-5');
  });

  it('omits the concurrency reservation with -c gatewayReservedConcurrency=0 (small-account escape hatch)', () => {
    // Lambda rejects any reservation that drops the account's unreserved pool below 100, so
    // an account still at a new-account limit deploys with the reservation omitted instead
    // of rolling back the whole stack update.
    const template = synth({ gatewayReservedConcurrency: '0' });
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0]!;
    expect(
      (fn.Properties as { ReservedConcurrentExecutions?: unknown }).ReservedConcurrentExecutions,
    ).toBeUndefined();
  });

  it('has only a scoped Anthropic secret grant and no DB, Twilio, queue, scheduler, or invoke grants', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const json = JSON.stringify(policies);
    expect(json).toContain('secretsmanager:GetSecretValue');
    expect(json).toContain(':secret:medadhere/anthropic-??????');
    for (const forbidden of [
      'DB_SECRET_ARN',
      'TWILIO_SECRET_ARN',
      'sqs:',
      'scheduler:',
      'lambda:InvokeFunction',
      'ssm:GetParameter',
      'bedrock:',
    ]) {
      expect(json).not.toContain(forbidden);
    }
    for (const policy of Object.values(policies)) {
      const statements = (
        policy.Properties as {
          PolicyDocument: { Statement: Array<{ Resource?: unknown }> };
        }
      ).PolicyDocument.Statement;
      for (const statement of statements) {
        if (statement.Resource !== undefined) expect(statement.Resource).not.toBe('*');
      }
    }
  });

  it('has no API, Function URL, event source, database, or network resources', () => {
    const template = synth();
    for (const resourceType of [
      'AWS::ApiGatewayV2::Api',
      'AWS::ApiGateway::RestApi',
      'AWS::Lambda::Url',
      'AWS::Lambda::EventSourceMapping',
      'AWS::RDS::DBInstance',
      'AWS::EC2::SecurityGroup',
      'AWS::EC2::Subnet',
    ]) {
      template.resourceCountIs(resourceType, 0);
    }
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ RetentionInDays: 7 }),
    });
  });
});
