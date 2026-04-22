/**
 * Datasets, scorers, and eval registrations.
 *
 * Six evals total — each one exercises a distinct piece of the eval
 * runner UI (history, multi-run, traces on failure, retry visualization,
 * comparison, etc).
 */
import type { AxlRuntime } from '@axlsdk/axl';
import { dataset, scorer } from '@axlsdk/eval';
import { z } from 'zod';

// ── Scorers ──────────────────────────────────────────────────────────

export const notEmpty = scorer({
  name: 'not-empty',
  description: 'Output is non-empty',
  score: (output) => (String(output).length > 5 ? 1 : 0),
});

export const topicRelevance = scorer({
  name: 'topic-relevant',
  description: 'Output mentions the expected topic',
  score: (output, _input, annotations) => {
    const topic = (annotations as { expectedTopic?: string })?.expectedTopic ?? '';
    return String(output).toLowerCase().includes(topic) ? 1 : 0.4;
  },
});

export const quality = scorer({
  name: 'quality',
  description: 'Simulated quality score with noise',
  score: (_output, input) => {
    const q = String((input as { question?: string })?.question ?? '');
    const len = q.length;
    const base = len > 30 ? 0.95 : len > 20 ? 0.85 : 0.7;
    const noise = (Math.random() - 0.5) * 0.15;
    const score = Math.max(0, Math.min(1, base + noise));
    const rounded = Math.round(score * 1000) / 1000;
    return {
      score: rounded,
      metadata: {
        reasoning: `Quality base ${base.toFixed(2)}, adjusted by ${noise >= 0 ? '+' : ''}${noise.toFixed(3)}.${
          rounded >= 0.85
            ? ' High quality.'
            : rounded >= 0.7
              ? ' Adequate quality.'
              : ' Below expectations.'
        }`,
        confidence: 0.7 + Math.random() * 0.2,
      },
    };
  },
});

export const safety = scorer({
  name: 'safety',
  description: 'Simulated safety check with noise',
  score: (_output, input) => {
    const q = String((input as { question?: string })?.question ?? '').toLowerCase();
    const base = q.includes('docker') || q.includes('https') ? 0.6 : 1.0;
    const noise = (Math.random() - 0.5) * 0.1;
    const score = Math.max(0, Math.min(1, base + noise));
    return Math.round(score * 1000) / 1000;
  },
});

// Marked isLlm so scorerTypes metadata distinguishes from deterministic.
export const fluency = {
  name: 'fluency',
  description: 'Simulated LLM fluency scorer with noise (for CI demo)',
  isLlm: true,
  score: (_output: unknown, input: unknown) => {
    const q = String((input as { question?: string })?.question ?? '');
    const base = q.length > 30 ? 0.9 : q.length > 20 ? 0.8 : 0.65;
    const noise = (Math.random() - 0.5) * 0.2;
    const score = Math.max(0, Math.min(1, base + noise));
    const rounded = Math.round(score * 1000) / 1000;
    return {
      score: rounded,
      metadata: {
        reasoning: `Base fluency ${base.toFixed(2)} with noise ${noise >= 0 ? '+' : ''}${noise.toFixed(3)}. ${
          rounded >= 0.8
            ? 'Fluent response.'
            : rounded >= 0.5
              ? 'Acceptable fluency.'
              : 'Below fluency threshold.'
        }`,
        confidence: 0.7 + Math.random() * 0.2,
      },
    };
  },
};

// ── Datasets ─────────────────────────────────────────────────────────

export const qaDataset = dataset({
  name: 'qa-basics',
  schema: z.object({ question: z.string() }),
  annotations: z.object({ expectedTopic: z.string() }),
  items: [
    { input: { question: 'What is TypeScript?' }, annotations: { expectedTopic: 'typescript' } },
    { input: { question: 'Explain closures in JavaScript' }, annotations: { expectedTopic: 'closures' } },
    { input: { question: 'What are React hooks?' }, annotations: { expectedTopic: 'react' } },
    { input: { question: 'How does garbage collection work?' }, annotations: { expectedTopic: 'gc' } },
    { input: { question: 'What is a promise?' }, annotations: { expectedTopic: 'promises' } },
    { input: { question: 'Explain the event loop' }, annotations: { expectedTopic: 'event-loop' } },
    { input: { question: 'What is a REST API?' }, annotations: { expectedTopic: 'rest' } },
    { input: { question: 'How do WebSockets work?' }, annotations: { expectedTopic: 'websockets' } },
    { input: { question: 'What is Docker?' }, annotations: { expectedTopic: 'docker' } },
    { input: { question: 'Explain microservices' }, annotations: { expectedTopic: 'microservices' } },
    { input: { question: 'What is CI/CD?' }, annotations: { expectedTopic: 'cicd' } },
    { input: { question: 'How does HTTPS work?' }, annotations: { expectedTopic: 'https' } },
  ],
});

export const miniDataset = dataset({
  name: 'mini-test',
  schema: z.object({ question: z.string() }),
  items: [
    { input: { question: 'Hello world' } },
    { input: { question: 'Testing 123' } },
    { input: { question: 'How does async/await work in JavaScript?' } },
  ],
});

export const ragDataset = dataset({
  name: 'rag-basics',
  schema: z.object({ question: z.string() }),
  annotations: z.object({ expectedTopic: z.string() }),
  items: [
    { input: { question: 'Tell me about TypeScript' }, annotations: { expectedTopic: 'typescript' } },
    { input: { question: 'How do React hooks work?' }, annotations: { expectedTopic: 'react-hooks' } },
    { input: { question: 'Explain closures' }, annotations: { expectedTopic: 'closures' } },
    { input: { question: 'What is the event loop?' }, annotations: { expectedTopic: 'event-loop' } },
    { input: { question: 'Explain Docker' }, annotations: { expectedTopic: 'docker' } },
    { input: { question: 'What are microservices?' }, annotations: { expectedTopic: 'microservices' } },
  ],
});

// Item 0's question starts with "FAIL", which `flakyWorkflow` matches via
// `.startsWith("FAIL")` — that item deterministically throws after the
// agent_call lands, exercising the eval runner's `axlCapturedTraces`
// failure-path side-channel. The other three items succeed.
export const flakyDataset = dataset({
  name: 'flaky-basics',
  schema: z.object({ question: z.string() }),
  items: [
    { input: { question: 'FAIL: this item deterministically throws' } },
    { input: { question: 'What is TypeScript?' } },
    { input: { question: 'Explain async/await' } },
    { input: { question: 'How does npm resolve packages?' } },
  ],
});

export const schemaRetryDataset = dataset({
  name: 'schema-retry-basics',
  schema: z.object({ question: z.string() }),
  items: [
    { input: { question: 'Rate TypeScript' } },
    { input: { question: 'Rate React' } },
  ],
});

// Every item fails with a `ValidationError` whose `.message` echoes the
// user question. Run with `AXL_DEV_REDACT=1` to verify the REST error
// envelope and `eval:*` WS error broadcast both scrub the message via
// `redactErrorMessage`. Run without redact to see the unscrubbed leak
// surface for comparison. The PII-shaped questions (SSN, email) make
// the scrubbing visually obvious in the panel.
export const leakyDataset = dataset({
  name: 'leaky-basics',
  schema: z.object({ question: z.string() }),
  items: [
    { input: { question: 'SSN 123-45-6789' } },
    { input: { question: 'email alice@example.com' } },
  ],
});

// ── Registration helper ──────────────────────────────────────────────

export function registerEvals(runtime: AxlRuntime): void {
  runtime.registerEval('qa-eval', {
    workflow: 'qa-workflow',
    dataset: qaDataset,
    scorers: [notEmpty, topicRelevance, quality, safety, fluency],
  });

  runtime.registerEval('mini-eval', {
    workflow: 'qa-workflow',
    dataset: miniDataset,
    scorers: [notEmpty, quality, fluency],
  });

  runtime.registerEval('rag-eval', {
    workflow: 'rag-workflow',
    dataset: ragDataset,
    scorers: [notEmpty, topicRelevance, quality, fluency],
  });

  runtime.registerEval('flaky-eval', {
    workflow: 'flaky-workflow',
    dataset: flakyDataset,
    scorers: [notEmpty, quality],
  });

  runtime.registerEval('schema-retry-eval', {
    workflow: 'schema-retry-workflow',
    dataset: schemaRetryDataset,
    scorers: [notEmpty],
  });

  runtime.registerEval('leaky-eval', {
    workflow: 'leaky-workflow',
    dataset: leakyDataset,
    scorers: [notEmpty],
  });
}
