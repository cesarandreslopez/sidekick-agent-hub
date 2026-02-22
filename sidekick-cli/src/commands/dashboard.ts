/**
 * `sidekick dashboard` — Full-screen TUI dashboard with live session data.
 * Uses Ink (React for the terminal) for rendering.
 */

import React from 'react';
import * as path from 'path';
import type { Command } from 'commander';
import { createWatcher, getAllDetectedProviders } from 'sidekick-shared';
import type { FollowEvent, ProviderId } from 'sidekick-shared';
import { ClaudeCodeProvider, OpenCodeProvider, CodexProvider } from 'sidekick-shared';
import { resolveProvider } from '../cli';
import { DashboardState } from '../dashboard/DashboardState';
import { loadStaticData } from '../dashboard/StaticDataLoader';
import type { StaticData } from '../dashboard/StaticDataLoader';
import { QuotaService } from '../dashboard/QuotaService';
import { SessionsPanel } from '../dashboard/panels/SessionsPanel';
import { TasksPanel } from '../dashboard/panels/TasksPanel';
import { KanbanPanel } from '../dashboard/panels/KanbanPanel';
import { NotesPanel } from '../dashboard/panels/NotesPanel';
import { DecisionsPanel } from '../dashboard/panels/DecisionsPanel';
import type { SidePanel } from '../dashboard/panels/types';
import { showSessionPicker } from '../dashboard/ink/SessionPickerInk';
import { Dashboard } from '../dashboard/ink/Dashboard';
import { disableMouse } from '../dashboard/ink/mouse';

function createProviderById(id: ProviderId) {
  switch (id) {
    case 'opencode': return new OpenCodeProvider();
    case 'codex': return new CodexProvider();
    case 'claude-code':
    default: return new ClaudeCodeProvider();
  }
}

export async function dashboardAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const provider = resolveProvider(globalOpts);
  const workspacePath = globalOpts.project || process.cwd();

  // ── Session picker (multi-provider) ──
  let sessionId: string | undefined = opts.session;
  let replay = !!opts.replay;
  let activeProvider = provider;

  // Detect additional providers for the session picker
  const detectedIds = getAllDetectedProviders();
  const additionalProviders = detectedIds
    .filter((id: ProviderId) => id !== provider.id)
    .map((id: ProviderId) => createProviderById(id));

  if (!sessionId) {
    const sessions = provider.findAllSessions(workspacePath);
    const hasAnySessions = sessions.length > 0 || additionalProviders.some(p => p.findAllSessions(workspacePath).length > 0);
    if (hasAnySessions) {
      try {
        const result = await showSessionPicker(provider, workspacePath, additionalProviders);
        if (result.sessionPath) {
          sessionId = path.basename(result.sessionPath, path.extname(result.sessionPath));
          replay = true;
          // Switch to the provider that owns the selected session
          if (result.providerId && result.providerId !== provider.id) {
            activeProvider = createProviderById(result.providerId);
          }
        }
      } catch {
        // User quit the picker
        for (const p of additionalProviders) p.dispose();
        process.exit(0);
      }
    }
  }

  // Dispose additional providers we won't use
  for (const p of additionalProviders) {
    if (p !== activeProvider) p.dispose();
  }

  // Load static data
  let staticData: StaticData;
  try {
    staticData = await loadStaticData(workspacePath);
  } catch {
    staticData = {
      sessions: [], tasks: [], decisions: [], notes: [],
      totalTokens: 0, totalCost: 0, totalSessions: 0,
    };
  }

  // Create dashboard state and panels
  const state = new DashboardState();
  const sessionsPanel = new SessionsPanel(workspacePath, activeProvider.id);
  const panels: SidePanel[] = [
    sessionsPanel,
    new TasksPanel(),
    new KanbanPanel(),
    new NotesPanel(),
    new DecisionsPanel(),
  ];

  // Wire up narrative completion callback to trigger re-render
  sessionsPanel.onNarrativeComplete = () => scheduleRender();

  // Subscription quota polling
  const quotaService = new QuotaService();

  // ── New session detection + auto-switch ──
  let lastNotifiedSessionPath: string | null = null;
  const currentSessions = activeProvider.findAllSessions(workspacePath);
  lastNotifiedSessionPath = currentSessions.length > 0 ? currentSessions[0] : null;
  let isPinned = false;
  let pendingSessionPath: string | null = null;

  function switchToSession(newSessionPath: string) {
    // Stop current watcher
    try { watcher?.stop(); } catch { /* ignore */ }

    // Reset state
    state.reset();
    pendingSessionPath = null;

    // Create new watcher for the new session
    const newSessionId = path.basename(newSessionPath, path.extname(newSessionPath));
    try {
      const result = createWatcher({
        provider: activeProvider,
        workspacePath,
        sessionId: newSessionId,
        callbacks: {
          onEvent: (event: FollowEvent) => {
            if (stopped) return;
            state.processEvent(event);
            scheduleRender();
          },
          onError: (_err: Error) => { /* non-fatal */ },
        },
      });
      watcher = result.watcher;
      watcher.start(true); // replay events
    } catch { /* ignore */ }

    lastNotifiedSessionPath = newSessionPath;
    scheduleRender();
  }

  const sessionPollInterval = setInterval(() => {
    try {
      const sessions = activeProvider.findAllSessions(workspacePath);
      if (sessions.length === 0) return;
      const latest = sessions[0];
      if (latest !== lastNotifiedSessionPath) {
        if (!isPinned) {
          // Auto-switch
          switchToSession(latest);
        } else {
          // Store as pending
          pendingSessionPath = latest;
          scheduleRender();
        }
        lastNotifiedSessionPath = latest;
      }
    } catch { /* ignore */ }
  }, 10_000);

  // ── Render with Ink ──
  const { render } = await import('ink');

  const instance = render(
    React.createElement(Dashboard, {
      panels,
      metrics: state.getMetrics(),
      staticData,
      isPinned,
      pendingSessionPath,
      onSessionSwitch: switchToSession,
      onTogglePin: () => { isPinned = !isPinned; scheduleRender(); },
    }),
  );

  // Re-render bridge: throttled rerender with new props
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      instance.rerender(
        React.createElement(Dashboard, {
          panels,
          metrics: state.getMetrics(),
          staticData,
          isPinned,
          pendingSessionPath,
          onSessionSwitch: switchToSession,
          onTogglePin: () => { isPinned = !isPinned; scheduleRender(); },
        }),
      );
    }, 100);
  }

  // Quota updates trigger rerender
  quotaService.onUpdate((quota) => {
    state.setQuota(quota);
    scheduleRender();
  });

  // Cleanup handler
  let stopped = false;
  function cleanup() {
    if (stopped) return;
    stopped = true;
    try { clearInterval(sessionPollInterval); } catch { /* ignore */ }
    try { quotaService.stop(); } catch { /* ignore */ }
    try { watcher?.stop(); } catch { /* ignore */ }
    try { activeProvider.dispose(); } catch { /* ignore */ }
    for (const panel of panels) {
      panel.dispose?.();
    }
  }

  // Safety net: ensure mouse tracking is disabled even on unclean exit
  process.on('exit', disableMouse);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Create watcher
  let watcher: ReturnType<typeof createWatcher>['watcher'] | null = null;

  try {
    const result = createWatcher({
      provider: activeProvider,
      workspacePath,
      sessionId,
      callbacks: {
        onEvent: (event: FollowEvent) => {
          if (stopped) return;
          state.processEvent(event);
          scheduleRender();
        },
        onError: (_err: Error) => {
          // Errors are non-fatal for the dashboard
        },
      },
    });
    watcher = result.watcher;
  } catch {
    // No active session — still show dashboard with static data
  }

  // Start quota polling
  quotaService.start();

  // Initial render
  scheduleRender();

  // Start the watcher
  if (watcher) {
    watcher.start(replay);
  }

  // Wait for exit
  await instance.waitUntilExit();
  cleanup();
  process.exit(0);
}
