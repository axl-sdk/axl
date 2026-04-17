import { useState, useRef, useEffect, useCallback } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Play, Minus, Plus, Activity } from 'lucide-react';
import { cn } from '../../lib/utils';
import { CommandPicker } from '../../components/shared/CommandPicker';
import type { RegisteredEval } from '../../lib/types';

interface EvalCommandBarProps {
  evals: RegisteredEval[];
  selectedEval: string;
  onSelectEval: (name: string) => void;
  runCount: number;
  onRunCountChange: (value: number) => void;
  captureTraces: boolean;
  onCaptureTracesChange: (value: boolean) => void;
  running: boolean;
  onRun: () => void;
}

const MIN_RUNS = 1;
const MAX_RUNS = 25;
const SHIFT_STEP = 5;

const clampRunCount = (v: number) => Math.max(MIN_RUNS, Math.min(MAX_RUNS, Math.round(v)));

// Rounded command pill for the eval panel header. Composes the generic
// CommandPicker with an eval-specific run-count stepper and hero Run button.
// Reads as one attached action: [picker] | [− N +] | Run.
export function EvalCommandBar({
  evals,
  selectedEval,
  onSelectEval,
  runCount,
  onRunCountChange,
  captureTraces,
  onCaptureTracesChange,
  running,
  onRun,
}: EvalCommandBarProps) {
  return (
    <div
      className={cn(
        'inline-flex items-stretch rounded-full bg-[hsl(var(--background))]',
        'ring-1 ring-[hsl(var(--input))] shadow-sm',
        'hover:ring-[hsl(var(--ring))] focus-within:ring-[hsl(var(--ring))]',
        'transition-shadow',
      )}
    >
      <CommandPicker
        items={evals}
        value={selectedEval}
        onSelect={onSelectEval}
        getKey={(e) => e.name}
        getLabel={(e) => e.name}
        getDescription={(e) => (
          <>
            <span>{e.workflow}</span>
            <span className="opacity-40 mx-1">·</span>
            <span>{e.dataset}</span>
            <span className="opacity-40 mx-1">·</span>
            <span>
              {e.scorers.length} scorer{e.scorers.length !== 1 ? 's' : ''}
            </span>
          </>
        )}
        searchMatch={(e, q) =>
          e.name.toLowerCase().includes(q) ||
          e.workflow.toLowerCase().includes(q) ||
          e.dataset.toLowerCase().includes(q)
        }
        placeholder="Select eval"
        searchPlaceholder="Search evals…"
        emptyLabel="No evals registered"
        shortcut
        triggerClassName="rounded-l-full"
        ariaLabel="Select an eval"
      />

      <RunCountStepper value={runCount} onChange={onRunCountChange} disabled={running} />

      <button
        type="button"
        role="switch"
        aria-checked={captureTraces}
        aria-label="Capture per-item trace events"
        onClick={() => onCaptureTracesChange(!captureTraces)}
        disabled={running}
        title={
          captureTraces
            ? 'Capturing per-item traces (click to disable) — traces appear inline on each item'
            : 'Capture per-item traces — extra memory, but lets you inspect every event per item'
        }
        className={cn(
          'flex items-center px-2 border-l border-[hsl(var(--input))] transition-colors cursor-pointer',
          'focus:outline-none focus-visible:bg-[hsl(var(--muted))]',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          captureTraces
            ? 'text-[hsl(var(--foreground))] bg-[hsl(var(--muted))]'
            : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]',
        )}
      >
        <Activity size={12} strokeWidth={2.5} />
      </button>

      <button
        type="button"
        onClick={onRun}
        disabled={!selectedEval || running}
        className={cn(
          'inline-flex items-center gap-1.5 pl-3.5 pr-4 py-2 text-sm font-medium cursor-pointer',
          'bg-[hsl(var(--foreground))] text-[hsl(var(--background))] rounded-r-full',
          'hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[hsl(var(--foreground))]',
          'disabled:opacity-40 disabled:cursor-not-allowed transition-opacity',
        )}
      >
        <Play size={12} className={cn('fill-current', running && 'animate-spin fill-none')} />
        {running ? 'Running\u2026' : 'Run'}
      </button>
    </div>
  );
}

// Inline stepper for the run count. Three affordances on one control:
//   − / +  step by 1 (shift+click steps by SHIFT_STEP for fast jumps)
//   click (or Enter/Space) the number to enter type-to-edit mode; ArrowUp/
//     Down on the number button steps without entering edit mode.
//   In edit mode: Enter commits, Esc reverts, blur commits, digit input only.
// Bounds are telegraphed by disabling − at MIN_RUNS and + at MAX_RUNS so the
// range teaches itself without a separate tooltip. All paths funnel through
// clampRunCount so typed or shift-jumped values can't escape [MIN, MAX].
// Semantics: wrapper is role="spinbutton" so screen readers announce the
// current value, min, max, and step changes natively.
function RunCountStepper({
  value,
  onChange,
  disabled = false,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Guard against double-commit: Enter keydown calls commit(), which sets
  // editing=false → input unmounts → onBlur fires → commit() runs again with
  // the same draft, firing a duplicate onChange. This ref trips on the first
  // commit of an edit session and resets when startEdit opens a new one.
  const committedRef = useRef(false);

  const step = useCallback(
    (direction: 1 | -1, bigJump: boolean) => {
      const delta = (bigJump ? SHIFT_STEP : 1) * direction;
      onChange(clampRunCount(value + delta));
    },
    [value, onChange],
  );

  const startEdit = useCallback(() => {
    if (disabled) return;
    committedRef.current = false;
    setDraft(String(value));
    setEditing(true);
  }, [value, disabled]);

  // If the parent swaps `value` while we're not editing, sync the draft so a
  // future edit session starts from the latest value. While editing, we keep
  // the user's in-progress draft intact.
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing]);

  const commit = useCallback(() => {
    if (committedRef.current) {
      setEditing(false);
      return;
    }
    committedRef.current = true;
    const parsed = parseInt(draft, 10);
    if (!Number.isNaN(parsed)) {
      onChange(clampRunCount(parsed));
    }
    setEditing(false);
  }, [draft, onChange]);

  const cancel = useCallback(() => {
    committedRef.current = true;
    setEditing(false);
  }, []);

  const handleInputKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const current = parseInt(draft, 10);
        if (!Number.isNaN(current)) setDraft(String(clampRunCount(current + 1)));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const current = parseInt(draft, 10);
        if (!Number.isNaN(current)) setDraft(String(clampRunCount(current - 1)));
      }
    },
    [commit, cancel, draft],
  );

  // Keyboard handler for the non-editing number button. Enter/Space enters
  // edit mode (matches click); ArrowUp/Down steps without needing to open
  // the input, matching native <input type="number"> expectations.
  const handleNumberKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        startEdit();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        step(1, e.shiftKey);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        step(-1, e.shiftKey);
      }
    },
    [disabled, startEdit, step],
  );

  const atMin = value <= MIN_RUNS;
  const atMax = value >= MAX_RUNS;

  return (
    <div
      className="flex items-stretch border-l border-[hsl(var(--input))]"
      role="group"
      aria-label="Run count"
    >
      <button
        type="button"
        onClick={(e) => step(-1, e.shiftKey)}
        disabled={disabled || atMin}
        title="Decrease runs — Shift+click: −5"
        aria-label="Decrease run count"
        className={cn(
          'flex items-center px-1.5 transition-colors cursor-pointer',
          'text-[hsl(var(--muted-foreground))]',
          'hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]',
          'focus:outline-none focus-visible:bg-[hsl(var(--muted))]',
          'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[hsl(var(--muted-foreground))]',
        )}
      >
        <Minus size={12} strokeWidth={2.5} />
      </button>

      {editing ? (
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
          onKeyDown={handleInputKeyDown}
          onBlur={commit}
          aria-label="Run count"
          className={cn(
            'w-10 text-center text-xs font-semibold tabular-nums bg-transparent',
            'focus:outline-none text-[hsl(var(--foreground))]',
          )}
        />
      ) : (
        <button
          type="button"
          role="spinbutton"
          aria-valuenow={value}
          aria-valuemin={MIN_RUNS}
          aria-valuemax={MAX_RUNS}
          aria-valuetext={`${value} run${value !== 1 ? 's' : ''}`}
          onClick={startEdit}
          onKeyDown={handleNumberKeyDown}
          disabled={disabled}
          title="Click or press Enter to type a value — Arrow keys step"
          aria-label={`Run count: ${value}. Press Enter to edit, arrow keys to step.`}
          className={cn(
            'flex items-center justify-center min-w-[2.5rem] px-1 text-xs tabular-nums cursor-text',
            'transition-colors hover:bg-[hsl(var(--muted))]',
            'focus:outline-none focus-visible:bg-[hsl(var(--muted))]',
            'disabled:opacity-60 disabled:cursor-not-allowed',
            value > 1
              ? 'text-[hsl(var(--foreground))] font-semibold'
              : 'text-[hsl(var(--muted-foreground))]',
          )}
        >
          <span className="opacity-50 mr-0.5">×</span>
          {value}
        </button>
      )}

      <button
        type="button"
        onClick={(e) => step(1, e.shiftKey)}
        disabled={disabled || atMax}
        title="Increase runs — Shift+click: +5"
        aria-label="Increase run count"
        className={cn(
          'flex items-center px-1.5 transition-colors cursor-pointer',
          'text-[hsl(var(--muted-foreground))]',
          'hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]',
          'focus:outline-none focus-visible:bg-[hsl(var(--muted))]',
          'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[hsl(var(--muted-foreground))]',
        )}
      >
        <Plus size={12} strokeWidth={2.5} />
      </button>
    </div>
  );
}
