# Claude Haiku 5.5 and Sonnet 5.5 live verification

**Date:** 2026-10-07  
**Scope:** the request contract for exact `claude-haiku-5-5` and
`claude-sonnet-5-5` on the direct `anthropic:` adapter. This covers thinking
and effort shapes, forced tool choice, raw sampling, thinking replay and the
binding beta, and metered cost. The same contract probes recheck raw sampling on
`claude-opus-5-5` and `claude-fable-5-1`.  
**Command:** `vitest run --config vitest.frontier-integration.config.ts -t
"Haiku 5.5 and Sonnet 5.5"` in `packages/axl`. Contract probes ran as raw
`fetch` calls first.

## Contract probes

Raw `POST /v1/messages` with `anthropic-version: 2023-06-01`, `max_tokens: 64`,
and the user message "Say ok.". The `thinking-binding-controls-2026-08-01` beta
was sent only on P8, P9, and P14.

| ID | Model | Extra body | Status | Evidence |
| --- | --- | --- | --- | --- |
| P1 | `claude-sonnet-5-5` | `top_p: 0.99` | 200 | `msg_011CfoXXG1GaS7nJ1oUKRC72` |
| P2 | `claude-sonnet-5-5` | `top_p: 1` | 400 | "`top_p` is deprecated for this model." |
| P3 | `claude-sonnet-5-5` | `temperature: 1` | 200 | `msg_011CfoXXLgZ7wFEMxLNrUTJu` |
| P4 | `claude-sonnet-5-5` | `temperature: 1, top_p: 0.99` | 400 | "`temperature` and `top_p` cannot both be specified for this model." |
| P5 | `claude-haiku-5-5` | `thinking: {type:'disabled'}`, effort `high` | 200 | `msg_011CfoXXReSwPLJ8DhyvkC4c`; text only, 0 thinking tokens |
| P6 | `claude-haiku-5-5` | `disabled`, effort `xhigh` | 400 | "output_config.effort 'xhigh' is not supported when thinking is disabled on this model…" |
| P7 | `claude-sonnet-5-5` | `thinking: {type:'between_tools'}`, effort `high` | 200 | `msg_011CfoXXYEaV9pJQLcRE8rzo` |
| P8 | `claude-sonnet-5-5` | `between_tools` + `block_binding` (+ beta) | 400 | "thinking.between_tools.block_binding: Extra inputs are not permitted" |
| P9 | `claude-haiku-5-5` | `disabled` + `block_binding` (+ beta) | 400 | "thinking.disabled.block_binding: Extra inputs are not permitted" |
| P10 | `claude-opus-5-5` | `top_p: 1` | 400 | "`top_p` is deprecated for this model." |
| P11 | `claude-haiku-5-5` | `top_p: 1` | 400 | same |
| P12 | `claude-haiku-5-5` | forced `tool_choice: {type:'any'}` | 200 | `msg_011CfoXXepiLDVgnKcduitpp`; `tool_use` stop, no thinking block |
| P13 | `claude-sonnet-5-5` | `thinking: {type:'disabled'}` | 400 | "To turn thinking off on this model, send \"thinking\": {\"type\": \"between_tools\"}…" |
| P14 | `claude-haiku-5-5` | adaptive + `block_binding` (+ beta) | 200 | `msg_011CfoXXhauUPPVd6X8e58Yo` |
| P15 | `claude-opus-5-5` | `temperature: 1, top_p: 0.99` | 400 | "`temperature` and `top_p` cannot both be specified…" |
| P16 | `claude-fable-5-1` | `top_p: 1` | 400 | "`top_p` is deprecated for this model." |

Conclusions the adapter now enforces before dispatch:
- All four models share one raw-sampling rule: `temperature` may only be `1`,
  `top_p` may only be `0.99`, and the two cannot be sent together. Before this
  change, Axl accepted `top_p` from 0.99 to 1 and the pair together on Opus 5.5
  and Fable 5.1 (P10, P15, P16). `top_k` is rejected per Anthropic's
  documentation and was not probed.
- Haiku 5.5 turns thinking off with `disabled` only at effort `high` or below.
  Sonnet 5.5 rejects `disabled` and turns thinking off with `between_tools`.
- Either thinking-off shape rejects `block_binding`, so Axl sends the binding
  beta and `block_binding` only under adaptive thinking.
- Haiku 5.5 accepts forced tool choice.

## Live rows

| Row | Provider / model | Scenario and assertion | Result |
| --- | --- | --- | --- |
| L1 | `claude-haiku-5-5`, `claude-sonnet-5-5` | Text at `effort: 'low'` and terminal stream at `'max'` on the exact ID. The wire body is adaptive with the requested effort, and the response is metered with a positive static cost. | Passed on both. |
| L2/L3/L4 | `claude-haiku-5-5` | Adaptive `high` tool turn with signed thinking. The continuation under adaptive thinking carries the binding beta and `drop_block` and reports no reset. A continuation at `effort: 'none'` sends `{type:'disabled'}`, no beta, and no `output_config`, replays the signed block verbatim, and is metered. | Passed. Switching thinking type with replayed blocks is accepted. |
| L2/L3/L4/L6/L4b | `claude-sonnet-5-5` | Same loop, with `{type:'between_tools'}` as the thinking-off shape. An edited system prompt under adaptive thinking reports a `prefix_binding_mismatch` reset. Under `between_tools`, an edited system prompt gets one attempt; a 200 or a surfaced `ProviderError` 400 is accepted, and neither is stripped nor retried. | Passed. On a targeted re-run, L4b returned **200**: this account predates the 2026-08-31 enforcement default. |
| L5 | `claude-haiku-5-5`, `claude-sonnet-5-5` | Haiku 5.5 sends `tool_choice: {type:'any'}` and returns the tool call. Sonnet 5.5 forced choice is a local `UnsupportedModelOptionError` with zero transport attempts. | Passed. |
| L7 | `claude-haiku-5-5` | A schema ask through Axl's JSON-instruction path at the default effort, with no `thinking` or `output_config` sent, returns a Zod-valid result. | Passed. |

## Limits

- **L4b on newer accounts.** The test account predates 2026-08-31, so an edited
  prefix under `between_tools` was accepted (200). The 400 that accounts created
  on or after that date receive is documented from Anthropic's preserved-thinking
  guide and covered by unit tests. It was not observed live.
- **Streamed `between_tools` progress blocks.** The live Sonnet loop passed, but
  the raw SSE was not captured. The shape of a streamed progress-update block is
  covered only by a documentation-derived unit fixture.
- **Pricing assumptions.** These are not invoice-verified:
  - The Haiku 5.5 100,000-token split counts uncached input, cache reads, and
    both cache-write TTLs.
  - Sonnet 5.5 cache reads use 10% of input.

  Live calls never cross 100,000 tokens. Costs here are Axl's usage-based
  estimates, not invoice audits.
- **Reverse model switch.** Whether Haiku 5.5 can read thinking blocks produced
  by Sonnet 5.5 or Opus 5.5 is not verified live. Either way, a provider drop is
  reported as `reasoning_context_reset`.
- The Opus 5.5 compacted-tail test that failed in the full run (an empty reply) passed on a targeted re-run. It was model nondeterminism, not a change in request shaping.
