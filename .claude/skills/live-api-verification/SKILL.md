---
name: live-api-verification
description: Close Axl provider-facing verification gaps with bounded, cost-conscious live API tests. Use after implementation or review leaves NEEDS-LIVE-API-VERIFICATION findings or acceptance criteria that MockProvider cannot establish, including effort/thinking mapping, streaming wire behavior, providerMetadata round-trips, structured output, tool calls, usage, or cost accounting.
disable-model-invocation: true
---

# Live API Verification

Turn one canonical provider-gated checklist into reproducible evidence. Verify
only the affected scenarios; do not invent a broad provider matrix.

## Establish the boundary

Read `CLAUDE.md`, `.claude/rules/testing.md`, the affected provider rule and
adapter, root/package scripts, and the existing integration test before running
anything. Do not guess commands, supported models, request fields, or what a
mock proves.

Use the smallest verification tier that reaches the real boundary:

- `MockProvider` for SDK-owned transformation and orchestration behavior.
- Existing provider integration tests for request/response wire behavior.
- A new focused integration case only when the affected behavior lacks one.

Never print API keys or `.env` contents. Use only credentials already available
to the worktree. If the required key is absent, record the exact blocked
provider and test instead of weakening the assertion or silently substituting a
different provider.

## Run bounded live checks

Prefer the narrow package integration script when one exists; otherwise use the
repo command documented in `package.json`:

```bash
pnpm -F @axlsdk/<package> test:integration
pnpm test:integration
```

Reuse the existing cheapest supported model and tiny payload conventions. Do
not expand to an unbounded provider/model matrix. Ask before introducing a new
paid provider, materially increasing request count, or exercising an external
tool with real side effects.

For each checklist item:

1. Record the provider/model, exact scenario, expected behavior, and test seam.
2. Confirm the test discriminates against the broken condition.
3. Run the narrowest live command and capture the pass/fail evidence without
   secrets or raw sensitive payloads.
4. If it fails, determine whether the SDK, provider contract, model capability,
   credentials, rate limit, or environment is responsible before changing code.
5. Re-run after fixes and keep residual provider/model limits explicit.

## Close the checklist

Update the plan's in-progress live-API table, or the review-local checklist,
with scenario, provider/model, command/test, result, and remaining risk. Finish
with a direct verdict: live-verified, verified with named provider/model limits,
changes required, or blocked on named credentials/access.
