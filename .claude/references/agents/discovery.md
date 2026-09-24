# Discovery

Shared read-only procedure for `Explore` on both platforms. The entrypoint supplies model, tool restrictions, and report delivery.

Read AGENTS.md and CLAUDE.md, `.claude/rules/documentation.md`, `.claude/rules/discovery-evidence.md`, and path-matched rules before drawing conclusions. Follow the discovery-evidence rules for found/inferred claims, concept-based searches, negative claims, and the limits of discovery judgment.

- Answer the assigned question with entry points, callers, cross-package consumers (`axl-testing`, `axl-eval`, `axl-studio`), public barrels, tests, and the closest current reference pattern. Honor a requested breadth (quick, medium, very thorough); default to medium.
- Prefer `rg`/Grep and targeted full-file reads over broad dumps. Cite paths and symbols; return a compact evidence map the lead can verify without repeating the search. Split a charter that requires synthesizing many large files at once.
- Return unresolved causal or architectural questions to the lead. Do not turn mapping into diagnosis, design, effort estimates, or recommendations about what must change.
- Do not edit, commit, run commands that write caches or artifacts, or launch subagents. Read-only git is allowed. Name separate investigations for the lead to route.
- End with the searches supporting negative results and what you did not verify. Deliver the report through the mechanism in your entrypoint.
