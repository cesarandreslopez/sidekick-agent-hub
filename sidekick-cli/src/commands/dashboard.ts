/**
 * `sidekick dashboard` — Full-screen TUI dashboard with live session data.
 * Uses Ink (React for the terminal) for rendering.
 */

import React from 'react';
import * as path from 'path';
import type { Command } from 'commander';
import * as fs from 'fs';
import { createWatcher, getAllDetectedProviders, readPlans, writePlans, getProjectSlug } from 'sidekick-shared';
import type { FollowEvent, ProviderId, PersistedPlan, PersistedPlanStep } from 'sidekick-shared';
import { ClaudeCodeProvider, OpenCodeProvider, CodexProvider } from 'sidekick-shared';
import { resolveProvider } from '../cli';
import { DashboardState } from '../dashboard/DashboardState';
import { loadStaticData } from '../dashboard/StaticDataLoader';
import type { StaticData } from '../dashboard/StaticDataLoader';
import { QuotaService } from '../dashboard/QuotaService';
import { UpdateCheckService } from '../dashboard/UpdateCheckService';
import { SessionsPanel } from '../dashboard/panels/SessionsPanel';
import { TasksPanel } from '../dashboard/panels/TasksPanel';
import { KanbanPanel } from '../dashboard/panels/KanbanPanel';
import { NotesPanel } from '../dashboard/panels/NotesPanel';
import { DecisionsPanel } from '../dashboard/panels/DecisionsPanel';
import { PlansPanel } from '../dashboard/panels/PlansPanel';
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

import type { PlanInfo, PlanStep } from '../dashboard/DashboardState';

function inferPlanStatus(plan: PlanInfo): 'in_progress' | 'completed' | 'failed' | 'abandoned' {
  const hasCompleted = plan.steps.some(s => s.status === 'completed');
  const hasFailed = plan.steps.some(s => s.status === 'failed');
  const hasPending = plan.steps.some(s => s.status === 'pending' || s.status === 'in_progress');
  if (hasFailed) return 'failed';
  if (!hasPending && hasCompleted) return 'completed';
  if (hasCompleted && hasPending) return 'in_progress';
  return 'abandoned';
}

function toPersistedStep(step: PlanStep): PersistedPlanStep {
  return {
    id: step.id,
    description: step.description,
    status: step.status as PersistedPlanStep['status'],
    phase: step.phase,
    complexity: step.complexity,
    durationMs: step.durationMs,
    tokensUsed: step.tokensUsed,
    toolCalls: step.toolCalls,
    errorMessage: step.errorMessage,
  };
}

async function persistPlan(state: DashboardState, workspacePath: string): Promise<void> {
  const metrics = state.getMetrics();
  if (!metrics.plan || metrics.plan.steps.length === 0) return;

  const slug = getProjectSlug(workspacePath);
  let existing: PersistedPlan[];
  try {
    existing = await readPlans(slug);
  } catch {
    existing = [];
  }

  const sessionId = metrics.sessionId || `unknown-${Date.now()}`;
  const persisted: PersistedPlan = {
    id: `cli-${Date.now()}`,
    projectSlug: slug,
    sessionId,
    title: metrics.plan.title,
    source: metrics.plan.source || 'claude-code',
    createdAt: new Date().toISOString(),
    status: inferPlanStatus(metrics.plan),
    steps: metrics.plan.steps.map(toPersistedStep),
    completionRate: metrics.plan.completionRate || 0,
    totalDurationMs: metrics.plan.totalDurationMs,
    rawMarkdown: metrics.plan.rawMarkdown,
  };

  // Upsert: avoid duplicating if same session
  const idx = existing.findIndex(p => p.sessionId === persisted.sessionId && p.title === persisted.title);
  if (idx >= 0) {
    existing[idx] = persisted;
  } else {
    existing.unshift(persisted);
  }

  try {
    await writePlans(slug, existing);
  } catch {
    // Non-fatal: don't crash dashboard on write failure
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
      sessions: [], tasks: [], decisions: [], notes: [], plans: [],
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
    new PlansPanel(),
  ];

  // Wire up narrative completion callback to trigger re-render
  sessionsPanel.onNarrativeComplete = () => scheduleRender();

  // Subscription quota polling
  const quotaService = new QuotaService();

  // One-shot update check
  const updateCheckService = new UpdateCheckService();
  updateCheckService.onResult((info) => {
    if (info) {
      state.setUpdateInfo(info);
      scheduleRender();
    }
  });

  // ── New session detection + auto-switch ──
  let lastNotifiedSessionPath: string | null = null;
  const currentSessions = activeProvider.findAllSessions(workspacePath);
  lastNotifiedSessionPath = currentSessions.length > 0 ? currentSessions[0] : null;
  let isPinned = false;
  let pendingSessionPath: string | null = null;

  function switchToSession(newSessionPath: string) {
    // Save snapshot for current session before switching
    if (watcher?.getPosition && sessionPath) {
      let sourceSize = 0;
      try { sourceSize = fs.statSync(sessionPath).size; } catch { /* ignore */ }
      state.persistSnapshot(watcher.getPosition(), sourceSize);
    }

    // Stop current watcher
    try { watcher?.stop(); } catch { /* ignore */ }

    // Persist any plan from current session before resetting
    persistPlan(state, workspacePath).catch(() => {});

    // Reset state
    state.reset();
    pendingSessionPath = null;

    // Create new watcher for the new session
    const newSessionId = path.basename(newSessionPath, path.extname(newSessionPath));
    state.setSessionId(newSessionId);
    try {
      const result = createWatcher({
        provider: activeProvider,
        workspacePath,
        sessionId: newSessionId,
        callbacks: {
          onEvent: (event: FollowEvent) => {
            if (stopped) return;
            state.processEvent(event);

            // Persist plan on session end
            if (event.type === 'system' && event.summary === 'Session ended') {
              persistPlan(state, workspacePath).catch(() => {});
            }

            // Periodically save snapshot
            const now = Date.now();
            if (now - lastSnapshotTime > SNAPSHOT_INTERVAL_MS && watcher?.getPosition) {
              lastSnapshotTime = now;
              let ss = 0;
              try { if (sessionPath) ss = fs.statSync(sessionPath).size; } catch { /* ignore */ }
              state.persistSnapshot(watcher.getPosition(), ss);
            }

            scheduleRender();
          },
          onError: (_err: Error) => { /* non-fatal */ },
        },
      });
      watcher = result.watcher;
      sessionPath = result.sessionPath;

      // Try snapshot restore
      let switchRestored = false;
      if (watcher.seekTo) {
        let sourceSize = 0;
        try { sourceSize = fs.statSync(sessionPath).size; } catch { /* DB-backed */ }
        const seekPos = state.tryRestoreFromSnapshot(newSessionId, activeProvider.id, sourceSize);
        if (seekPos !== null) {
          watcher.seekTo(seekPos);
          switchRestored = true;
        }
      }

      watcher.start(true); // replay from current position (snapshot or start)

      // Save snapshot after catching up
      if (!switchRestored && watcher.getPosition) {
        let sourceSize = 0;
        try { sourceSize = fs.statSync(sessionPath).size; } catch { /* ignore */ }
        state.persistSnapshot(watcher.getPosition(), sourceSize);
        lastSnapshotTime = Date.now();
      }
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
    // Persist any active plan before exiting
    persistPlan(state, workspacePath).catch(() => {});
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
  let sessionPath: string | undefined;
  let restoredFromSnapshot = false;

  // Set session ID for plan persistence
  if (sessionId) {
    state.setSessionId(sessionId);
  }

  // Snapshot-based throttled save (every 30s during live events)
  let lastSnapshotTime = 0;
  const SNAPSHOT_INTERVAL_MS = 30_000;

  try {
    const result = createWatcher({
      provider: activeProvider,
      workspacePath,
      sessionId,
      callbacks: {
        onEvent: (event: FollowEvent) => {
          if (stopped) return;
          state.processEvent(event);

          // Persist plan on session end
          if (event.type === 'system' && event.summary === 'Session ended') {
            persistPlan(state, workspacePath).catch(() => {});
          }

          // Periodically save snapshot
          const now = Date.now();
          if (now - lastSnapshotTime > SNAPSHOT_INTERVAL_MS && watcher?.getPosition) {
            lastSnapshotTime = now;
            let sourceSize = 0;
            try { if (sessionPath) sourceSize = fs.statSync(sessionPath).size; } catch { /* DB-backed */ }
            state.persistSnapshot(watcher.getPosition(), sourceSize);
          }

          scheduleRender();
        },
        onError: (_err: Error) => {
          // Errors are non-fatal for the dashboard
        },
      },
    });
    watcher = result.watcher;
    sessionPath = result.sessionPath;

    // Try snapshot restore before starting the watcher
    if (sessionId && replay && watcher.seekTo) {
      let sourceSize = 0;
      try { sourceSize = fs.statSync(sessionPath).size; } catch { /* DB-backed */ }
      const seekPosition = state.tryRestoreFromSnapshot(sessionId, activeProvider.id, sourceSize);
      if (seekPosition !== null) {
        watcher.seekTo(seekPosition);
        restoredFromSnapshot = true;
      }
    }
  } catch {
    // No active session — still show dashboard with static data
  }

  // Start quota polling + update check
  quotaService.start();
  updateCheckService.check();

  // Initial render
  scheduleRender();

  // Start the watcher
  if (watcher) {
    if (restoredFromSnapshot) {
      // Start with replay=true to pick up events after the snapshot position
      watcher.start(true);
      // Save updated snapshot after catching up
      if (watcher.getPosition && sessionPath) {
        let sourceSize = 0;
        try { sourceSize = fs.statSync(sessionPath).size; } catch { /* ignore */ }
        state.persistSnapshot(watcher.getPosition(), sourceSize);
        lastSnapshotTime = Date.now();
      }
    } else {
      watcher.start(replay);
      // Save initial snapshot after full replay
      if (replay && watcher.getPosition && sessionPath) {
        let sourceSize = 0;
        try { sourceSize = fs.statSync(sessionPath).size; } catch { /* ignore */ }
        state.persistSnapshot(watcher.getPosition(), sourceSize);
        lastSnapshotTime = Date.now();
      }
    }
  }

  // Wait for exit
  await instance.waitUntilExit();
  cleanup();
  process.exit(0);
}
