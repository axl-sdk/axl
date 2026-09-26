# Session summary coverage and Anthropic replay verification

**Date:** 2026-09-25  
**Scope:** `Session.history.maxMessages`, `AgentConfig.maxContext`, and
Anthropic thinking carried across an Axl client-side summary.  
**Source:** commits `452a9d2` and `665f8b2`, with the final live-test bound
adjustment in the same workstream.

## Decision and deterministic evidence

Session retention keeps its rolling summary as durable context. An agent's
`maxContext` summary is an execution-local view with an exact covered prefix
and every later message in the tail; it does not overwrite session metadata.
When Axl trims or summarizes old turns, affected requests omit Anthropic
thinking signed to the previous prefix while retaining text, tool calls, and
other provider metadata. This follows Anthropic's
[preserved-thinking guidance](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking).

Focused tests cover a tail displaced past a cached summary, an in-place edit
to the covered prefix, a summary-model change, durable-summary preservation,
a small agent followed by a larger agent, both session trim modes, historical
thinking removal, and active tool-turn preservation. The final provider-free
gate passed **3,499 core tests**, **129 end-to-end tests**, workspace typecheck,
lint, formatting, and build. An independent senior seam review found no code
defects.

## Live Opus 5.5 evidence

The exact-model case in `integration-latest-models.test.ts` seeded a real
signed thinking/tool-use turn and a completed tool result, then ran two
`ctx.ask()` calls with Axl `maxContext` summarization. The revised case passed
on 2026-09-25 with **four metered provider calls**, **zero unpriced calls**, and
an **Axl usage-based cost estimate of $0.123324**. The test checked that the
first compacted request retained the tool-use text and result, omitted the old
thinking block, received a nonempty answer, and emitted no first-call
reasoning-reset diagnostic. It also checked that the later request retained
the question in either its verbatim tail or a regenerated summary input.

An earlier run with a tighter context limit returned answers to both asks but
failed an obsolete test assumption that the second ask must reuse the first
summary. Regeneration is correct when the complete uncovered tail will not
fit. That run did not retain token usage, so its charge is **unknown** and is
not included in the $0.123324 estimate. The revised run used a separately
approved $0.30 cap and recorded usage before assertions.

The [Opus 5.5 model page](https://platform.claude.com/docs/en/models/opus-5-5/overview)
publishes Standard text prices used by Axl's estimator. This check verifies
the resulting usage-based estimate, not Anthropic's final invoice. No pricing
table was changed in this work.

## Limits

This case establishes provider acceptance for one completed historical tool
exchange after compaction. It does not establish zero resets on later asks,
after restart/fork, during every active tool loop, or after changes to the
system prompt, tools, or model. Axl's persisted session history is not a full
provider replay transcript. The durable summary and retained history also
remain separate StateStore writes; their atomic snapshot is tracked as a
separate durability change in the roadmap.
