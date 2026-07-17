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
import type { AxlRuntime, AxlEvent, HistoricalExecutionInfo } from '@axlsdk/axl';
import { runEval } from '@axlsdk/eval';
import type { EvalConfig, EvalResult, EvalItem, EvalSummary } from '@axlsdk/eval';

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
  const models = [
    'openai-responses:gpt-5.4',
    'openai-responses:gpt-5.5',
    'openai-responses:gpt-5-mini',
  ];
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
          schemaVersion: 2 as const,
          type: 'workflow_start' as const,
          executionId: execId,
          step: 0,
          timestamp: startedAt,
          workflow,
          data: { input: {} },
        },
        {
          schemaVersion: 2 as const,
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
          schemaVersion: 2 as const,
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
        eventSchemaVersion: 2,
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

  const lifecycleStartedAt = Date.now() - 60_000;
  const v2Base = {
    schemaVersion: 2 as const,
    executionId: 'tool-lifecycle-v2-demo',
    timestamp: lifecycleStartedAt,
    workflow: 'tool-lifecycle-v2-demo',
    askId: 'tool-lifecycle-v2-ask',
    depth: 0,
    agent: 'tool-lifecycle-demo-agent',
  };
  const v2Events: AxlEvent[] = [
    {
      schemaVersion: 2,
      executionId: v2Base.executionId,
      step: 0,
      timestamp: lifecycleStartedAt,
      workflow: v2Base.workflow,
      type: 'workflow_start',
      data: { input: {} },
    },
    ...(
      [
        {
          callId: 'demo-succeeded',
          outcome: { status: 'succeeded', result: { answer: 42 } },
        },
        {
          callId: 'demo-failed',
          outcome: {
            status: 'failed',
            failure: {
              phase: 'projection',
              kind: 'output',
              disposition: 'abort',
              error: { name: 'ToolModelOutputError', message: 'Projection failed' },
              result: { hostOnly: true },
            },
          },
        },
        { callId: 'demo-denied', outcome: { status: 'denied', reason: 'Operator denied' } },
        {
          callId: 'demo-cancelled',
          outcome: {
            status: 'cancelled',
            cancellation: {
              phase: 'after_handler',
              reason: 'Execution cancelled',
              result: { completedBeforeCancel: true },
            },
          },
        },
      ] as const
    ).flatMap(({ callId, outcome }, index) => [
      {
        ...v2Base,
        step: index * 2 + 1,
        timestamp: lifecycleStartedAt + index * 20 + 1,
        type: 'tool_call_start' as const,
        tool: 'demo_tool',
        callId,
        data: { args: { scenario: outcome.status } },
      },
      {
        ...v2Base,
        step: index * 2 + 2,
        timestamp: lifecycleStartedAt + index * 20 + 2,
        type: 'tool_call_end' as const,
        tool: 'demo_tool',
        callId,
        duration: 1,
        data: { args: { scenario: outcome.status }, outcome },
      },
    ]),
    {
      ...v2Base,
      step: 9,
      timestamp: lifecycleStartedAt + 90,
      type: 'tool_call_rejected',
      tool: 'missing_tool',
      callId: 'demo-rejected',
      data: {
        reason: 'unavailable',
        requestedTool: 'missing_tool',
        availableTools: ['demo_tool'],
      },
    },
    {
      schemaVersion: 2,
      executionId: v2Base.executionId,
      step: 10,
      timestamp: lifecycleStartedAt + 100,
      workflow: v2Base.workflow,
      type: 'workflow_end',
      data: { status: 'completed', duration: 100, result: 'seeded lifecycle outcomes' },
    },
  ];
  const lifecycleExecutions: HistoricalExecutionInfo[] = [
    {
      executionId: v2Base.executionId,
      eventSchemaVersion: 2,
      workflow: v2Base.workflow,
      status: 'completed',
      events: v2Events,
      totalCost: 0,
      startedAt: lifecycleStartedAt,
      completedAt: lifecycleStartedAt + 100,
      duration: 100,
      result: 'seeded lifecycle outcomes',
    },
    {
      executionId: 'tool-lifecycle-v1-demo',
      workflow: 'tool-lifecycle-v1-demo',
      status: 'completed',
      totalCost: 0,
      startedAt: lifecycleStartedAt - 1_000,
      completedAt: lifecycleStartedAt - 900,
      duration: 100,
      events: [
        {
          executionId: 'tool-lifecycle-v1-demo',
          step: 1,
          timestamp: lifecycleStartedAt - 990,
          type: 'tool_call_start',
          askId: 'legacy-ask',
          depth: 0,
          agent: 'legacy-agent',
          tool: 'legacy_tool',
          callId: 'legacy-complete',
          data: { args: { value: 1 } },
        },
        {
          executionId: 'tool-lifecycle-v1-demo',
          step: 2,
          timestamp: lifecycleStartedAt - 980,
          type: 'tool_call_end',
          askId: 'legacy-ask',
          depth: 0,
          agent: 'legacy-agent',
          tool: 'legacy_tool',
          callId: 'legacy-complete',
          duration: 10,
          data: {
            args: { value: 1 },
            result: { error: null, value: 1 },
            callId: 'legacy-complete',
          },
        },
        {
          executionId: 'tool-lifecycle-v1-demo',
          step: 3,
          timestamp: lifecycleStartedAt - 970,
          type: 'tool_call_start',
          askId: 'legacy-ask',
          depth: 0,
          agent: 'legacy-agent',
          tool: 'legacy_incomplete_tool',
          callId: 'legacy-incomplete',
          data: { args: {} },
        },
      ],
    },
  ];
  for (const execution of lifecycleExecutions) {
    const saved = store.saveExecution?.(execution);
    if (saved) saves.push(saved);
  }

  await Promise.all(saves);

  // eslint-disable-next-line no-console
  console.log(
    `[axl-studio dev] Seeded ${counter + lifecycleExecutions.length} historical executions across the last 12 days`,
  );
}

// ── Live seed ────────────────────────────────────────────────────────

const FACTS: Array<[string, string]> = [
  [
    'fact:typescript',
    'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript and catches type errors at compile time.',
  ],
  [
    'fact:react-hooks',
    'React Hooks are functions that let you use state and other React features without writing class components. Common hooks include useState, useEffect, useMemo, and useCallback.',
  ],
  [
    'fact:closures',
    'A closure is a function that remembers variables from the scope in which it was defined, even after that outer scope has finished executing.',
  ],
  [
    'fact:event-loop',
    'The JavaScript event loop continuously checks the call stack and task queue, enabling non-blocking I/O through asynchronous callbacks.',
  ],
  [
    'fact:promises',
    'A Promise represents the eventual completion or failure of an asynchronous operation and supports chained .then/.catch handlers.',
  ],
  [
    'fact:docker',
    'Docker packages applications into lightweight containers that include code, runtime, libraries, and dependencies for consistent deployment across environments.',
  ],
  [
    'fact:kubernetes',
    'Kubernetes is an open-source orchestration system for automating deployment, scaling, and management of containerized applications.',
  ],
  [
    'fact:rest',
    'REST (Representational State Transfer) is an architectural style for building stateless web APIs using standard HTTP verbs.',
  ],
  [
    'fact:websockets',
    'WebSockets provide full-duplex communication over a single TCP connection, enabling real-time bidirectional data exchange between client and server.',
  ],
  [
    'fact:microservices',
    'Microservices architecture decomposes an application into small, independently deployable services that communicate over well-defined APIs.',
  ],
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
    await runtime.execute('research-workflow', {
      topic: 'Edge computing trends',
      depth: 'shallow',
    });

    // RAG: each call does semantic recall (1 embedder call) + agent ask.
    await runtime.execute('rag-workflow', {
      question: 'Tell me about TypeScript and its benefits',
    });
    await runtime.execute('rag-workflow', { question: 'How do React hooks work in practice?' });
    await runtime.execute('rag-workflow', { question: 'Explain the JavaScript event loop' });
    await runtime.execute('rag-workflow', {
      question: 'What are the differences between Docker and Kubernetes?',
    });

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
    await runtime
      .execute('handoff-workflow', { query: 'review of architecture trade-offs' })
      .catch(() => {});
    await runtime.execute('schema-retry-workflow', { question: 'rate the spec' }).catch(() => {});
    await runtime
      .execute('parallel-workflow', { topics: ['observability', 'streaming', 'state'] })
      .catch(() => {});
    await runtime
      .execute('streaming-structured-workflow', { subject: 'event-model migration' })
      .catch(() => {});
    await runtime.execute('ask-failure-workflow', { question: 'force a failure' }).catch(() => {});
    await runtime.execute('always-fail-workflow', { message: 'expected to fail' }).catch(() => {});

    // Sessions for the Session Manager panel.
    const session1 = runtime.session('session-typescript-intro');
    await session1.send('qa-workflow', { question: 'What is TypeScript and why should I use it?' });
    await session1.send('qa-workflow', { question: 'How does it compare to JavaScript?' });
    await session1.send('qa-workflow', { question: 'What are generics in TypeScript?' });

    const session2 = runtime.session('session-react-deep-dive');
    await session2.send('qa-workflow', { question: 'Explain React hooks' });
    await session2.send('qa-workflow', {
      question: 'What is the difference between useState and useReducer?',
    });
    await session2.send('qa-workflow', { question: 'When should I use useMemo vs useCallback?' });
    await session2.send('qa-workflow', { question: 'How do custom hooks work?' });
    await session2.send('qa-workflow', { question: 'Explain the rules of hooks' });

    const session3 = runtime.session('session-devops-questions');
    await session3.send('qa-workflow', { question: 'What is Docker?' });
    await session3.send('qa-workflow', { question: 'How does Kubernetes orchestrate containers?' });

    const session4 = runtime.session('session-structured-responses');
    await session4.send('structured-workflow', { question: 'What are TypeScript generics?' });
    await session4.send('structured-workflow', { question: 'Explain React Server Components' });

    // Multi-agent session — exercises ChatMessage.agent stamps. The
    // qa-workflow-multistep workflow calls ctx.ask(mathAgent) then
    // ctx.ask(qaAgent), so the persisted history alternates between the
    // two agents and the Session Manager panel renders distinct badges.
    const session5 = runtime.session('session-multi-agent-attribution');
    await session5.send('qa-workflow-multistep', {
      question: 'What is the time complexity of quicksort?',
    });
    await session5.send('qa-workflow-multistep', {
      question: 'Explain the difference between BFS and DFS',
    });

    // qa-eval model-upgrade story: three cohorts spread across 10 days.
    await seedQaEvalCohorts(runtime);
    await seedRagEval(runtime);
    await seedPartialBatchEval(runtime);
    await seedConditionalScorerEval(runtime);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[axl-studio dev] seed failed:', err instanceof Error ? err.message : String(err));
  }
}

// ── qa-eval cohort story ────────────────────────────────────────────
//
// Three cohorts spread across 10 days that tell a narrative: over time,
// the team upgraded models and saw quality rise (with corresponding cost
// and latency shifts). Makes the "By Model" view on Eval Trends
// immediately useful.
//
//   Cohort 1 (gpt-5-mini, days 8-10 ago): baseline scores, fast, cheap
//   Cohort 2 (gpt-5.4, days 3-5 ago):     +0.06 scores, 1.0× duration, 1.0× cost
//   Cohort 3 (gpt-5.5, days 0-2 ago):     +0.13 scores, 1.6× duration, 2.5× cost
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
  {
    label: 'gpt-5-mini era',
    model: 'openai-responses:gpt-5-mini',
    scoreBias: 0,
    durMult: 0.6,
    costMult: 0.3,
    daysAgoStart: 10,
    daysAgoEnd: 8,
    runs: 5,
  },
  {
    label: 'gpt-5.4 upgrade',
    model: 'openai-responses:gpt-5.4',
    scoreBias: 0.06,
    durMult: 1.0,
    costMult: 1.0,
    daysAgoStart: 5,
    daysAgoEnd: 3,
    runs: 4,
  },
  {
    label: 'gpt-5.5 upgrade',
    model: 'openai-responses:gpt-5.5',
    scoreBias: 0.13,
    durMult: 1.6,
    costMult: 2.5,
    daysAgoStart: 2,
    daysAgoEnd: 0,
    runs: 4,
  },
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
        cohort.runs > 1 ? cohort.daysAgoStart - (span * i) / (cohort.runs - 1) : cohort.daysAgoEnd;
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

// ── Partial-batch eval (2 of 5 completed) ────────────────────────────
//
// Simulates the failure mode that the multi-run partial-preservation fix
// addresses: a 5-run batch where runs 1 + 2 succeed and run 3 throws
// (e.g. provider 503). The fix preserves the completed runs in history
// with `metadata.batchAttempted: 5` so the Eval Runner panel can derive
// partial-ness. We seed the post-failure state directly: two history
// entries sharing a `runGroupId`, each tagged with `batchAttempted: 5`
// plus the explicit partial markers on every entry. When the user opens
// the Eval Runner panel and selects this group from history, the panel's
// partial-batch banner ("Partial batch — 2 of 5 runs completed") and the
// "Stopped after: ..." line should render distinctly from a complete run.
async function seedPartialBatchEval(runtime: AxlRuntime): Promise<void> {
  const entry = runtime.getRegisteredEval('partial-batch-eval');
  if (!entry) return;
  const { randomUUID } = await import('node:crypto');
  const config = entry.config as EvalConfig;
  const exec = async (input: unknown) => {
    const { result, cost, metadata } = await runtime.trackExecution(async () =>
      runtime.execute('qa-workflow', input),
    );
    return { output: result, cost, metadata };
  };

  // Two partial-batch groups so the Compare panel has a distinct
  // baseline / candidate pair (otherwise the picker won't let the user
  // run the comparison — datasets must match but groups must differ).
  // First group: 2 of 5 (provider 503). Second: 3 of 5 (rate limit).
  // Both render the partial-batch banner; comparing them produces the
  // partial-on-both-sides verdict view.
  const failures: Array<{ completed: number; failure: string; offsetMin: number }> = [
    {
      completed: 2,
      failure: 'Provider returned 503 Service Unavailable after 3 retries',
      offsetMin: 30,
    },
    {
      completed: 3,
      failure: 'Rate-limited by provider (429); aborted to preserve quota',
      offsetMin: 12,
    },
  ];
  const attempted = 5;

  for (const f of failures) {
    const groupId = randomUUID();
    for (let i = 0; i < f.completed; i++) {
      const result = await runEval(config, exec, runtime);
      result.metadata.runGroupId = groupId;
      result.metadata.runIndex = i;
      result.metadata.batchAttempted = attempted;
      result.metadata.partialBatch = true;
      result.metadata.batchCompleted = f.completed;
      result.metadata.batchFailure = f.failure;
      await runtime.saveEvalResult({
        id: result.id,
        eval: 'partial-batch-eval',
        timestamp: Date.now() - f.offsetMin * 60 * 1000 + i * 1000,
        data: result,
      });
    }
  }
}

// ── Conditional-scorer eval (the `applies` skip / N-A feature) ───────
//
// Exercises every Studio surface that renders the "skipped / N/A" scorer
// state introduced with the `applies` predicate:
//   - EvalSummaryTable / ScoreDistribution: an "N/A: N" chip on a
//     partially-skipped scorer, and a "No valid scores" row for a
//     fully-skipped scorer.
//   - Per-item detail / list: a neutral "N/A" badge, distinct from a
//     failed (amber) or low (red) score.
//   - Multi-run aggregate table (AggregateScorerRow): N/A chips + the
//     "No valid scores" guard.
//   - Compare view PairedSampleNote ("paired n=X · per-side B/C") and the
//     compare item table "N/A" cells — via two runs whose conditional
//     scorer applies to DIFFERENT item subsets (the asymmetric-skip case,
//     including equal-count-but-disjoint).
//
// Hand-crafted EvalResult rows (no provider/workflow needed) so the skip
// markers (`scoreDetails[name].skipped`) and the per-scorer
// scored/failed/skipped counts are fully under our control.
async function seedConditionalScorerEval(runtime: AxlRuntime): Promise<void> {
  const { randomUUID } = await import('node:crypto');

  const SCORERS = ['answer-quality', 'constraint-adherence', 'refusal-quality'] as const;
  const scorerTypes: Record<string, string> = {
    'answer-quality': 'llm',
    'constraint-adherence': 'deterministic',
    'refusal-quality': 'llm',
  };

  const QUESTIONS = [
    'What is TypeScript?',
    'Summarize this in exactly 3 bullet points.',
    'Explain closures in JavaScript.',
    'Respond in under 10 words: what is HTTP?',
    'How do React hooks work?',
    'List 5 sorting algorithms, one per line.',
    'What is the capital of France?',
    'Describe the JavaScript event loop.',
  ];
  // answer-quality runs on every item; constraint score used when an item is
  // "constrained". refusal-quality is never applicable here (fully N/A).
  const QUALITY = [0.92, 0.81, 0.88, 0.73, 0.95, 0.79, 0.99, 0.85];
  const CONSTRAINT = [0.9, 0.6, 0.75, 0.5, 0.8, 0.65, 1.0, 0.7];

  const r3 = (n: number) => Math.round(n * 1000) / 1000;

  const makeItem = (idx: number, constrained: boolean, qualityBias: number): EvalItem => {
    const scores: Record<string, number | null> = {};
    const scoreDetails: NonNullable<EvalItem['scoreDetails']> = {};

    const q = r3(Math.min(1, Math.max(0, QUALITY[idx] + qualityBias)));
    scores['answer-quality'] = q;
    scoreDetails['answer-quality'] = {
      score: q,
      duration: 120 + ((idx * 17) % 80),
      cost: 0.0006,
      metadata: {
        reasoning: 'Rated the answer for accuracy and completeness against the question.',
      },
    };

    if (constrained) {
      const c = CONSTRAINT[idx];
      scores['constraint-adherence'] = c;
      scoreDetails['constraint-adherence'] = { score: c, duration: 2 };
    } else {
      // Skipped: null score + positive `skipped` marker, NO duration.
      scores['constraint-adherence'] = null;
      scoreDetails['constraint-adherence'] = { score: null, skipped: true };
    }

    // No refusal-expected items in this dataset → fully N/A.
    scores['refusal-quality'] = null;
    scoreDetails['refusal-quality'] = { score: null, skipped: true };

    return {
      input: { question: QUESTIONS[idx], constrained },
      annotations: { constrained, expectRefusal: false },
      output: `A thorough answer to: ${QUESTIONS[idx]}`,
      scores,
      scoreDetails,
      duration: 700 + ((idx * 131) % 900),
      cost: 0.002 + ((idx * 7) % 5) / 1000,
      scorerCost: 0.0006,
    };
  };

  const summarize = (items: EvalItem[]): EvalSummary => {
    const scorers: EvalSummary['scorers'] = {};
    for (const name of SCORERS) {
      const vals = items
        .map((i) => i.scores[name])
        .filter((v): v is number => typeof v === 'number')
        .sort((a, b) => a - b);
      const skipped = items.filter((i) => i.scoreDetails?.[name]?.skipped === true).length;
      const failed = items.filter(
        (i) =>
          i.scores[name] == null &&
          i.scoreDetails?.[name]?.skipped !== true &&
          i.scoreDetails?.[name]?.duration != null,
      ).length;
      const stat = vals.length
        ? {
            mean: r3(vals.reduce((s, v) => s + v, 0) / vals.length),
            min: vals[0],
            max: vals[vals.length - 1],
            p50: vals[Math.floor((vals.length - 1) * 0.5)],
            p95: vals[Math.floor((vals.length - 1) * 0.95)],
          }
        : { mean: 0, min: 0, max: 0, p50: 0, p95: 0 };
      scorers[name] = { ...stat, scored: vals.length, failed, skipped };
    }
    const durs = items
      .map((i) => i.duration)
      .filter((d): d is number => typeof d === 'number')
      .sort((a, b) => a - b);
    const timing = durs.length
      ? {
          mean: r3(durs.reduce((s, d) => s + d, 0) / durs.length),
          min: durs[0],
          max: durs[durs.length - 1],
          p50: durs[Math.floor((durs.length - 1) * 0.5)],
          p95: durs[Math.floor((durs.length - 1) * 0.95)],
        }
      : undefined;
    return { count: items.length, failures: 0, scorers, timing };
  };

  const makeResult = (items: EvalItem[], extraMeta: Record<string, unknown> = {}): EvalResult => ({
    id: randomUUID(),
    dataset: 'conditional-demo-dataset',
    metadata: {
      workflows: ['conditional-demo-workflow'],
      models: ['openai-responses:gpt-5.5'],
      modelCounts: { 'openai-responses:gpt-5.5': items.length },
      scorerTypes,
      ...extraMeta,
    },
    timestamp: new Date().toISOString(),
    totalCost: r3(items.reduce((s, it) => s + (it.cost ?? 0) + (it.scorerCost ?? 0), 0)),
    duration: items.reduce((s, it) => s + (it.duration ?? 0), 0),
    items,
    summary: summarize(items),
  });

  const itemsFor = (constrainedIdx: number[], qualityBias = 0): EvalItem[] => {
    const set = new Set(constrainedIdx);
    return QUESTIONS.map((_q, i) => makeItem(i, set.has(i), qualityBias));
  };

  // 1) Multi-run group (3 runs): constraint applies to items 0-2 → scored 3,
  //    N/A 5; refusal-quality fully N/A. Drives the run-detail N/A chips AND
  //    the multi-run aggregate table (N/A chips + "No valid scores").
  const groupId = randomUUID();
  for (let i = 0; i < 3; i++) {
    const result = makeResult(itemsFor([0, 1, 2], (i - 1) * 0.02), {
      runGroupId: groupId,
      runIndex: i,
    });
    await runtime.saveEvalResult({
      id: result.id,
      eval: 'conditional-demo',
      timestamp: Date.now() - 30 * 60 * 1000 + i * 1000,
      data: result,
    });
  }

  // 2) Compare pair — same eval/dataset/scorers, but the conditional scorer
  //    applies to DIFFERENT (and equal-count-but-disjoint) subsets:
  //    baseline constrains {0,1,2}, candidate constrains {2,3,4}. Overlap is
  //    only item 2 → paired n=1 for constraint while each side scored 3, and
  //    both skip 5 (equal counts, disjoint) → PairedSampleNote + the CLI's
  //    equal-but-disjoint NOTE. answer-quality is biased down so there's also
  //    a real delta on the always-applicable scorer.
  const baseline = makeResult(itemsFor([0, 1, 2], 0));
  const candidate = makeResult(itemsFor([2, 3, 4], -0.05));
  await runtime.saveEvalResult({
    id: baseline.id,
    eval: 'conditional-demo',
    timestamp: Date.now() - 20 * 60 * 1000,
    data: baseline,
  });
  await runtime.saveEvalResult({
    id: candidate.id,
    eval: 'conditional-demo',
    timestamp: Date.now() - 19 * 60 * 1000,
    data: candidate,
  });
}
