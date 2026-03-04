import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');

function packAndList(pkgDir: string): string[] {
  const tmpDir = mkdtempSync(join(tmpdir(), 'axl-smoke-'));
  execSync(`pnpm pack --pack-destination ${tmpDir}`, { cwd: pkgDir, stdio: 'pipe' });
  const tarballs = readdirSync(tmpDir).filter((f) => f.endsWith('.tgz'));
  expect(tarballs.length).toBe(1);
  const tarball = join(tmpDir, tarballs[0]);
  const listing = execSync(`tar -tf ${tarball}`, { encoding: 'utf-8' });
  return listing.split('\n').filter(Boolean);
}

describe('Smoke: Package Tarballs', () => {
  it('@axlsdk/axl tarball contains required dist files', () => {
    const files = packAndList(join(ROOT, 'packages/axl'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.js'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.cjs'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.d.ts'));
    expect(files).toContainEqual(expect.stringContaining('package.json'));

    // No source files or secrets
    const hasSrc = files.some((f) => f.includes('/src/'));
    const hasEnv = files.some((f) => f.includes('.env'));
    const hasTsconfig = files.some((f) => f.endsWith('tsconfig.json'));
    expect(hasSrc).toBe(false);
    expect(hasEnv).toBe(false);
    expect(hasTsconfig).toBe(false);
  });

  it('@axlsdk/testing tarball contains required dist files', () => {
    const files = packAndList(join(ROOT, 'packages/axl-testing'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.js'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.cjs'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.d.ts'));
    expect(files).toContainEqual(expect.stringContaining('package.json'));

    const hasSrc = files.some((f) => f.includes('/src/'));
    expect(hasSrc).toBe(false);
  });

  it('@axlsdk/eval tarball contains required dist files and CLI', () => {
    const files = packAndList(join(ROOT, 'packages/axl-eval'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.js'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.cjs'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.d.ts'));
    expect(files).toContainEqual(expect.stringContaining('dist/cli.js'));
    expect(files).toContainEqual(expect.stringContaining('package.json'));

    const hasSrc = files.some((f) => f.includes('/src/'));
    expect(hasSrc).toBe(false);
  });

  it('@axlsdk/studio tarball contains server, CLI, and client', () => {
    const files = packAndList(join(ROOT, 'packages/axl-studio'));
    expect(files).toContainEqual(expect.stringContaining('dist/server/index.js'));
    expect(files).toContainEqual(expect.stringContaining('dist/cli.js'));
    expect(files).toContainEqual(expect.stringContaining('dist/client/index.html'));
    expect(files).toContainEqual(expect.stringContaining('package.json'));

    const hasSrc = files.some((f) => f.includes('/src/'));
    const hasEnv = files.some((f) => f.includes('.env'));
    expect(hasSrc).toBe(false);
    expect(hasEnv).toBe(false);
  });
});
