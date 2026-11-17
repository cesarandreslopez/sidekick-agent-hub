/**
 * Appends the live part of the demo session while a take records.
 *
 * Lines keep their recorded order and spacing, compressed by `speed`, and each
 * one is stamped with the moment it is written, so the dashboards see a session
 * that is running right now (the activity map animates only while a call is
 * open or the last event is under three seconds old). Each line goes out in one
 * write, so a tailer never sees half a line.
 */
import { appendFileSync } from 'node:fs';
import { lineAt } from './generate.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export class Feeder {
  /**
   * @param {object} options
   * @param {Record<string,string>} options.files  target → file (from writePreRoll)
   * @param {Array} options.entries                live timeline entries
   * @param {number} [options.speed]               recorded time / wall time
   * @param {number} [options.maxGapMs]            longest wall-clock pause between two lines
   */
  constructor({ files, entries, speed = 4, maxGapMs = 2_200 }) {
    this.files = files;
    this.entries = [...entries].sort((a, b) => a.at - b.at);
    this.speed = speed;
    this.maxGapMs = maxGapMs;
    this.index = 0;
    this.listeners = [];
  }

  get done() {
    return this.index >= this.entries.length;
  }

  /** Called with each entry after it is written. */
  onWrite(fn) {
    this.listeners.push(fn);
  }

  writeNext() {
    const entry = this.entries[this.index++];
    appendFileSync(this.files[entry.target], lineAt(entry, Date.now()));
    for (const fn of this.listeners) fn(entry);
    return entry;
  }

  /**
   * Play until `until(entry)` returns true for an entry just written, or until
   * the end. Pauses between lines follow the recorded gaps / speed, capped.
   */
  async play({ until, speed = this.speed } = {}) {
    while (!this.done) {
      const entry = this.writeNext();
      if (until?.(entry)) return entry;
      if (this.done) break;
      const gap = (this.entries[this.index].at - entry.at) / speed;
      await sleep(Math.min(gap, this.maxGapMs));
    }
    return null;
  }

  /** Play the next `n` tool calls (through each call's result). */
  async playCalls(n, options = {}) {
    let seen = 0;
    return this.play({ ...options, until: (e) => e.phase === 'tool_result' && ++seen >= n });
  }

  /** Play through the end of the current turn's reply. */
  playTurn(options = {}) {
    return this.play({ ...options, until: (e) => e.line.type === 'system' && e.line.subtype === 'turn_duration' });
  }
}
