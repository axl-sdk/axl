import { useState, useCallback, useRef, useEffect } from 'react';
import { Pencil } from 'lucide-react';
import { JsonViewer } from './JsonViewer';

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
};

export function JsonEditor({ value, onChange, placeholder, className }: Props) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      onChange(val);
      try {
        if (val.trim()) JSON.parse(val);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid JSON');
      }
    },
    [onChange],
  );

  // Auto-focus textarea when entering edit mode
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  // Try to parse for the viewer
  let parsed: unknown = null;
  try {
    parsed = value.trim() ? JSON.parse(value) : {};
  } catch {
    // Invalid JSON — force edit mode
  }

  // If JSON is invalid, always show the editor
  if (parsed === null || editing) {
    return (
      <div className={className}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onBlur={() => {
            if (!error) setEditing(false);
          }}
          placeholder={placeholder ?? '{}'}
          className="w-full h-40 p-3 text-xs font-mono rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))] border-none resize-y focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          spellCheck={false}
        />
        {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
      </div>
    );
  }

  // Show syntax-highlighted viewer with edit button
  return (
    <div className={className}>
      <div>
        <JsonViewer data={parsed} maxHeight="12rem" />
        <button
          onClick={() => setEditing(true)}
          className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer"
        >
          <Pencil size={10} />
          Edit
        </button>
      </div>
    </div>
  );
}
