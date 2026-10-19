import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const CDK_OUT_BASE_ENV = 'MEDADHERE_CDK_OUT_BASE';

export function pruneStaleCdkTmp(
  tmpDir: string,
  opts?: { maxAgeMs?: number; now?: number },
): string[] {
  const maxAgeMs = opts?.maxAgeMs ?? 60 * 60 * 1000;
  const now = opts?.now ?? Date.now();
  const removed: string[] = [];
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    try {
      const matchesCdkOutdir =
        entry.name.startsWith('cdk.out') || entry.name.startsWith('medadhere-cdk-vitest-');
      if (!entry.isDirectory() || !matchesCdkOutdir) {
        continue;
      }

      const entryPath = path.join(tmpDir, entry.name);
      const { mtimeMs } = fs.statSync(entryPath);
      if (mtimeMs >= now - maxAgeMs) {
        continue;
      }

      fs.rmSync(entryPath, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // A concurrent process may remove or replace a temporary entry.
    }
  }

  return removed;
}

export function assignWorkerCdkOutdir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env[CDK_OUT_BASE_ENV] ?? path.join(os.tmpdir(), 'medadhere-cdk-vitest-fallback');
  const outdir = path.join(base, `worker-${env.VITEST_POOL_ID ?? '0'}`);
  env.CDK_OUTDIR = outdir;
  return outdir;
}

export default function setupCdkOutdir(): () => void {
  pruneStaleCdkTmp(os.tmpdir());
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'medadhere-cdk-vitest-'));
  process.env[CDK_OUT_BASE_ENV] = base;

  return () => {
    fs.rmSync(base, { recursive: true, force: true });
  };
}
