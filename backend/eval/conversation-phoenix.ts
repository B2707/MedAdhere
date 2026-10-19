import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  freezeConversationReviewBundle,
  type ConversationReviewBundleItem,
  type FrozenConversationReviewBundle,
} from './lib/conversation-review-bundle.js';
import {
  CONVERSATION_SCORER_VERSION,
  SEMANTIC_REVIEW_REQUIRED_METRICS,
  scoreConversationTurn,
} from './lib/conversation-scoring.js';
import {
  SONNET_CANDIDATE_CONFIGS,
  type SonnetCandidateConfigId,
} from './lib/conversation-runner.js';

const DEFAULT_PHOENIX_ENDPOINT = 'http://127.0.0.1:6006';
const DEV_V2_CORPUS_SHA256 = 'afdfbff857e8452e0c80f65a9c73fa936579cf43777d292027f5309848be798a';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const CANDIDATE_DERIVED_INPUT_KEYS = new Set([
  'currentDayMessages',
  'pendingClarification',
  'pendingClarificationTopic',
  'promptVersion',
  'recentObservations',
]);

interface PhoenixDatasetUpload {
  readonly action: 'update' | 'create';
  readonly name: string;
  readonly description: string;
  readonly inputs: readonly Readonly<Record<string, unknown>>[];
  readonly outputs: readonly Readonly<Record<string, unknown>>[];
  readonly metadata: readonly Readonly<Record<string, unknown>>[];
  readonly splits: readonly string[];
  readonly example_ids: readonly string[];
}

interface PhoenixResponseBody {
  readonly data: { readonly dataset_id: string };
}

export interface PhoenixConversationUploadOptions {
  readonly endpoint?: string;
  readonly confirmSynthetic: boolean;
  readonly fetcher?: typeof fetch;
}

export interface PhoenixConversationExperimentOptions extends PhoenixConversationUploadOptions {
  readonly candidateConfigId: SonnetCandidateConfigId;
}

export interface PhoenixConversationCliDeps {
  readonly fetcher?: typeof fetch;
  readonly logCode: (code: string) => void;
}

export class PhoenixConversationError extends Error {
  override readonly name = 'PhoenixConversationError';
}

interface PhoenixConversationScenario {
  readonly scenarioId: string;
  readonly items: readonly ConversationReviewBundleItem[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertLocalEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new PhoenixConversationError('Phoenix endpoint must be a loopback HTTP origin');
  }
  return url;
}

function readFrozenBundle(path: string): FrozenConversationReviewBundle {
  if ((statSync(path).mode & 0o777) !== 0o600) {
    throw new PhoenixConversationError('conversation review bundle must use mode 0600');
  }
  const document = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(document) || !Array.isArray(document.items)) {
    throw new PhoenixConversationError('conversation review bundle is not canonical');
  }
  const items = document.items as readonly ConversationReviewBundleItem[];
  for (const item of items) {
    if (
      !isRecord(item) ||
      typeof item.scenarioId !== 'string' ||
      !/^conv-dev-\d{3}$/u.test(item.scenarioId) ||
      typeof item.turnId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.turnId)
    ) {
      throw new PhoenixConversationError('only canonical synthetic dev turns may be uploaded');
    }
  }
  const { expiresAtUtc, evalSetVersion, partition, corpusSha256 } = document;
  if (
    document.schemaVersion !== 2 ||
    evalSetVersion !== 'v2' ||
    partition !== 'dev' ||
    corpusSha256 !== DEV_V2_CORPUS_SHA256 ||
    typeof expiresAtUtc !== 'string'
  ) {
    throw new PhoenixConversationError('conversation review bundle is not canonical');
  }
  const frozen = freezeConversationReviewBundle(
    items.map(({ scenarioId, turnId, preparedTurnInput, turnResult, expectation }) => ({
      scenarioId,
      turnId,
      preparedTurnInput,
      turnResult,
      expectation,
    })),
    expiresAtUtc,
    { evalSetVersion, partition, corpusSha256 },
  );
  if (JSON.stringify(document) !== frozen.serialized) {
    throw new PhoenixConversationError('conversation review bundle is not canonical');
  }
  return frozen;
}

function requireCurrentDevBundle(frozen: FrozenConversationReviewBundle): void {
  if (
    frozen.bundle.schemaVersion !== 2 ||
    frozen.bundle.evalSetVersion !== 'v2' ||
    frozen.bundle.partition !== 'dev' ||
    frozen.bundle.corpusSha256 !== DEV_V2_CORPUS_SHA256
  ) {
    throw new PhoenixConversationError('only the locked v2 development corpus may be uploaded');
  }
}

function groupConversationScenarios(
  items: readonly ConversationReviewBundleItem[],
): readonly PhoenixConversationScenario[] {
  return [...new Set(items.map(({ scenarioId }) => scenarioId))].map((scenarioId) => ({
    scenarioId,
    items: items.filter((item) => item.scenarioId === scenarioId),
  }));
}

function fixedScenarioTurn({
  turnId,
  preparedTurnInput,
}: ConversationReviewBundleItem): Readonly<Record<string, unknown>> {
  const fixedInput = Object.fromEntries(
    Object.entries(preparedTurnInput).filter(([key]) => !CANDIDATE_DERIVED_INPUT_KEYS.has(key)),
  );
  return { turnId, ...fixedInput };
}

function uniqueValues<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

export function buildPhoenixConversationDataset(
  frozen: FrozenConversationReviewBundle,
  action: 'update' | 'create' = 'update',
): PhoenixDatasetUpload {
  requireCurrentDevBundle(frozen);
  if (
    frozen.bundle.items.length === 0 ||
    frozen.bundle.items.some(({ scenarioId }) => !/^conv-dev-\d{3}$/u.test(scenarioId))
  ) {
    throw new PhoenixConversationError('only non-empty synthetic dev bundles may be uploaded');
  }
  const scenarios = groupConversationScenarios(frozen.bundle.items);
  const inputs = scenarios.map(({ items }) => ({
    conversationScenarioInput: {
      initialContext: {
        currentDayMessages: items[0]!.preparedTurnInput.currentDayMessages,
        pendingClarification: items[0]!.preparedTurnInput.pendingClarification,
        pendingClarificationTopic: items[0]!.preparedTurnInput.pendingClarificationTopic,
        recentObservations: items[0]!.preparedTurnInput.recentObservations,
      },
      turns: items.map(fixedScenarioTurn),
    },
  }));
  const outputs = scenarios.map(({ items }) => ({
    conversationScenarioReference: {
      turns: items.map(({ turnId, expectation }) => ({ turnId, expectation })),
    },
  }));
  const metadata = scenarios.map(({ scenarioId, items }) => {
    const expectations = items.map(({ expectation }) => expectation);
    return {
      synthetic: true,
      evalSetVersion: frozen.bundle.evalSetVersion,
      corpusSha256: frozen.bundle.corpusSha256,
      scenarioId,
      turnIds: items.map(({ turnId }) => turnId),
      languages: uniqueValues(expectations.map(({ language }) => language)),
      safetySlices: uniqueValues(expectations.flatMap(({ safetySlices }) => safetySlices)),
      temporalSlices: uniqueValues(expectations.flatMap(({ temporalSlices }) => temporalSlices)),
      retrievalSlices: uniqueValues(expectations.flatMap(({ retrievalSlices }) => retrievalSlices)),
      semanticMetricIds: uniqueValues(items.flatMap(({ semanticMetricIds }) => semanticMetricIds)),
    };
  });
  const splits = scenarios.map(() => 'dev');
  const referenceHash = createHash('sha256')
    .update(JSON.stringify({ inputs, outputs, metadata, splits }), 'utf8')
    .digest('hex');
  return {
    action,
    name: 'medadhere-conversation-dev-v2',
    description: `Local synthetic MedAdhere conversation reference set; SHA-256 ${referenceHash}`,
    inputs,
    outputs,
    metadata,
    splits,
    example_ids: scenarios.map(({ scenarioId }) => scenarioId),
  };
}

interface PhoenixDatasetExample {
  readonly id: string;
  readonly nodeId: string;
  readonly metadata: {
    readonly scenarioId: string;
  };
}

function parsePhoenixDatasetExamples(value: unknown): {
  readonly versionId: string;
  readonly examples: readonly PhoenixDatasetExample[];
} {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new PhoenixConversationError('Phoenix returned invalid dataset examples');
  }
  const { version_id: versionId, examples } = value.data;
  if (typeof versionId !== 'string' || !Array.isArray(examples)) {
    throw new PhoenixConversationError('Phoenix returned invalid dataset examples');
  }
  const parsed = examples.flatMap((example) => {
    if (
      !isRecord(example) ||
      typeof example.id !== 'string' ||
      typeof example.node_id !== 'string' ||
      !isRecord(example.metadata) ||
      typeof example.metadata.scenarioId !== 'string'
    ) {
      return [];
    }
    return [
      {
        id: example.id,
        nodeId: example.node_id,
        metadata: {
          scenarioId: example.metadata.scenarioId,
        },
      },
    ];
  });
  if (parsed.length !== examples.length) {
    throw new PhoenixConversationError('Phoenix returned invalid dataset examples');
  }
  return { versionId, examples: parsed };
}

function parsePhoenixExperimentId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.data) || typeof value.data.id !== 'string') {
    throw new PhoenixConversationError('Phoenix returned an invalid experiment response');
  }
  return value.data.id;
}

const PHOENIX_UNSCORED_METRICS = new Set([
  ...SEMANTIC_REVIEW_REQUIRED_METRICS,
  'token_context_cost_ceiling',
]);

function parsePhoenixResponse(value: unknown): PhoenixResponseBody {
  if (
    !isRecord(value) ||
    !isRecord(value.data) ||
    typeof value.data.dataset_id !== 'string' ||
    value.data.dataset_id.length === 0
  ) {
    throw new PhoenixConversationError('Phoenix returned an invalid dataset response');
  }
  return { data: { dataset_id: value.data.dataset_id } };
}

export async function uploadPhoenixConversationDataset(
  frozen: FrozenConversationReviewBundle,
  options: PhoenixConversationUploadOptions,
): Promise<{
  readonly datasetId: string;
  readonly scenarioCount: number;
  readonly turnCount: number;
}> {
  if (!options.confirmSynthetic) {
    throw new PhoenixConversationError('--confirm-synthetic is required');
  }
  const endpoint = assertLocalEndpoint(options.endpoint ?? DEFAULT_PHOENIX_ENDPOINT);
  const uploadUrl = new URL('/v1/datasets/upload?sync=true', endpoint).toString();
  const fetcher = options.fetcher ?? fetch;
  const request = async (action: 'update' | 'create'): Promise<Response> =>
    fetcher(uploadUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPhoenixConversationDataset(frozen, action)),
      signal: AbortSignal.timeout(30_000),
    });

  let response = await request('update');
  if (response.status === 422 && (await response.text()).includes('Invalid dataset action')) {
    response = await request('create');
  }
  if (!response.ok) {
    throw new PhoenixConversationError(
      `Phoenix dataset upload failed with HTTP ${response.status}`,
    );
  }
  const body = parsePhoenixResponse((await response.json()) as unknown);
  return {
    datasetId: body.data.dataset_id,
    scenarioCount: groupConversationScenarios(frozen.bundle.items).length,
    turnCount: frozen.bundle.items.length,
  };
}

export async function uploadPhoenixConversationExperiment(
  frozen: FrozenConversationReviewBundle,
  options: PhoenixConversationExperimentOptions,
): Promise<{
  readonly datasetId: string;
  readonly experimentId: string;
  readonly scenarioCount: number;
  readonly turnCount: number;
}> {
  const endpoint = assertLocalEndpoint(options.endpoint ?? DEFAULT_PHOENIX_ENDPOINT);
  const fetcher = options.fetcher ?? fetch;
  const { datasetId } = await uploadPhoenixConversationDataset(frozen, options);
  const examplesUrl = new URL(
    `/v1/datasets/${encodeURIComponent(datasetId)}/examples`,
    endpoint,
  ).toString();
  const examplesResponse = await fetcher(examplesUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!examplesResponse.ok) {
    throw new PhoenixConversationError(
      `Phoenix dataset examples failed with HTTP ${examplesResponse.status}`,
    );
  }
  const { versionId, examples } = parsePhoenixDatasetExamples(
    (await examplesResponse.json()) as unknown,
  );
  const scenarios = groupConversationScenarios(frozen.bundle.items);
  const exampleIds = new Map(examples.map(({ nodeId, metadata }) => [metadata.scenarioId, nodeId]));
  if (
    examples.length !== scenarios.length ||
    exampleIds.size !== examples.length ||
    scenarios.some(({ scenarioId }) => !exampleIds.has(scenarioId))
  ) {
    throw new PhoenixConversationError('Phoenix dataset examples do not match the review bundle');
  }

  const bundleHash = createHash('sha256').update(frozen.serialized, 'utf8').digest('hex');
  const promptVersion = frozen.bundle.items[0]!.preparedTurnInput.promptVersion;
  const experimentUrl = new URL(
    `/v1/datasets/${encodeURIComponent(datasetId)}/experiments`,
    endpoint,
  ).toString();
  const experimentResponse = await fetcher(experimentUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `${options.candidateConfigId.replaceAll('_', '-')}-${promptVersion}-${CONVERSATION_SCORER_VERSION}-${bundleHash.slice(0, 12)}`,
      description: 'MedAdhere synthetic conversation candidate run',
      metadata: {
        candidateConfigId: options.candidateConfigId,
        promptVersion,
        scorerVersion: CONVERSATION_SCORER_VERSION,
        bundleSha256: bundleHash,
      },
      version_id: versionId,
      splits: ['dev'],
      repetitions: 1,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!experimentResponse.ok) {
    throw new PhoenixConversationError(
      `Phoenix experiment creation failed with HTTP ${experimentResponse.status}`,
    );
  }
  const experimentId = parsePhoenixExperimentId((await experimentResponse.json()) as unknown);
  const runUrl = new URL(
    `/v1/experiments/${encodeURIComponent(experimentId)}/runs`,
    endpoint,
  ).toString();
  const evaluationUrl = new URL('/v1/experiment_evaluations', endpoint).toString();
  for (const { scenarioId, items } of scenarios) {
    const timestamp = new Date().toISOString();
    const response = await fetcher(runUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dataset_example_id: exampleIds.get(scenarioId),
        output: {
          conversationTurns: items.map(({ turnId, preparedTurnInput, turnResult, outputHash }) => ({
            turnId,
            preparedTurnInput,
            turnResult,
            outputHash,
          })),
        },
        repetition_number: 1,
        start_time: timestamp,
        end_time: timestamp,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new PhoenixConversationError(
        `Phoenix experiment run failed with HTTP ${response.status}`,
      );
    }
    const runId = parsePhoenixExperimentId((await response.json()) as unknown);
    const turnScores = items.map(({ expectation, turnResult }) =>
      scoreConversationTurn(expectation, turnResult),
    );
    const mechanicalMetricIds = uniqueValues(
      turnScores.flatMap((scores) =>
        Object.keys(scores).filter((metricId) => !PHOENIX_UNSCORED_METRICS.has(metricId)),
      ),
    );
    const mechanicalScores = mechanicalMetricIds.map((metricId) => {
      const applicable = turnScores.filter((scores) => Object.hasOwn(scores, metricId));
      const successes = applicable.filter(
        (scores) => scores[metricId as keyof typeof scores] === true,
      ).length;
      return {
        metricId,
        successes,
        denominator: applicable.length,
        rate: successes / applicable.length,
      };
    });
    await Promise.all(
      mechanicalScores.map(async ({ metricId, successes, denominator, rate }) => {
        const passed = successes === denominator;
        const evaluationResponse = await fetcher(evaluationUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            experiment_run_id: runId,
            name: metricId,
            annotator_kind: 'CODE',
            start_time: timestamp,
            end_time: timestamp,
            result: {
              label: passed ? 'pass' : 'fail',
              score: rate,
              explanation: null,
            },
            metadata: {
              scorerVersion: CONVERSATION_SCORER_VERSION,
              numerator: successes,
              denominator,
            },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!evaluationResponse.ok) {
          throw new PhoenixConversationError(
            `Phoenix experiment evaluation failed with HTTP ${evaluationResponse.status}`,
          );
        }
      }),
    );
  }
  return {
    datasetId,
    experimentId,
    scenarioCount: scenarios.length,
    turnCount: frozen.bundle.items.length,
  };
}

export async function runPhoenixConversationCli(
  argv: readonly string[],
  deps: PhoenixConversationCliDeps = {
    logCode: (code) => process.stdout.write(`${code}\n`),
  },
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      bundle: { type: 'string' },
      candidate: { type: 'string' },
      endpoint: { type: 'string' },
      'confirm-synthetic': { type: 'boolean' },
    },
    strict: true,
  });
  if (values.bundle === undefined) throw new PhoenixConversationError('--bundle is required');
  const candidate = values.candidate;
  if (!SONNET_CANDIDATE_CONFIGS.some(({ id }) => id === candidate)) {
    throw new PhoenixConversationError('--candidate is invalid');
  }
  if (values['confirm-synthetic'] !== true) {
    throw new PhoenixConversationError('--confirm-synthetic is required');
  }
  const result = await uploadPhoenixConversationExperiment(readFrozenBundle(values.bundle), {
    endpoint: values.endpoint,
    confirmSynthetic: true,
    candidateConfigId: candidate as SonnetCandidateConfigId,
    fetcher: deps.fetcher,
  });
  deps.logCode(
    `PHOENIX_EXPERIMENT_UPLOADED:${result.datasetId}:${result.experimentId}:${result.scenarioCount}:${result.turnCount}`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPhoenixConversationCli(process.argv.slice(2)).catch(() => {
    process.stderr.write('PHOENIX_DATASET_UPLOAD_FAILED\n');
    process.exitCode = 1;
  });
}
