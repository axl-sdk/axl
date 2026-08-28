---
paths:
  - "packages/*/package.json"
  - "CHANGELOG.md"
---

# Releasing

Publishing is **tag-triggered** through npm trusted publishing
(`.github/workflows/publish.yml`). Each of the four npm packages must trust the
GitHub Actions publisher `axl-sdk/axl` with workflow filename `publish.yml` and
the `npm publish` action allowed. No long-lived npm publish token is used. All
four packages share one version and publish together under `@axlsdk`.

The workflow packs each package with pnpm so `workspace:*` dependencies resolve
to the release version, then publishes the tarballs with the npm CLI under OIDC.
It skips package versions already present in the registry so a retry can finish
a partially completed four-package release.

**Get explicit approval before bumping versions or pushing a tag.** Never commit, push, or
tag without it.

1. Bump the version in all four `packages/*/package.json` together.
2. Move `CHANGELOG.md` `[Unreleased]` → the new version (Keep a Changelog format).
   **0.x SemVer**: patch = features *and* fixes; bump minor *only* for breaking changes.
3. `git commit -m "chore: Bump to X.Y.Z"`.
4. `git tag -a vX.Y.Z -m "<summary of key features/fixes>"` — the annotated tag message must
   summarize what's in the release, not just "Release X.Y.Z".
5. `git push && git push origin vX.Y.Z` (the tag triggers publish).

If publish fails, first check all four package versions in npm. Fix the failure,
then delete and recreate the tag; the workflow safely skips any package version
that was already published:
```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
```

CI required before merge: `Typecheck & Unit Tests (20)`, `Typecheck & Unit Tests (22)`,
`Lint & Format` (Node 20 + 22 matrix). The current version's source of truth is
`packages/*/package.json` + the latest git tag — don't trust a number written elsewhere.
