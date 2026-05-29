# Axl Examples

Small, self-contained programs you can run in under a minute. Each file is
standalone and heavily commented.

## Setup

These examples install `@axlsdk/axl` from npm, so they run against the published
package exactly like your own project would:

```bash
cd examples
npm install
export OPENAI_API_KEY=sk-...   # or swap the model for a provider you have a key for
```

> The examples use `openai-responses:gpt-5.5` (OpenAI's Responses API). Change the
> `model` string in any file to use Anthropic (`anthropic:claude-sonnet-4-6`),
> Gemini (`google:gemini-3.1-pro-preview`), or any other supported model — just set
> the matching API key. See [docs/providers.md](../docs/providers.md).

## Run

| Example | Command | What it shows |
| --- | --- | --- |
| [`quickstart.ts`](./quickstart.ts) | `npm run quickstart` | A tool, an agent, a workflow — the tool-calling loop end to end. |
| [`consensus.ts`](./consensus.ts) | `npm run consensus` | `spawn` 5 parallel attempts, then majority `vote` on the answer. |
| [`support-bot.ts`](./support-bot.ts) | `npm run support-bot` | Triage agent with `handoffs` to specialists, each with scoped tools. |

Or run any file directly: `npx tsx quickstart.ts`.

## Next steps

- [Getting Started](../README.md#getting-started) — the same quickstart, narrated
- [Use Cases](../docs/use-cases.md) — support bots, batch processing, budgets, voting strategies
- [API Reference](../docs/api-reference.md) — every `ctx.*` primitive and option
- [Axl Studio](../packages/axl-studio/README.md) — a local UI to watch any of these run
