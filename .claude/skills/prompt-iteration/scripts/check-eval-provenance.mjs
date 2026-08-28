#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_PACKAGES = ['@axlsdk/axl', '@axlsdk/eval'];

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: check-eval-provenance.mjs [--from <directory>] [--package <name>]...\n',
  );
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const options = { from: process.cwd(), packages: [...DEFAULT_PACKAGES] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') usage();
    if (argument === '--from') {
      const value = argv[++index];
      if (!value) usage('--from requires a directory');
      options.from = path.resolve(value);
      continue;
    }
    if (argument === '--package') {
      const value = argv[++index];
      if (!value) usage('--package requires a package name');
      options.packages.push(value);
      continue;
    }
    usage(`Unknown argument: ${argument}`);
  }
  options.packages = [...new Set(options.packages)];
  return options;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').toString().trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function git(repoRoot, args) {
  return run('git', ['-C', repoRoot, ...args], repoRoot);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

function resolvePackage(packageName, from) {
  const source = 'process.stdout.write(import.meta.resolve(process.argv[1]))';
  return run(process.execPath, ['--input-type=module', '--eval', source, packageName], from).trim();
}

function inspectPackage(packageName, from, repoRoot, blockers) {
  let resolvedUrl;
  try {
    resolvedUrl = resolvePackage(packageName, from);
  } catch (error) {
    blockers.push(`Could not resolve ${packageName} from ${from}: ${error.message}`);
    return { name: packageName, resolved: null };
  }

  if (!resolvedUrl.startsWith('file:')) {
    blockers.push(`${packageName} resolved to a non-file URL: ${resolvedUrl}`);
    return { name: packageName, resolved: resolvedUrl };
  }

  const resolved = realpathSync(new URL(resolvedUrl));
  if (!isInside(repoRoot, resolved)) {
    blockers.push(`${packageName} resolves outside this checkout: ${resolved}`);
  }
  return { name: packageName, resolved };
}

function resolveEvalCli(repoRoot, blockers) {
  const packageRoot = path.join(repoRoot, 'packages', 'axl-eval');
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== '@axlsdk/eval') {
    blockers.push(`${packageRoot}/package.json does not declare @axlsdk/eval.`);
    return null;
  }
  const bin = manifest.bin;
  const relativeTarget = typeof bin === 'string' ? bin : bin?.['axl-eval'];
  if (!relativeTarget) {
    blockers.push('@axlsdk/eval does not declare an axl-eval binary.');
    return null;
  }

  const candidate = path.resolve(packageRoot, relativeTarget);
  if (!existsSync(candidate)) {
    blockers.push(`axl-eval target does not exist; build @axlsdk/eval first: ${candidate}`);
    return candidate;
  }
  const target = realpathSync(candidate);
  if (!isInside(repoRoot, target)) {
    blockers.push(`axl-eval target resolves outside this checkout: ${target}`);
  }
  return target;
}

function gitFingerprint(repoRoot) {
  const head = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  const diff = git(repoRoot, ['diff', '--binary', 'HEAD']);
  const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .sort();
  const hash = createHash('sha256');
  hash.update(`HEAD\0${head}\0DIFF\0${diff}\0UNTRACKED\0`);
  for (const relativePath of untracked) {
    const absolutePath = path.join(repoRoot, relativePath);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(
      lstatSync(absolutePath).isSymbolicLink()
        ? `symlink:${readlinkSync(absolutePath)}`
        : readFileSync(absolutePath),
    );
    hash.update('\0');
  }

  return {
    head,
    sha256: hash.digest('hex'),
    changedPaths: git(repoRoot, ['status', '--short']).trim().split('\n').filter(Boolean),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const from = realpathSync(options.from);
  const repoRoot = realpathSync(run('git', ['rev-parse', '--show-toplevel'], from).trim());
  const blockers = [];
  const packages = options.packages.map((packageName) =>
    inspectPackage(packageName, from, repoRoot, blockers),
  );
  const cliTarget = resolveEvalCli(repoRoot, blockers);

  const result = {
    status: blockers.length === 0 ? 'ok' : 'blocked',
    repoRoot,
    from,
    packages,
    cliTarget,
    fingerprint: gitFingerprint(repoRoot),
    blockers,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (blockers.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
