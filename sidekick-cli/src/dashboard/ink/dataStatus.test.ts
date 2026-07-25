import { describe, expect, it } from 'vitest';
import {
  describeDataStatus,
  initialDataStatus,
  STALE_AFTER_MS,
  WATCHER_ERROR_TTL_MS,
} from './dataStatus';

const NOW = 1_800_000_000_000;

describe('describeDataStatus', () => {
  it('shows nothing when data is healthy and fresh', () => {
    expect(describeDataStatus({ ...initialDataStatus(), loadedAt: NOW }, NOW)).toBeNull();
  });

  it('shows nothing before the first load completes', () => {
    expect(describeDataStatus(initialDataStatus(), NOW)).toBeNull();
  });

  it('reports a failed load in red', () => {
    const badge = describeDataStatus({ ...initialDataStatus(), error: 'EACCES' }, NOW);
    expect(badge).toEqual({ text: '⚠ data', color: 'red' });
  });

  it('reports a watcher failure in yellow', () => {
    const badge = describeDataStatus(
      { ...initialDataStatus(), watcherError: 'bad line', watcherErrorAt: NOW },
      NOW,
    );
    expect(badge).toEqual({ text: '⚠ session', color: 'yellow' });
  });

  it('expires a watcher failure the watcher already recovered from', () => {
    const status = {
      ...initialDataStatus(),
      loadedAt: NOW,
      watcherError: 'bad line',
      watcherErrorAt: NOW - WATCHER_ERROR_TTL_MS - 1,
    };
    expect(describeDataStatus(status, NOW)).toBeNull();
  });

  it('lets staleness through once a stale watcher failure has expired', () => {
    const status = {
      ...initialDataStatus(),
      loadedAt: NOW - STALE_AFTER_MS - 60_000,
      watcherError: 'bad line',
      watcherErrorAt: NOW - WATCHER_ERROR_TTL_MS - 1,
    };
    expect(describeDataStatus(status, NOW)).toEqual({ text: 'stale 3m', color: 'yellow' });
  });

  it('ranks a load failure above a watcher failure', () => {
    const badge = describeDataStatus(
      { ...initialDataStatus(), error: 'EACCES', watcherError: 'bad line', watcherErrorAt: NOW },
      NOW,
    );
    expect(badge!.text).toBe('⚠ data');
  });

  it('shows a spinner glyph while refreshing', () => {
    const badge = describeDataStatus({ ...initialDataStatus(), refreshing: true }, NOW);
    expect(badge).toEqual({ text: '↻', color: 'gray' });
  });

  it('reports staleness in whole minutes once past the threshold', () => {
    const loadedAt = NOW - STALE_AFTER_MS - 60_000;
    const badge = describeDataStatus({ ...initialDataStatus(), loadedAt }, NOW);
    expect(badge).toEqual({ text: 'stale 3m', color: 'yellow' });
  });

  it('does not call data stale before the threshold', () => {
    const loadedAt = NOW - STALE_AFTER_MS + 1;
    expect(describeDataStatus({ ...initialDataStatus(), loadedAt }, NOW)).toBeNull();
  });
});
