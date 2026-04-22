/**
 * Seed data for the dev fixtures.
 *
 * Two seed paths:
 *
 *   seedHistorical(runtime)  — synchronous at module load. Stuffs synthetic
 *                              ExecutionInfo objects directly into the
 *                              StateStore with backdated timestamps so the
 *                              24h / 7d / 30d / all aggregator windows
 *                              show visibly different numbers from second
 *                              one of the dev session.
 *
 *   seedLive(runtime)        — async, scheduled after server startup.
 *                              Runs every workflow at least once, populates
 *                              memory, creates sessions, runs the qa-eval
 *                              cohort story (3 model upgrades over 10 days).
 */
import type { AxlRuntime, AxlEvent } from '@axlsdk/axl';
import { runEval } from '@axlsdk/eval';
import type { EvalConfig } from '@axlsdk/eval';

const DAY = 24 * 60 * 60 * 1000;

// ── Historical execution seed ───────────────────────────────────────

// Async + awaited. MemoryStore happens to mutate its map synchronously
// inside the async method, but SQLiteStore / RedisStore actually wait on
// I/O — without this awaited, the aggregator rebuild on createServer()
// would fire before the seed lands and the 24h/7d/30d/all windows would
// show empty numbers on startup.
export async function seedHistorical(runtime: AxlRuntime): Promise<void> {
  const store = runtime.getStateStore();
  const workflows = ['qa-workflow', 'research-workflow', 'rag-workflow', 'unreliable-workflow'];
  const agents = ['qa-agent', 'research-agent', 'qa-agent-upgraded'];
  const models = ['mock:gpt-4o', 'mock:claude-sonnet-4-6', 'mock:gpt-4o-mini'];
  let counter = 0;
  const saves: Array<Promise<unknown>> = [];

  // Distribution across the last 12 days:
  //   2 days ago: 6 (inside 7d, outside 24h)
  //   5 days ago: 4 (inside 7d)
  //  10 days ago: 5 (inside 30d, outside 7d)
  const plan = [
    { daysAgo: 2, count: 6 },
    { daysAgo: 5, count: 4 },
    { daysAgo: 10, count: 5 },
  ];

  for (const { daysAgo, count } of plan) {
    for (let i = 0; i < count; i++) {
      const startedAt = Date.now() - daysAgo * DAY - i * 60_000;
      const duration = 500 + Math.floor(Math.random() * 1500);
      const workflow = workflows[counter % workflows.length];
      const agent = agents[counter % agents.length];
      const model = models[counter % models.length];
      const cost = 0.002 + Math.random() * 0.008;
      const inputTokens = 100 + Math.floor(Math.random() * 100);
      const outputTokens = 180 + Math.floor(Math.random() * 120);
      // ~30% failure for unreliable-workflow.
      const status: 'completed' | 'failed' =
        workflow === 'unreliable-workflow' && Math.random() < 0.3 ? 'failed' : 'completed';
      const execId = `hist-${counter}`;
      const askId = `hist-ask-${counter}`;
      counter += 1;

      const events = [
        {
          type: 'workflow_start' as const,
          executionId: execId,
          step: 0,
          timestamp: startedAt,
          workflow,
          data: { input: {} },
        },
        {
          type: 'agent_call_end' as const,
          executionId: execId,
          step: 1,
          timestamp: startedAt + 100,
          workflow,
          askId,
          depth: 0,
          agent,
          model,
          cost,
          duration: duration - 200,
          tokens: { input: inputTokens, output: outputTokens },
          data: {
            prompt: 'historical seed',
            response: 'historical seed response',
            params: {},
            turn: 1,
          },
        },
        {
          type: 'workflow_end' as const,
          executionId: execId,
          step: 2,
          timestamp: startedAt + duration,
          workflow,
          data:
            status === 'completed'
              ? { status, duration, result: 'historical seed result' }
              : { status, duration, error: 'Simulated historical failure' },
        },
      ];

      const saved = store.saveExecution?.({
        executionId: execId,
        workflow,
        status,
        events: events as unknown as AxlEvent[],
        totalCost: cost,
        startedAt,
        completedAt: startedAt + duration,
        duration,
        ...(status === 'failed' ? { error: 'Simulated historical failure' } : {}),
      });
      if (saved) saves.push(saved);
    }
  }

  await Promise.all(saves);

  // eslint-disable-next-line no-console
  console.log(
    `[axl-studio dev] Seeded ${counter} historical executions across the last 12 days`,
  );
}

// ── Live seed ────────────────────────────────────────────────────────

const FACTS: Array<[string, string]> = [
  ['fact:typescript', 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript and catches type errors at compile time.'],
  ['fact:react-hooks', 'React Hooks are functions that let you use state and other React features without writing class components. Common hooks include useState, useEffect, useMemo, and useCallback.'],
  ['fact:closures', 'A closure is a function that remembers variables from the scope in which it was defined, even after that outer scope has finished executing.'],
  ['fact:event-loop', 'The JavaScript event loop continuously checks the call stack and task queue, enabling non-blocking I/O through asynchronous callbacks.'],
  ['fact:promises', 'A Promise represents the eventual completion or failure of an asynchronous operation and supports chained .then/.catch handlers.'],
  ['fact:docker', 'Docker packages applications into lightweight containers that include code, runtime, libraries, and dependencies for consistent deployment across environments.'],
  ['fact:kubernetes', 'Kubernetes is an open-source orchestration system for automating deployment, scaling, and management of containerized applications.'],
  ['fact:rest', 'REST (Representational State Transfer) is an architectural style for building stateless web APIs using standard HTTP verbs.'],
  ['fact:websockets', 'WebSockets provide full-duplex communication over a single TCP connection, enabling real-time bidirectional data exchange between client and server.'],
  ['fact:microservices', 'Microservices architecture decomposes an application into small, independently deployable services that communicate over well-defined APIs.'],
];

export async function seedLive(runtime: AxlRuntime): Promise<void> {
  try {
    // Embedder seed — every fact triggers a memory_remember trace event
    // with cost. Populates Trace Explorer + Cost Dashboard byEmbedder.
    const seedCtx = runtime.createContext();
    for (const [key, value] of FACTS) {
      await seedCtx.remember(key, value, { embed: true, scope: 'global' });
    }

    // Baseline executions.
    await runtime.execute('qa-workflow', { question: 'What is TypeScript?' });
    await runtime.execute('qa-workflow', { question: 'Explain closures in JavaScript' });
    await runtime.execute('research-workflow', { topic: 'WebAssembly performance', depth: 'deep' });
    await runtime.execute('qa-workflow', { question: 'How do React hooks work?' });
    await runtime.execute('research-workflow', { topic: 'Edge computing trends', depth: 'shallow' });

    // RAG: each call does semantic recall (1 embedder call) + agent ask.
    await runtime.execute('rag-workflow', { question: 'Tell me about TypeScript and its benefits' });
    await runtime.execute('rag-workflow', { question: 'How do React hooks work in practice?' });
    await runtime.execute('rag-workflow', { question: 'Explain the JavaScript event loop' });
    await runtime.execute('rag-workflow', { question: 'What are the differences between Docker and Kubernetes?' });

    // Memory-heavy: 3 recalls + 1 write per run.
    await runtime.execute('memory-heavy-workflow', { topic: 'TypeScript' });
    await runtime.execute('memory-heavy-workflow', { topic: 'React' });
    await runtime.execute('memory-heavy-workflow', { topic: 'Docker' });

    // Unreliable: ~50% fail rate seeds non-zero failure stats.
    for (let i = 0; i < 6; i++) {
      await runtime.execute('unreliable-workflow', { message: `attempt ${i}` }).catch(() => {});
    }

    // Budget-demo trips on the 2nd recall.
    await runtime.execute('budget-demo-workflow', {
      budget: '$0.0000001',
      callCount: 20,
    });

    // Spec/16 unified-event-model seeds — at least one execution of each
    // so history has the new event shapes ready to inspect.
    await runtime.execute('nested-asks-workflow', { topic: 'unified event model' }).catch(() => {});
    await runtime.execute('handoff-workflow', { query: 'review of architecture trade-offs' }).catch(() => {});
    await runtime.execute('schema-retry-workflow', { question: 'rate the spec' }).catch(() => {});
    await runtime.execute('parallel-workflow', { topics: ['observability', 'streaming', 'state'] }).catch(() => {});
    await runtime.execute('streaming-structured-workflow', { subject: 'event-model migration' }).catch(() => {});
    await runtime.execute('ask-failure-workflow', { question: 'force a failure' }).catch(() => {});
    await runtime.execute('always-fail-workflow', { message: 'expected to fail' }).catch(() => {});

    // Sessions for the Session Manager panel.
    const session1 = runtime.session('session-typescript-intro');
    await session1.send('qa-workflow', { question: 'What is TypeScript and why should I use it?' });
    await session1.send('qa-workflow', { question: 'How does it compare to JavaScript?' });
    await session1.send('qa-workflow', { question: 'What are generics in TypeScript?' });

    const session2 = runtime.session('session-react-deep-dive');
    await session2.send('qa-workflow', { question: 'Explain React hooks' });
    await session2.send('qa-workflow', { question: 'What is the difference between useState and useReducer?' });
    await session2.send('qa-workflow', { question: 'When should I use useMemo vs useCallback?' });
    await session2.send('qa-workflow', { question: 'How do custom hooks work?' });
    await session2.send('qa-workflow', { question: 'Explain the rules of hooks' });

    const session3 = runtime.session('session-devops-questions');
    await session3.send('qa-workflow', { question: 'What is Docker?' });
    await session3.send('qa-workflow', { question: 'How does Kubernetes orchestrate containers?' });

    const session4 = runtime.session('session-structured-responses');
    await session4.send('structured-workflow', { question: 'What are TypeScript generics?' });
    await session4.send('structured-workflow', { question: 'Explain React Server Components' });

    // qa-eval model-upgrade story: three cohorts spread across 10 days.
    await seedQaEvalCohorts(runtime);
    await seedRagEval(runtime);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[axl-studio dev] seed failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── qa-eval cohort story ────────────────────────────────────────────
//
// Three cohorts spread across 10 days that tell a narrative: over time,
// the team upgraded models and saw quality rise (with corresponding cost
// and latency shifts). Makes the "By Model" view on Eval Trends
// immediately useful.
//
//   Cohort 1 (mini, days 8-10 ago):    baseline scores, fast, cheap
//   Cohort 2 (gpt-4o, days 3-5 ago):   +0.06 scores, 1.0× duration, 1.0× cost
//   Cohort 3 (claude, days 0-2 ago):   +0.13 scores, 1.6× duration, 2.5× cost
//
// Scores are biased post-hoc on the EvalResult: scorer means, per-item
// scores, duration, cost, and model metadata are overridden so the UI
// shows the upgrade-path trend without per-model provider behavior.

type Cohort = {
  label: string;
  model: string;
  scoreBias: number;
  durMult: number;
  costMult: number;
  daysAgoStart: number;
  daysAgoEnd: number;
  runs: number;
};

const COHORTS: Cohort[] = [
  { label: 'mini era', model: 'mock:gpt-4o-mini', scoreBias: 0, durMult: 0.6, costMult: 0.3, daysAgoStart: 10, daysAgoEnd: 8, runs: 5 },
  { label: 'gpt-4o upgrade', model: 'mock:gpt-4o', scoreBias: 0.06, durMult: 1.0, costMult: 1.0, daysAgoStart: 5, daysAgoEnd: 3, runs: 4 },
  { label: 'claude upgrade', model: 'mock:claude-sonnet-4-6', scoreBias: 0.13, durMult: 1.6, costMult: 2.5, daysAgoStart: 2, daysAgoEnd: 0, runs: 4 },
];

async function seedQaEvalCohorts(runtime: AxlRuntime): Promise<void> {
  const qaEvalEntry = runtime.getRegisteredEval('qa-eval');
  if (!qaEvalEntry) return;
  const { randomUUID } = await import('node:crypto');
  const config = qaEvalEntry.config as EvalConfig;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  const execQa = async (input: unknown) => {
    const { result, cost, metadata } = await runtime.trackExecution(async () =>
      runtime.execute('qa-workflow', input),
    );
    return { output: result, cost, metadata };
  };

  for (const cohort of COHORTS) {
    const groupId = randomUUID();
    for (let i = 0; i < cohort.runs; i++) {
      const result = await runEval(config, execQa, runtime);

      // Override model metadata so the reducer's extractModel picks this cohort.
      result.metadata.models = [cohort.model];
      result.metadata.modelCounts = { [cohort.model]: result.items.length };
      result.metadata.runGroupId = groupId;
      result.metadata.runIndex = i;

      // Bias per-item scores (clamped to [0,1]) and recompute summary stats.
      // Apply costMult to BOTH item.cost (LLM) and item.scorerCost (scorer
      // LLM-as-judge), so the recomputed totalCost below sums the same
      // total the eval runner would compute on a fresh row.
      for (const item of result.items) {
        for (const name of Object.keys(item.scores)) {
          const current = item.scores[name];
          if (typeof current === 'number') {
            item.scores[name] = clamp(current + cohort.scoreBias, 0, 1);
          }
        }
        if (typeof item.duration === 'number') {
          item.duration = Math.round(item.duration * cohort.durMult);
        }
        if (typeof item.cost === 'number') {
          item.cost *= cohort.costMult;
        }
        if (typeof item.scorerCost === 'number') {
          item.scorerCost *= cohort.costMult;
        }
      }
      for (const name of Object.keys(result.summary.scorers)) {
        const vals = result.items
          .map((it) => it.scores[name])
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
          .sort((a, b) => a - b);
        if (vals.length === 0) continue;
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        result.summary.scorers[name] = {
          mean,
          min: vals[0],
          max: vals[vals.length - 1],
          p50: vals[Math.floor((vals.length - 1) * 0.5)],
          p95: vals[Math.floor((vals.length - 1) * 0.95)],
        };
      }
      // totalCost includes both LLM cost AND scorer cost — matching what
      // runEval emits after a fresh run. Dropping scorerCost here would
      // make the cohort totals diverge from per-row sums in the UI.
      result.totalCost = result.items.reduce(
        (s, it) => s + (it.cost ?? 0) + (it.scorerCost ?? 0),
        0,
      );
      result.duration = result.items.reduce((s, it) => s + (it.duration ?? 0), 0);

      // Spread runs evenly across the cohort's time window.
      const span = cohort.daysAgoStart - cohort.daysAgoEnd;
      const offsetDays =
        cohort.runs > 1
          ? cohort.daysAgoStart - (span * i) / (cohort.runs - 1)
          : cohort.daysAgoEnd;
      const timestamp = Date.now() - offsetDays * DAY;

      await runtime.saveEvalResult({
        id: result.id,
        eval: 'qa-eval',
        timestamp,
        data: result,
      });
    }
  }

  // One mixed-model run 1 day ago — exercises "most-called model" heuristic.
  const execMixed = async (input: unknown) => {
    const { result, cost, metadata } = await runtime.trackExecution(async () =>
      runtime.execute('qa-workflow-multistep', input),
    );
    return { output: result, cost, metadata };
  };
  const mixedResult = await runEval(config, execMixed, runtime);
  await runtime.saveEvalResult({
    id: mixedResult.id,
    eval: 'qa-eval',
    timestamp: Date.now() - 1 * DAY,
    data: mixedResult,
  });
}

async function seedRagEval(runtime: AxlRuntime): Promise<void> {
  const ragEvalEntry = runtime.getRegisteredEval('rag-eval');
  if (!ragEvalEntry) return;
  const ragConfig = ragEvalEntry.config as EvalConfig;
  const execRag = async (input: unknown) => {
    const { result, cost, metadata } = await runtime.trackExecution(async () =>
      runtime.execute('rag-workflow', input),
    );
    return { output: result, cost, metadata };
  };
  const ragResult = await runEval(ragConfig, execRag, runtime);
  await runtime.saveEvalResult({
    id: ragResult.id,
    eval: 'rag-eval',
    timestamp: Date.now() - 2 * DAY,
    data: ragResult,
  });
}
