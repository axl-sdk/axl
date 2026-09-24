# Workflow handoffs

Read this once when using an orchestration workflow. Workflows run only when
explicitly invoked; ordinary understood work needs implementation and focused
checks, not a chain of audits.

- `plan-doc` establishes accepted journeys, criteria, and architecture.
- `tackle-plan` implements them with risk-scaled milestone review, blind scenario
  derivation for substantive behavior, and the relevant live-API evidence.
- `scenario-review` adds a fresh independent behavioral audit.
- `session-review` adds a comprehensive audit of the concrete net diff.
- `live-api-verification` closes the provider-gated checklist with bounded paid
  integration tests.

When these are requested together, schedule implementation → scenario review →
session review → affected live-API checks → final validation. An early live
probe can still test a risky mocked provider boundary. Use the requested
comprehensive review as the final milestone review rather than duplicating the
same charter on the same tree. Do not postpone a consequential seam review
needed before other work can safely build on it.

Keep one handoff in the existing plan's status section, or one review note in
the workstream directory when there is no plan: accepted scope, frozen
scenario/test matrices, reviewed revision and local changes, findings with
owners, evidence with provenance, and remaining gaps. Link artifacts rather
than copying reports across documents. Maintain one live-API checklist with
scenario, provider/model, expected behavior, evidence needed, and status.

Reuse frozen matrices while implementing the same accepted requirements; update
only affected rows when requirements change. An explicitly requested fresh blind
audit still derives independently before seeing earlier matrices or findings.
Reuse checks and reviews whose relevant code, configuration, and environment
remain unchanged. After fixes, retain prior evidence as superseded where affected
and rerun the discriminating checks; do not repeat an entire workflow by default.
A green `MockProvider` test never substitutes for required live-provider evidence.

Respect existing scope and authorization. Fix confirmed in-scope defects; record
unrelated improvements and proposed product expansion separately. A recorded gap
alone does not invoke another workflow or authorize paid calls, publishing, or
pushing. Select final gates from `CLAUDE.md` → Commands and
`.claude/rules/testing.md`.
