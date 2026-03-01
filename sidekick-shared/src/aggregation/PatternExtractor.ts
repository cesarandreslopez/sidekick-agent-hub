/**
 * Simplified Drain algorithm for session event clustering.
 *
 * Tokenizes event summaries, groups by token count, clusters by shared prefix
 * tokens, and replaces variable tokens with `<*>` to produce templates.
 * Surfaces repetitive patterns like "Read src/<*>.ts" (count: 5).
 *
 * @module aggregation/PatternExtractor
 */

const DEFAULT_MAX_CLUSTERS = 100;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

export interface PatternCluster {
  /** Template string with <*> wildcards for variable tokens. */
  template: string;
  /** Number of events matching this pattern. */
  count: number;
  /** Up to 3 example summaries. */
  examples: string[];
}

interface InternalCluster {
  tokens: string[];
  mask: boolean[]; // true = wildcard
  count: number;
  examples: string[];
}

export interface SerializedPatternState {
  clusters: Array<{
    tokens: string[];
    mask: boolean[];
    count: number;
    examples: string[];
  }>;
}

export class PatternExtractor {
  private readonly maxClusters: number;
  private readonly maxDepth: number;
  private readonly similarityThreshold: number;

  // Group clusters by token count for efficient lookup
  private groups = new Map<number, InternalCluster[]>();

  constructor(options?: {
    maxClusters?: number;
    maxDepth?: number;
    similarityThreshold?: number;
  }) {
    this.maxClusters = options?.maxClusters ?? DEFAULT_MAX_CLUSTERS;
    this.maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.similarityThreshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  }

  /** Add a summary string for clustering. */
  add(summary: string): void {
    const tokens = this.tokenize(summary);
    if (tokens.length === 0) return;

    const key = tokens.length;
    let group = this.groups.get(key);
    if (!group) {
      group = [];
      this.groups.set(key, group);
    }

    // Find best matching cluster
    let bestCluster: InternalCluster | null = null;
    let bestSim = 0;

    for (const cluster of group) {
      const sim = this.similarity(tokens, cluster);
      if (sim > bestSim) {
        bestSim = sim;
        bestCluster = cluster;
      }
    }

    if (bestCluster && bestSim >= this.similarityThreshold) {
      // Merge into existing cluster
      bestCluster.count++;
      if (bestCluster.examples.length < 3) {
        bestCluster.examples.push(summary);
      }
      // Update mask: mark differing positions as wildcards
      for (let i = 0; i < tokens.length; i++) {
        if (!bestCluster.mask[i] && tokens[i] !== bestCluster.tokens[i]) {
          bestCluster.mask[i] = true;
        }
      }
    } else {
      // Create new cluster (evict least-used if at capacity)
      if (this.totalClusters() >= this.maxClusters) {
        this.evictSmallest();
      }
      group.push({
        tokens: [...tokens],
        mask: new Array(tokens.length).fill(false),
        count: 1,
        examples: [summary],
      });
    }
  }

  /** Get all patterns sorted by frequency. */
  getPatterns(): PatternCluster[] {
    const result: PatternCluster[] = [];
    for (const group of this.groups.values()) {
      for (const cluster of group) {
        if (cluster.count < 2) continue; // Only show patterns with 2+ matches
        result.push({
          template: this.buildTemplate(cluster),
          count: cluster.count,
          examples: [...cluster.examples],
        });
      }
    }
    return result.sort((a, b) => b.count - a.count);
  }

  /** Reset all tracked patterns. */
  reset(): void {
    this.groups.clear();
  }

  /** Serialize for snapshot persistence. */
  serialize(): SerializedPatternState {
    const clusters: SerializedPatternState['clusters'] = [];
    for (const group of this.groups.values()) {
      for (const cluster of group) {
        clusters.push({
          tokens: [...cluster.tokens],
          mask: [...cluster.mask],
          count: cluster.count,
          examples: [...cluster.examples],
        });
      }
    }
    return { clusters };
  }

  /** Restore from serialized state. */
  restore(state: SerializedPatternState): void {
    this.groups.clear();
    for (const c of state.clusters) {
      const key = c.tokens.length;
      let group = this.groups.get(key);
      if (!group) {
        group = [];
        this.groups.set(key, group);
      }
      group.push({
        tokens: [...c.tokens],
        mask: [...c.mask],
        count: c.count,
        examples: [...c.examples],
      });
    }
  }

  // ── Private ──

  private tokenize(text: string): string[] {
    return text.split(/\s+/).filter(t => t.length > 0).slice(0, this.maxDepth * 4);
  }

  private similarity(tokens: string[], cluster: InternalCluster): number {
    const len = Math.min(tokens.length, this.maxDepth);
    let matches = 0;
    for (let i = 0; i < len; i++) {
      if (cluster.mask[i] || tokens[i] === cluster.tokens[i]) {
        matches++;
      }
    }
    return matches / len;
  }

  private buildTemplate(cluster: InternalCluster): string {
    return cluster.tokens
      .map((tok, i) => (cluster.mask[i] ? '<*>' : tok))
      .join(' ');
  }

  private totalClusters(): number {
    let total = 0;
    for (const group of this.groups.values()) {
      total += group.length;
    }
    return total;
  }

  private evictSmallest(): void {
    let minCount = Infinity;
    let minGroup: InternalCluster[] | null = null;
    let minIndex = -1;

    for (const group of this.groups.values()) {
      for (let i = 0; i < group.length; i++) {
        if (group[i].count < minCount) {
          minCount = group[i].count;
          minGroup = group;
          minIndex = i;
        }
      }
    }

    if (minGroup && minIndex >= 0) {
      minGroup.splice(minIndex, 1);
    }
  }
}
