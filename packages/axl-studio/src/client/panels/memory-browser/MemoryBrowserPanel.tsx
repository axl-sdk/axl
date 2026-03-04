import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Brain, Plus, Trash2, Search } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { JsonEditor } from '../../components/shared/JsonEditor';
import { fetchMemory, saveMemoryEntry, deleteMemoryEntry, searchMemory } from '../../lib/api';
import type { MemoryEntry } from '../../lib/types';

export function MemoryBrowserPanel() {
  const [scope, setScope] = useState('session');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('{}');
  const [showAddForm, setShowAddForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<unknown[] | null>(null);
  const queryClient = useQueryClient();

  const { data: entries = [] } = useQuery({
    queryKey: ['memory', scope],
    queryFn: () => fetchMemory(scope),
  });

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      saveMemoryEntry(scope, key, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memory', scope] });
      setShowAddForm(false);
      setNewKey('');
      setNewValue('{}');
      // Reset form state
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => deleteMemoryEntry(scope, key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memory', scope] });
    },
  });

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    const res = await searchMemory(searchQuery, scope);
    setSearchResults(res.results);
  }, [searchQuery, scope]);

  const handleSaveNew = useCallback(() => {
    if (!newKey.trim()) return;
    try {
      const parsed = JSON.parse(newValue);
      saveMutation.mutate({ key: newKey, value: parsed });
    } catch {
      saveMutation.mutate({ key: newKey, value: newValue });
    }
  }, [newKey, newValue, saveMutation]);

  return (
    <PanelShell
      title="Memory Browser"
      description="View and manage agent memory entries"
      actions={
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90"
        >
          <Plus size={14} />
          Add Entry
        </button>
      }
    >
      {/* Scope tabs */}
      <div className="flex items-center gap-2 mb-4">
        {['session', 'global'].map((s) => (
          <button
            key={s}
            onClick={() => {
              setScope(s);
              setSearchResults(null);
            }}
            className={`px-3 py-1.5 text-sm rounded-md ${
              scope === s
                ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                : 'border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))]'
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}

        {/* Semantic search */}
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Semantic search..."
            className="px-2 py-1.5 text-sm rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] w-48"
          />
          <button onClick={handleSearch} className="p-1.5 rounded-md hover:bg-[hsl(var(--accent))]">
            <Search size={14} />
          </button>
        </div>
      </div>

      {/* Add form */}
      {showAddForm && (
        <div className="mb-4 p-4 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] space-y-3">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="Key"
            className="w-full px-2 py-1.5 text-sm rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
          />
          <JsonEditor value={newValue} onChange={setNewValue} placeholder="Value (JSON)" />
          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveNew}
              disabled={!newKey.trim()}
              className="px-3 py-1.5 text-sm rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => setShowAddForm(false)}
              className="px-3 py-1.5 text-sm rounded-md border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Search results */}
      {searchResults && (
        <div className="mb-4 p-4 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <h3 className="text-sm font-medium mb-2">Search Results</h3>
          {searchResults.length === 0 ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No results found</p>
          ) : (
            <JsonViewer data={searchResults} />
          )}
        </div>
      )}

      {/* Memory entries */}
      {entries.length === 0 ? (
        <EmptyState
          icon={<Brain size={32} />}
          title="No memory entries"
          description={`No entries in the ${scope} scope. Use ctx.remember() in workflows or add entries manually.`}
        />
      ) : (
        <div className="space-y-2">
          {entries.map((entry: MemoryEntry) => (
            <div
              key={entry.key}
              className="p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-mono font-medium">{entry.key}</span>
                <button
                  onClick={() => deleteMutation.mutate(entry.key)}
                  className="p-1 rounded hover:bg-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive-foreground))] text-[hsl(var(--muted-foreground))]"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <JsonViewer data={entry.value} collapsed />
            </div>
          ))}
        </div>
      )}
    </PanelShell>
  );
}
