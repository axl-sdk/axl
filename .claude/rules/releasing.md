---
paths:
  - "packages/*/package.json"
  - "CHANGELOG.md"
---

# Releasing

Publishing is **tag-triggered** (`.github/workflows/publish.yml`, needs the `NPM_TOKEN`
secret). All four packages share one version and publish together under `@axlsdk`;
cross-deps use `workspace:*` (pnpm resolves them at publish time).

**Get explicit approval before bumping versions or pushing a tag.** Never commit, push, or
tag without it.

1. Bump the version in all four `packages/*/package.json` together.
2. Move `CHANGELOG.md` `[Unreleased]` → the new version (Keep a Changelog format).
   **0.x SemVer**: patch = features *and* fixes; bump minor *only* for breaking changes.
3. `git commit -m "chore: Bump to X.Y.Z"`.
4. `git tag -a vX.Y.Z -m "<summary of key features/fixes>"` — the annotated tag message must
   summarize what's in the release, not just "Release X.Y.Z".
5. `git push && git push origin vX.Y.Z` (the tag triggers publish).

If publish fails, delete and recreate the tag:
```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
```

CI required before merge: `Typecheck & Unit Tests (20)`, `Typecheck & Unit Tests (22)`,
`Lint & Format` (Node 20 + 22 matrix). The current version's source of truth is
`packages/*/package.json` + the latest git tag — don't trust a number written elsewhere.
