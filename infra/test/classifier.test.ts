// infra/test/classifier.test.ts
//
// The 08-04a patient-ordered worker SHAPE gate. Uses aws-cdk-lib/assertions Template.fromStack —
// no live AWS call.
//
// Pins:
//   - no EventBridge rule, async invoke config, or EventBridge invoke permission remains
//   - one SQS event-source mapping consumes the passed FIFO work queue at batch size one
//   - fn shape: in-VPC nodejs24/arm64, 180 s timeout, DESTROY/ONE_WEEK
//     logs, env: LLM_GATEWAY_FN_ARN + OUTBOUND_FN_ARN + QUEUE_URL + DB_* with NO provider/Twilio
//     secret or password
//   - M1: queue consume + same-queue send, app-DB secret read, scoped gateway/outbound invoke, no wildcard

import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { describe, it, expect } from 'vitest';
import { App, Duration, Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { ClassifierConstruct } from '../lib/constructs/classifier.js';

function synth(context: Record<string, unknown> = {}) {
  const app = new App({ context });
  const stack = new Stack(app, 'TestClassifier', {
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
  const lambdaSg = new ec2.SecurityGroup(stack, 'LambdaSg', { vpc });

  const db = new rds.DatabaseInstance(stack, 'Db', {
    engine: rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_16_4,
    }),
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    credentials: rds.Credentials.fromGeneratedSecret('medadhere_admin'),
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const dbSecret = db.secret!;

  const llmGatewayFn = new lambda.Function(stack, 'LlmGatewayFn', {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({ ok: true });'),
  });
  const outboundFn = new lambda.Function(stack, 'OutboundFn', {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({ ok: true });'),
  });
  const queue = new sqs.Queue(stack, 'TurnWorkQueue', {
    fifo: true,
    visibilityTimeout: Duration.seconds(1_080),
  });

  new ClassifierConstruct(stack, 'Classifier', {
    vpc,
    lambdaSg,
    db,
    dbSecret,
    llmGatewayFn,
    outboundFn,
    queue,
  });

  return { stack, template: Template.fromStack(stack) };
}

describe('ClassifierConstruct — SQS FIFO event source replaces the old EventBridge route', () => {
  it('creates one enabled batch-size-one event source mapping to the passed queue', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      Enabled: true,
      EventSourceArn: Match.anyValue(),
      FunctionName: Match.anyValue(),
    });
    const mapping = Object.values(template.findResources('AWS::Lambda::EventSourceMapping'))[0]!;
    const props = mapping.Properties as {
      FunctionResponseTypes?: unknown;
      MaximumBatchingWindowInSeconds?: number;
    };
    expect(props.FunctionResponseTypes).toBeUndefined();
    expect(props.MaximumBatchingWindowInSeconds).toBeUndefined();
  });

  it('has zero EventBridge rule, EventBridge invoke permission, or async invoke config', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Events::Rule', 0);
    template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 0);
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission'));
    expect(JSON.stringify(permissions)).not.toContain('events.amazonaws.com');
  });
});

describe('ClassifierConstruct — in-VPC Lambda shape (08-04a)', () => {
  it('places the queue worker in the VPC on nodejs24.x/arm64 with the pinned 180 s timeout', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const ourFns = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig !== undefined,
    );
    expect(ourFns.length).toBe(1);
    const p = ourFns[0]!.Properties as {
      Runtime: string;
      Architectures: string[];
      Timeout: number;
    };
    expect(p.Runtime).toBe('nodejs24.x');
    expect(p.Architectures).toEqual(['arm64']);
    expect(p.Timeout).toBe(180);
  });

  it('carries only the gateway/outbound ARNs, queue, and DB runtime environment', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const classifier = Object.values(fns).find(
      (f) =>
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables?.DB_NAME === 'medadhere',
    );
    expect(classifier).toBeDefined();
    const env = (
      classifier!.Properties as {
        Environment: { Variables: Record<string, unknown> };
      }
    ).Environment.Variables;
    expect('LLM_GATEWAY_FN_ARN' in env).toBe(true);
    expect('OUTBOUND_FN_ARN' in env).toBe(true);
    expect('DB_SECRET_ARN' in env).toBe(true);
    expect('QUEUE_URL' in env).toBe(true);
    for (const removed of [
      'ANTHROPIC_SECRET_ARN',
      'ANTHROPIC_MODEL_ID',
      'TWILIO_SECRET_ARN',
      'TWILIO_FROM_PARAM',
    ]) {
      expect(removed in env).toBe(false);
    }
    expect('PGSSLMODE' in env).toBe(false);
    expect('DB_PASSWORD' in env).toBe(false);
  });

  it('gives the classifier an explicit DESTROY/ONE_WEEK log group (F61 teardown)', () => {
    const { template } = synth();
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ RetentionInDays: 7 }),
    });
  });
});

describe('ClassifierConstruct — M1 least privilege (no `*`, no bedrock:/servicequotas:)', () => {
  it('grants queue consume/send, DB-secret read, and scoped gateway/outbound invoke only; never `*`', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const allPolicyJson = JSON.stringify(Object.values(policies));
    expect(allPolicyJson).toContain('secretsmanager:GetSecretValue');
    for (const action of [
      'sqs:ReceiveMessage',
      'sqs:ChangeMessageVisibility',
      'sqs:DeleteMessage',
      'sqs:GetQueueAttributes',
      'sqs:GetQueueUrl',
      'sqs:SendMessage',
    ]) {
      expect(allPolicyJson).toContain(action);
    }
    expect(allPolicyJson).toContain('lambda:InvokeFunction');
    expect(allPolicyJson).toContain('LlmGatewayFn');
    expect(allPolicyJson).not.toContain('ssm:GetParameter');
    expect(allPolicyJson).not.toContain('medadhere/anthropic');
    expect(allPolicyJson).not.toContain('medadhere/twilio');
    expect(allPolicyJson).not.toContain('bedrock:'); // D-BEDROCK-REMOVED
    expect(allPolicyJson).not.toContain('servicequotas:');

    const invokeStatements = Object.values(policies).flatMap((policy) => {
      const statements = (
        policy.Properties as {
          PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> };
        }
      ).PolicyDocument.Statement;
      return statements.filter((statement) => {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        return actions.includes('lambda:InvokeFunction');
      });
    });
    expect(invokeStatements).toHaveLength(2);
    const invokeResources = invokeStatements.map((statement) => JSON.stringify(statement.Resource));
    expect(invokeResources.some((resource) => resource.includes('LlmGatewayFn'))).toBe(true);
    expect(invokeResources.some((resource) => resource.includes('OutboundFn'))).toBe(true);

    for (const policy of Object.values(policies)) {
      const doc = (
        policy.Properties as {
          PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> };
        }
      ).PolicyDocument;
      for (const stmt of doc.Statement) {
        const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        for (const res of resources) {
          expect(res).not.toBe('*');
        }
      }
    }

    const sqsResources = Object.values(policies).flatMap((policy) => {
      const statements = (
        policy.Properties as {
          PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> };
        }
      ).PolicyDocument.Statement;
      return statements
        .filter((statement) => {
          const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
          return actions.some((action) => action.startsWith('sqs:'));
        })
        .map((statement) => JSON.stringify(statement.Resource));
    });
    expect(new Set(sqsResources).size).toBe(1); // consume and replacement-send target one queue
  });
});

describe('ClassifierConstruct — composer model config-only swap (shared with LlmGatewayConstruct)', () => {
  function classifierEnv(template: Template): Record<string, unknown> {
    const fns = template.findResources('AWS::Lambda::Function');
    const classifier = Object.values(fns).find(
      (f) =>
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables?.DB_NAME === 'medadhere',
    );
    expect(classifier).toBeDefined();
    return (
      classifier!.Properties as {
        Environment: { Variables: Record<string, unknown> };
      }
    ).Environment.Variables;
  }

  it('omits CLINICAL_COMPOSER_MODEL by default', () => {
    const { template } = synth();
    expect('CLINICAL_COMPOSER_MODEL' in classifierEnv(template)).toBe(false);
  });

  it('sets CLINICAL_COMPOSER_MODEL when the shared clinicalComposerModel context key is set', () => {
    const { template } = synth({ clinicalComposerModel: 'claude-sonnet-5' });
    expect(classifierEnv(template).CLINICAL_COMPOSER_MODEL).toBe('claude-sonnet-5');
  });
});

describe('ClassifierConstruct — frozen OnSIDES asset', () => {
  const src = readFileSync(
    nodePath.join(__dirname, '..', 'lib', 'constructs', 'classifier.ts'),
    'utf8',
  );

  it('copies the frozen v3.1.1 index beside the conversation worker bundle', () => {
    expect(src).toMatch(/mkdir -p.*assets/i);
    expect(src).toContain('onsides-labels.v3.1.1.json');
  });

  it('points the production Lambda at the patient-ordered queue worker entry', () => {
    expect(src).toContain("backend', 'src', 'conversation'");
    expect(src).toContain('queue-worker.ts');
  });
});
