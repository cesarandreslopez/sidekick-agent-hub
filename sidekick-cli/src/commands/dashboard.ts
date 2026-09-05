/**
 * `sidekick dashboard` — Full-screen TUI dashboard with live session data.
 * Uses Ink (React for the terminal) for rendering.
 */

import React from 'react';
import * as path from 'path';
import * as os from 'os';
import type { Command } from 'commander';
import * as fs from 'fs';
import {
  createWatcher,
  getAllDetectedProviders,
  generateHtmlReport,
  readSessionReportInputs,
  openInBrowser,
  readPlans,
  writePlans,
  resolveProjectIdentity,
  DEFAULT_QUOTA_THRESHOLDS,
  describeQuotaThresholdAlert,
  evaluateQuotaThresholds,
  BILLING_BLOCK_DURATION_MS,
  ObservedSessionCollector,
  observedSessionSourceFromProvider,
  collectUsageEvents,
  computeBillingBlocks,
  findActiveBillingBlock,
  billingBlockToStateFile,
  getActiveAccountStatus,
  quotaToStateFile,
  writeStateFile,
} from 'sidekick-shared';
import type {
  FollowEvent,
  PersistedPlan,
  PersistedPlanStep,
  ProviderId,
  SessionProviderBase,
} from 'sidekick-shared';
import { ClaudeCodeProvider, OpenCodeProvider, CodexProvider } from 'sidekick-shared';
import { resolveProvider } from '../cli';
import { DashboardState } from '../dashboard/DashboardState';
import type { DashboardMetrics } from '../dashboard/DashboardState';
import { loadStaticData } from '../dashboard/StaticDataLoader';
import type { StaticData } from '../dashboard/StaticDataLoader';
import { QuotaService } from '../dashboard/QuotaService';
import { ProviderStatusService } from '../dashboard/ProviderStatusService';
import { scopeDashboardProviderStatuses } from '../dashboard/providerStatusScope';
import type { DashboardProviderId } from '../dashboard/providerStatusScope';
import { UpdateCheckService } from '../dashboard/UpdateCheckService';
import { SessionsPanel } from '../dashboard/panels/SessionsPanel';
import { TasksPanel } from '../dashboard/panels/TasksPanel';
import { KanbanPanel } from '../dashboard/panels/KanbanPanel';
import { NotesPanel } from '../dashboard/panels/NotesPanel';
import { DecisionsPanel } from '../dashboard/panels/DecisionsPanel';
import { PlansPanel } from '../dashboard/panels/PlansPanel';
import { EventStreamPanel } from '../dashboard/panels/EventStreamPanel';
import { ChartsPanel } from '../dashboard/panels/ChartsPanel';
import type { SidePanel } from '../dashboard/panels/types';
import { showSessionPicker } from '../dashboard/ink/SessionPickerInk';
import { Dashboard } from '../dashboard/ink/Dashboard';
import { disableMouse } from '../dashboard/ink/mouse';
import { checkInteractivePreflight, currentTerminalCapabilities } from './interactivePreflight';
import { readDashboardConfig, updateDashboardConfig } from '../utils/cliConfig';
import { staticDataFingerprint } from '../dashboard/staticDataFingerprint';
import { initialDataStatus, type DataStatus } from '../dashboard/ink/dataStatus';
import type { DashboardNotice } from '../dashboard/ink/notice';
import type { QuotaAlertMemory } from 'sidekick-shared';
import type { PlanInfo, PlanStep } from '../dashboard/DashboardState';
import { createDashboardSignalHandler, selectSessionProvider } from './dashboardLifecycle';

function createProviderById(id: ProviderId) {
  switch (id) {
    case 'opencode':
      return new OpenCodeProvider();
    case 'codex':
      return new CodexProvider();
    case 'claude-code':
    default:
      return new ClaudeCodeProvider();
  }
}

export function getProviderRuntimeIssue(
  provider: Pick<SessionProviderBase, 'id' | 'displayName' | 'getRuntimeStatus'>,
): string | null {
  if (provider.id !== 'opencode') {
    return null;
  }

  const status = provider.getRuntimeStatus?.();
  if (!status || status.available || status.kind === 'db_missing') {
    return null;
  }
  const detail = status.message ? ` ${status.message}` : '';
  const recommendation =
    status.kind === 'sqlite_missing'
      ? ' Recommendation: install `sqlite3`, ensure it is on PATH for the current shell, then retry.'
      : status.kind === 'sqlite_blocked'
        ? ' Recommendation: ensure `sqlite3` is executable in the same environment as this shell, then retry.'
        : ' Recommendation: verify `sqlite3` can read `opencode.db` in the current environment, then retry.';
  return `${provider.displayName} session database is unavailable.${detail}${recommendation}`;
}

export function inferPlanStatus(
  plan: PlanInfo,
): 'in_progress' | 'completed' | 'failed' | 'abandoned' {
  if (plan.steps.some((step) => step.status === 'failed')) return 'failed';
  if (plan.steps.some((step) => step.status === 'pending' || step.status === 'in_progress')) {
    return 'in_progress';
  }
  if (plan.steps.some((step) => step.status === 'completed')) return 'completed';
  return 'abandoned';
}

function toPersistedStep(step: PlanStep): PersistedPlanStep {
  return {
    id: step.id,
    description: step.description,
    status: step.status as PersistedPlanStep['status'],
    phase: step.phase,
    complexity: step.complexity,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    durationMs: step.durationMs,
    tokensUsed: step.tokensUsed,
    toolCalls: step.toolCalls,
    errorMessage: step.errorMessage,
    costUsd: step.costUsd,
  };
}

export async function persistPlan(state: DashboardState, workspacePath: string): Promise<void> {
  const metrics = state.getMetrics();
  const plan = metrics.plan;
  const sessionId = metrics.sessionId;
  if (!plan || !sessionId || (plan.steps.length === 0 && !plan.rawMarkdown)) return;

  const project = resolveProjectIdentity(workspacePath);
  const existing = await readPlans(project.canonicalSlug);
  const steps = plan.steps.map(toPersistedStep);
  const completed = steps.filter((step) => step.status === 'completed').length;
  const record: PersistedPlan = {
    id: `${sessionId}:${plan.title}`,
    projectSlug: project.canonicalSlug,
    sessionId,
    title: plan.title || 'Plan',
    source: plan.source ?? 'claude-code',
    createdAt: plan.enteredAt ?? new Date().toISOString(),
    completedAt: plan.exitedAt,
    status: inferPlanStatus(plan),
    steps,
    completionRate: steps.length > 0 ? completed / steps.length : 0,
    totalDurationMs: plan.totalDurationMs,
    totalTokensUsed: steps.reduce((sum, step) => sum + (step.tokensUsed ?? 0), 0) || undefined,
    totalToolCalls: steps.reduce((sum, step) => sum + (step.toolCalls ?? 0), 0) || undefined,
    totalCostUsd: steps.reduce((sum, step) => sum + (step.costUsd ?? 0), 0) || undefined,
    rawMarkdown: plan.rawMarkdown,
  };
  const withoutCurrent = existing.filter(
    (item) => !(item.sessionId === sessionId && item.title === record.title),
  );
  await writePlans(project.canonicalSlug, [record, ...withoutCurrent]);
}

/** All-zero project data, used before the first load and after a failed one. */
function emptyStaticData(): StaticData {
  return {
    sessions: [],
    tasks: [],
    decisions: [],
    notes: [],
    plans: [],
    totalTokens: 0,
    totalCost: 0,
    totalSessions: 0,
  };
}

export async function dashboardAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  // Checked before anything is constructed, so a piped invocation allocates
  // nothing and has nothing to tear down. Without this, Ink renders its
  // "Raw mode is not supported" panel into the middle of a partial frame and
  // still exits 0, so callers read the failure as success.
  const preflight = checkInteractivePreflight(
    currentTerminalCapabilities(),
    'dashboard',
    'sidekick dump --format text   or   sidekick today',
  );
  if (preflight) {
    process.stderr.write(preflight.message);
    process.exitCode = preflight.exitCode;
    return;
  }

  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const provider = resolveProvider(globalOpts);
  const workspacePath = globalOpts.project || process.cwd();

  // ── Session picker (multi-provider) ──
  let sessionId: string | undefined = opts.session;
  let replay = !!opts.replay;
  let activeProvider = provider;
  const providerIssue = getProviderRuntimeIssue(provider);

  // Detect additional providers for the session picker
  const detectedIds = getAllDetectedProviders();
  const additionalProviders = detectedIds
    .filter((id: ProviderId) => id !== provider.id)
    .map((id: ProviderId) => createProviderById(id));

  if (!sessionId) {
    const sessions = providerIssue ? [] : provider.findAllSessions(workspacePath);
    const healthyAdditionalProviders = additionalProviders.filter(
      (p) => !getProviderRuntimeIssue(p),
    );
    const hasAnySessions =
      sessions.length > 0 ||
      healthyAdditionalProviders.some((p) => p.findAllSessions(workspacePath).length > 0);
    if (hasAnySessions) {
      try {
        const pickerProvider = providerIssue ? healthyAdditionalProviders[0] || provider : provider;
        const pickerAdditionalProviders = providerIssue
          ? healthyAdditionalProviders.slice(1)
          : healthyAdditionalProviders;
        const result = await showSessionPicker(
          pickerProvider,
          workspacePath,
          pickerAdditionalProviders,
        );
        if (result.sessionPath) {
          sessionId = path.basename(result.sessionPath, path.extname(result.sessionPath));
          replay = true;
          // Switch to the provider that owns the selected session
          if (result.providerId && result.providerId !== provider.id) {
            activeProvider = selectSessionProvider(
              provider,
              additionalProviders,
              result.providerId,
              createProviderById,
            );
          }
        }
      } catch {
        // User quit the picker
        for (const p of additionalProviders) p.dispose();
        process.exit(0);
      }
    } else if (providerIssue) {
      for (const p of additionalProviders) p.dispose();
      console.error(providerIssue);
      process.exitCode = 1;
      return;
    }
  }

  // Dispose additional providers we won't use
  for (const p of additionalProviders) {
    if (p !== activeProvider) p.dispose();
  }

  const activeProviderIssue = getProviderRuntimeIssue(activeProvider);
  if (activeProviderIssue) {
    console.error(activeProviderIssue);
    process.exitCode = 1;
    return;
  }

  // Set once the Ink instance exists; scheduleRender is a no-op before that,
  // since the initial load runs ahead of the first render.
  let renderReady = false;
  let stopped = false;

  // ── Persisted project data ──
  // Loaded once at startup used to be the whole story, so tasks, notes,
  // decisions, and plans written by the VS Code extension or another terminal
  // never appeared until the dashboard was restarted.
  let staticData: StaticData = emptyStaticData();
  let staticFingerprint = '';
  let refreshInFlight = false;
  const dataStatus: DataStatus = initialDataStatus();

  let noticeSeq = 0;
  let notice: DashboardNotice | null = null;
  function pushNotice(message: string, severity: 'error' | 'warning' | 'info'): void {
    notice = { id: ++noticeSeq, message, severity };
    scheduleRender();
  }

  async function refreshStaticData(trigger: 'initial' | 'manual' | 'auto'): Promise<void> {
    if (refreshInFlight || stopped) return;
    refreshInFlight = true;
    dataStatus.refreshing = true;
    if (trigger !== 'auto') scheduleRender();
    try {
      const next = await loadStaticData(workspacePath);
      const nextFingerprint = staticDataFingerprint(next);
      dataStatus.error = null;
      dataStatus.loadedAt = Date.now();
      if (nextFingerprint !== staticFingerprint) {
        staticFingerprint = nextFingerprint;
        // New object identity only when the content actually moved, so a quiet
        // project costs a few JSON reads and no re-render at all.
        staticData = next;
        if (trigger === 'manual') pushNotice('Project data refreshed', 'info');
      } else if (trigger === 'manual') {
        pushNotice('Project data is up to date', 'info');
      }
    } catch (err) {
      dataStatus.error = err instanceof Error ? err.message : String(err);
      // Background polls stay silent; they would otherwise nag about a
      // condition the user has already been told about.
      if (trigger !== 'auto') {
        pushNotice(`Could not load project data: ${dataStatus.error}`, 'error');
      }
    } finally {
      refreshInFlight = false;
      dataStatus.refreshing = false;
      scheduleRender();
    }
  }

  // A malformed session file fires onError per line, so an unthrottled toast
  // would be a storm. The status badge still reflects the latest error.
  let lastWatcherErrorAt = 0;
  const WATCHER_ERROR_TOAST_MS = 60_000;
  function reportWatcherError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    dataStatus.watcherError = message;
    dataStatus.watcherErrorAt = now;
    if (now - lastWatcherErrorAt > WATCHER_ERROR_TOAST_MS) {
      lastWatcherErrorAt = now;
      pushNotice(`Session read error: ${message}`, 'error');
    }
    scheduleRender();
  }

  await refreshStaticData('initial');
  if (dataStatus.error) {
    // Non-fatal: open with the zeroed fallback, but say so rather than looking
    // like an empty project.
    pushNotice(`Project data unavailable: ${dataStatus.error}`, 'error');
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
    new EventStreamPanel(),
    new ChartsPanel(),
  ];

  // Wire up narrative completion callback to trigger re-render
  sessionsPanel.onNarrativeComplete = () => scheduleRender();

  // Subscription quota polling
  const quotaService = new QuotaService();

  // Provider status polling, scoped to the page that matters for this provider
  const providerStatusService = new ProviderStatusService(activeProvider.id as DashboardProviderId);

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
      try {
        sourceSize = fs.statSync(sessionPath).size;
      } catch {
        /* ignore */
      }
      state.persistSnapshot(watcher.getPosition(), sourceSize);
    }

    // Stop current watcher
    try {
      watcher?.stop();
    } catch {
      /* ignore */
    }

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

            if (event.type === 'system' && event.summary === 'Session ended') {
              persistPlan(state, workspacePath).catch(() => {});
            }

            // Periodically save snapshot
            const now = Date.now();
            if (now - lastSnapshotTime > SNAPSHOT_INTERVAL_MS && watcher?.getPosition) {
              lastSnapshotTime = now;
              let ss = 0;
              try {
                if (sessionPath) ss = fs.statSync(sessionPath).size;
              } catch {
                /* ignore */
              }
              state.persistSnapshot(watcher.getPosition(), ss);
            }

            scheduleRender();
          },
          onError: (err: Error) => reportWatcherError(err),
        },
      });
      watcher = result.watcher;
      sessionPath = result.sessionPath;

      // Try snapshot restore
      let switchRestored = false;
      if (watcher.seekTo) {
        let sourceSize = 0;
        try {
          sourceSize = fs.statSync(sessionPath).size;
        } catch {
          /* DB-backed */
        }
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
        try {
          sourceSize = fs.statSync(sessionPath).size;
        } catch {
          /* ignore */
        }
        state.persistSnapshot(watcher.getPosition(), sourceSize);
        lastSnapshotTime = Date.now();
      }
    } catch {
      /* ignore */
    }

    lastNotifiedSessionPath = newSessionPath;
    scheduleRender();
  }

  // Auto-refresh persisted project data. The fingerprint gate means an
  // unchanged project keeps the previous object identity and schedules no
  // render at all, so this costs a handful of JSON reads per tick.
  const STATIC_REFRESH_MS = 15_000;
  const SESSION_CHANGE_DEBOUNCE_MS = 2_000;
  const SESSION_CATCH_UP_POLL_MS = 30_000;
  const staticRefreshInterval = setInterval(() => {
    void refreshStaticData('auto');
  }, STATIC_REFRESH_MS);

  // New-session detection: subscribe to the provider's session root (fs.watch
  // with a 30 s catch-up poll) instead of walking the corpus every 10 s. The
  // followed session changes on every event, so only batches that touch some
  // other session trigger the (cheap, cached) newest-session lookup.
  function checkForNewerSession(): void {
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
    } catch {
      /* ignore */
    }
  }
  const sessionCollector = new ObservedSessionCollector({
    sources: [
      observedSessionSourceFromProvider(activeProvider, workspacePath, { observationOnly: true }),
    ],
  });
  const sessionSubscription = sessionCollector.subscribe(
    (batch) => {
      if (stopped) return;
      const touchesOtherSession = batch.changes.some(
        (change) => change.type !== 'removed' && change.reference.sourceKey !== sessionPath,
      );
      if (touchesOtherSession) checkForNewerSession();
    },
    { debounceMs: SESSION_CHANGE_DEBOUNCE_MS, pollIntervalMs: SESSION_CATCH_UP_POLL_MS },
  );

  // ── Render with Ink ──
  const { render } = await import('ink');

  // Mouse capture: --no-mouse flag > persisted preference > enabled.
  // The flag is per-run and never persisted; only the interactive 'M'
  // toggle writes the preference back.
  const mouseInitiallyEnabled =
    opts.mouse === false ? false : (readDashboardConfig().mouseEnabled ?? true);
  const persistMouseSetting = (enabled: boolean) => {
    try {
      updateDashboardConfig({ mouseEnabled: enabled });
    } catch {
      // Persistence is best-effort (read-only HOME, CI); the in-session
      // toggle must keep working regardless.
    }
  };

  const generateReport = () => {
    if (!sessionPath) return;
    // One read of the session feeds both the metrics and the transcript.
    const { metrics, transcript } = readSessionReportInputs(activeProvider, sessionPath);
    const html = generateHtmlReport(metrics, transcript, {
      sessionFileName: path.basename(sessionPath),
      includeThinking: true,
      includeToolDetail: true,
      theme: 'dark',
    });
    const outFile = path.join(os.tmpdir(), `sidekick-report-${Date.now()}.html`);
    fs.writeFileSync(outFile, html, 'utf-8');
    openInBrowser(outFile);
  };

  // The Dashboard memoises on the metrics identity, so the scoped copy is
  // rebuilt only when the state's own metrics object changes.
  let lastRawMetrics: DashboardMetrics | null = null;
  let lastScopedMetrics: DashboardMetrics | null = null;
  function scopedMetrics(): DashboardMetrics {
    const metrics = state.getMetrics();
    if (metrics !== lastRawMetrics || !lastScopedMetrics) {
      lastRawMetrics = metrics;
      lastScopedMetrics = {
        ...metrics,
        ...scopeDashboardProviderStatuses(
          activeProvider.id as DashboardProviderId,
          metrics.providerStatus,
          metrics.openaiStatus,
        ),
      };
    }
    return lastScopedMetrics;
  }

  const instance = render(
    React.createElement(Dashboard, {
      panels,
      metrics: scopedMetrics(),
      staticData,
      isPinned,
      pendingSessionPath,
      onSessionSwitch: switchToSession,
      onTogglePin: () => {
        isPinned = !isPinned;
        scheduleRender();
      },
      onGenerateReport: generateReport,
      onRefresh: () => {
        void refreshStaticData('manual');
      },
      // Snapshot: the mutable status object must not leak into React props.
      dataStatus: { ...dataStatus },
      notice,
      mouseInitiallyEnabled,
      onMouseSettingChange: persistMouseSetting,
    }),
  );
  renderReady = true;

  // Re-render bridge: throttled rerender with new props
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRender() {
    if (!renderReady || renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      instance.rerender(
        React.createElement(Dashboard, {
          panels,
          metrics: scopedMetrics(),
          staticData,
          isPinned,
          pendingSessionPath,
          onSessionSwitch: switchToSession,
          onTogglePin: () => {
            isPinned = !isPinned;
            scheduleRender();
          },
          onGenerateReport: generateReport,
          onRefresh: () => {
            void refreshStaticData('manual');
          },
          dataStatus: { ...dataStatus },
          notice,
          mouseInitiallyEnabled,
          onMouseSettingChange: persistMouseSetting,
        }),
      );
    }, 100);
  }

  // Quota updates trigger rerender
  // Threshold crossings are announced once per reset window, through the same
  // shared evaluator the VS Code extension uses.
  let quotaAlertMemory: QuotaAlertMemory = {};
  quotaService.onUpdate((quota) => {
    state.setQuota(quota);
    writeDashboardState();
    const evaluated = evaluateQuotaThresholds(quota, DEFAULT_QUOTA_THRESHOLDS, quotaAlertMemory);
    quotaAlertMemory = evaluated.memory;
    for (const alert of evaluated.alerts) {
      pushNotice(
        describeQuotaThresholdAlert(alert),
        alert.severity === 'critical' ? 'error' : 'warning',
      );
    }
    scheduleRender();
  });

  // Public state.json for external tools (tmux, menu bars): written on the
  // billing-block tick and on quota updates, only when something changed.
  function writeDashboardState(): void {
    try {
      const metrics = state.getMetrics();
      const accounts = getActiveAccountStatus(undefined, { selfHeal: false });
      const providerId = activeProvider.id;
      const account =
        providerId === 'codex' && accounts.codex.present
          ? {
              providerId: 'codex' as const,
              id: accounts.codex.accountId ?? null,
              label: accounts.codex.label ?? null,
            }
          : accounts.claude.present
            ? {
                providerId: 'claude-code' as const,
                id: accounts.claude.accountId ?? null,
                label: accounts.claude.label ?? null,
              }
            : null;
      const quota = quotaToStateFile(metrics.quota);
      // File the sample under the provider that produced it; the dashboard's
      // quota only ever comes from the active provider, so an unstamped sample
      // is the active provider's.
      const quotaProviderId = metrics.quota?.providerId ?? providerId;
      const startedMs = metrics.sessionStartTime ? Date.parse(metrics.sessionStartTime) : NaN;
      writeStateFile({
        writer: 'cli-dashboard',
        account,
        quota: {
          claude: quotaProviderId === 'claude-code' ? quota : null,
          codex: quotaProviderId === 'codex' ? quota : null,
        },
        context: {
          usedPercentage: metrics.context.percent,
          contextWindowSize: metrics.context.limit || null,
          totalInputTokens:
            metrics.tokens.input + metrics.tokens.cacheRead + metrics.tokens.cacheWrite,
          totalOutputTokens: metrics.tokens.output,
        },
        session: {
          sessionId: metrics.sessionId ?? null,
          cwd: workspacePath,
          model: metrics.currentModel ?? null,
          costUsd: metrics.tokens.cost,
          durationMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : null,
          linesAdded: null,
          linesRemoved: null,
          promptCacheHitRatio: null,
        },
        billingBlock: billingBlockToStateFile(metrics.billingBlock),
      });
    } catch {
      // The state file is a convenience for other tools; never disturb the TUI.
    }
  }

  // Active billing block (local estimate from session logs), refreshed every
  // minute. The collector caches each session by fingerprint, so a tick that
  // finds nothing changed is a handful of small JSON reads.
  const BILLING_BLOCK_REFRESH_MS = 60_000;
  let billingBlockInFlight = false;
  async function refreshBillingBlock(): Promise<void> {
    if (billingBlockInFlight) return;
    billingBlockInFlight = true;
    try {
      const now = new Date();
      const collected = await collectUsageEvents({
        providers: [activeProvider],
        since: new Date(now.getTime() - 2 * BILLING_BLOCK_DURATION_MS),
        until: now,
      });
      state.setBillingBlock(
        findActiveBillingBlock(computeBillingBlocks(collected.events, { now })),
      );
      writeDashboardState();
      scheduleRender();
    } catch {
      // The block is an estimate; a failed refresh keeps the last one.
    } finally {
      billingBlockInFlight = false;
    }
  }
  void refreshBillingBlock();
  const billingBlockInterval = setInterval(
    () => void refreshBillingBlock(),
    BILLING_BLOCK_REFRESH_MS,
  );
  billingBlockInterval.unref?.();

  // Provider status updates trigger rerender
  providerStatusService.onUpdate((status) => {
    state.setProviderStatus(status);
    scheduleRender();
  });
  providerStatusService.onOpenAIUpdate((status) => {
    state.setOpenAIStatus(status);
    scheduleRender();
  });

  // Cleanup handler
  function cleanup() {
    if (stopped) return;
    stopped = true;
    persistPlan(state, workspacePath).catch(() => {});
    try {
      sessionSubscription.dispose();
      sessionCollector.dispose();
    } catch {
      /* ignore */
    }
    try {
      clearInterval(staticRefreshInterval);
    } catch {
      /* ignore */
    }
    try {
      clearInterval(billingBlockInterval);
    } catch {
      /* ignore */
    }
    try {
      quotaService.stop();
    } catch {
      /* ignore */
    }
    try {
      providerStatusService.stop();
    } catch {
      /* ignore */
    }
    try {
      watcher?.stop();
    } catch {
      /* ignore */
    }
    try {
      activeProvider.dispose();
    } catch {
      /* ignore */
    }
    for (const panel of panels) {
      panel.dispose?.();
    }
  }

  // Safety net: ensure mouse tracking is disabled even on unclean exit.
  // Wrapped because 'exit' passes the exit code as the first argument, which
  // disableMouse would otherwise take as its stream.
  process.on('exit', () => disableMouse());
  const onSignal = createDashboardSignalHandler(cleanup, () => instance.unmount());
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

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

          if (event.type === 'system' && event.summary === 'Session ended') {
            persistPlan(state, workspacePath).catch(() => {});
          }

          // Periodically save snapshot
          const now = Date.now();
          if (now - lastSnapshotTime > SNAPSHOT_INTERVAL_MS && watcher?.getPosition) {
            lastSnapshotTime = now;
            let sourceSize = 0;
            try {
              if (sessionPath) sourceSize = fs.statSync(sessionPath).size;
            } catch {
              /* DB-backed */
            }
            state.persistSnapshot(watcher.getPosition(), sourceSize);
          }

          scheduleRender();
        },
        onError: (err: Error) => reportWatcherError(err),
      },
    });
    watcher = result.watcher;
    sessionPath = result.sessionPath;
    if (!sessionId && sessionPath) {
      sessionId = path.basename(sessionPath, path.extname(sessionPath));
      state.setSessionId(sessionId);
    }

    // Try snapshot restore before starting the watcher
    if (sessionId && replay && watcher.seekTo) {
      let sourceSize = 0;
      try {
        sourceSize = fs.statSync(sessionPath).size;
      } catch {
        /* DB-backed */
      }
      const seekPosition = state.tryRestoreFromSnapshot(sessionId, activeProvider.id, sourceSize);
      if (seekPosition !== null) {
        watcher.seekTo(seekPosition);
        restoredFromSnapshot = true;
      }
    }
  } catch {
    // No active session — still show dashboard with static data
  }

  // Start quota polling + provider status polling + update check
  // Only poll Claude OAuth quota for claude-code; Codex quota arrives via event stream
  if (activeProvider.id === 'claude-code') {
    quotaService.start();
  }
  providerStatusService.start();
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
        try {
          sourceSize = fs.statSync(sessionPath).size;
        } catch {
          /* ignore */
        }
        state.persistSnapshot(watcher.getPosition(), sourceSize);
        lastSnapshotTime = Date.now();
      }
    } else {
      watcher.start(replay);
      // Save initial snapshot after full replay
      if (replay && watcher.getPosition && sessionPath) {
        let sourceSize = 0;
        try {
          sourceSize = fs.statSync(sessionPath).size;
        } catch {
          /* ignore */
        }
        state.persistSnapshot(watcher.getPosition(), sourceSize);
        lastSnapshotTime = Date.now();
      }
    }
  }

  // Wait for exit
  await instance.waitUntilExit();
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  cleanup();
  process.exit(0);
}
