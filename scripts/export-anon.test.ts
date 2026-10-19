import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeLocalExport } from './export-anon.js';

const temporaryDirectories: string[] = [];

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'medadhere-export-'));
  temporaryDirectories.push(directory);
  return join(directory, 'export.csv');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('writeLocalExport', () => {
  it('creates a local export with owner-only 0600 permissions', () => {
    const path = temporaryPath();
    writeLocalExport(path, 'header\r\nvalue\r\n', false);
    expect(readFileSync(path, 'utf8')).toBe('header\r\nvalue\r\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite an existing export unless --force is explicit', () => {
    const path = temporaryPath();
    writeFileSync(path, 'existing', { encoding: 'utf8', mode: 0o600 });
    expect(() => writeLocalExport(path, 'replacement', false)).toThrow(/--force/i);
    expect(readFileSync(path, 'utf8')).toBe('existing');
  });

  it('replaces an existing export under --force and restores 0600 permissions', () => {
    const path = temporaryPath();
    writeFileSync(path, 'existing', { encoding: 'utf8', mode: 0o644 });
    writeLocalExport(path, 'replacement', true);
    expect(readFileSync(path, 'utf8')).toBe('replacement');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rejects symlink destinations even when --force is explicit', () => {
    const path = temporaryPath();
    const targetPath = join(path, '..', 'target.csv');
    writeFileSync(targetPath, 'sensitive-existing-data', { encoding: 'utf8', mode: 0o600 });
    symlinkSync(targetPath, path);

    expect(() => writeLocalExport(path, 'replacement', true)).toThrow(/symlink/i);
    expect(readFileSync(targetPath, 'utf8')).toBe('sensitive-existing-data');
  });

  it('rejects hard-link destinations under --force without changing the target', () => {
    const path = temporaryPath();
    const targetPath = join(path, '..', 'target.csv');
    writeFileSync(targetPath, 'sensitive-existing-data', { encoding: 'utf8', mode: 0o600 });
    linkSync(targetPath, path);

    expect(() => writeLocalExport(path, 'replacement', true)).toThrow(/single-link regular file/i);
    expect(readFileSync(targetPath, 'utf8')).toBe('sensitive-existing-data');
  });

  it('rejects a non-regular FIFO destination under --force', () => {
    const path = temporaryPath();
    execFileSync('mkfifo', [path]);
    const reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      expect(() => writeLocalExport(path, 'replacement', true)).toThrow(
        /single-link regular file/i,
      );
    } finally {
      closeSync(reader);
    }
  });
});
