/** Public record helpers fit both core and eval execution callbacks and concrete scorers. */
import type { EvalExecuteWorkflow, FoldedOperationRecord } from '@axlsdk/axl';
import {
  defineEval,
  modelCallDataset,
  recordedModelCall,
  replayModelCall,
  runEval,
  scorer,
} from '../index.js';
import type { ModelCallInput } from '../index.js';

const records: FoldedOperationRecord[] = [];
const captured = modelCallDataset(records, {
  filter: (record) => record.kind !== 'external',
  annotate: () => ({ expected: 'answer' }),
});
const concrete = scorer<string, ModelCallInput, { expected: string }>({
  name: 'exact',
  description: 'exact',
  score: (output, input, annotations) =>
    output === annotations?.expected && !!input.recorded.id ? 1 : 0,
});
const config = defineEval({ workflow: 'recorded', dataset: captured, scorers: [concrete] });
const coreRecorded: EvalExecuteWorkflow = recordedModelCall();
const coreReplay: EvalExecuteWorkflow = replayModelCall({ model: 'mock:other' });
const evalRecorded: Parameters<typeof runEval>[1] = recordedModelCall();
const evalReplay: Parameters<typeof runEval>[1] = replayModelCall();
void [config, coreRecorded, coreReplay, evalRecorded, evalReplay];
