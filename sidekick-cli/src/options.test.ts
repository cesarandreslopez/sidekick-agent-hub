/**
 * Tests for choice-validated Option factories.
 */

import { describe, it, expect } from 'vitest';
import { Command, CommanderError, type Option } from 'commander';
import {
  quotaHistoryProviderOption,
  quotaProviderOption,
  reportThemeOption,
  ROOT_PROVIDER_CHOICES,
  rootProviderOption,
  sessionProviderChoice,
  tasksStatusOption,
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
  });

  // Commander parses the root option wherever it appears, so `sidekick quota
  // --provider zai` is validated against the root list, never the quota one.
  it('root provider admits every value a subcommand accepts', () => {
    const root = new Set(ROOT_PROVIDER_CHOICES);
    const sub = [
      ...(quotaProviderOption().argChoices ?? []),
      ...(quotaHistoryProviderOption().argChoices ?? []),
      'all',
    ];
    for (const id of sub) expect(root.has(id as never), id).toBe(true);
  });

  it('a subcommand value reaches the subcommand through the root option', () => {
    const program = new Command('sidekick').exitOverride().addOption(rootProviderOption());
    let seen: unknown;
    program
      .command('quota')
      .addOption(quotaProviderOption())
      .action((_opts, cmd: Command) => {
        seen = cmd.parent!.opts().provider;
      });
    program.parse(['quota', '--provider', 'zai'], { from: 'user' });
    expect(seen).toBe('zai');
  });

  it('session readers refuse values only another command accepts', () => {
    expect(sessionProviderChoice(undefined)).toBeUndefined();
    for (const id of ['claude-code', 'opencode', 'codex', 'auto']) {
      expect(sessionProviderChoice(id)).toBe(id);
    }
    for (const id of ['zai', 'z.ai', 'claude', 'all']) {
      expect(() => sessionProviderChoice(id)).toThrow(/not a session provider/);
    }
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
});
