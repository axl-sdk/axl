# Lead accountability for orchestration

The lead owns whether delegation improves accepted delivery. Use this reference
from either platform's tackle-plan skill. Optimize quality, completion time, and
total effort together; cheaper calls or more parallel agents alone are not success.

## Keep a proportional record

Use the existing workstream plan's progress section or execution log. Without a
workstream, keep concise session notes. Do not create a telemetry system or a
separate report for each small task. Record meaningful chunks and review waves,
not every command. At the start, note the accepted outcome, expected critical
path, routing rationale, and any user-specified time or spend constraints. Give
bounded reviews and discovery an expected time budget. At that budget, request
confirmed findings and limitations or justify a targeted extension for a concrete
unresolved risk; elapsed time alone never establishes a clean review.

For each meaningful assignment, capture:

- Owned chunk and role; requested model/effort and resolved settings if exposed.
  Mark unavailable actual settings as unknown, not inferred from the role file.
- Start/end timestamps and elapsed duration when observable; completion status
  and acceptance/verification evidence.
- Material retries, rework, lead repairs, reviewer false-positive triage, and
  remaining blockers. Distinguish productive investigation from repeated failure.
- Actual token usage or cost only when exposed by the host. Unknown is not zero;
  benchmark prices are not measured session or subscription costs.

A compact row can use `chunk | role/settings | start/end | result | rework | next
adjustment`; include usage only when available. Do not reconstruct precise times
from memory. Note measurement gaps rather than inventing a baseline.

## Assess and adjust at decision points

Check the record at handoffs, escalations, milestones, and close. Do not poll
agents or rerun tests merely to populate metrics. Assess:

- Did the assignment produce accepted work, or shift implementation back to the
  lead? Include briefing, coordination, repairs, review, and verification effort.
- Is a slower worker blocking the critical path? Is parallelism actually useful,
  or causing dependency waits, conflicts, and duplicated discovery?
- Did a review find material defects or mostly generate triage? Are distinct risk
  surfaces covered with independent evidence?
- Are retries adding evidence? After two repetitions of the same ineffective
  approach without new evidence, re-scope or route uncertain diagnosis to the
  debugger. Productive red/green iterations do not trigger this rule.

Distinguish end-to-end wall time from summed agent elapsed time: overlapping
assignments must not be counted as sequential delivery time. Separate queue,
setup, tools, and test waits only when the evidence permits. Do not claim active
model time, savings, or speedup without measurements and a comparable baseline.

Make bounded adjustments within the accepted task and authority: batch small
handoffs, tighten ownership, change sequencing, route a stalled chunk to a more
suitable role, or stop redundant checks after appropriate verification passes.
Do not silently change an explicitly selected root model, expand approved spend
or scope, weaken required review/independence safeguards, or rewrite shared
agents/skills merely to improve the numbers.

## Close the feedback loop

Include material routing changes and their reasons in milestone updates. At
completion, add a short orchestration assessment to the handoff: what worked,
what caused delay or rework, adjustments applied, and any evidence-backed future
change. If evidence is sparse, say so; one successful task does not validate a
model portfolio. Record durable recommendations in the workstream for later
comparison across similar accepted tasks. Propose shared configuration changes
separately unless their implementation is already authorized.
