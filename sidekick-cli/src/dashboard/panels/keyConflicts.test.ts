/**
 * Panel key bindings checked against the live dispatcher contract.
 *
 * Tier 4 silently ignores any panel binding on a reserved key, and tier 5
 * globals are silently shadowed by panel bindings that claim them. Both
 * failures are invisible at runtime and invisible to TypeScript, so this test
 * is the only thing standing between a plausible-looking binding and a key
 * that quietly stops working.
 */

import { describe, expect, it } from 'vitest';
import { RESERVED_KEYS } from '../ink/inputDispatch';
import type { SidePanel } from './types';
import { SessionsPanel } from './SessionsPanel';
import { TasksPanel } from './TasksPanel';
import { KanbanPanel } from './KanbanPanel';
import { NotesPanel } from './NotesPanel';
import { DecisionsPanel } from './DecisionsPanel';
import { PlansPanel } from './PlansPanel';
import { EventStreamPanel } from './EventStreamPanel';
import { ChartsPanel } from './ChartsPanel';

/**
 * Shadowable tier-5 globals. A panel binding on one of these wins, which is
 * the intended design — but every instance must be a deliberate choice.
 */
const SHADOWABLE_GLOBALS = new Set(['z', 'V', 'r', 'p', 'f', 'x', '[', ']']);

/** Tier-5 keys a panel is knowingly allowed to shadow, with the reason. */
const INTENTIONAL_SHADOWS = new Map<string, string>();

function allPanels(): SidePanel[] {
  return [
    new SessionsPanel('/tmp/keyconflicts', 'claude-code'),
    new TasksPanel(),
    new KanbanPanel(),
    new NotesPanel(),
    new DecisionsPanel(),
    new PlansPanel(),
    new EventStreamPanel(),
    new ChartsPanel(),
  ];
}

/** Every key a panel claims, via either binding mechanism. */
function claimedKeys(panel: SidePanel): string[] {
  const fromBindings = (panel.getKeybindings?.() ?? []).flatMap((b) => b.keys);
  const fromActions = (panel.getActions?.() ?? []).map((a) => a.key);
  return [...fromBindings, ...fromActions];
}

describe('panel key bindings', () => {
  it('never claims a reserved key', () => {
    const offenders: string[] = [];
    for (const panel of allPanels()) {
      for (const key of claimedKeys(panel)) {
        if (RESERVED_KEYS.has(key)) offenders.push(`${panel.id} binds reserved '${key}'`);
      }
    }
    // A reserved binding is dropped by tier 4, so the panel action is dead and
    // nothing says so.
    expect(offenders).toEqual([]);
  });

  it('never shadows a tier-5 global outside the allow-list', () => {
    const offenders: string[] = [];
    for (const panel of allPanels()) {
      for (const key of claimedKeys(panel)) {
        if (!SHADOWABLE_GLOBALS.has(key)) continue;
        if (INTENTIONAL_SHADOWS.has(key)) continue;
        offenders.push(`${panel.id} shadows global '${key}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not let one panel claim the same key twice', () => {
    for (const panel of allPanels()) {
      const keys = claimedKeys(panel);
      expect(new Set(keys).size, `${panel.id} claims a key more than once`).toBe(keys.length);
    }
  });

  it('keeps the session switch reachable from every panel', () => {
    // PlansPanel bound 's' with no condition, so it fired whenever an item was
    // selected — which on Plans is always — and switching sessions from that
    // panel was impossible.
    expect(RESERVED_KEYS.has('s')).toBe(true);
    for (const panel of allPanels()) {
      expect(claimedKeys(panel), `${panel.id} claims 's'`).not.toContain('s');
    }
  });

  it('keeps the session filter reachable from the sessions panel', () => {
    // SessionsPanel bound 'f' on the mind-map tab, shadowing the only way to
    // establish a session filter from a historical session.
    const sessions = allPanels().find((p) => p.id === 'sessions')!;
    expect(claimedKeys(sessions)).not.toContain('f');
  });

  it('keeps refresh reachable from every panel', () => {
    expect(RESERVED_KEYS.has('R')).toBe(true);
    for (const panel of allPanels()) {
      expect(claimedKeys(panel), `${panel.id} claims 'R'`).not.toContain('R');
    }
  });
});
