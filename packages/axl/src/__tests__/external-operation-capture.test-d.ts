import type { CapturedRequestRecord, ExternalOperationReport } from '../index.js';

declare const record: CapturedRequestRecord;
declare const report: ExternalOperationReport;

report.capture({ request: { query: 'q' } });
report.capture({ response: [1, true, null] });

if (record.kind === 'external') {
  const name: string = record.name;
  const provider: undefined = record.provider;
  const model: undefined = record.model;
  void [name, provider, model];
} else {
  const provider: string = record.provider;
  const model: string = record.model;
  void [provider, model];
}
