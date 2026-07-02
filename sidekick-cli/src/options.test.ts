/**
 * Tests for choice-validated Option factories.
 */

import { describe, it, expect } from 'vitest';
import { Command, CommanderError, type Option } from 'commander';
import {
  quotaHistoryProviderOption,
  quotaProviderOption,
  reportThemeOption,
  rootProviderOption,
  tasksStatusOption,
  zaiTierOption,
} from './options';

function parse(option: Option, args: string[]): Record<string, unknown> {
  const cmd = new Command('t').exitOverride().addOption(option);
  cmd.parse(args, { from: 'user' });
  return cmd.opts();
}

describe('option factories', () => {
  it('root provider accepts the four session providers', () => {
    for (const id of ['claude-code', 'opencode', 'codex', 'auto']) {
      expect(parse(rootProviderOption(), ['--provider', id]).provider).toBe(id);
    }
  });

  it('root provider rejects unknown values at parse time', () => {
    expect(() => parse(rootProviderOption(), ['--provider', 'typo'])).toThrow(CommanderError);
    expect(() => parse(rootProviderOption(), ['--provider', 'zai'])).toThrow(CommanderError);
  });

  it('quota provider additionally accepts zai', () => {
    expect(parse(quotaProviderOption(), ['--provider', 'zai']).provider).toBe('zai');
  });

  it('quota-history provider keeps the legacy aliases working', () => {
    for (const id of ['claude', 'claude-code', 'codex', 'zai', 'z.ai']) {
      expect(parse(quotaHistoryProviderOption(), ['--provider', id]).provider).toBe(id);
    }
    expect(() => parse(quotaHistoryProviderOption(), ['--provider', 'opencode'])).toThrow(
      CommanderError,
    );
  });

  it('report theme defaults to dark and rejects unknown themes', () => {
    expect(parse(reportThemeOption(), []).theme).toBe('dark');
    expect(parse(reportThemeOption(), ['--theme', 'light']).theme).toBe('light');
    expect(() => parse(reportThemeOption(), ['--theme', 'solarized'])).toThrow(CommanderError);
  });

  it('tasks status accepts pending/completed/all only', () => {
    expect(parse(tasksStatusOption(), ['--status', 'pending']).status).toBe('pending');
    expect(() => parse(tasksStatusOption(), ['--status', 'done'])).toThrow(CommanderError);
  });

  it('zai tier defaults to auto and validates tiers', () => {
    expect(parse(zaiTierOption(), []).tier).toBe('auto');
    expect(parse(zaiTierOption(), ['--tier', 'max']).tier).toBe('max');
    expect(() => parse(zaiTierOption(), ['--tier', 'ultra'])).toThrow(CommanderError);
  });
});
