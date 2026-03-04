import { useState, useCallback } from 'react';

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
};

export function JsonEditor({ value, onChange, placeholder, className }: Props) {
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className={className}>
      <textarea
        value={value}
        onChange={handleChange}
        placeholder={placeholder ?? '{}'}
        className="w-full h-32 p-3 text-xs font-mono rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] resize-y focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
        spellCheck={false}
      />
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  );
}
