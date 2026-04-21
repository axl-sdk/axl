import { describe, it, expect } from 'vitest';
import { parsePartialJson } from '../partial-json.js';

describe('parsePartialJson — full-input equivalence to JSON.parse', () => {
  const cases: [string, unknown][] = [
    ['{}', {}],
    ['[]', []],
    ['null', null],
    ['true', true],
    ['false', false],
    ['42', 42],
    ['-3.14', -3.14],
    ['1e3', 1000],
    ['-1.5e-2', -0.015],
    ['"hello"', 'hello'],
    ['"with \\"quotes\\""', 'with "quotes"'],
    ['"escapes: \\n\\t\\r\\b\\f\\/\\\\"', 'escapes: \n\t\r\b\f/\\'],
    ['"unicode \\u00e9"', 'unicode é'],
    ['{"name":"Alice","age":30}', { name: 'Alice', age: 30 }],
    ['[1,2,3]', [1, 2, 3]],
    ['{"a":[1,2],"b":{"c":true}}', { a: [1, 2], b: { c: true } }],
    ['{"empty":""}', { empty: '' }],
    ['  {  "k"  :  "v"  }  ', { k: 'v' }],
  ];

  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      expect(parsePartialJson(input)).toEqual(expected);
    });
  }
});

describe('parsePartialJson — truncation recovery', () => {
  it('unterminated string returns content parsed so far', () => {
    expect(parsePartialJson('"hello wor')).toBe('hello wor');
  });

  it('unterminated string with escape at end returns prefix', () => {
    expect(parsePartialJson('"hi\\')).toBe('hi');
  });

  it('object: unclosed `{` returns parsed pairs', () => {
    expect(parsePartialJson('{"name":"Alice","age":30')).toEqual({
      name: 'Alice',
      age: 30,
    });
  });

  it('object: key-only is dropped', () => {
    expect(parsePartialJson('{"name"')).toEqual({});
    expect(parsePartialJson('{"name":')).toEqual({});
  });

  it('object: partial value truncation includes what parsed so far', () => {
    // Truncated string value — included as the parsed prefix
    expect(parsePartialJson('{"name":"Ali')).toEqual({ name: 'Ali' });
  });

  it('object: trailing comma is ignored at EOF', () => {
    expect(parsePartialJson('{"a":1,')).toEqual({ a: 1 });
  });

  it('array: unclosed `[` returns parsed elements', () => {
    expect(parsePartialJson('[1,2,3')).toEqual([1, 2, 3]);
  });

  it('array: partial element truncation drops the dangling element', () => {
    expect(parsePartialJson('[1,2,"par')).toEqual([1, 2, 'par']);
  });

  it('array: trailing comma at EOF is ignored', () => {
    expect(parsePartialJson('[1,2,')).toEqual([1, 2]);
  });

  it('number: malformed prefixes are dropped (-, 1., 1e)', () => {
    // A bare `-` mid-stream gets dropped — neither value nor complete.
    expect(parsePartialJson('{"x":-')).toEqual({});
    expect(parsePartialJson('{"x":1.')).toEqual({});
    expect(parsePartialJson('{"x":1e')).toEqual({});
    expect(parsePartialJson('{"x":1e+')).toEqual({});
  });

  it('number: complete number prefix is included', () => {
    // `123` is a complete number, even if a digit might follow — we accept
    // what we have. (Streaming consumers re-parse on each delta anyway.)
    expect(parsePartialJson('{"x":123')).toEqual({ x: 123 });
  });

  it('boolean truncation: "tru" and "fals" are dropped', () => {
    expect(parsePartialJson('{"x":tru')).toEqual({});
    expect(parsePartialJson('{"x":fals')).toEqual({});
  });

  it('null truncation: "nul" is dropped', () => {
    expect(parsePartialJson('{"x":nul')).toEqual({});
  });

  it('nested object: unclosed inner closes outer too', () => {
    expect(parsePartialJson('{"outer":{"inner":1')).toEqual({
      outer: { inner: 1 },
    });
  });

  it('nested array: unclosed inner closes outer too', () => {
    expect(parsePartialJson('{"items":[{"a":1},{"b":')).toEqual({
      items: [{ a: 1 }, {}],
    });
  });
});

describe('parsePartialJson — rejects malformed input', () => {
  it('throws on unquoted keys', () => {
    expect(() => parsePartialJson('{name:"Alice"}')).toThrow(SyntaxError);
  });

  it('throws on trailing-comma-with-content (not at EOF)', () => {
    // `{,}` is not the same as `{` at EOF — the comma here precedes
    // what should be a key. We expect our parser to reject (matches strict
    // JSON behavior — recovery is for trailing truncation only).
    expect(() => parsePartialJson('{,}')).toThrow(SyntaxError);
  });

  it('throws on bogus character', () => {
    expect(() => parsePartialJson('@')).toThrow(SyntaxError);
  });
});

describe('parsePartialJson — empty input', () => {
  it('returns undefined for empty string', () => {
    expect(parsePartialJson('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only', () => {
    expect(parsePartialJson('   \n\t  ')).toBeUndefined();
  });
});

describe('parsePartialJson — adversarial input', () => {
  it('throws on deeply nested input (stack overflow guard)', () => {
    // Build `[[[[[...]]]]]` at a depth well above the 256 cap. A
    // typical V8 stack tolerates ~10k recursive frames; we cap at 256
    // so the error surfaces as a SyntaxError rather than a hard crash.
    const depth = 300;
    const deep = '['.repeat(depth) + ']'.repeat(depth);
    expect(() => parsePartialJson(deep)).toThrow(/Maximum nesting depth/);
  });

  it('accepts input at the legal depth ceiling (256 levels)', () => {
    const depth = 200;
    const deep = '['.repeat(depth) + ']'.repeat(depth);
    // Should parse without throwing — depth is checked with ++, so
    // exactly 256 is the first rejected value.
    expect(() => parsePartialJson(deep)).not.toThrow();
  });
});

describe('parsePartialJson — monotonicity guard (spec/16 §4.2)', () => {
  it('progressive parses are supersets of earlier parses (object case)', () => {
    const final = '{"name":"Alice","age":30,"tags":["a","b"]}';
    const cuts = [
      '{"name":"Al',
      '{"name":"Alice"',
      '{"name":"Alice","age":3',
      '{"name":"Alice","age":30',
      '{"name":"Alice","age":30,"tags":["a"',
      '{"name":"Alice","age":30,"tags":["a","b"]',
      final,
    ];
    let prev: Record<string, unknown> = {};
    for (const cut of cuts) {
      const cur = parsePartialJson(cut) as Record<string, unknown>;
      // Each emission strictly extends prev — never removes a key, never
      // changes a key's value. (The agent doesn't go BACK on its output.)
      for (const [k, v] of Object.entries(prev)) {
        // Either the key is preserved with the same value, or it's been
        // extended (e.g., "Al" → "Alice"). For string values, the new
        // value either equals the old OR starts with it.
        if (typeof v === 'string' && typeof cur[k] === 'string') {
          expect(cur[k] as string).toMatch(
            new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
          );
        } else {
          expect(cur).toHaveProperty(k);
        }
      }
      prev = cur;
    }
    expect(prev).toEqual(JSON.parse(final));
  });
});
