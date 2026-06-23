/**
 * @fileoverview Sliding window burn rate calculator for token usage.
 *
 * Tracks token consumption over a configurable time window to calculate
 * tokens/minute rate and estimate time to quota exhaustion.
 *
 * @module services/BurnRateCalculator
 */

interface TokenEvent {
  tokens: number;
  timestamp: Date;
}

/**
 * Calculates token burn rate using sliding window algorithm.
 *
 * The calculator maintains a list of recent token events within
 * a configurable time window (default 5 minutes) and computes
 * the average tokens per minute.
 *
 * @example
 * ```typescript
 * const calc = new BurnRateCalculator();
 * calc.addEvent(1000, new Date());
 * const rate = calc.calculateBurnRate(); // tokens per minute
 * const eta = calc.estimateTimeToQuota(50000, 100000); // minutes remaining
 * ```
 */
export class BurnRateCalculator {
  private events: TokenEvent[] = [];
  private readonly windowMs: number;

  /**
   * Creates a new BurnRateCalculator.
   *
   * @param windowMinutes - Size of sliding window in minutes (default: 5)
   */
  constructor(windowMinutes: number = 5) {
    this.windowMs = windowMinutes * 60 * 1000;
  }

  /**
   * Records a token consumption event.
   *
   * @param tokens - Number of tokens consumed
   * @param timestamp - When the consumption occurred
   */
  addEvent(tokens: number, timestamp: Date = new Date()): void {
    this.events.push({ tokens, timestamp });
    this.pruneOldEvents(timestamp);
  }

  /**
   * Removes events outside the sliding window.
   */
  private pruneOldEvents(now: Date): void {
    const cutoff = new Date(now.getTime() - this.windowMs);
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
  }

  /**
   * Calculates current burn rate in tokens per minute.
   *
   * @param now - Current time (for testing, defaults to now)
   * @returns Tokens per minute, or 0 if no recent events
   */
  calculateBurnRate(now: Date = new Date()): number {
    this.pruneOldEvents(now);

    if (this.events.length === 0) {
      return 0;
    }

    const totalTokens = this.events.reduce((sum, e) => sum + e.tokens, 0);

    // Calculate actual elapsed time from first event to now
    const firstEvent = this.events[0];
    const elapsedMs = now.getTime() - firstEvent.timestamp.getTime();
    const elapsedMinutes = Math.max(elapsedMs / 60000, 1); // At least 1 minute

    return totalTokens / elapsedMinutes;
  }

  /**
   * Estimates minutes until quota exhaustion.
   *
   * @param currentTokens - Tokens used so far in quota window
   * @param quotaLimit - Maximum tokens allowed in quota window
   * @param now - Current time
   * @returns Minutes remaining, or null if burn rate is zero
   */
  estimateTimeToQuota(
    currentTokens: number,
    quotaLimit: number,
    now: Date = new Date(),
  ): number | null {
    const burnRate = this.calculateBurnRate(now);

    if (burnRate <= 0) {
      return null; // Can't estimate without burn rate
    }

    const tokensRemaining = quotaLimit - currentTokens;
    if (tokensRemaining <= 0) {
      return 0; // Already at or over quota
    }

    return tokensRemaining / burnRate;
  }

  /**
   * Gets the number of events in current window.
   * Useful for debugging and testing.
   */
  getEventCount(): number {
    return this.events.length;
  }

  /**
   * Resets the calculator, clearing all events.
   */
  reset(): void {
    this.events = [];
  }
}
