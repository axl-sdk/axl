import { useState } from 'react';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { formatCost, formatDuration } from '../../lib/utils';
import type { EvalItem } from './types';
import { scoreColorClass } from './types';

type Props = {
  item: EvalItem;
  itemIndex: number;
  scorerNames: string[];
  onBack: () => void;
};

const REASONING_TRUNCATE_LENGTH = 300;

function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.length > REASONING_TRUNCATE_LENGTH;

  return (
    <div>
      <pre className="text-xs font-mono p-3 rounded-md bg-[hsl(var(--secondary))] overflow-auto max-h-96 whitespace-pre-wrap">
        {needsTruncation && !expanded ? text.slice(0, REASONING_TRUNCATE_LENGTH) + '...' : text}
      </pre>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-[hsl(var(--primary))] hover:underline mt-1"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

export function EvalItemDetail({ item, itemIndex, scorerNames, onBack }: Props) {
  const scorerErrors = item.scorerErrors ?? [];

  // Compute total cost line
  const workflowCost = item.cost ?? 0;
  const scorerCost = item.scorerCost ?? 0;
  const totalItemCost = workflowCost + scorerCost;

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="px-3 py-1.5 text-xs rounded-md border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))]"
      >
        Back to list
      </button>

      <h3 className="text-sm font-medium">Item #{itemIndex + 1}</h3>

      {/* Input */}
      <div className="text-xs">
        <span className="font-medium">Input:</span>
        <JsonViewer data={item.input} collapsed />
      </div>

      {/* Output */}
      <div className="text-xs">
        <span className="font-medium">Output:</span>
        <JsonViewer data={item.output} collapsed />
      </div>

      {/* Error */}
      {item.error && (
        <div className="text-xs">
          <span className="font-medium text-red-600 dark:text-red-400">Error:</span>
          <span className="ml-1">{item.error}</span>
        </div>
      )}

      {/* Duration & cost summary */}
      {(item.duration != null || totalItemCost > 0) && (
        <div className="flex items-center gap-3 text-xs text-[hsl(var(--muted-foreground))]">
          {item.duration != null && (
            <span>
              Duration: <span className="font-mono">{formatDuration(item.duration)}</span>
            </span>
          )}
          {totalItemCost > 0 && workflowCost > 0 && scorerCost > 0 && (
            <span>
              Cost: <span className="font-mono">{formatCost(workflowCost)}</span> workflow
              {' + '}
              <span className="font-mono">{formatCost(scorerCost)}</span> scoring
              {' = '}
              <span className="font-mono">{formatCost(totalItemCost)}</span>
            </span>
          )}
          {totalItemCost > 0 && !(workflowCost > 0 && scorerCost > 0) && (
            <span>
              Cost: <span className="font-mono">{formatCost(totalItemCost)}</span>
            </span>
          )}
        </div>
      )}

      {/* Per-scorer sections */}
      {scorerNames.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
            Scorer Details
          </h4>
          {scorerNames.map((name) => {
            const score = item.scores[name];
            const detail = item.scoreDetails?.[name];
            const scorerError = scorerErrors.find((err) => err.includes(name));

            return (
              <div
                key={name}
                className="border border-[hsl(var(--border))] rounded-md p-3 space-y-2"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-medium">{name}</span>
                  {score != null && (
                    <span className={`px-1.5 py-0.5 rounded font-mono ${scoreColorClass(score)}`}>
                      {score.toFixed(3)}
                    </span>
                  )}
                  {score == null && !scorerError && (
                    <span className="px-1.5 py-0.5 rounded font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]">
                      null
                    </span>
                  )}
                  {detail?.duration != null && (
                    <span className="px-1.5 py-0.5 rounded font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]">
                      {formatDuration(detail.duration)}
                    </span>
                  )}
                  {detail?.cost != null && detail.cost > 0 && (
                    <span className="px-1.5 py-0.5 rounded font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]">
                      {formatCost(detail.cost)}
                    </span>
                  )}
                </div>

                {/* Scorer reasoning */}
                {detail?.metadata &&
                  typeof detail.metadata.reasoning === 'string' &&
                  detail.metadata.reasoning.length > 0 && (
                    <div className="text-xs">
                      <span className="font-medium text-[hsl(var(--muted-foreground))]">
                        Reasoning:
                      </span>
                      <ReasoningBlock text={detail.metadata.reasoning} />
                    </div>
                  )}

                {/* Other metadata (excluding reasoning if shown above) */}
                {detail?.metadata &&
                  (() => {
                    const otherKeys = Object.keys(detail.metadata!).filter(
                      (k) => k !== 'reasoning',
                    );
                    if (otherKeys.length === 0) return null;
                    const otherMeta: Record<string, unknown> = {};
                    for (const k of otherKeys) {
                      otherMeta[k] = detail.metadata![k];
                    }
                    return (
                      <div className="text-xs">
                        <span className="font-medium text-[hsl(var(--muted-foreground))]">
                          Metadata:
                        </span>
                        <JsonViewer data={otherMeta} collapsed />
                      </div>
                    );
                  })()}

                {/* Scorer error */}
                {scorerError && (
                  <div className="text-xs text-amber-600 dark:text-amber-400">{scorerError}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
