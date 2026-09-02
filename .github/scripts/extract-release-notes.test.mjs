import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractReleaseNotes } from './extract-release-notes.mjs';

const changelog = `# Changelog

## [Unreleased]

### Added

- Future work.

## [1.2.0] - 2026-09-02

### Added

- Shipped feature.

### Breaking Changes

- Requires Node.js 22.

## [1.1.0] - 2026-08-01

### Fixed

- Older fix.
`;

describe('extractReleaseNotes', () => {
  it('returns only the requested version body', () => {
    assert.equal(
      extractReleaseNotes(changelog, '1.2.0'),
      '### Added\n\n- Shipped feature.\n\n### Breaking Changes\n\n- Requires Node.js 22.\n',
    );
  });

  it('rejects invalid, missing, and empty versions', () => {
    assert.throws(() => extractReleaseNotes(changelog, '../1.2.0'), /Invalid release version/);
    assert.throws(() => extractReleaseNotes(changelog, '9.9.9'), /has no section/);
    assert.throws(
      () => extractReleaseNotes('## [1.2.0] - 2026-09-02\n\n## [1.1.0]', '1.2.0'),
      /section for 1.2.0 is empty/,
    );
  });
});
