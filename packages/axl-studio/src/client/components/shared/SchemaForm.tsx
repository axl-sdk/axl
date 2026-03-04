import { useState, useCallback } from 'react';

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  items?: JsonSchema;
  description?: string;
  const?: unknown;
};

type Props = {
  schema: JsonSchema;
  onSubmit: (values: Record<string, unknown>) => void;
  submitLabel?: string;
  className?: string;
};

export function SchemaForm({ schema, onSubmit, submitLabel = 'Submit', className }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});

  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const parsed: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(properties)) {
        const raw = values[key] ?? '';
        if (!raw && !required.has(key)) continue;

        if (prop.type === 'number') {
          parsed[key] = Number(raw);
        } else if (prop.type === 'boolean') {
          parsed[key] = raw === 'true';
        } else if (prop.type === 'object' || prop.type === 'array') {
          try {
            parsed[key] = JSON.parse(raw);
          } catch {
            parsed[key] = raw;
          }
        } else {
          parsed[key] = raw;
        }
      }
      onSubmit(parsed);
    },
    [values, properties, required, onSubmit],
  );

  return (
    <form onSubmit={handleSubmit} className={`space-y-3 ${className ?? ''}`}>
      {Object.entries(properties).map(([key, prop]) => (
        <div key={key}>
          <label className="block text-xs font-medium text-[hsl(var(--foreground))] mb-1">
            {key}
            {required.has(key) && <span className="text-red-500 ml-0.5">*</span>}
            {prop.description && (
              <span className="text-[hsl(var(--muted-foreground))] font-normal ml-1">
                - {prop.description}
              </span>
            )}
          </label>
          {prop.enum ? (
            <select
              value={values[key] ?? ''}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
              className="w-full px-2 py-1.5 text-sm rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
            >
              <option value="">Select...</option>
              {prop.enum.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : prop.type === 'boolean' ? (
            <select
              value={values[key] ?? ''}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
              className="w-full px-2 py-1.5 text-sm rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
            >
              <option value="">Select...</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              type={prop.type === 'number' ? 'number' : 'text'}
              value={values[key] ?? ''}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
              placeholder={prop.type ?? 'string'}
              className="w-full px-2 py-1.5 text-sm rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
            />
          )}
        </div>
      ))}
      <button
        type="submit"
        className="px-4 py-2 text-sm font-medium rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity"
      >
        {submitLabel}
      </button>
    </form>
  );
}
