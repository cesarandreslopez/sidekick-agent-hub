interface TokenEvent {
  tokens: number;
  timestamp: Date;
}

/** Sliding-window burn-rate calculator shared by every Sidekick surface. */
export class BurnRateCalculator {
  private events: TokenEvent[] = [];
  private readonly windowMs: number;

  constructor(windowMinutes = 5) {
    this.windowMs = windowMinutes * 60_000;
  }

  addEvent(tokens: number, timestamp = new Date()): void {
    this.events.push({ tokens, timestamp });
    this.pruneOldEvents(timestamp);
  }

  calculateBurnRate(now = new Date()): number {
    this.pruneOldEvents(now);
    if (this.events.length === 0) return 0;
    const totalTokens = this.events.reduce((sum, event) => sum + event.tokens, 0);
    const elapsedMinutes = Math.max(
      (now.getTime() - this.events[0].timestamp.getTime()) / 60_000,
      1,
    );
    return totalTokens / elapsedMinutes;
  }

  estimateTimeToQuota(currentTokens: number, quotaLimit: number, now = new Date()): number | null {
    return estimateTimeToQuota(currentTokens, quotaLimit, this.calculateBurnRate(now));
  }

  getEventCount(): number {
    return this.events.length;
  }

  reset(): void {
    this.events = [];
  }

  private pruneOldEvents(now: Date): void {
    const cutoff = now.getTime() - this.windowMs;
    this.events = this.events.filter((event) => event.timestamp.getTime() >= cutoff);
  }
}

/** Pure ETA helper for cached or externally computed burn rates. */
export function estimateTimeToQuota(
  currentUsage: number,
  quotaLimit: number,
  burnRatePerMinute: number,
): number | null {
  if (burnRatePerMinute <= 0) return null;
  const remaining = quotaLimit - currentUsage;
  return remaining <= 0 ? 0 : remaining / burnRatePerMinute;
}
