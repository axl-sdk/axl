import type { Agent } from '../agent.js';
import type { WorkflowContext } from '../context.js';
import type { InputGuardrail } from '../types.js';
import type { ModelInput } from '../input.js';

declare const ctx: WorkflowContext;
declare const agent: Agent;

const input = [
  { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
  { type: 'text', text: 'inspect' },
] as const satisfies ModelInput;

const askResult: Promise<string> = ctx.ask(agent, input);
const delegateResult: Promise<string> = ctx.delegate([agent], input);
void askResult;
void delegateResult;

const guardrail: InputGuardrail = (_text, guardrailCtx) => {
  const view: ModelInput = guardrailCtx.input;
  void view;
  return { block: false };
};
void guardrail;

// @ts-expect-error Image parts require a declared source.
const invalidImage: ModelInput = [{ type: 'image' }];
const invalidModality: ModelInput = [
  // @ts-expect-error Unknown modalities are not accepted in the image-era contract.
  { type: 'audio', source: { type: 'url', url: 'https://example.test/a.mp3' } },
];
// @ts-expect-error Public parts are readonly.
input.push({ type: 'text', text: 'mutate' });
void invalidImage;
void invalidModality;
