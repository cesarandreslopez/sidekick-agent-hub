import { describe, expect, it } from 'vitest';
import { DASHBOARD_INIT_ELEMENT_ID, emptyDashboardInit, readDashboardInit } from './init';

function documentWith(text: string | null) {
  return {
    getElementById: (id: string) =>
      id === DASHBOARD_INIT_ELEMENT_ID ? { textContent: text } : null,
  };
}

describe('readDashboardInit', () => {
  it('parses the embedded block, including script-safe escapes', () => {
    const init = readDashboardInit(
      documentWith(
        JSON.stringify({
          session: { providerId: 'codex', providerName: 'Codex CLI', isPinned: true },
          changelog: [{ version: '1.0.0', date: '2026-09-04', sections: [] }],
          attributionVars: { 'System Prompt': '--sk-attr-system' },
        }).replace(/</g, '\\u003c'),
      ),
    );
    expect(init.session).toMatchObject({
      providerId: 'codex',
      providerName: 'Codex CLI',
      isPinned: true,
      groups: null,
    });
    expect(init.changelog).toHaveLength(1);
    expect(init.attributionVars['System Prompt']).toBe('--sk-attr-system');
  });

  it('falls back to the empty init when the block is missing or malformed', () => {
    expect(readDashboardInit(documentWith(null))).toEqual(emptyDashboardInit());
    expect(readDashboardInit(documentWith('{not json'))).toEqual(emptyDashboardInit());
    expect(readDashboardInit({ getElementById: () => null })).toEqual(emptyDashboardInit());
  });
});
