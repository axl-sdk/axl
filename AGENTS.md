# AGENTS.md

This file is the agent-neutral entrypoint for this repository.

Read `CLAUDE.md` first. It is the canonical source for the shared project
overview, commands, architecture, and repo conventions. Do not duplicate that
content here; update `CLAUDE.md` when shared guidance changes.

## Dynamic rule loading

The files in `.claude/rules/` are shared repo rules, not Claude-only rules.
Load every rule that matches the files being edited, reviewed, or investigated:

- Always load `.claude/rules/documentation.md` and
  `.claude/rules/discovery-evidence.md`.
- Load `.claude/rules/core-sdk.md` for `packages/axl/src/**`.
- Load `.claude/rules/providers.md` for `packages/axl/src/providers/**`.
- Load `.claude/rules/events-streaming-redaction.md` for event, streaming,
  redaction, and the matching Studio boundary files listed in that rule.
- Load `.claude/rules/state-and-memory.md` for
  `packages/axl/src/state/**` or `packages/axl/src/memory/**`.
- Load `.claude/rules/eval.md` for `packages/axl-eval/**`.
- Load `.claude/rules/studio.md` for `packages/axl-studio/**`.
- Load `.claude/rules/testing.md` for tests and test infrastructure.
- Load `.claude/rules/releasing.md` for package versions, `CHANGELOG.md`,
  tags, or publishing work.
- Load `.claude/rules/parallel-agents.md` whenever multiple agents may edit
  concurrently.

When a task spans multiple areas, load every matching rule before changing
files. Path lists in each rule's frontmatter are authoritative when this summary
and the rule differ.

## Shared skills and roles

Claude project skills live under `.claude/skills/`. Codex discovers repository
skills through `.agents/skills`, which points to `.codex/skills`. The shared
`live-api-verification` and `prompt-iteration` methodology skills are linked
individually from `.codex/skills` back to `.claude/skills`; Codex-specific
orchestration variants
(`plan-doc`, `tackle-plan`, `session-review`, and `scenario-review`) live as
native files under `.codex/skills` because they route named Codex agents and
model tiers. Update both platform variants only when shared orchestration
semantics change.

Project-scoped Codex roles live in `.codex/agents/`; Claude-native roles live in
`.claude/agents/`. Keep shared roles aligned on responsibilities and escalation
outcomes while allowing platform model/tool instructions and platform-specific
escalation lanes to differ.
