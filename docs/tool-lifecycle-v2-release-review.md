# Tool Lifecycle v2 Release Review

Status: verified for owner release decision. This tracked checklist is the
durable handoff for the breaking tool-lifecycle and stream-first observation
release. The full frozen scenario matrix remains an internal review artifact.

## Owner decisions

- Approval continuations are in-process. State stores retain pending requests
  for operator visibility, but Axl does not replay a workflow after process
  loss. Cross-process approval requires a separate decision-claim, lease,
  checkpoint-lineage, and idempotency design.
- `runtime.resolveDecision()` removes the persisted request before releasing
  the workflow. Cleanup failure leaves the gate closed and retryable.
- `runtime.resumeExecution()` and `runtime.resumePending()` do not ship as
  misleading fail-only APIs.
- Race and quorum losers get a bounded terminal drain. The default is 5
  seconds; timeout finalizes with machine-readable incompleteness and suppresses
  later trace mutation.
- Exact start/end pairing is a complete-trace invariant, not a delivery promise
  for lossy queues, capped persistence, disconnection, or process death.
- Default queue overflow stays non-fatal, but every affected bus/stream exposes
  `observationStatus`. Strict overflow stays fatal and preserves a displaced
  application failure as `cause`.

## Release gates

| Gate | Required evidence | Status |
|---|---|---|
| Tool lifecycle v2 semantics | MockProvider integration and adversarial tool-boundary matrices | Passed |
| In-process approval ownership | Exact decision validation, cleanup-before-release, concurrent resolution, Studio 400/404/409 | Passed |
| Bounded branch finalization | Cooperative loser drain, non-cooperative timeout, persisted/terminal incomplete marker, no late trace mutation | Passed |
| Lossy observation honesty | Queue drop count through `observationStatus`; Studio incomplete rendering | Passed |
| Strict overflow integrity | Recovery-boundary propagation and original-cause preservation | Passed |
| Historical compatibility | Explicit v1/v2 readers and mixed-history Studio fixtures | Passed in prior scenario review |
| Redaction and Studio lifecycle rendering | Outcome/phase/reason and route/channel cross-products | Passed |
| Live provider wire compatibility | Minimal projected tool continuation across provider families and public stream modes | Passed for OpenAI Chat/Responses, Anthropic, and Gemini with named public-mode limits |

## Live verification evidence

Run on 2026-07-18 with the repository's existing credentials, cheapest test
models, and fixed projection markers. No external tools or side effects were
invoked.

| Provider/model | Public mode and projection | Test | Result |
|---|---|---|---|
| `openai-responses:gpt-4.1-nano` | Streamed record | `integration.test.ts: streaming projected tool output` | Passed |
| `google:gemini-2.5-flash-lite` | Streamed record | `integration.test.ts: streaming projected tool output` | Passed |
| `openai:gpt-4.1-nano` | Streamed string | `integration-advanced.test.ts: streaming emits interleaved token and tool_call events` | Passed |
| `anthropic:claude-haiku-4-5` | Streamed string | `integration-advanced.test.ts: streaming emits interleaved token and tool_call events` | Passed |

The two direct filtered Vitest invocations ran four live cases total. Each case
discriminates against a wire-only false positive by asserting correlated
start/end identity, complete host result retention, projection only in the
provider continuation, persisted-history equivalence, and complete observation.
Residual risk is ordinary live-model/provider drift; this is not proof for
unlisted compatible-provider presets.

## Final verification evidence

Verification completed on 2026-07-18 after the owner hardening pass:

- all package suites passed: 2,077 core, 376 eval, 103 testing, and 742 Studio
  tests;
- cross-package suites passed: 75 E2E and 162 Studio API tests;
- typecheck and build passed across the workspace;
- lint passed with zero errors and four pre-existing `no-explicit-any`
  warnings; and
- formatting and `git diff --check` passed.

## Deferred product work

Durable approval replay is not a release bug to patch into the current
`StateStore` interface. A future design must make ownership and exactly-once
claims explicit before exposing a resume API. Portable run state on the roadmap
is the appropriate design vehicle.

## Release operations

Versioning, publishing, tags, deployment, and rollout remain owner-gated. This
document records code/test readiness only; it does not authorize release
operations.
