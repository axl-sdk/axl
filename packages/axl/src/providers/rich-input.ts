import type { InputContentPart, ModelInput } from '../input.js';
import type { ChatMessage } from '../types.js';

/** Any non-text model input part. Its `type` is exactly its modality, which is
 * what every `UnsupportedModelInputError` reports. */
export type RichInputPart = Exclude<InputContentPart, { type: 'text' }>;

export type RichModality = RichInputPart['type'];

/** Non-text parts of one input, in caller order. Strings carry none. */
export function richInputParts(input: ModelInput): readonly RichInputPart[] {
  return typeof input === 'string'
    ? []
    : input.filter((part): part is RichInputPart => part.type !== 'text');
}

/**
 * First non-text part across an input and the history that accompanies it —
 * the input's own parts first, then history in order. Pass `modality` to
 * restrict the search to one modality.
 */
export function firstRichPart(
  input: ModelInput,
  history: readonly ChatMessage[],
  modality?: RichModality,
): RichInputPart | undefined {
  const find = (value: ModelInput): RichInputPart | undefined =>
    richInputParts(value).find((part) => modality === undefined || part.type === modality);
  return (
    find(input) ??
    history.map((message) => find(message.content)).find((part) => part !== undefined)
  );
}
