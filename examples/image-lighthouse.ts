import { agent, type ModelInput } from '@axlsdk/axl';
import { z } from 'zod';

// A transparent 1×1 PNG. Keeping this tiny fixture as source makes the
// example runnable without a local file path, hosted URL, or upload service.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4HgAAAABJRU5ErkJggg==';

const model = process.env.IMAGE_MODEL ?? 'openai-responses:gpt-4o-mini';

const screenshot: ModelInput = [
  { type: 'text', text: 'Inspect this UI screenshot fixture.' },
  {
    type: 'image',
    label: 'transparent pixel fixture',
    source: { type: 'base64', data: PNG_1X1, mediaType: 'image/png' },
  },
  { type: 'text', text: 'Return a concise visual finding.' },
];

const Finding = z.object({
  visible: z.boolean(),
  finding: z.string().max(160),
});

const analyst = agent({
  name: 'image-analyst',
  model,
  system: 'You inspect images carefully. Return only the requested JSON.',
});

const verifier = agent({
  name: 'finding-verifier',
  model,
  system: 'You verify a short visual finding. Return one concise sentence.',
});

const finding = await analyst.ask(screenshot, {
  schema: Finding,
  maxTokens: 100,
  temperature: 0,
  retries: 1,
});

const verification = await verifier.ask(
  `Verify this image finding and state whether it is plausible: ${JSON.stringify(finding)}`,
  { maxTokens: 80, temperature: 0 },
);

console.log({ model, finding, verification });
