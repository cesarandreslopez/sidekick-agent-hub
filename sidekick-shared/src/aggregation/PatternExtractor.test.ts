import { describe, it, expect, beforeEach } from 'vitest';
import { PatternExtractor } from './PatternExtractor';

describe('PatternExtractor', () => {
  let extractor: PatternExtractor;

  beforeEach(() => {
    extractor = new PatternExtractor();
  });

  it('clusters similar summaries into patterns', () => {
    // Two-token summaries: first token matches, second varies → "Read <*>"
    extractor.add('Read src/foo.ts');
    extractor.add('Read src/bar.ts');
    extractor.add('Read src/baz.ts');

    const patterns = extractor.getPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].template).toBe('Read <*>');
    expect(patterns[0].count).toBe(3);
  });

  it('keeps separate patterns for different token counts', () => {
    // 3-token summaries vs 2-token summaries should be separate groups
    extractor.add('Read file alpha');
    extractor.add('Read file beta');
    extractor.add('Write gamma');
    extractor.add('Write delta');

    const patterns = extractor.getPatterns();
    expect(patterns).toHaveLength(2);
    // Both patterns should have count 2
    const counts = patterns.map(p => p.count).sort();
    expect(counts).toEqual([2, 2]);
  });

  it('does not return patterns with only 1 match', () => {
    extractor.add('Unique event alpha');

    const patterns = extractor.getPatterns();
    expect(patterns).toHaveLength(0);
  });

  it('stores up to 3 examples per pattern', () => {
    for (let i = 0; i < 5; i++) {
      extractor.add(`Read file${i}.txt`);
    }

    const patterns = extractor.getPatterns();
    expect(patterns[0].examples.length).toBeLessThanOrEqual(3);
  });

  it('respects max cluster limit', () => {
    const small = new PatternExtractor({ maxClusters: 3 });
    // Create 4 unique single-token-count groups
    small.add('alpha');
    small.add('beta');
    small.add('gamma');
    small.add('delta'); // should evict smallest

    // The extractor has at most 3 clusters
    const state = small.serialize();
    expect(state.clusters.length).toBeLessThanOrEqual(3);
  });

  it('serializes and restores', () => {
    extractor.add('Read src/a.ts');
    extractor.add('Read src/b.ts');

    const state = extractor.serialize();
    const restored = new PatternExtractor();
    restored.restore(state);

    const patterns = restored.getPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].count).toBe(2);
  });

  it('resets all state', () => {
    extractor.add('Read src/a.ts');
    extractor.add('Read src/b.ts');
    extractor.reset();
    expect(extractor.getPatterns()).toEqual([]);
  });

  it('handles empty and whitespace-only strings', () => {
    extractor.add('');
    extractor.add('   ');
    expect(extractor.getPatterns()).toEqual([]);
  });
});
