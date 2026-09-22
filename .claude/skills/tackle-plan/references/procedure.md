# Tackle plan — shared procedure

Follow `.claude/references/workflow-handoffs.md` for journey sequencing,
scope, and evidence reuse (read once per task).

Platform-neutral. The invoking `SKILL.md` binds each lane named here to an
agent and supplies the platform mechanics (skill syntax, resume, report
delivery). Lanes: **discovery**, **implementation**, **hard problems**,
**review** (diff review with a composite or focused charter),
**blind analyst**, **live-API pass**.

## Role

Drive the plan to genuine completion. You are the orchestrator: decomposition,
routing, adjudicating findings, integration, and the final coverage judgment.
Delegation is the default for implementation, serial as well as parallel; it
also preserves your context for the decisions only you can make. Implement
directly only when a chunk is coupled to the live conversation, smaller than
the overhead of briefing an agent, or inseparable from a product decision you
are making. Judge that overhead by expected lead round-trips times accumulated
lead context, not step count: keep single-pass work, batch small related
edits, and delegate settled work likely to need several edit, debug, or
verification cycles. Near a lock, atomic-commit, or release boundary, reviewer
follow-ups and small residual fixes are yours too; the briefing costs more
than the edit and you hold the freshest picture of the frozen tree.

Keep going through research, code inspection, testing, and repair. Stop only
for a genuine product fork, a required irreversible action, unapproved spend,
or missing authority. Never push, tag, merge, or publish without explicit
approval.

## Definition of done

Done means the plan's explicit acceptance criteria are met and every accepted
developer journey is covered. If the request carries neither, establish them
first as an owner would. An uncovered accepted journey is unfinished scope; a
newly discovered journey outside accepted scope is a proposed decision, not an
implicit obligation. Preserve the plan's goals, acceptance criteria, and
explicit owner decisions; adapt implementation, decomposition, testing, and
sequencing as evidence emerges and record material deviations in the plan.
Ask only when an adaptation changes product behavior, accepted scope,
authority, irreversible actions, or approved spend.

For a plan under `.internal/plans/`, keep all review artifacts in its
workstream directory. Once accepted scope is implemented and verified, fold
durable content into `.internal/spec/` or public `docs/` and move the whole
workstream from `active/` to `graduated/` as `.internal/README.md` defines. A
stopped or partially implemented plan stays active, or moves to `paused/` with
a reason and resume condition. Keep the active index in
`.internal/plans/README.md` aligned with lifecycle moves.

## Route by lane

- **Discovery:** bounded read-only questions. Reuse overlapping discovery across
  briefs; skip a scout when the relevant source is already localized. Ask
  discovery questions, not design questions, and verify a negative claim with
  your own search before it enters a brief (`.claude/rules/discovery-evidence.md`).
- **Implementation:** settled work whose behavior, location, reference pattern,
  acceptance criteria, and owned scope are decided. It may be substantial and
  span files. Consuming an unchanged API, type, or schema alone is not
  consequential.
- **Hard problems:** unknown causes, intermittent or provider-specific bugs,
  races, cross-package lifecycle failures, and stagnant diagnosis (the same
  ineffective approach repeated twice without new evidence; productive
  red/green iteration is not that). A flaky test is an intermittent bug until
  its mechanism is proven; never fold one into a hardening batch. This lane
  also owns consequential seam changes even when the design is settled: public
  types/Zod and barrels, structured output, provider request/response and
  `effort` mapping, streaming/events/redaction, state durability and
  suspend/resume, usage/cost accounting, and concurrency. A seam needs a brief
  stating invariants and verification, then a consolidated focused-seam review
  before acceptance. A brief does not make it routine work. These ownership
  rules apply to review fixes too.
- **Review:** ordinary correctness and established-architecture checks use the
  composite review binding. Consequential contracts, architectural changes,
  and interacting failures use the focused-seam review binding directly.
  Both have the same evidence standard and inspect beyond the diff as needed.
  These are alternative assignments, not sequential approval gates.
- **Blind analyst:** use the blind-analyst binding for scenario/test derivation;
  provide only requirements and public behavior until its matrices are frozen.
- **Lead only:** unresolved architecture, product forks, breaking public API
  policy, provider/model support policy, security or tenant policy, destructive
  migrations, irreversible operations, paid live calls, and decisions coupled
  to the live conversation.

Brief workers with complete owned chunks, settled behavior and invariants, and
local engineering discretion inside them; do not implement the solution twice
through an overly prescriptive handoff. Before writing a brief that names a
symptom, grep for it once; a brief's premise meets the same evidence bar as a
discovery claim. When the evidence a decision needs is one command, run it
rather than accepting a report that asserts it. After a review changes a
design decision, update the plan first and re-derive every open brief from it.
A resumed agent re-reads the plan, status, diff, and owned files before
editing; sibling waves land underneath it. Brief the discovery lane and
reviewers with raw requirements and artifacts, never persuasive correctness
rationale, and name the workstream artifact path each reviewer writes to.

## Parallelism

Parallelism is dependency-bound, not slot-bound. Per wave: `packages/axl` core
and shared-type changes land first; at most three concurrent writers on
disjoint scopes, each in its own worktree (`.claude/rules/parallel-agents.md`;
a worktree needs `pnpm install`, and `.env` only for live integration tests);
reuse discovery across briefs; one review wave per batch. When a plan
genuinely has more than three disjoint workstreams, they queue into the next
wave rather than widening this one: the fourth writer costs a fourth worktree,
a wider review wave, and integration risk that a second wave does not.
Read-only agents are not counted, but at most two agents run vitest at once.
Do not delegate a few-line edit in a file you have already read; do batch
small related tasks into one brief.

## Implement and verify

- Before designing or changing Axl-owned runtime prompts, model-facing schema
  rendering or guidance, retry feedback, routing instructions, built-in tool
  descriptions, or LLM scorers, load and follow the prompt-iteration skill.
- Bug fixes: the failing behavior-focused test comes first, written by whoever
  implements the fix.
- Substantive new behavior or changed contracts: the blind analyst freezes a
  discriminating scenario and test matrix from requirements and public
  behavior before it sees any implementation detail. The implementation owner
  then writes production code and tests against that matrix; use a separate
  test author only for an independent oracle, substantial parallel test work,
  or specialized harness expertise. The reviewer checks that critical tests
  exercise the real boundary and discriminate the specified failure; the lead
  owns final coverage and product decisions.
- Tests try to break things: hunt gaps in the logic, not happy paths.
- Iterate with targeted package tests and typechecks (vitest with
  `--maxWorkers=2`); no stacked or tree-wide sweeps while siblings are active.
- Studio UI phases get a dev-server iteration pass
  (`pnpm --filter @axlsdk/studio dev`) once their review wave is clean.
- Commit verified logical chunks with conventional messages as you go. Never
  work on the default branch.

## Review cadence

- Risk-scaled independent review at meaningful milestones, not per commit. An
  ordinary milestone gets one review pass with a composite correctness,
  journeys, architecture, and tests charter. A consequential seam (provider
  wire behavior, state/data loss, streaming/redaction, security, concurrency,
  usage/cost, lifecycle, public API compatibility) gets a focused charter of
  its own. Add a reviewer for a distinct uncovered failure surface or a
  concrete unresolved consequential question, not because a diff is large.
  Bindings select the review class by charter; a consequential review needs no
  preliminary ordinary review or automatic second approval.
- Review only a quiescent tree: never launch a reviewer while an implementer
  is editing overlapping files or has pending messages. Let the wave land and
  commit, then review the consolidated diff once. A seam-touch declaration
  requests one consolidated seam review, not a pass per fix wave.
- Batch open findings into one fix wave. If the wave changed behavior, review
  it again with the same charter; formatting, documentation, or fixture
  maintenance with unchanged assertions and production behavior is verified by
  the lead. Changed test oracles, removed assertions, and executable
  configuration are behavior.
- Resume, don't respawn, for related follow-up: a fix wave on code an idle
  implementer wrote goes back to that agent; a reviewer rechecks its own
  findings. Spawn fresh for a different seam or a stale context. Never resume
  across the independence boundary: an implementer does not review its own
  work, and the blind analyst stays blind. A provider outage (overloaded or
  5xx) is platform degradation, not agent failure: resume, do not duplicate.
- Every finding gets a verdict with file-backed evidence: `REAL BUG`,
  `NOT A BUG`, `NEEDS-INVESTIGATION`, or `NEEDS-LIVE-API-VERIFICATION`.
  `NEEDS-INVESTIGATION` names the evidence, unresolved question, owner, and
  smallest discriminating check; it is not a confirmed defect or an approval.
  Resolve consequential uncertainty before accepting the affected behavior.
  Confirmed defects are fixed and re-verified with targeted gates.
- Reviewers are read-only: prohibit edits and artifact-writing commands other
  than their report artifact in the brief, and confirm the tree did not change
  before accepting findings.

## Live-API evidence

- Maintain one live-API checklist in the plan's in-progress section. Route
  every `NEEDS-LIVE-API-VERIFICATION` finding there with scenario,
  provider/model, expected behavior, and evidence needed.
- Early live probe, once: when an acceptance criterion crosses a boundary
  `MockProvider` fakes (effort/thinking mapping, streaming wire behavior,
  `providerMetadata` round-trips, structured output, tools, usage, or cost),
  consider one bounded probe of the primary scenario right after the first
  milestone lands; a late discovery in that class invalidates every phase
  stacked on it. It is paid: follow the live-API pass's spend rules.
- Close the checklist with the live-API pass on the stabilized tree and record
  its verdict before declaring done; never claim provider behavior from
  `MockProvider` or code inspection.

## Final verification and closeout

Select final verification from `CLAUDE.md` → Commands and
`.claude/rules/testing.md`; completing a plan does not itself require a full
repository sweep. Documentation, agent, and skill instruction changes use
focused validation unless the user requests more or the change affects
application/build/test behavior. Start any required full repository gate
(`pnpm test`, `pnpm -r typecheck`, `pnpm build`) only after implementation has
stopped, required reviews have returned, and confirmed findings are resolved.
Targeted checks may overlap read-only review when they preserve the reviewed
tree. A later source change invalidates the evidence it affects; a failed or
interrupted gate is never recorded as complete. Required live-API evidence is
a separate gate, not implied by `MockProvider` tests.

Record in the plan: the reviewed revision, outstanding findings, the final
gate result with live-provider limitations, documentation and `CHANGELOG.md`
updates, and graduation status. If the run is interrupted (usage limit,
outage, owner stop), leave a resumable checkpoint in the plan first: what
landed, what is in flight and where, and the next command.

## Stance

Skeptical and grounded in the source; answer your own questions by reading
code. Think about different developers and their journeys; address the root
problem; decide like an owner and record the decision inline. No shortcuts.
