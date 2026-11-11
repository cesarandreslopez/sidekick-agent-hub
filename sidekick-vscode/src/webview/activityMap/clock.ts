/**
 * The extension host's clock, seen from the webview. Record times follow the
 * host (on remote hosts, the remote machine), so live animations offset the
 * local clock by the host's.
 *
 * Every message carries `hostNow`, read just before sending; delivery delay
 * only makes a sample smaller than the true offset, so the largest of the
 * recent samples is the best estimate.
 *
 * @module webview/activityMap/clock
 */

const SAMPLES = 8;

export class HostClock {
  private samples: number[] = [];
  private offset = 0;

  constructor(private readonly localNow: () => number = () => Date.now()) {}

  observe(hostNow: number): void {
    if (!Number.isFinite(hostNow)) return;
    this.samples.push(hostNow - this.localNow());
    if (this.samples.length > SAMPLES) this.samples.shift();
    this.offset = Math.max(...this.samples);
  }

  get offsetMs(): number {
    return this.offset;
  }

  /** Host time now, epoch ms. */
  now(): number {
    return this.localNow() + this.offset;
  }
}
