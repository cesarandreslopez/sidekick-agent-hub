import { describe, expect, it } from 'vitest';
import { collectDeprecatedSettings } from './deprecatedSettings';

describe('collectDeprecatedSettings', () => {
  it('reports only settings configured at some scope, with their replacements', () => {
    const values: Record<string, { globalValue?: unknown; workspaceValue?: unknown }> = {
      inlineTimeout: { workspaceValue: 5000 },
      'zai.tier': { globalValue: 'pro' },
      authMode: {},
    };
    expect(collectDeprecatedSettings({ inspect: (key) => values[key] })).toEqual([
      { key: 'sidekick.inlineTimeout', replacement: 'sidekick.timeouts.inlineCompletion' },
      { key: 'sidekick.zai.tier' },
    ]);
    expect(collectDeprecatedSettings({ inspect: () => undefined })).toEqual([]);
  });
});
