import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { join } from 'node:path';
import { Construct } from 'constructs';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/**
 * Wave 1b: the gateway serves the interpretation stage AND the new composition stage, so
 * invocations double. Memory is reviewed up from the 128 MB default (Anthropic SDK + zod
 * parse of full-conversation payloads), and reserved concurrency fences the function so a
 * redrive storm can never starve the account's unreserved pool — or exceed the provider
 * rate limit — while still covering both stages for the research-scale cohort.
 *
 * DEPLOY-TIME CAVEAT: Lambda requires the account's UNRESERVED pool to stay >= 100 after any
 * reservation, so the default reservation of 10 deploys only when the account concurrency
 * limit is >= 110. THIS account's total limit is 10 (new-account floor, measured 2026-08-16),
 * so `infra/cdk.json` pins `gatewayReservedConcurrency: 0` — the escape hatch is part of the
 * checked-in configuration, not an operator-remembered CLI flag whose omission rolls the whole
 * stack update back. Raise the account quota first, then delete that context line to restore
 * the fence. `-c gatewayReservedConcurrency=N` still overrides for a one-off deploy.
 */
const GATEWAY_MEMORY_MB = 512;
const GATEWAY_RESERVED_CONCURRENCY = 10;
export const GATEWAY_RESERVED_CONCURRENCY_CONTEXT_KEY = 'gatewayReservedConcurrency';

/**
 * Owner decision #2 (2026-08-16): the composer model is a config-only swap (Haiku default in
 * code, no code change needed to move to Sonnet). Shared by BOTH the gateway and the FIFO
 * worker construct (classifier.ts) so `-c clinicalComposerModel=...` sets the SAME
 * CLINICAL_COMPOSER_MODEL env var on both Lambdas in one deploy. Unset by default: the env var
 * is omitted entirely and each runtime's own resolver applies the Haiku default.
 */
export const CLINICAL_COMPOSER_MODEL_CONTEXT_KEY = 'clinicalComposerModel';

export interface LlmGatewayConstructProps {
  readonly anthropicSecret: secretsmanager.ISecret;
}

function resolveReservedConcurrency(scope: Construct): number {
  const raw: unknown = scope.node.tryGetContext(GATEWAY_RESERVED_CONCURRENCY_CONTEXT_KEY);
  if (raw === undefined) return GATEWAY_RESERVED_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${GATEWAY_RESERVED_CONCURRENCY_CONTEXT_KEY} must be a non-negative integer`);
  }
  return parsed;
}

/** Returns the context-set composer model, or undefined when unset (env var omitted). */
export function resolveComposerModelContext(scope: Construct): string | undefined {
  const raw: unknown = scope.node.tryGetContext(CLINICAL_COMPOSER_MODEL_CONTEXT_KEY);
  return typeof raw === 'string' ? raw : undefined;
}

/** Secret-isolated, invoke-only Anthropic boundary. Deliberately has no VPC or public endpoint. */
export class LlmGatewayConstruct extends Construct {
  public readonly fn: NodejsFunction;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: LlmGatewayConstructProps) {
    super(scope, id);

    this.logGroup = new logs.LogGroup(this, 'GatewayLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const reservedConcurrency = resolveReservedConcurrency(this);
    const composerModel = resolveComposerModelContext(this);
    this.fn = new NodejsFunction(this, 'GatewayFn', {
      entry: join(REPO_ROOT, 'backend', 'src', 'conversation', 'gateway-handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(60),
      memorySize: GATEWAY_MEMORY_MB,
      ...(reservedConcurrency === 0 ? {} : { reservedConcurrentExecutions: reservedConcurrency }),
      logGroup: this.logGroup,
      environment: {
        ANTHROPIC_SECRET_ARN: props.anthropicSecret.secretArn,
        ...(composerModel === undefined ? {} : { CLINICAL_COMPOSER_MODEL: composerModel }),
      },
    });
    props.anthropicSecret.grantRead(this.fn);
  }
}
