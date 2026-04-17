/**
 * Tripwire test: both the Workflow Runner and Trace Explorer panels must
 * render trace events through the shared `TraceEventList` component.
 *
 * Background: a prior refactor replaced `TraceEventList` with inline
 * `<details>` / `<div>` rendering in both panels. That silently regressed:
 *   - the Expand-all toolbar
 *   - retry pill + amber tint for retries/gate failures
 *   - attempt counters ("2/3") on guardrail events
 *   - per-type body renderers (AgentCallBody, GateCheckBody, ToolApprovalBody)
 *   - TraceJsonViewer context-aware JSON expansion
 *   - CostBadge on trace rows
 *   - DurationBadge (replaced with raw span)
 *   - `#{event.step ?? index}` guard (displayed `#undefined` otherwise)
 *   - proper React keys under streaming inserts
 *
 * The regression wasn't caught by any automated test because the server
 * API was unaffected. This tripwire is a structural assertion: if the
 * shared component gets removed again, the failure points at the specific
 * feature loss instead of letting users rediscover it by eye.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../client/panels');

const PANELS_THAT_RENDER_TRACES = [
  'workflow-runner/WorkflowRunnerPanel.tsx',
  'trace-explorer/TraceExplorerPanel.tsx',
];

/** Strip // line comments, /* block comments *\/, and string/template literals
 *  from TSX source so the tripwire only matches real code. Not a full parser —
 *  deliberately simple, tuned for the shape of these panel files. */
function stripNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/.*$/gm, '') // line comments
    .replace(/'(?:\\.|[^'\\])*'/g, "''") // single-quoted strings
    .replace(/"(?:\\.|[^"\\])*"/g, '""') // double-quoted strings
    .replace(/`(?:\\.|[^`\\])*`/g, '``'); // template literals (no embedded expressions expected)
}

describe('trace-panel structure tripwire', () => {
  for (const rel of PANELS_THAT_RENDER_TRACES) {
    const abs = resolve(ROOT, rel);
    const raw = readFileSync(abs, 'utf-8');
    const code = stripNonCode(raw);

    it(`${rel} imports TraceEventList`, () => {
      // Match a real ES import statement that pulls in the symbol. The path
      // itself gets stripped by stripNonCode, so we only verify the import
      // keyword + named binding + `from '...'` syntax survived.
      const importRe = /import\s*\{[^}]*\bTraceEventList\b[^}]*\}\s*from\s*''/;
      expect(
        importRe.test(code),
        `${rel} should have a real \`import { TraceEventList } from '...'\` statement. ` +
          `If you intentionally replaced it, update this test and the comment in this ` +
          `file to document the new strategy.`,
      ).toBe(true);
    });

    it(`${rel} renders <TraceEventList /> as JSX (not in a comment/string)`, () => {
      // Require a real JSX open tag. The character after `TraceEventList`
      // must be JSX-valid ("/", ">", whitespace), not identifier-continuing.
      // `String.includes('<TraceEventList')` was the prior check — it would
      // also match a block comment like `// TODO: restore <TraceEventList />`.
      const jsxRe = /<TraceEventList(?:\s|\/|>)/;
      expect(
        jsxRe.test(code),
        `${rel} must render <TraceEventList /> so the Expand-all toolbar, ` +
          `retry pills, attempt counters, and per-type bodies stay consistent ` +
          `across panels. Inline rendering has historically dropped these features.`,
      ).toBe(true);
    });
  }

  it('stripNonCode correctly ignores comments and strings (self-test)', () => {
    const fixture =
      "import x from 'TraceEventList';\n" +
      '// <TraceEventList />\n' +
      '/* also fake: <TraceEventList /> */\n' +
      'const s = "<TraceEventList />";\n' +
      '<TraceEventList  />';
    const code = stripNonCode(fixture);
    // Comment and string mentions are gone; the real JSX usage stays.
    expect(code.match(/<TraceEventList(?:\s|\/|>)/g)?.length).toBe(1);
  });
});
