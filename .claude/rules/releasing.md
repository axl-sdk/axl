---
paths:
  - "packages/*/package.json"
  - "CHANGELOG.md"
  - ".github/workflows/publish.yml"
  - ".github/scripts/extract-release-notes*"
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
a partially completed four-package release. Only after npm publishing succeeds,
a separate least-privilege job creates the GitHub Release from the matching
version section in `CHANGELOG.md` and opens an `Announcements` discussion. The
changelog remains the canonical release record; the GitHub Release is its public,
subscriber-friendly presentation.

**Get explicit approval before bumping versions or starting release mutations.** Never
commit, push, tag, merge, or publish without it.

1. Bump the version in all four `packages/*/package.json` together.
2. Move `CHANGELOG.md` `[Unreleased]` → the new version (Keep a Changelog format).
   **0.x SemVer**: patch = features *and* fixes; bump minor *only* for breaking changes.
3. `git commit -m "chore: Bump to X.Y.Z"`.
4. Merge through a PR after `Typecheck & Unit Tests (22)`, `Typecheck & Unit Tests (24)`,
   and `Lint & Format` pass. Required-check names in branch protection must match the CI
   matrix whenever supported Node versions change.
5. Wait for the post-merge `main` CI run, including `Pack Smoke Test`, to pass.
6. `git tag -a vX.Y.Z -m "<summary of key features/fixes>"` on that exact green `main`
   commit — the annotated tag message must
   summarize what's in the release, not just "Release X.Y.Z".
7. `git push origin vX.Y.Z` (the tag triggers npm publishing, then GitHub Release creation).
8. Verify all four npm packages resolve at the new version and `latest`, then verify the
   GitHub Release and linked announcement discussion exist.

The workflow is idempotent: npm versions and an existing GitHub Release are
skipped. If a transient step fails, rerun the workflow first. If a source or
workflow fix is required before any GitHub Release exists, merge the fix, then
delete and recreate the tag on the corrected commit; already-published npm
packages remain safely skipped:
```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
```

Once a GitHub Release exists, do not move or recreate its tag; ship corrections
as a new patch version. The current version's source of truth is
`packages/*/package.json` + the latest git tag. Release prose comes from the
matching version section in `CHANGELOG.md`; don't maintain a second hand-written
copy.
