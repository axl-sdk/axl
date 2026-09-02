import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractReleaseNotes(changelog, version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }

  const heading = new RegExp(
    `^## \\[${escapeRegExp(version)}\\](?: - \\d{4}-\\d{2}-\\d{2})?\\s*$`,
    'm',
  );
  const match = heading.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md has no section for ${version}`);

  const remainder = changelog.slice(match.index + match[0].length);
  const nextVersion = remainder.search(/^## \[/m);
  const notes = (nextVersion === -1 ? remainder : remainder.slice(0, nextVersion)).trim();
  if (!notes) throw new Error(`CHANGELOG.md section for ${version} is empty`);
  return `${notes}\n`;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  const version = process.argv[2];
  if (!version) throw new Error('Usage: extract-release-notes.mjs <version> [changelog-path]');
  const changelogPath = process.argv[3] ?? 'CHANGELOG.md';
  process.stdout.write(extractReleaseNotes(readFileSync(changelogPath, 'utf8'), version));
}
