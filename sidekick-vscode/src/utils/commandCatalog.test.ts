import { describe, expect, it } from 'vitest';
import { buildCommandCatalog } from './commandCatalog';

describe('buildCommandCatalog', () => {
  it('derives and sorts the menu from contributed commands', () => {
    const items = buildCommandCatalog(
      {
        contributes: {
          commands: [
            { command: 'sidekick.z', title: 'Zulu', category: 'Sidekick' },
            { command: 'sidekick.a', title: 'Alpha', category: 'Sidekick' },
            { command: 'sidekick.showMenu', title: 'Show Menu', category: 'Sidekick' },
            { command: 'sidekick.internal', title: 'Internal', category: 'Sidekick' },
          ],
          menus: {
            commandPalette: [{ command: 'sidekick.internal', when: 'false' }],
          },
        },
      },
      new Set(['sidekick.showMenu']),
    );
    expect(items).toEqual([
      { command: 'sidekick.a', label: 'Alpha', description: 'Sidekick' },
      { command: 'sidekick.z', label: 'Zulu', description: 'Sidekick' },
    ]);
  });
});
