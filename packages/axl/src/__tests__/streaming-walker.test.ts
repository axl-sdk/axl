/**
 * Adversarial unit tests for `StreamingWalker`.
 *
 * These tests exercise the walker directly — no MockProvider, no agent, no
 * `ctx.ask()`. We feed chunks in, capture the callback emissions, and pin
 * the contract documented in spec §4 (walker design) and §9 (test plan).
 */

import { describe, it, expect } from 'vitest';
import { StreamingWalker } from '../streaming-walker.js';

type Delta = { path: string; delta: string };

interface Capture {
  deltas: Delta[];
  /** Number of structural boundaries observed across `consumeBoundary()`
   *  calls. The walker's `boundaryPending` flag flips only once between
   *  consume calls, so the count here mirrors how a real caller would
   *  drain the flag at the end of every chunk. */
  boundaries: number;
  isDone: boolean;
}

/**
 * Drive the walker with `chunks` (defaulting to one big chunk equal to the
 * full JSON), draining `consumeBoundary()` after each chunk so multi-chunk
 * boundary counts add up correctly.
 */
function captureWalker(chunks: string[]): Capture {
  const deltas: Delta[] = [];
  let boundaries = 0;
  const w = new StreamingWalker({
    onStringDelta: (path, delta) => {
      deltas.push({ path, delta });
    },
  });
  for (const c of chunks) {
    w.processChunk(c);
    if (w.consumeBoundary()) boundaries++;
  }
  return { deltas, boundaries, isDone: w.isDone };
}

/** Concatenate all deltas matching `path`. */
function joinPath(deltas: Delta[], path: string): string {
  return deltas
    .filter((d) => d.path === path)
    .map((d) => d.delta)
    .join('');
}

/** Set of distinct paths seen in `deltas`. */
function pathsSeen(deltas: Delta[]): Set<string> {
  return new Set(deltas.map((d) => d.path));
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Path computation
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — path computation', () => {
  it('flat object key produces /<key>', () => {
    const { deltas } = captureWalker(['{"summary":"hello"}']);
    expect(deltas).toEqual([{ path: '/summary', delta: 'hello' }]);
  });

  it('nested objects produce /a/b/c', () => {
    const { deltas } = captureWalker(['{"a":{"b":{"c":"deep"}}}']);
    expect(deltas).toEqual([{ path: '/a/b/c', delta: 'deep' }]);
  });

  it('array of strings produces /tags/0, /tags/1, /tags/2', () => {
    const { deltas } = captureWalker(['{"tags":["one","two","three"]}']);
    expect(deltas).toEqual([
      { path: '/tags/0', delta: 'one' },
      { path: '/tags/1', delta: 'two' },
      { path: '/tags/2', delta: 'three' },
    ]);
  });

  it('array of objects produces /sources/0/title, /sources/1/title', () => {
    const { deltas } = captureWalker(['{"sources":[{"title":"first"},{"title":"second"}]}']);
    expect(deltas).toEqual([
      { path: '/sources/0/title', delta: 'first' },
      { path: '/sources/1/title', delta: 'second' },
    ]);
  });

  it('keys with `~` encode to `~0`', () => {
    const { deltas } = captureWalker(['{"~tilde":"v"}']);
    expect(deltas).toEqual([{ path: '/~0tilde', delta: 'v' }]);
  });

  it('keys with `/` encode to `~1`', () => {
    const { deltas } = captureWalker(['{"a/b":"v"}']);
    expect(deltas).toEqual([{ path: '/a~1b', delta: 'v' }]);
  });

  it('keys with both `~` and `/` encode `~` first, then `/`', () => {
    // Per RFC 6901 §4: ~ MUST be escaped first to `~0`, then `/` to `~1`,
    // so a literal `~1` in the source key isn't decoded back to `/`.
    const { deltas } = captureWalker(['{"a~b/c":"v"}']);
    expect(deltas).toEqual([{ path: '/a~0b~1c', delta: 'v' }]);
  });

  it('key containing already-escaped sequence `~1` round-trips correctly', () => {
    // Source key is `~1`, which must encode to `~01` (NOT `~1`, which
    // would decode back to `/`).
    const { deltas } = captureWalker(['{"~1":"v"}']);
    expect(deltas).toEqual([{ path: '/~01', delta: 'v' }]);
  });

  it('deeply mixed paths: array of objects with array of objects', () => {
    const { deltas } = captureWalker(['{"groups":[{"items":[{"name":"a"},{"name":"b"}]}]}']);
    expect(deltas).toEqual([
      { path: '/groups/0/items/0/name', delta: 'a' },
      { path: '/groups/0/items/1/name', delta: 'b' },
    ]);
  });

  it('RFC 6901 round-trip: encoded path can be decoded back to the original key', () => {
    // Decode helper: `~1` → `/`, then `~0` → `~` (per RFC 6901 §4).
    const decode = (s: string): string => s.replace(/~1/g, '/').replace(/~0/g, '~');

    const cases: Array<[string, string]> = [
      ['plain', 'plain'],
      ['a/b', 'a~1b'],
      ['~tilde', '~0tilde'],
      ['a~b/c', 'a~0b~1c'],
      ['~1', '~01'],
      ['~0', '~00'],
      ['/leading', '~1leading'],
    ];
    for (const [original, expectedSegment] of cases) {
      const json = `{${JSON.stringify(original)}:"x"}`;
      const { deltas } = captureWalker([json]);
      expect(deltas, `key=${original}`).toHaveLength(1);
      const path = deltas[0].path;
      expect(path).toBe('/' + expectedSegment);
      // Strip leading `/`, decode, compare.
      expect(decode(path.slice(1))).toBe(original);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Escape handling
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — escape handling', () => {
  it('translates all standard JSON escapes', () => {
    const json = JSON.stringify({
      v: '"\\\b\f\n\r\t/',
    });
    const { deltas } = captureWalker([json]);
    expect(joinPath(deltas, '/v')).toBe('"\\\b\f\n\r\t/');
  });

  it('translates each escape in isolation', () => {
    const cases: Array<[string, string]> = [
      ['\\"', '"'],
      ['\\\\', '\\'],
      ['\\/', '/'],
      ['\\b', '\b'],
      ['\\f', '\f'],
      ['\\n', '\n'],
      ['\\r', '\r'],
      ['\\t', '\t'],
    ];
    for (const [src, expected] of cases) {
      const { deltas } = captureWalker([`{"v":"${src}"}`]);
      expect(joinPath(deltas, '/v'), `src=${src}`).toBe(expected);
    }
  });

  it('translates `\\uXXXX` to a single code unit', () => {
    // U+0041 = 'A'
    const { deltas } = captureWalker(['{"v":"\\u0041"}']);
    expect(joinPath(deltas, '/v')).toBe('A');
  });

  it('split escape: `\\` in chunk N, escape body in chunk N+1', () => {
    const { deltas } = captureWalker(['{"v":"a\\', 'n"}']);
    expect(joinPath(deltas, '/v')).toBe('a\n');
  });

  it('split escape: `\\u` in chunk N, hex digits in chunk N+1', () => {
    const { deltas } = captureWalker(['{"v":"\\u', '0041"}']);
    expect(joinPath(deltas, '/v')).toBe('A');
  });

  it('split unicode escape across many chunks (1+3 digits)', () => {
    const { deltas } = captureWalker(['{"v":"\\u0', '041"}']);
    expect(joinPath(deltas, '/v')).toBe('A');
  });

  it('split unicode escape across many chunks (2+2 digits)', () => {
    const { deltas } = captureWalker(['{"v":"\\u00', '41"}']);
    expect(joinPath(deltas, '/v')).toBe('A');
  });

  it('split unicode escape across many chunks (3+1 digits)', () => {
    const { deltas } = captureWalker(['{"v":"\\u004', '1"}']);
    expect(joinPath(deltas, '/v')).toBe('A');
  });

  it('split unicode escape: `\\` in chunk N, `u` + digits in chunk N+1', () => {
    const { deltas } = captureWalker(['{"v":"\\', 'u0041"}']);
    expect(joinPath(deltas, '/v')).toBe('A');
  });

  it('split unicode escape one digit per chunk', () => {
    const { deltas } = captureWalker(['{"v":"\\u0', '0', '4', '1"}']);
    expect(joinPath(deltas, '/v')).toBe('A');
  });

  it('escape inside a key (not a value) is translated correctly', () => {
    // Key `a"b` should encode to `/a"b` after RFC 6901 (only `~` and `/` get
    // pointer-escaped; `"` is fine in a path segment).
    const { deltas } = captureWalker(['{"a\\"b":"v"}']);
    expect(deltas).toEqual([{ path: '/a"b', delta: 'v' }]);
  });

  it('unicode escape in a key', () => {
    // `A` in a key → 'A'
    const { deltas } = captureWalker(['{"k\\u0041y":"v"}']);
    expect(deltas).toEqual([{ path: '/kAy', delta: 'v' }]);
  });

  it('empty string value emits no delta', () => {
    // Spec: deltas are "non-empty unescaped". The walker guards `deltaBuf.length > 0`.
    const deltas: Delta[] = [];
    const w = new StreamingWalker({
      onStringDelta: (path, delta) => deltas.push({ path, delta }),
    });
    w.processChunk('{"v":""}');
    expect(deltas).toEqual([]);
  });

  it('never emits a zero-length delta even with all-escape content split per chunk', () => {
    // Drive the walker char-by-char through `{"v":"\\n"}`. The escape body
    // `n` is the only char that produces an emit; intermediate chunks where
    // we're mid-escape must NOT produce a `delta: ''` emission.
    const deltas: Delta[] = [];
    const w = new StreamingWalker({
      onStringDelta: (_path, delta) => deltas.push({ path: '', delta }),
    });
    for (const ch of '{"v":"\\n"}') w.processChunk(ch);
    for (const d of deltas) expect(d.delta.length).toBeGreaterThan(0);
    expect(deltas.map((d) => d.delta).join('')).toBe('\n');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Surrogate pairs
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — surrogate pairs', () => {
  it('emoji `\\uD83D\\uDE00` produces two String.fromCharCode chars', () => {
    const { deltas } = captureWalker(['{"v":"\\uD83D\\uDE00"}']);
    const text = joinPath(deltas, '/v');
    // Two UTF-16 code units → length 2 (NOT 1, NOT 4).
    expect(text.length).toBe(2);
    expect(text.charCodeAt(0)).toBe(0xd83d);
    expect(text.charCodeAt(1)).toBe(0xde00);
    // Round-trip via JSON.parse to confirm we match its behavior.
    expect(text).toBe(JSON.parse('"\\uD83D\\uDE00"'));
    // Verify the assembled string represents 😀.
    expect(text).toBe('😀');
  });

  it('split surrogate pair across chunks (high in chunk 1, low in chunk 2)', () => {
    const { deltas } = captureWalker(['{"v":"\\uD83D', '\\uDE00"}']);
    const text = joinPath(deltas, '/v');
    expect(text).toBe('😀');
  });

  it('high surrogate is emitted before low surrogate arrives (no waiting)', () => {
    // Spec §4: "We do not 'wait for the second half' — the high surrogate
    // is emitted as soon as it parses." Verify by feeding only the high
    // half across a chunk boundary and checking that delta(s) appear.
    const deltas: Delta[] = [];
    const w = new StreamingWalker({
      onStringDelta: (path, delta) => deltas.push({ path, delta }),
    });
    // Chunk 1: open string + high surrogate.
    w.processChunk('{"v":"\\uD83D');
    // After chunk 1's end-of-chunk flush, the high surrogate has been
    // appended to deltaBuf, then flushed.
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const text1 = deltas.map((d) => d.delta).join('');
    expect(text1.length).toBe(1);
    expect(text1.charCodeAt(0)).toBe(0xd83d);
    // Chunk 2: low surrogate + close.
    w.processChunk('\\uDE00"}');
    const fullText = deltas.map((d) => d.delta).join('');
    expect(fullText).toBe('😀');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Prefix prose
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — prefix prose', () => {
  it('ignores prose before the opening `{`', () => {
    const { deltas } = captureWalker(['Here is the answer: {"x":"y"}']);
    expect(deltas).toEqual([{ path: '/x', delta: 'y' }]);
  });

  it('quote in prose does NOT flip walker state (the latent bug fix)', () => {
    // A `"` in prose was the bug in the old walker — it'd flip `inString`
    // and then a later `,` would look "outside a string" but actually be
    // inside the model's prose. Verify the new walker is immune.
    const { deltas } = captureWalker(['The model said "hello, world" and then: {"x":"y"}']);
    expect(deltas).toEqual([{ path: '/x', delta: 'y' }]);
  });

  it('prose with structural-looking chars (`,`, `}`) is ignored', () => {
    const { deltas, boundaries } = captureWalker(['a, b, c, d } weird: {"x":"y"}']);
    expect(deltas).toEqual([{ path: '/x', delta: 'y' }]);
    // Only the closing `}` and any inner boundaries count.
    expect(boundaries).toBeGreaterThanOrEqual(1);
  });

  it('prose split across multiple chunks before JSON', () => {
    // NOTE: the walker treats the FIRST `{` it sees as the start of the
    // JSON document. Prose containing a literal `{` would be misread as
    // JSON start (and likely terminate as malformed). This is documented
    // in spec §4 — the walker's prefix-prose handling is heuristic. We
    // exercise the supported path: prose with quotes/punctuation but no
    // braces, split across multiple chunks.
    const { deltas } = captureWalker([
      'Part one ',
      'with "quotes" ',
      'and brackets [like this] ',
      'and then... ',
      '{"k":"v"}',
    ]);
    expect(deltas).toEqual([{ path: '/k', delta: 'v' }]);
  });

  it('a literal `{` in prose is treated as JSON start (documented limitation)', () => {
    // Pin this behavior so a future refactor that "fixes" prose-with-brace
    // detection can intentionally update the test. The current contract:
    // first `{` outside any string → walker enters object mode. If the
    // following chars don't form valid JSON, the walker terminates.
    const { isDone, deltas } = captureWalker([
      'I will reply with {an opinion} and then JSON: {"k":"v"}',
    ]);
    expect(isDone).toBe(true);
    // No deltas — the walker died at `{an...` because `a` is not a valid
    // post-`{` char (not whitespace, `}`, or `"`).
    expect(deltas).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Markdown fences
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — markdown fences', () => {
  it('enters at `{` even after ` ```json\\n` fence', () => {
    const { deltas } = captureWalker(['```json\n{"x":"y"}\n```']);
    expect(deltas).toEqual([{ path: '/x', delta: 'y' }]);
  });

  it('handles fence + prose + JSON + trailing fence', () => {
    const { deltas, isDone } = captureWalker([
      'Sure! Here you go:\n```json\n{"summary":"hi"}\n```',
    ]);
    expect(deltas).toEqual([{ path: '/summary', delta: 'hi' }]);
    expect(isDone).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Trailing prose
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — trailing prose', () => {
  it('enters `done` after root close, ignores trailing prose', () => {
    const { deltas, isDone } = captureWalker(['{"x":"y"}\n\nHope this helps!']);
    expect(deltas).toEqual([{ path: '/x', delta: 'y' }]);
    expect(isDone).toBe(true);
  });

  it('ignores trailing chars in subsequent chunks too', () => {
    const { deltas, isDone } = captureWalker([
      '{"x":"y"}',
      'more prose with "quotes" and {fake braces}',
      'even more.',
    ]);
    expect(deltas).toEqual([{ path: '/x', delta: 'y' }]);
    expect(isDone).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Chunk-boundary fuzzing: split at every offset, verify same final text
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — chunk boundary fuzzing', () => {
  /**
   * For a JSON string, split at every possible offset 1..N-1 and verify the
   * concatenated per-path delta text is identical to the single-chunk case.
   * Number-of-events may differ (a chunk-end mid-string flushes early),
   * but the per-path totals MUST match.
   */
  function fuzzSplits(json: string, expectedByPath: Record<string, string>) {
    // Single-chunk baseline.
    const baseline = captureWalker([json]).deltas;
    const baselineByPath: Record<string, string> = {};
    for (const d of baseline) {
      baselineByPath[d.path] = (baselineByPath[d.path] ?? '') + d.delta;
    }
    expect(baselineByPath).toEqual(expectedByPath);

    // Split at every offset.
    for (let i = 1; i < json.length; i++) {
      const chunks = [json.slice(0, i), json.slice(i)];
      const { deltas } = captureWalker(chunks);
      const byPath: Record<string, string> = {};
      for (const d of deltas) {
        byPath[d.path] = (byPath[d.path] ?? '') + d.delta;
      }
      expect(byPath, `split at offset ${i}: chunks=${JSON.stringify(chunks)}`).toEqual(
        expectedByPath,
      );
    }
  }

  it('`{"x":"hello"}` — split at every offset produces same final deltas', () => {
    fuzzSplits('{"x":"hello"}', { '/x': 'hello' });
  });

  it('two strings — split at every offset preserves both', () => {
    fuzzSplits('{"a":"foo","b":"bar"}', { '/a': 'foo', '/b': 'bar' });
  });

  it('escaped content survives every split', () => {
    fuzzSplits('{"v":"a\\nb\\tc"}', { '/v': 'a\nb\tc' });
  });

  it('unicode escape survives every split', () => {
    fuzzSplits('{"v":"\\u0041\\u0042"}', { '/v': 'AB' });
  });

  it('nested objects survive every split', () => {
    fuzzSplits('{"a":{"b":"c"}}', { '/a/b': 'c' });
  });

  it('arrays survive every split', () => {
    fuzzSplits('{"t":["a","b"]}', { '/t/0': 'a', '/t/1': 'b' });
  });

  it('mixed types survive every split', () => {
    fuzzSplits('{"s":"hi","n":42,"b":true,"x":null}', { '/s': 'hi' });
  });

  it('three-way splits at every pair of offsets', () => {
    const json = '{"x":"hi"}';
    for (let i = 1; i < json.length - 1; i++) {
      for (let j = i + 1; j < json.length; j++) {
        const chunks = [json.slice(0, i), json.slice(i, j), json.slice(j)];
        const { deltas } = captureWalker(chunks);
        const text = joinPath(deltas, '/x');
        expect(text, `splits at ${i},${j}`).toBe('hi');
      }
    }
  });

  it('one char per chunk reproduces the full string with no loss', () => {
    const json = '{"v":"abcdefg"}';
    const chunks = [...json];
    const { deltas } = captureWalker(chunks);
    expect(joinPath(deltas, '/v')).toBe('abcdefg');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Concurrent strings in one chunk
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — concurrent strings in one chunk', () => {
  it('one chunk that closes string A and opens string B emits two deltas', () => {
    // chunk 1 starts the JSON and string A; chunk 2 closes A, comma, opens B and writes some.
    const { deltas } = captureWalker(['{"a":"hel', 'lo","b":"wor', 'ld"}']);
    // Per-chunk events:
    //   chunk1: open + 'hel' → 1 delta {/a, 'hel'} flushed at chunk end
    //   chunk2: 'lo' close → flush {/a, 'lo'}; then 'wor' → flush {/b, 'wor'} at chunk end
    //   chunk3: 'ld' close → flush {/b, 'ld'}
    expect(joinPath(deltas, '/a')).toBe('hello');
    expect(joinPath(deltas, '/b')).toBe('world');
    // And we must have at least one delta for each path mid-chunk2.
    expect(pathsSeen(deltas)).toEqual(new Set(['/a', '/b']));
  });

  it('a single chunk crossing a key/value boundary emits to multiple paths', () => {
    const { deltas } = captureWalker(['{"a":"x","b":"y","c":"z"}']);
    expect(deltas).toEqual([
      { path: '/a', delta: 'x' },
      { path: '/b', delta: 'y' },
      { path: '/c', delta: 'z' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. Boundary detection
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — boundary detection', () => {
  it('comma OUTSIDE a string sets boundary', () => {
    const { boundaries } = captureWalker(['{"a":"x","b":"y"}']);
    // Boundaries: `,` and `}` close → at least 2 raw flips, but we
    // consume only at end-of-chunk so `boundaries` counts to 1 here.
    expect(boundaries).toBeGreaterThanOrEqual(1);
  });

  it('comma INSIDE a string does NOT set boundary on its own', () => {
    // String contains commas; only the closing `}` should set boundary.
    const deltas: Delta[] = [];
    let boundaryHits = 0;
    const w = new StreamingWalker({
      onStringDelta: (path, delta) => deltas.push({ path, delta }),
    });
    // Feed each char individually so we can see when the boundary flips.
    const json = '{"a":"x,y,z"}';
    for (const ch of json) {
      w.processChunk(ch);
      if (w.consumeBoundary()) boundaryHits++;
    }
    // The boundary flips only on the final `}` — NOT on the in-string commas.
    expect(boundaryHits).toBe(1);
    expect(joinPath(deltas, '/a')).toBe('x,y,z');
  });

  it('object close AND array close inside a string do NOT set boundary', () => {
    let boundaryHits = 0;
    const w = new StreamingWalker({
      onStringDelta: () => undefined,
    });
    const json = '{"a":"} ] ,"}';
    for (const ch of json) {
      w.processChunk(ch);
      if (w.consumeBoundary()) boundaryHits++;
    }
    // Only the final `}` is structural.
    expect(boundaryHits).toBe(1);
  });

  it('boundary fires once per consume call regardless of how many flips happened', () => {
    // The flag is just a boolean — multiple structural chars in one
    // chunk all collapse to one boundaryPending=true.
    let boundaryHits = 0;
    const w = new StreamingWalker({});
    w.processChunk('{"a":"x","b":"y","c":"z"}');
    if (w.consumeBoundary()) boundaryHits++;
    expect(boundaryHits).toBe(1);
    // Subsequent consume returns false.
    expect(w.consumeBoundary()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Malformed input
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — malformed input', () => {
  it('invalid escape `\\x` terminates the walker', () => {
    const { isDone, deltas } = captureWalker(['{"v":"a\\xb"}']);
    expect(isDone).toBe(true);
    // 'a' was appended before the bad escape — but the walker drops
    // pending deltas when state goes to 'done' mid-string (no flush).
    // Verify nothing leaked through after the failure point.
    const all = deltas.map((d) => d.delta).join('');
    expect(all).not.toContain('b');
  });

  it('invalid `\\uXXXG` (non-hex digit) terminates the walker', () => {
    const { isDone } = captureWalker(['{"v":"\\u00AG"}']);
    expect(isDone).toBe(true);
  });

  it('subsequent chunks after malformed input are no-ops', () => {
    const w = new StreamingWalker({
      onStringDelta: () => {
        throw new Error('should not be called after malformed termination');
      },
    });
    w.processChunk('{"v":"\\u00AG"}');
    expect(w.isDone).toBe(true);
    // Next chunk must not call any callback.
    w.processChunk('{"a":"b"}');
    expect(w.isDone).toBe(true);
  });

  it('object with non-string key terminates the walker', () => {
    const deltas: Delta[] = [];
    const w = new StreamingWalker({
      onStringDelta: (path, delta) => deltas.push({ path, delta }),
    });
    // `{1:2}` — but we use a leading whitespace + literal 1 which is not `}`
    // and not `"` → walker goes done without emitting.
    w.processChunk('{1:2}');
    expect(w.isDone).toBe(true);
    expect(deltas).toEqual([]);
  });

  it('unclosed string at EOF: no flush issue, walker stays in `read-value-string`', () => {
    // Spec §10: "no error, just no flush; subsequent chunks resume".
    const deltas: Delta[] = [];
    const w = new StreamingWalker({
      onStringDelta: (path, delta) => deltas.push({ path, delta }),
    });
    w.processChunk('{"v":"unclosed');
    // The end-of-chunk flush DOES emit pending delta for in-progress strings.
    expect(joinPath(deltas, '/v')).toBe('unclosed');
    // Walker is still alive — feed more.
    w.processChunk(' more"}');
    expect(joinPath(deltas, '/v')).toBe('unclosed more');
    expect(w.isDone).toBe(true);
  });

  it('escape at EOF (no escape body yet) — escape state survives to next chunk', () => {
    const deltas: Delta[] = [];
    const w = new StreamingWalker({
      onStringDelta: (path, delta) => deltas.push({ path, delta }),
    });
    w.processChunk('{"v":"a\\');
    // No emit yet for the pending escape — but `a` should have flushed.
    expect(joinPath(deltas, '/v')).toBe('a');
    w.processChunk('n"}');
    expect(joinPath(deltas, '/v')).toBe('a\n');
  });

  it('unicodePending state survives across chunks at EOF', () => {
    const deltas: Delta[] = [];
    const w = new StreamingWalker({
      onStringDelta: (path, delta) => deltas.push({ path, delta }),
    });
    w.processChunk('{"v":"\\u00');
    // No emit yet — escape is pending.
    expect(joinPath(deltas, '/v')).toBe('');
    w.processChunk('41"}');
    expect(joinPath(deltas, '/v')).toBe('A');
  });

  it('comma at root (no frame on stack) terminates walker', () => {
    // Implementation-level edge case: the `expect-comma-close` state
    // checks `if (!top) state = done` — there's no easy way to reach this
    // in well-formed input because the only way out of `expect-comma-close`
    // back to root is via `popFrame`, which sets `state = done` first.
    // So we construct an adversarial path: a top-level `42,` would put us
    // in expect-value → read-value-other → expect-comma-close, but we're
    // gated on `{` so this doesn't happen in practice. Instead verify the
    // walker doesn't crash on a bare `,` after JSON is done.
    const w = new StreamingWalker({});
    w.processChunk('{"x":"y"},');
    // After `}` we're done; the trailing `,` is ignored.
    expect(w.isDone).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 11. Empty objects and arrays
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — empty containers', () => {
  it('empty object `{}` produces no deltas, walker reaches done', () => {
    const { deltas, isDone } = captureWalker(['{}']);
    expect(deltas).toEqual([]);
    expect(isDone).toBe(true);
  });

  it('empty object as a value `{"x":{}}`', () => {
    const { deltas, isDone } = captureWalker(['{"x":{}}']);
    expect(deltas).toEqual([]);
    expect(isDone).toBe(true);
  });

  it('empty array as a value `{"x":[]}`', () => {
    const { deltas, isDone } = captureWalker(['{"x":[]}']);
    expect(deltas).toEqual([]);
    expect(isDone).toBe(true);
  });

  it('mixed empty and non-empty', () => {
    const { deltas, isDone } = captureWalker(['{"a":[],"b":{},"c":"v","d":[],"e":{}}']);
    expect(deltas).toEqual([{ path: '/c', delta: 'v' }]);
    expect(isDone).toBe(true);
  });

  it('array of arrays', () => {
    const { deltas } = captureWalker(['{"matrix":[["a","b"],["c","d"]]}']);
    expect(deltas).toEqual([
      { path: '/matrix/0/0', delta: 'a' },
      { path: '/matrix/0/1', delta: 'b' },
      { path: '/matrix/1/0', delta: 'c' },
      { path: '/matrix/1/1', delta: 'd' },
    ]);
  });

  it('array of empty arrays', () => {
    const { deltas, isDone } = captureWalker(['{"x":[[],[],[]]}']);
    expect(deltas).toEqual([]);
    expect(isDone).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 12. Numbers, booleans, nulls
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — numbers, booleans, nulls', () => {
  it('number value emits no delta, root close fires boundary', () => {
    const { deltas, boundaries, isDone } = captureWalker(['{"x":42}']);
    expect(deltas).toEqual([]);
    expect(boundaries).toBe(1);
    expect(isDone).toBe(true);
  });

  it('negative number', () => {
    const { isDone } = captureWalker(['{"x":-42}']);
    expect(isDone).toBe(true);
  });

  it('true / false / null values emit no delta', () => {
    expect(captureWalker(['{"x":true}']).deltas).toEqual([]);
    expect(captureWalker(['{"x":false}']).deltas).toEqual([]);
    expect(captureWalker(['{"x":null}']).deltas).toEqual([]);
  });

  it('mixed scalar types', () => {
    const { deltas, isDone } = captureWalker(['{"a":1,"b":true,"c":null,"d":"text","e":-3.14}']);
    expect(deltas).toEqual([{ path: '/d', delta: 'text' }]);
    expect(isDone).toBe(true);
  });

  it('array of numbers', () => {
    const { deltas, isDone } = captureWalker(['{"x":[1,2,3,4]}']);
    expect(deltas).toEqual([]);
    expect(isDone).toBe(true);
  });

  it('mixed array', () => {
    const { deltas, isDone } = captureWalker(['{"x":[1,"two",true,null,"five"]}']);
    expect(deltas).toEqual([
      { path: '/x/1', delta: 'two' },
      { path: '/x/4', delta: 'five' },
    ]);
    expect(isDone).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 13. Whitespace tolerance
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — whitespace tolerance', () => {
  it('pretty-printed JSON with newlines and indents', () => {
    const json = `{
  "a": "first",
  "b": "second",
  "nested": {
    "c": "third"
  }
}`;
    const { deltas, isDone } = captureWalker([json]);
    expect(deltas).toEqual([
      { path: '/a', delta: 'first' },
      { path: '/b', delta: 'second' },
      { path: '/nested/c', delta: 'third' },
    ]);
    expect(isDone).toBe(true);
  });

  it('whitespace inside arrays, between values', () => {
    const json = '{ "tags" : [ "a" , "b" , "c" ] }';
    const { deltas, isDone } = captureWalker([json]);
    expect(deltas).toEqual([
      { path: '/tags/0', delta: 'a' },
      { path: '/tags/1', delta: 'b' },
      { path: '/tags/2', delta: 'c' },
    ]);
    expect(isDone).toBe(true);
  });

  it('whitespace between number and structural separator', () => {
    const json = '{"x":42 , "y":7}';
    const { isDone } = captureWalker([json]);
    expect(isDone).toBe(true);
  });

  it('all whitespace types: space, tab, newline, carriage return', () => {
    const json = '{\n\t"x": "v",\r\n  "y": "w"\n}';
    const { deltas, isDone } = captureWalker([json]);
    expect(deltas).toEqual([
      { path: '/x', delta: 'v' },
      { path: '/y', delta: 'w' },
    ]);
    expect(isDone).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 14. Depth cap
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — depth cap', () => {
  it('256+ deep nested arrays/objects → walker enters done state', () => {
    // 512 levels of nested objects + a string at the bottom + closing.
    // We expect the walker to bail at MAX_DEPTH (256) and stay silent.
    const opens = '{"x":'.repeat(512);
    const string = '"deep"';
    const closes = '}'.repeat(512);
    const json = opens + string + closes;
    const { isDone } = captureWalker([json]);
    expect(isDone).toBe(true);
  });

  it('depth-cap overflow does not crash', () => {
    // Adversarial: very deep nesting via objects (must enter via `{`
    // since pre-json only triggers on `{`). The 257th push hits the cap
    // and sets state to done.
    const deltas: Delta[] = [];
    const w = new StreamingWalker({
      onStringDelta: (path, delta) => deltas.push({ path, delta }),
    });
    expect(() => {
      // 300 levels of nested objects: `{"a":{"a":{"a":...`
      w.processChunk('{"a":'.repeat(300));
    }).not.toThrow();
    // Walker bailed at MAX_DEPTH=256.
    expect(w.isDone).toBe(true);
    expect(deltas).toEqual([]);
  });

  it('depth-cap overflow via arrays inside an object does not crash', () => {
    const deltas: Delta[] = [];
    const w = new StreamingWalker({
      onStringDelta: (path, delta) => deltas.push({ path, delta }),
    });
    expect(() => {
      // Enter the JSON via `{`, then push 300 array frames. First push
      // is the object frame, then 300 arrays would hit the cap.
      w.processChunk('{"a":' + '['.repeat(300));
    }).not.toThrow();
    expect(w.isDone).toBe(true);
  });

  it('exactly 256 levels nested object — walker may complete or bail; never throw', () => {
    const N = 256;
    let json = '';
    for (let i = 0; i < N; i++) json += '{"a":';
    json += '"v"';
    for (let i = 0; i < N; i++) json += '}';
    expect(() => captureWalker([json])).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 15. isDone state
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — isDone state', () => {
  it('once root closes, further processChunk calls are no-ops', () => {
    let calls = 0;
    const w = new StreamingWalker({
      onStringDelta: () => {
        calls++;
      },
    });
    w.processChunk('{"x":"y"}');
    expect(w.isDone).toBe(true);
    expect(calls).toBe(1);
    // Now feed more JSON — should NOT trigger.
    w.processChunk('{"a":"b"}');
    expect(calls).toBe(1);
    w.processChunk('{"more":"data"}');
    expect(calls).toBe(1);
  });

  it('isDone is false until root close', () => {
    const w = new StreamingWalker({});
    expect(w.isDone).toBe(false);
    w.processChunk('{');
    expect(w.isDone).toBe(false);
    w.processChunk('"x"');
    expect(w.isDone).toBe(false);
    w.processChunk(':"y"');
    expect(w.isDone).toBe(false);
    w.processChunk('}');
    expect(w.isDone).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Bonus: stress test
// ─────────────────────────────────────────────────────────────────────────

describe('StreamingWalker — stress', () => {
  it('handles a large string field via 1024 single-char chunks', () => {
    const longText = 'X'.repeat(1024);
    const json = `{"summary":"${longText}"}`;
    const chunks = [...json];
    const { deltas, isDone } = captureWalker(chunks);
    expect(joinPath(deltas, '/summary')).toBe(longText);
    expect(isDone).toBe(true);
  });

  it('emits at most one delta per chunk per path', () => {
    // Property: per (chunk, path) pair, the walker emits at most one
    // delta event. We feed 5 chunks of `summary` content; the walker
    // should emit 5 deltas with path /summary (or fewer, if some chunks
    // happen to be all-escape-pending).
    const chunks = ['{"v":"', 'aaa', 'bbb', 'ccc', '"}'];
    const { deltas } = captureWalker(chunks);
    expect(joinPath(deltas, '/v')).toBe('aaabbbccc');
    // Each chunk that contains string-value chars produces one delta.
    expect(deltas.length).toBe(3);
  });

  it('handles object with many keys', () => {
    const N = 50;
    const obj: Record<string, string> = {};
    for (let i = 0; i < N; i++) obj[`k${i}`] = `v${i}`;
    const json = JSON.stringify(obj);
    const { deltas, isDone } = captureWalker([json]);
    expect(deltas.length).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(joinPath(deltas, `/k${i}`)).toBe(`v${i}`);
    }
    expect(isDone).toBe(true);
  });
});
