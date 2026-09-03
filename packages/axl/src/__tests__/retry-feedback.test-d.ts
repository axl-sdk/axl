/**
 * Type-level surface guard for `retryFeedback` (frozen matrix case A15).
 *
 * The hook is deliberately ask-scoped: it belongs on `AskOptions` and `DelegateOptions`
 * only. It must NOT leak onto `AgentConfig` (mirroring `validate`, which is also per-ask),
 * onto `RaceOptions` (race discards failures instead of retrying), or onto `VerifyOptions`
 * (`ctx.verify` runs its own retry loop whose feedback goes to caller code, not the model).
 *
 * This file is type-checked by `pnpm typecheck` (`tsc --noEmit`); each
 * `@ts-expect-error` fails the build if the option ever becomes assignable there.
 */
import { z } from 'zod';
import type { AgentConfig } from '../agent.js';
import type {
  AskOptions,
  DelegateOptions,
  RaceOptions,
  RetryFeedbackHook,
  RetryFeedbackResult,
  VerifyOptions,
} from '../types.js';

const hook: RetryFeedbackHook = (info) => `stage=${info.stage} attempt=${info.attempt}`;

// --- Accepted where the hook is public API ---------------------------------
const askOptions: AskOptions<{ x: number }> = {
  schema: z.object({ x: z.number() }),
  retryFeedback: hook,
};
void askOptions;

const delegateOptions: DelegateOptions<{ x: number }> = {
  schema: z.object({ x: z.number() }),
  retryFeedback: hook,
};
void delegateOptions;

// A hook used only for logging or inspection never returns a value. A block-bodied arrow
// infers `void`, which is not assignable to `RetryFeedbackResult` — so the hook's return
// type must admit `void` or partial adoption does not compile at all.
const loggingOnly: AskOptions<{ x: number }> = {
  schema: z.object({ x: z.number() }),
  retryFeedback: (info) => {
    void info.output;
  },
};
void loggingOnly;

const asyncLoggingOnly: AskOptions<{ x: number }> = {
  schema: z.object({ x: z.number() }),
  retryFeedback: async (info) => {
    await Promise.resolve(info.stage);
  },
};
void asyncLoggingOnly;

// `parsed` is typed by the ask's schema at the validate stage, so a consumer reads the
// object's own fields without casting at exactly the point the type is known.
const typedParsed: AskOptions<{ x: number }> = {
  schema: z.object({ x: z.number() }),
  retryFeedback: (info) => {
    if (info.stage === 'validate' && info.parsed) {
      const x: number = info.parsed.x;
      // @ts-expect-error `parsed` is the schema's type, not `any` — unknown fields fail.
      void info.parsed.notOnTheSchema;
      return `x was ${x}`;
    }
    return undefined;
  },
};
void typedParsed;

// --- Rejected everywhere else ----------------------------------------------
const agentConfig: AgentConfig = {
  model: 'openai:gpt-4o',
  // @ts-expect-error `retryFeedback` is ask-scoped, not agent-level (Q2).
  retryFeedback: hook,
};
void agentConfig;

const raceOptions: RaceOptions<{ x: number }> = {
  // @ts-expect-error `ctx.race` discards failures rather than retrying them.
  retryFeedback: hook,
};
void raceOptions;

const verifyOptions: VerifyOptions<{ x: number }> = {
  // @ts-expect-error `ctx.verify` feeds its retry back to caller code, not to the model.
  retryFeedback: hook,
};
void verifyOptions;

// --- Return type ------------------------------------------------------------
const asString: RetryFeedbackResult = 'replacement text';
const asUndefined: RetryFeedbackResult = undefined;
const asAbort: RetryFeedbackResult = { retry: false };
void asString;
void asUndefined;
void asAbort;

// @ts-expect-error only `{ retry: false }` is a valid object result — there is no
// "keep retrying" object form; return `undefined` to keep the default text.
const asContinue: RetryFeedbackResult = { retry: true };
void asContinue;

// A hook may be sync or async, and may return any of the three result shapes.
const syncAbort: RetryFeedbackHook = () => ({ retry: false });
const asyncDefault: RetryFeedbackHook = async () => undefined;
void syncAbort;
void asyncDefault;
