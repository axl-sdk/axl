import { readFileSync } from 'node:fs';
import { agent, type ModelInput } from '@axlsdk/axl';
import { z } from 'zod';

// Reuse the repository's real Studio screenshot: no hosted URL or upload
// service is needed, and providers receive a normal, decodable PNG.
const screenshotBytes = readFileSync(
  new URL('../docs/assets/studio-playground.png', import.meta.url),
);

const model = process.env.IMAGE_MODEL ?? 'openai-responses:gpt-4o-mini';

const screenshot: ModelInput = [
  { type: 'text', text: 'Inspect this UI screenshot fixture.' },
  {
    type: 'image',
    label: 'Studio Playground screenshot',
    source: { type: 'bytes', data: screenshotBytes, mediaType: 'image/png' },
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
