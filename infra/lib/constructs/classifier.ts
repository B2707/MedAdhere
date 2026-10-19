// infra/lib/constructs/classifier.ts
//
// ClassifierConstruct is retained as the existing stack seam while 08-04a replaces its production
// EventBridge trigger with the patient-ordered SQS route:
//
//   InboundConstruct.workQueue → batch-size-one SQS event source → queue worker
//
// SQS invokes Lambda synchronously. The former EventBridge Rule, Lambda async EventInvokeConfig,
// crash DLQ, and rule-delivery DLQ therefore do not belong in this construct. The work queue owns
// one redrive DLQ, and the worker can send a uniquely keyed replacement wake to that same queue.

import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as path from 'node:path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Architecture, Runtime, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { DATABASE_NAME } from './database.js';
import { resolveComposerModelContext } from './llm-gateway.js';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const CONVERSATION_DIR = path.join(REPO_ROOT, 'backend', 'src', 'conversation');
const HANDLER_ENTRY = path.join(CONVERSATION_DIR, 'queue-worker.ts');

export interface ClassifierConstructProps {
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly db: rds.DatabaseInstance;
  readonly dbSecret: secretsmanager.ISecret;
  readonly llmGatewayFn: IFunction;
  readonly outboundFn: IFunction;
  /** Patient-keyed FIFO queue created by InboundConstruct. */
  readonly queue: sqs.IQueue;
}

export class ClassifierConstruct extends Construct {
  public readonly fn: NodejsFunction;
  /** Exposed for the existing OPS-02 metric filters. */
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ClassifierConstructProps) {
    super(scope, id);

    this.logGroup = new logs.LogGroup(this, 'ClassifierLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const composerModel = resolveComposerModelContext(this);
    this.fn = new NodejsFunction(this, 'ClassifierFn', {
      entry: HANDLER_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(180),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      logGroup: this.logGroup,
      environment: {
        LLM_GATEWAY_FN_ARN: props.llmGatewayFn.functionArn,
        OUTBOUND_FN_ARN: props.outboundFn.functionArn,
        QUEUE_URL: props.queue.queueUrl,
        DB_SECRET_ARN: props.dbSecret.secretArn,
        DB_HOST: props.db.dbInstanceEndpointAddress,
        DB_PORT: props.db.dbInstanceEndpointPort,
        DB_NAME: DATABASE_NAME,
        ...(composerModel === undefined ? {} : { CLINICAL_COMPOSER_MODEL: composerModel }),
      },
      bundling: {
        nodeModules: ['pg'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${path.join(inputDir, 'backend', 'src', 'schema-init', 'rds-global-bundle.pem')} ${outputDir}`,
            `mkdir -p ${path.join(outputDir, 'assets')} && cp ${path.join(inputDir, 'backend', 'src', 'classifier', 'assets', 'onsides-labels.v3.1.1.json')} ${path.join(outputDir, 'assets')}`,
          ],
        },
      },
    });

    props.dbSecret.grantRead(this.fn);
    props.llmGatewayFn.grantInvoke(this.fn);
    props.outboundFn.grantInvoke(this.fn);

    // Batch size one keeps a failed wake atomic: throwing leaves that one message for SQS redelivery.
    this.fn.addEventSource(
      new SqsEventSource(props.queue, {
        batchSize: 1,
        enabled: true,
      }),
    );
    // Needed only for a bounded drain's uniquely keyed replacement wake.
    props.queue.grantSendMessages(this.fn);
  }
}
