import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import {
  helpWhenRunAlone,
  rejectUnknownSubcommands,
  showGlobalOptionsEverywhere,
  suggestSubcommand,
} from './subcommandHelp';

function program(): { root: Command; tasks: Command; note: Command; ran: string[] } {
  const ran: string[] = [];
  const root = new Command('sidekick').exitOverride().option('--json', 'Output as JSON');
  const tasks = new Command('tasks').exitOverride().action(() => ran.push('tasks'));
  tasks
    .command('add')
    .argument('<subject>')
    .action(() => ran.push('add'));
  tasks.command('done').argument('<id>');
  const note = new Command('note').exitOverride();
  note.command('add').argument('<content>');
  root.addCommand(tasks).addCommand(note);
  return { root, tasks, note, ran };
}

describe('subcommand help', () => {
  it('suggests the closest subcommand for a typo', () => {
    expect(suggestSubcommand('ad', ['add', 'done'])).toBe('add');
    expect(suggestSubcommand('histroy', ['history'])).toBe('history');
    expect(suggestSubcommand('zzzz', ['add', 'done'])).toBeUndefined();
  });

  it('names a mistyped subcommand instead of reporting too many arguments', async () => {
    const { root, tasks, ran } = program();
    rejectUnknownSubcommands(tasks);
    const errors: string[] = [];
    tasks.configureOutput({ writeErr: (text) => errors.push(text) });
    await expect(root.parseAsync(['tasks', 'ad', 'foo'], { from: 'user' })).rejects.toThrow();
    expect(errors.join('')).toContain("unknown command 'ad' for 'tasks'");
    expect(errors.join('')).toContain('Did you mean add?');
    expect(ran).toEqual([]);

    await root.parseAsync(['tasks'], { from: 'user' });
    expect(ran).toEqual(['tasks']);
  });

  it('prints a bare grouping command’s help on stdout', async () => {
    const { root, note } = program();
    helpWhenRunAlone(note, []);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await root.parseAsync(['note'], { from: 'user' });
    expect(write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
      'Usage: sidekick note',
    );
    write.mockRestore();
  });

  it('still prints that help when only a global boolean flag follows', async () => {
    const { root, note } = program();
    helpWhenRunAlone(note, ['--json']);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await root.parseAsync(['note', '--json'], { from: 'user' });
    expect(write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
      'Usage: sidekick note',
    );
    write.mockRestore();
  });

  it('answers `tasks help add` and `tasks help` with help, exit 0', async () => {
    const { root, tasks, ran } = program();
    rejectUnknownSubcommands(tasks);
    const out: string[] = [];
    for (const command of [tasks, ...tasks.commands]) {
      command.exitOverride().configureOutput({ writeOut: (text) => out.push(text) });
    }
    await expect(root.parseAsync(['tasks', 'help', 'add'], { from: 'user' })).rejects.toMatchObject(
      { exitCode: 0 },
    );
    expect(out.join('')).toContain('Usage: sidekick tasks add');
    out.length = 0;
    await expect(root.parseAsync(['tasks', 'help'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 0,
    });
    expect(out.join('')).toContain('Usage: sidekick tasks');
    expect(ran).toEqual([]);
  });

  it('lists the global options in subcommand help', () => {
    const { root, tasks } = program();
    showGlobalOptionsEverywhere(root);
    expect(tasks.helpInformation()).toContain('--json');
  });
});
