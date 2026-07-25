/**
 * Structural invariants of the extension manifest.
 *
 * package.json and the TypeScript that depends on it drift silently: a `when`
 * clause that names a context key nobody sets, a contextValue no menu matches,
 * or a menu whose language filter disagrees with the provider registration are
 * all invisible to the compiler and to every other test.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

interface ViewContribution {
  id: string;
  name: string;
  type?: string;
  when?: string;
  visibility?: string;
  contextualTitle?: string;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
) as {
  contributes: {
    views: Record<string, ViewContribution[]>;
    viewsContainers: Record<string, Array<{ id: string }>>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    commands: Array<{ command: string; title: string; category?: string }>;
  };
};

const views = manifest.contributes.views['sidekick-monitor'];

/** The only view that stays visible when monitoring is off. */
const PRIMARY_VIEW = 'sidekick.dashboard';

describe('view contributions', () => {
  it('contributes every view to the single Agent Hub container', () => {
    expect(Object.keys(manifest.contributes.views)).toEqual(['sidekick-monitor']);
    expect(views.length).toBeGreaterThan(0);
  });

  it('gates every secondary view behind the monitoring context key', () => {
    // The key is set from the branch that registers the providers. Without
    // this, disabling monitoring left views contributed but unbacked: trees
    // spun forever and webviews stayed blank.
    for (const view of views) {
      if (view.id === PRIMARY_VIEW) continue;
      expect(view.when, `${view.id} is not gated`).toBe('sidekick.monitoringActive');
    }
  });

  it('leaves the primary view ungated so the container never disappears', () => {
    const primary = views.find((v) => v.id === PRIMARY_VIEW);
    expect(primary).toBeDefined();
    expect(primary!.when).toBeUndefined();
  });

  it('collapses every secondary view by default', () => {
    // Nine always-expanded views, five of them webviews, made the sidebar
    // unusable at any normal height.
    for (const view of views) {
      if (view.id === PRIMARY_VIEW) continue;
      expect(view.visibility, `${view.id} is not collapsed`).toBe('collapsed');
    }
  });

  it('gives every view a contextual title for when it is dragged out', () => {
    for (const view of views) {
      expect(view.contextualTitle, `${view.id} has no contextualTitle`).toBeTruthy();
    }
  });
});

describe('command contributions', () => {
  it('gives every command a category so the palette is not one flat list', () => {
    for (const command of manifest.contributes.commands) {
      expect(command.category, `${command.command} has no category`).toBeTruthy();
    }
  });

  it('registers every menu command in the command list', () => {
    const declared = new Set(manifest.contributes.commands.map((c) => c.command));
    for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
      for (const entry of entries) {
        if (!entry.command) continue;
        if (!entry.command.startsWith('sidekick.')) continue;
        expect(declared.has(entry.command), `${menu} references undeclared ${entry.command}`).toBe(
          true,
        );
      }
    }
  });
});

describe('monitoring-disabled command fallbacks', () => {
  // Nine commands are registered only inside the monitoring branch, but stay in
  // the Command Palette either way — plus addKnowledgeNote in the editor context
  // menu and a walkthrough link. Invoking one with monitoring off used to raise a
  // raw "command not found", so the disabled branch registers a fallback for each.
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf-8');
  const loop = source.match(/for \(const id of \[([\s\S]*?)\]\) \{/);
  const fallbackIds = loop ? [...loop[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

  it('registers a fallback for each command the monitoring branch owns', () => {
    expect(fallbackIds.length).toBe(9);
  });

  it('names only commands the manifest actually contributes', () => {
    const declared = new Set(manifest.contributes.commands.map((c) => c.command));
    for (const id of fallbackIds) {
      expect(declared.has(id), `${id} has a fallback but is not contributed`).toBe(true);
    }
  });

  it('keeps a real handler for every fallback command', () => {
    // A fallback whose real registration was deleted would silently become the
    // only handler, so the feature would look broken rather than gated.
    for (const id of fallbackIds) {
      const registrations = [
        ...source.matchAll(new RegExp(`registerCommand\\(\\s*'${id.replace('.', '\\.')}'`, 'g')),
      ];
      expect(registrations.length, `${id} has no real registration`).toBe(1);
    }
  });
});
