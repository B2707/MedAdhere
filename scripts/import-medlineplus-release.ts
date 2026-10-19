import {
  medlinePlusPassageBudget,
  sourceReleaseManifestSchema,
  type SourceReleaseManifest,
} from '@medadhere/shared';
import { z } from 'zod';
import {
  FrozenReleaseVerificationError,
  activateVerifiedSource,
  insertEvidenceRecords,
  releaseChecksum,
  runSourceImportCli,
  runSourceImportMain,
  verifyFrozenFile,
  type SourceImportCliConfig,
  type SourceImportCliDeps,
  type SourceImportClient,
} from './source-release-import.js';

interface NodeRequire {
  (id: string): unknown;
  main?: unknown;
}
declare const require: NodeRequire;
declare const module: unknown;
const { JSDOM } = require('jsdom') as {
  JSDOM: new (input?: string, options?: { contentType?: string }) => { window: Window };
};

const topicSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    url: z.string().url().max(2_048),
    language: z.enum(['English', 'Spanish']),
    summary: z.string(),
  })
  .strict()
  .refine((topic) => topic.url.startsWith('https://medlineplus.gov/'), {
    message: 'topic URL must be on MedlinePlus.gov',
  });

const MAX_TAGS = 32;
const INSERT_CHUNK_SIZE = 1_000;

interface MedlinePlusEvidence {
  readonly code: string;
  readonly language: 'en' | 'es';
  readonly passage: string;
  readonly sourceUrl: string;
  readonly tags: readonly string[];
}

export interface FrozenMedlinePlusRelease {
  readonly manifest: SourceReleaseManifest;
  readonly checksumSha256: string;
  readonly topicCount: number;
  readonly evidence: readonly MedlinePlusEvidence[];
}

function normalizedText(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function directElements(topic: Element, tagName: string): Element[] {
  return Array.from(topic.children).filter((child) => child.tagName === tagName);
}

function chunks(value: string, maxChars: number): readonly string[] {
  const words = value.split(' ');
  const output: string[] = [];
  let current = '';
  for (const word of words) {
    if (Array.from(word).length > maxChars) {
      throw new FrozenReleaseVerificationError('one summary token exceeds the passage bound');
    }
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (Array.from(candidate).length <= maxChars) {
      current = candidate;
    } else {
      output.push(current);
      current = word;
    }
  }
  return current.length === 0 ? output : [...output, current];
}

function normalizedTag(value: string): string {
  return normalizedText(value).toLowerCase();
}

function topicTags(topic: Element, topicId: string, title: string): readonly string[] {
  const descriptors = Array.from(topic.getElementsByTagName('descriptor')).flatMap((descriptor) => {
    const id = normalizedTag(descriptor.getAttribute('id') ?? '');
    return id.length === 0 ? [] : [`condition:mesh:${id}`];
  });
  const synonyms = [
    ...directElements(topic, 'also-called'),
    ...directElements(topic, 'see-reference'),
  ].flatMap((element) => {
    const value = normalizedTag(element.textContent ?? '');
    return value.length === 0 ? [] : [`synonym:${value}`];
  });
  const related = directElements(topic, 'related-topic').flatMap((element) => {
    const id = normalizedTag(element.getAttribute('id') ?? '');
    return id.length === 0 ? [] : [`related:medlineplus:${id}`];
  });
  const mapped = directElements(topic, 'language-mapped-topic').flatMap((element) => {
    const id = normalizedTag(element.getAttribute('id') ?? '');
    return id.length === 0 ? [] : [`medlineplus:${id}`];
  });
  return Array.from(
    new Set([
      `condition:medlineplus:${normalizedTag(topicId)}`,
      ...descriptors,
      `title:${normalizedTag(title)}`,
      ...synonyms,
      ...related,
      ...mapped,
    ]),
  ).slice(0, MAX_TAGS);
}

function parseTopics(bytes: Buffer): readonly {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly language: 'en' | 'es';
  readonly summary: string;
  readonly tags: readonly string[];
}[] {
  let document: Document;
  try {
    document = new JSDOM(bytes.toString('utf8'), { contentType: 'application/xml' }).window
      .document;
  } catch {
    throw new FrozenReleaseVerificationError('health-topic XML is malformed');
  }
  if (document.documentElement.tagName !== 'health-topics') {
    throw new FrozenReleaseVerificationError('health-topic XML has the wrong root element');
  }
  const topicElements = Array.from(document.getElementsByTagName('health-topic'));
  const declaredTotal = Number(document.documentElement.getAttribute('total'));
  if (!Number.isInteger(declaredTotal) || declaredTotal !== topicElements.length) {
    throw new FrozenReleaseVerificationError('health-topic XML declared total is inconsistent');
  }
  const htmlDocument = new JSDOM('').window.document;
  const topics = topicElements.map((topic) => {
    const summaryElement = directElements(topic, 'full-summary')[0];
    htmlDocument.body.innerHTML = summaryElement?.textContent ?? '';
    const parsed = topicSchema.safeParse({
      id: topic.getAttribute('id'),
      title: topic.getAttribute('title'),
      url: topic.getAttribute('url'),
      language: topic.getAttribute('language'),
      summary: normalizedText(htmlDocument.body.textContent),
    });
    if (!parsed.success) {
      throw new FrozenReleaseVerificationError('health topic is missing reviewed required fields');
    }
    return {
      id: parsed.data.id,
      title: parsed.data.title,
      url: parsed.data.url,
      language: parsed.data.language === 'English' ? ('en' as const) : ('es' as const),
      summary: parsed.data.summary,
      tags: topicTags(topic, parsed.data.id, parsed.data.title),
    };
  });
  if (new Set(topics.map((topic) => topic.id)).size !== topics.length) {
    throw new FrozenReleaseVerificationError('health-topic XML contains duplicate topic IDs');
  }
  return topics;
}

/** Verify the exact NLM XML, terms, and transformation before producing bounded evidence rows. */
export function loadFrozenMedlinePlusRelease(
  repositoryRoot: string,
  value: unknown,
): FrozenMedlinePlusRelease {
  const manifest = sourceReleaseManifestSchema.parse(value);
  if (manifest.source !== 'medlineplus' || manifest.activation.status !== 'active') {
    throw new FrozenReleaseVerificationError('manifest is not an active MedlinePlus release');
  }
  for (const licence of manifest.licences) {
    verifyFrozenFile(repositoryRoot, licence.termsSnapshotPath!, licence.termsSnapshotSha256!);
  }
  const transformation = manifest.provenance.transformation;
  if (transformation.status !== 'applied') {
    throw new FrozenReleaseVerificationError('MedlinePlus requires the reviewed field transform');
  }
  verifyFrozenFile(repositoryRoot, transformation.scriptPath!, transformation.scriptSha256!);

  const topicGroups = manifest.files.map((file) => {
    if (file.kind !== 'raw' || file.rowCount === null) {
      throw new FrozenReleaseVerificationError(
        'MedlinePlus release files must be raw with row counts',
      );
    }
    const topics = parseTopics(
      verifyFrozenFile(repositoryRoot, file.path, file.sha256, file.bytes),
    );
    if (topics.length !== file.rowCount) {
      throw new FrozenReleaseVerificationError('MedlinePlus topic row count does not match');
    }
    return topics;
  });
  const topics = topicGroups.flat();
  if (new Set(topics.map((topic) => topic.id)).size !== topics.length) {
    throw new FrozenReleaseVerificationError(
      'release files contain duplicate MedlinePlus topic IDs',
    );
  }
  const evidence = topics.flatMap((topic) =>
    chunks(topic.summary, medlinePlusPassageBudget(topic.language, topic.url)).map(
      (passage, index) => ({
        code: `medlineplus-${topic.id}-${index + 1}`,
        language: topic.language,
        passage,
        sourceUrl: topic.url,
        tags: topic.tags,
      }),
    ),
  );
  return Object.freeze({
    manifest,
    checksumSha256: releaseChecksum(manifest),
    topicCount: topics.length,
    evidence: Object.freeze(evidence),
  });
}

async function insertEvidence(
  client: SourceImportClient,
  releaseId: string,
  evidence: readonly MedlinePlusEvidence[],
): Promise<void> {
  await insertEvidenceRecords(
    client,
    releaseId,
    evidence.map((row) => ({
      ...row,
      kind: 'medlineplus',
      coverageState: 'direct_evidence',
    })),
    INSERT_CHUNK_SIZE,
  );
}

export type MedlinePlusImportResult =
  | { readonly mode: 'dry-run'; readonly topics: number; readonly evidence: number }
  | {
      readonly mode: 'applied';
      readonly releaseId: string;
      readonly topics: number;
      readonly evidence: number;
    };

export async function activateMedlinePlusRelease(
  client: SourceImportClient,
  bundle: FrozenMedlinePlusRelease,
  apply = false,
): Promise<MedlinePlusImportResult> {
  const counts = { topics: bundle.topicCount, evidence: bundle.evidence.length };
  if (!apply) return { mode: 'dry-run', ...counts };
  const releaseId = await activateVerifiedSource({
    client,
    manifest: bundle.manifest,
    checksumSha256: bundle.checksumSha256,
    insertRows: (id) => insertEvidence(client, id, bundle.evidence),
  });
  return { mode: 'applied', releaseId, ...counts };
}

export async function runMedlinePlusImportCli(
  argv: readonly string[],
  deps: SourceImportCliDeps<MedlinePlusImportResult>,
): Promise<number> {
  return runSourceImportCli(argv, deps, MEDLINEPLUS_CLI);
}

const MEDLINEPLUS_CLI: SourceImportCliConfig<FrozenMedlinePlusRelease, MedlinePlusImportResult> = {
  label: 'medlineplus-import',
  load: loadFrozenMedlinePlusRelease,
  apply: (client, bundle) => activateMedlinePlusRelease(client, bundle, true),
  dryRunLines: (bundle) => [
    `[medlineplus-import] dry-run verified: topics=${bundle.topicCount} evidence=${bundle.evidence.length}; no database writes`,
    '[medlineplus-import] pass --apply to activate this exact verified release',
  ],
  appliedLine: (result) =>
    `[medlineplus-import] applied: topics=${result.topics} evidence=${result.evidence}`,
};

if (typeof require !== 'undefined' && require.main === module) {
  void runSourceImportMain(process.argv.slice(2), MEDLINEPLUS_CLI).then(
    (exitCode) => (process.exitCode = exitCode),
  );
}
