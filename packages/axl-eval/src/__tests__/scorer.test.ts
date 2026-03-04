import { describe, it, expect } from 'vitest';
import { scorer } from '../scorer.js';

describe('scorer()', () => {
  it('creates a scorer with name and description', () => {
    const s = scorer({
      name: 'accuracy',
      description: 'Measures accuracy',
      score: () => 1,
    });

    expect(s.name).toBe('accuracy');
    expect(s.description).toBe('Measures accuracy');
  });

  it('has isLlm set to false', () => {
    const s = scorer({
      name: 'test',
      description: 'Test scorer',
      score: () => 0,
    });

    expect(s.isLlm).toBe(false);
  });

  it('score function receives output, input, and annotations', () => {
    const receivedArgs: any[] = [];
    const s = scorer({
      name: 'spy',
      description: 'Spy scorer',
      score: (output, input, annotations) => {
        receivedArgs.push({ output, input, annotations });
        return 0.5;
      },
    });

    const result = s.score('my-output', { question: 'test' }, { answer: '42' });
    expect(result).toBe(0.5);
    expect(receivedArgs).toHaveLength(1);
    expect(receivedArgs[0].output).toBe('my-output');
    expect(receivedArgs[0].input).toEqual({ question: 'test' });
    expect(receivedArgs[0].annotations).toEqual({ answer: '42' });
  });

  it('returns numeric score', () => {
    const s = scorer({
      name: 'fixed',
      description: 'Always returns 0.75',
      score: () => 0.75,
    });

    expect(s.score('any', 'any')).toBe(0.75);
  });

  it('can return 0', () => {
    const s = scorer({
      name: 'zero',
      description: 'Returns zero',
      score: () => 0,
    });

    expect(s.score('x', 'y')).toBe(0);
  });

  it('can return 1', () => {
    const s = scorer({
      name: 'perfect',
      description: 'Returns one',
      score: () => 1,
    });

    expect(s.score('x', 'y')).toBe(1);
  });

  it('score function can use annotations parameter', () => {
    const s = scorer<string, { question: string }, { answer: string }>({
      name: 'exact-match',
      description: 'Exact match against annotation',
      score: (output, _input, annotations) => {
        return output === annotations?.answer ? 1 : 0;
      },
    });

    expect(s.score('42', { question: 'What is 6*7?' }, { answer: '42' })).toBe(1);
    expect(s.score('wrong', { question: 'What is 6*7?' }, { answer: '42' })).toBe(0);
  });

  it('annotations parameter is optional', () => {
    const s = scorer({
      name: 'no-ann',
      description: 'Works without annotations',
      score: (output) => (output === 'good' ? 1 : 0),
    });

    expect(s.score('good', 'any')).toBe(1);
    expect(s.score('bad', 'any')).toBe(0);
  });
});
