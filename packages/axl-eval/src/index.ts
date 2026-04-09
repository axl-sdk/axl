export { dataset } from './dataset.js';
export type { Dataset, DatasetConfig, DatasetItem } from './dataset.js';

export { scorer, normalizeScorerResult } from './scorer.js';
export type { Scorer, ScorerConfig, ScorerContext, ScorerFn, ScorerResult } from './scorer.js';

export { llmScorer } from './llm-scorer.js';
export type { LlmScorerConfig } from './llm-scorer.js';

export { defineEval } from './define-eval.js';
export { runEval } from './runner.js';
export { evalCompare } from './compare.js';
export { pairedBootstrapCI } from './bootstrap.js';
export type { BootstrapCIResult } from './bootstrap.js';
export { rescore } from './rescore.js';
export type { RescoreOptions } from './rescore.js';
export { aggregateRuns } from './multi-run.js';
export type { MultiRunSummary } from './multi-run.js';

export type {
  EvalConfig,
  EvalResult,
  EvalItem,
  EvalSummary,
  EvalComparison,
  EvalCompareOptions,
  EvalRegression,
  EvalImprovement,
  ScorerDetail,
} from './types.js';
