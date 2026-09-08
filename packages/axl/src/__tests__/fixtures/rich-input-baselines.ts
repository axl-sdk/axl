/**
 * Phase 0 baselines for the general-audio-input workstream.
 *
 * These constants capture what each adapter sends on the wire today for
 * string-only and image-only asks, plus the `{modality, feature, source}`
 * triples of the `UnsupportedModelInputError` each adapter/MockProvider
 * throws for image-only rejections.
 *
 * They live in a plain module, NOT in `rich-input-baselines.test.ts`, so a
 * suite that compares against them imports data only — importing the test
 * module would re-execute its 15 baseline cases (and its `afterEach` global
 * `fetch` restore) inside every importer.
 */

// A 1x1 transparent PNG, hand-picked so image asks are fully deterministic
// (no captured field depends on real image content).
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** The baseline string-only ask. */
export const STRING_INPUT = 'Describe the weather.';

/** The baseline image-only ask (image first, then text). */
export const IMAGE_INPUT = [
  {
    type: 'image' as const,
    source: { type: 'base64' as const, data: TINY_PNG_BASE64, mediaType: 'image/png' },
  },
  { type: 'text' as const, text: 'Describe.' },
];

// ── Fixtures ────────────────────────────────────────────────────────────
// Hand-copied from the actual request bodies observed against MockProvider-
// free adapter dispatch below. No nondeterministic fields (ids, timestamps)
// appear in any of these bodies, so nothing was stripped before compare.

export const OPENAI_STRING_BODY = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Describe the weather.' }],
  max_completion_tokens: 4096,
  stream: false,
};

export const OPENROUTER_STRING_BODY = {
  model: 'vendor/text',
  messages: [{ role: 'user', content: 'Describe the weather.' }],
  max_tokens: 4096,
  stream: false,
};

export const OPENROUTER_IMAGE_BODY = {
  model: 'vendor/vision',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } },
        { type: 'text', text: 'Describe.' },
      ],
    },
  ],
  max_tokens: 4096,
  stream: false,
};

// String-only asks stay on Gemini's plain `generateContent` endpoint.
export const GOOGLE_STRING_BODY = {
  contents: [{ role: 'user', parts: [{ text: 'Describe the weather.' }] }],
  generationConfig: { maxOutputTokens: 4096 },
};

// Rich (image) asks route through Gemini's stateful-shaped but
// deliberately-stateless Interactions endpoint (`/interactions`), a
// different request/response schema than plain `generateContent`.
export const GOOGLE_IMAGE_BODY = {
  model: 'gemini-2.5-flash',
  input: [
    {
      type: 'user_input',
      content: [
        { type: 'image', data: TINY_PNG_BASE64, mime_type: 'image/png' },
        { type: 'text', text: 'Describe.' },
      ],
    },
  ],
  generation_config: { max_output_tokens: 4096 },
  stream: false,
  store: false,
};

export const ANTHROPIC_STRING_BODY = {
  model: 'claude-sonnet-4',
  max_tokens: 4096,
  messages: [{ role: 'user', content: 'Describe the weather.' }],
  stream: false,
};

export const ANTHROPIC_IMAGE_BODY = {
  model: 'claude-sonnet-4',
  max_tokens: 4096,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 },
        },
        { type: 'text', text: 'Describe.' },
      ],
    },
  ],
  stream: false,
};

export const OPENAI_RESPONSES_STRING_BODY = {
  model: 'gpt-4o',
  input: [{ type: 'message', role: 'user', content: 'Describe the weather.' }],
  max_output_tokens: 4096,
  store: false,
  stream: false,
};

export const OPENAI_RESPONSES_IMAGE_BODY = {
  model: 'gpt-4o',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: `data:image/png;base64,${TINY_PNG_BASE64}` },
        { type: 'input_text', text: 'Describe.' },
      ],
    },
  ],
  max_output_tokens: 4096,
  store: false,
  stream: false,
};

export const IMAGE_REJECTION_TRIPLES = {
  openai: {
    modality: 'image',
    source: undefined as string | undefined,
    message: "Provider 'openai' model 'gpt-4o' does not support image input for this model",
  },
  openaiResponsesMismatchedProviderFile: {
    modality: 'image',
    source: 'provider-file',
    message: "Provider 'openai-responses' model 'gpt-4o' does not support image from provider-file",
  },
  googleUrlSource: {
    modality: 'image',
    source: 'url',
    message:
      "Provider 'google' model 'gemini-2.5-flash' does not support direct URL image input; pass bytes/base64 or a Gemini provider-file from url",
  },
  openrouterMismatchedProviderFile: {
    modality: 'image',
    source: 'provider-file',
    message:
      "Provider 'openrouter' model 'vendor/vision' does not support image from provider-file",
  },
  anthropicMismatchedProviderFile: {
    modality: 'image',
    source: 'provider-file',
    message:
      "Provider 'anthropic' model 'claude-sonnet-4' does not support image from provider-file",
  },
  mockMismatchedProviderFile: {
    modality: 'image',
    source: 'provider-file',
    message: "Provider 'mock' model 'mock-model' does not support image from provider-file",
  },
};
