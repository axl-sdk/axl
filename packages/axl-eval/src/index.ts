export { dataset } from './dataset.js';
export type { Dataset, DatasetConfig, DatasetItem } from './dataset.js';

export { scorer } from './scorer.js';
export type { Scorer, ScorerConfig, ScorerFn } from './scorer.js';

export { llmScorer } from './llm-scorer.js';
export type { LlmScorerConfig } from './llm-scorer.js';

export { defineEval } from './define-eval.js';
export { runEval } from './runner.js';
export { evalCompare } from './compare.js';

export type {
  EvalConfig,
  EvalResult,
  EvalItem,
  EvalSummary,
  EvalComparison,
  EvalRegression,
  EvalImprovement,
} from './types.js';
