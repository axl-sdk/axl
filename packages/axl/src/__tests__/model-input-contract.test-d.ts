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
const invalidAudioSource: ModelInput = [
  // @ts-expect-error Audio has no URL source; recordings are bytes/base64/provider-file.
  { type: 'audio', source: { type: 'url', url: 'https://example.test/a.mp3' } },
];
const invalidModality: ModelInput = [
  // @ts-expect-error Only text, image and audio parts exist.
  { type: 'video', source: { type: 'base64', data: 'AQID', mediaType: 'video/mp4' } },
];
const audioInput = [
  { type: 'audio', source: { type: 'base64', data: 'AQID', mediaType: 'audio/wav' } },
  {
    type: 'audio',
    source: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
    label: 'call',
  },
  { type: 'audio', source: { type: 'provider-file', provider: 'google', reference: 'files/a' } },
  { type: 'text', text: 'describe' },
] as const satisfies ModelInput;
const audioAsk: Promise<string> = ctx.ask(agent, audioInput);
void audioAsk;
void invalidAudioSource;
// @ts-expect-error Public parts are readonly.
input.push({ type: 'text', text: 'mutate' });
void invalidImage;
void invalidModality;
