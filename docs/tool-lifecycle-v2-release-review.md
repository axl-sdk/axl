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
  the workflow. The in-process resolver is published before its audit event,
  concurrent resolvers claim before store mutation, and cleanup failure leaves
  the gate closed and retryable. Cancellation shares that claim: it waits for
  an in-flight public resolution and compensates only if the write failed.
  Ambiguous save failures are also compensated because a custom store may
  durably write before losing its acknowledgement. Total execution deletion
  joins the same cleanup barrier before sweeping the store. Compensation
  failure emits `decision_cleanup_failed` without replacing the original
  workflow error and leaves the durable request visible for operator action.
- Pending decisions remain execution-keyed. Concurrent `awaitHuman()` calls in
  one execution fail loudly and cancel both waits; request-scoped concurrency
  belongs with the future durable replay design.
- `runtime.resumeExecution()` and `runtime.resumePending()` do not ship as
  misleading fail-only APIs.
- Race and quorum losers get a bounded terminal drain. The default is 5
  seconds; timeout finalizes with machine-readable incompleteness and suppresses
  later trace mutation.
- Exact start/end pairing is a complete-trace invariant, not a delivery promise
  for lossy queues, capped persistence, disconnection, or process death.
- Default queue overflow stays non-fatal, but every affected iterable view,
  including `stringStream()`, contributes to `observationStatus`. Strict
  overflow stays fatal, marks the view incomplete, and preserves a displaced
  application failure as `cause`.
- Persisted traces report cap truncation and recovered v2 traces report process
  interruption. All built-in stores retain the status; SQLite uses schema v5.

## Release gates

| Gate | Required evidence | Status |
|---|---|---|
| Tool lifecycle v2 semantics | MockProvider integration and adversarial tool-boundary matrices | Passed |
| In-process approval ownership | Exact decision validation, publish-before-audit, cleanup-before-release, single store mutation under concurrent resolution, observable compensation failure, concurrent-wait rejection, Studio 400/404/409 | Passed |
| Bounded branch finalization | Cooperative loser drain, non-cooperative timeout, persisted/terminal incomplete marker, no late trace mutation | Passed |
| Lossy observation honesty | Main/string-view drop count through `observationStatus`; persistence/process markers; Studio terminal incomplete rendering | Passed |
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

An independent session review on 2026-07-20 then adversarially checked the net
diff from `b3cf695`. It closed approval publication, cancellation, and
single-mutation races; SQLite observation loss; side-table-only delete return
values; strict/string-view overflow signaling; recovered-process status;
terminal incomplete rendering; malformed decision JSON; and testing-runtime
cause parity. Its closure pass additionally verified serialized public-decision
and cancellation cleanup, write-then-reject save compensation, and total-delete
ordering behind approval cleanup. No finding required live-provider
verification.

Final post-review verification on 2026-07-20 passed 2,096 core tests (11
Redis integration tests skipped without a live Redis), 376 eval tests, 104
testing tests, 745 Studio tests, 75 cross-package E2E tests, and 162 Studio API
tests. Workspace typecheck, build, lint, formatting, and diff checks also
passed; lint retains the same four pre-existing warnings.

Owner closeout verification on 2026-07-20 then passed under Node 22.22.2:
2,097 core tests (with the separately gated Redis cases skipped), 376 eval,
104 testing, 745 Studio, 75 E2E, and 162 Studio API tests. The current build and
typecheck passed across the workspace; lint passed with the same four
pre-existing warnings; formatting and diff checks passed. The tarball/downstream
type smoke suite passed all 6 cases, and a separately enabled real Redis run
passed all 11 integration cases. After the Node 22 run, the native SQLite
dependency was restored for Node 20.19.5 and its migration plus approval
regressions passed there as well.

The live-provider evidence above remains applicable to the closeout commit. All
post-live changes are confined to local coordination, persistence/observation
status, Studio rendering, tests/docs, and the trusted-host approval-cleanup
event; provider adapters and model-facing continuation shapes did not change.
No additional paid provider call was needed to establish a newly affected
property beyond the four live cases and current-head deterministic suites;
ordinary provider/model drift remains a release-time operational risk.

## Deferred product work

Durable approval replay is not a release bug to patch into the current
`StateStore` interface. A future design must make ownership and exactly-once
claims explicit before exposing a resume API. Portable run state on the roadmap
is the appropriate design vehicle.

## Release operations

Versioning, publishing, tags, deployment, and rollout remain owner-gated. This
document records code/test readiness only; it does not authorize release
operations.
