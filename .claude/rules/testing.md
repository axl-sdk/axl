---
paths:
  - "**/__tests__/**"
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.test-d.ts"
  - "tests/**"
---

# Testing

Vitest everywhere. **All tests use `MockProvider` — no real API keys.** Test behavior, not
implementation details.

- **Inline/unit tests** live in each package's `src/__tests__/`. Cross-package scenarios
  live in the `tests/` workspace: `tests/e2e/`, `tests/studio/`, `tests/smoke/` (tarball
  content validation via `pnpm pack`).
- **Run from the repo root**: `pnpm test` (all), `pnpm test:e2e | test:studio | test:smoke`,
  `pnpm test:watch`, `pnpm -r test`.
- **Live-API integration tests** are gated `describe.skipIf(!process.env.<PROVIDER>_API_KEY)`
  and excluded from the default run. Routine, repeatable coverage fires via
  `pnpm test:integration`; use the **cheapest model and tiny payloads**. Expensive exact-model
  certification fires only via `pnpm test:integration:frontier`. Each package with live tests
  has an integration config that loads the repo-root `.env`.
- **Studio React tests** opt into jsdom with a per-file `// @vitest-environment jsdom`
  directive; `setup-dom.ts` loads jest-dom matchers + RTL `cleanup` only when a DOM is
  present.
- **Type-level tests** are `*.test-d.ts` (e.g. the `AxlEvent` exhaustiveness fixture).
- New behavior ⇒ a test that fails before the fix and passes after. `MockProvider` modes:
  sequence / echo / json / replay / fn. Use `AxlTestRuntime` to mirror prod — it threads the
  same `config`, so `trace.level` / `trace.redact` behave identically in tests.
- Before adding tests around a new internal path, trace a production caller. A green test over
  unreachable code does not prove the feature works.
- When a persisted schema becomes stricter or required, run the relevant cross-package e2e and
  store-specific integration gate where available. If required services or credentials are
  unavailable, report that gate instead of presenting unit coverage as persistence proof.

Deep guide + assertion helpers: `docs/testing.md`.
