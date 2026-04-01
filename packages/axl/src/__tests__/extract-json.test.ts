import { describe, it, expect } from 'vitest';
import { extractJson } from '../context.js';

describe('extractJson()', () => {
  it('returns raw JSON object as-is', () => {
    const json = '{"score": 0.5, "reasoning": "OK"}';
    expect(extractJson(json)).toBe(json);
  });

  it('returns raw JSON array as-is', () => {
    const json = '[1, 2, 3]';
    expect(extractJson(json)).toBe(json);
  });

  it('strips trailing text after JSON object', () => {
    const result = extractJson('{"score": 0.7}\n\nI hope this helps!');
    expect(JSON.parse(result)).toEqual({ score: 0.7 });
  });

  it('strips trailing text after JSON array', () => {
    const result = extractJson('[1, 2, 3]\nDone!');
    expect(JSON.parse(result)).toEqual([1, 2, 3]);
  });

  it('extracts JSON from markdown fenced code block', () => {
    const result = extractJson('```json\n{"score": 0.5}\n```');
    expect(JSON.parse(result)).toEqual({ score: 0.5 });
  });

  it('extracts JSON from fence without language tag', () => {
    const result = extractJson('```\n{"score": 0.5}\n```');
    expect(JSON.parse(result)).toEqual({ score: 0.5 });
  });

  it('extracts JSON from prose with leading text', () => {
    const result = extractJson('Here is the result: {"score": 0.8}');
    expect(JSON.parse(result)).toEqual({ score: 0.8 });
  });

  it('extracts JSON from prose with both leading and trailing text', () => {
    const result = extractJson('Result: {"score": 0.8, "note": "good"}\nEnd.');
    expect(JSON.parse(result)).toEqual({ score: 0.8, note: 'good' });
  });

  it('handles escaped quotes inside JSON strings', () => {
    const result = extractJson('{"key": "value with \\"quotes\\""}');
    expect(JSON.parse(result)).toEqual({ key: 'value with "quotes"' });
  });

  it('handles braces inside JSON string values', () => {
    const result = extractJson('Note: {"reasoning": "uses {template} syntax", "score": 0.5}');
    expect(JSON.parse(result)).toEqual({ reasoning: 'uses {template} syntax', score: 0.5 });
  });

  it('handles nested objects', () => {
    const json = '{"outer": {"inner": 1}, "score": 0.5}';
    const result = extractJson('prefix ' + json + ' suffix');
    expect(JSON.parse(result)).toEqual({ outer: { inner: 1 }, score: 0.5 });
  });

  it('returns empty string as-is for empty input', () => {
    expect(extractJson('')).toBe('');
  });

  it('returns whitespace-only input trimmed', () => {
    expect(extractJson('   \n  ')).toBe('');
  });

  it('returns plain text as-is when no JSON found', () => {
    expect(extractJson('no json here')).toBe('no json here');
  });

  it('handles truncated JSON (unbalanced braces)', () => {
    // Model hit max tokens — JSON is incomplete
    const truncated = '{"score": 0.5, "reasoning": "this is a lo';
    const result = extractJson(truncated);
    // extractBalanced returns null for unbalanced, falls back to returning as-is
    expect(result).toBe(truncated);
    // JSON.parse should throw on this
    expect(() => JSON.parse(result)).toThrow();
  });

  it('handles multiple JSON objects — picks the first', () => {
    const result = extractJson('first: {"a": 1} second: {"b": 2}');
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  it('handles JSON with whitespace padding', () => {
    const result = extractJson('  \n  {"score": 0.5}  \n  ');
    expect(JSON.parse(result)).toEqual({ score: 0.5 });
  });
});
