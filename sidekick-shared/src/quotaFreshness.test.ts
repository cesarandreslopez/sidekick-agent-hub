import { describe, expect, it } from 'vitest';
import {
  classifyQuotaFreshness,
  formatQuotaAge,
  QUOTA_AGING_MAX_AGE_MS,
  QUOTA_FRESH_MAX_AGE_MS,
} from './quota';

describe('classifyQuotaFreshness', () => {
  it('tiers by age', () => {
    expect(classifyQuotaFreshness(0)).toBe('fresh');
    expect(classifyQuotaFreshness(QUOTA_FRESH_MAX_AGE_MS - 1)).toBe('fresh');
    expect(classifyQuotaFreshness(QUOTA_FRESH_MAX_AGE_MS)).toBe('aging');
    expect(classifyQuotaFreshness(QUOTA_AGING_MAX_AGE_MS - 1)).toBe('aging');
    expect(classifyQuotaFreshness(QUOTA_AGING_MAX_AGE_MS)).toBe('stale');
  });

  it('treats unknown ages as stale', () => {
    expect(classifyQuotaFreshness(undefined)).toBe('stale');
    expect(classifyQuotaFreshness(Number.NaN)).toBe('stale');
    expect(classifyQuotaFreshness(-1)).toBe('stale');
  });
});

describe('formatQuotaAge', () => {
  it('renders compact ages', () => {
    expect(formatQuotaAge(10_000)).toBe('just now');
    expect(formatQuotaAge(3 * 60_000)).toBe('3m ago');
    expect(formatQuotaAge(2 * 3_600_000)).toBe('2h ago');
    expect(formatQuotaAge(3 * 86_400_000)).toBe('3d ago');
    expect(formatQuotaAge(undefined)).toBe('age unknown');
  });
});
