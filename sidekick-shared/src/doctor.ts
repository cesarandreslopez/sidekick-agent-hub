import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getActiveAccountStatus, type ActiveAccountStatus } from './accountStatus';
import { resolveProjectIdentity, type ProjectIdentity } from './paths';
import {
  discoverSessionDirectory,
  encodeWorkspacePath,
  findSubdirectorySessionDirs,
  getMostRecentlyActiveSessionDir,
  getSessionDirectory,
} from './parsers/sessionPathResolver';
import { fetchOpenAIStatus, fetchProviderStatus, type ProviderStatusState } from './providerStatus';
import { getOpenCodeDataDir } from './providers/openCode';
import { createSessionProviders } from './providers/factory';
import { detectProvider } from './providers/detect';
import type { ProviderId } from './providers/types';
import { OpenCodeDatabase, type OpenCodeDbRuntimeStatus } from './providers/openCodeDatabase';

export type HealthCheckStatus = 'ok' | 'warning' | 'error' | 'info';

export interface HealthCheck {
  id:
    | 'project_slug'
    | 'session_discovery'
    | 'opencode_sqlite'
    | 'accounts'
    | 'provider_api'
    | 'deprecated_settings';
  status: HealthCheckStatus;
  title: string;
  message: string;
  repair?: string;
}

export interface DeprecatedSetting {
  key: string;
  replacement?: string;
}

export interface SessionDiagnostics {
  workspacePath: string;
  encodedPath: string;
  expectedSessionDir: string;
  expectedDirExists: boolean;
  discoveredSessionDir: string | null;
  existingProjectDirs: string[];
  similarDirs: string[];
  platform: string;
  subdirectoryMatches: string[];
  selectedSubdirectoryMatch: string | null;
}

export interface HealthReport {
  schemaVersion: 1;
  generatedAt: string;
  project: ProjectIdentity;
  status: 'healthy' | 'attention' | 'unhealthy';
  checks: HealthCheck[];
  accounts: ActiveAccountStatus;
  openCode: OpenCodeDbRuntimeStatus;
  providerStatus: { claude: ProviderStatusState; openai: ProviderStatusState };
  /** Legacy Claude Code path diagnostics, retained for compatibility. */
  sessions: SessionDiagnostics;
  sessionProvider?: ProviderId;
}

export interface DoctorOptions {
  cwd?: string;
  /** Session provider to diagnose; defaults to auto-detection. */
  provider?: ProviderId | 'auto';
  deprecatedSettings?: DeprecatedSetting[];
  openCodeStatus?: OpenCodeDbRuntimeStatus;
  fetchStatuses?: () => Promise<{ claude: ProviderStatusState; openai: ProviderStatusState }>;
}

/** Collects the Claude Code path-resolution detail used by both host surfaces. */
export function getSessionDiagnostics(workspacePath: string): SessionDiagnostics {
  const encodedPath = encodeWorkspacePath(workspacePath);
  const expectedSessionDir = getSessionDirectory(workspacePath);
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let existingProjectDirs: string[] = [];
  let expectedDirExists = false;

  try {
    if (fs.existsSync(projectsDir)) {
      existingProjectDirs = fs
        .readdirSync(projectsDir)
        .filter((name) => {
          try {
            return fs.statSync(path.join(projectsDir, name)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort();
    }
    expectedDirExists = fs.existsSync(expectedSessionDir);
  } catch {
    // Diagnostics remain useful even if a directory cannot be read.
  }

  const discoveredSessionDir = discoverSessionDirectory(workspacePath);
  const workspaceBasename = path.basename(workspacePath).toLowerCase();
  const similarDirs = existingProjectDirs.filter((directory) => {
    const lower = directory.toLowerCase();
    return (
      lower.includes(workspaceBasename) || workspaceBasename.includes(lower.split('-').pop() || '')
    );
  });
  const subdirectoryMatches = findSubdirectorySessionDirs(workspacePath);

  return {
    workspacePath,
    encodedPath,
    expectedSessionDir,
    expectedDirExists,
    discoveredSessionDir,
    existingProjectDirs,
    similarDirs,
    platform: process.platform,
    subdirectoryMatches,
    selectedSubdirectoryMatch:
      subdirectoryMatches.length > 0 ? getMostRecentlyActiveSessionDir(subdirectoryMatches) : null,
  };
}

function statusUnavailable(): ProviderStatusState {
  return {
    indicator: 'none',
    description: 'Status unavailable',
    affectedComponents: [],
    activeIncident: null,
    updatedAt: new Date().toISOString(),
  };
}

async function checkSessionProvider(
  providerId: ProviderId,
  workspacePath: string,
): Promise<HealthCheck> {
  const { providers } = createSessionProviders({ providerIds: [providerId] });
  const provider = providers[0];
  const title = `Session discovery (${provider?.displayName ?? providerId})`;
  try {
    if (!provider) throw new Error(`${providerId} could not be initialized.`);
    const sessions = provider.listSessionFilesAsync
      ? await provider.listSessionFilesAsync(workspacePath)
      : provider.findAllSessions(workspacePath);
    if (sessions.length > 0) {
      return {
        id: 'session_discovery',
        status: 'ok',
        title,
        message: `Found ${sessions.length} ${provider.displayName} session${sessions.length === 1 ? '' : 's'} for ${workspacePath}.`,
      };
    }
    const operation = provider.getLastOperationStatus?.();
    const runtime = provider.getRuntimeStatus?.();
    const issue =
      operation && !operation.usable
        ? operation.runtimeStatus
        : runtime && !runtime.available
          ? runtime
          : undefined;
    return {
      id: 'session_discovery',
      status: 'warning',
      title,
      message: issue?.message ?? `No ${provider.displayName} sessions found for ${workspacePath}.`,
      repair:
        issue?.kind === 'sqlite_missing'
          ? 'Install sqlite3 and ensure it is on PATH, then rerun sidekick doctor.'
          : `Start ${provider.displayName} in this project, or inspect ${provider.getSessionDirectory(workspacePath)}.`,
    };
  } catch (error) {
    return {
      id: 'session_discovery',
      status: 'warning',
      title,
      message: error instanceof Error ? error.message : String(error),
      repair: `Check ${providerId} session storage permissions and rerun sidekick doctor.`,
    };
  } finally {
    for (const candidate of providers) candidate.dispose();
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<HealthReport> {
  const project = resolveProjectIdentity(options.cwd);
  const sessions = getSessionDiagnostics(project.cwd);
  const accounts = getActiveAccountStatus(undefined, { selfHeal: false });
  const sessionProvider =
    options.provider && options.provider !== 'auto' ? options.provider : detectProvider();
  let openCode = options.openCodeStatus;
  if (!openCode) {
    const database = new OpenCodeDatabase(getOpenCodeDataDir());
    database.open();
    openCode = database.getRuntimeStatus();
    database.close();
  }
  const providerStatus = await (
    options.fetchStatuses ??
    (async () => {
      const [claude, openai] = await Promise.all([fetchProviderStatus(), fetchOpenAIStatus()]);
      return { claude, openai };
    })
  )().catch(() => ({ claude: statusUnavailable(), openai: statusUnavailable() }));

  const checks: HealthCheck[] = [];
  checks.push(
    project.hasLegacyMismatch
      ? {
          id: 'project_slug',
          status: 'warning',
          title: 'Project path resolves to a different slug',
          message: `Legacy ${project.legacySlug}; canonical ${project.canonicalSlug}.`,
          repair: `Open the resolved path (${project.resolvedCwd}) and merge any legacy project stores into the canonical slug. Sidekick readers keep the legacy fallback.`,
        }
      : {
          id: 'project_slug',
          status: 'ok',
          title: 'Project identity',
          message: `Canonical slug: ${project.canonicalSlug}`,
        },
  );
  checks.push(await checkSessionProvider(sessionProvider, project.resolvedCwd));

  const openCodeCheck: HealthCheck = openCode.available
    ? {
        id: 'opencode_sqlite',
        status: 'ok',
        title: 'OpenCode database',
        message: 'OpenCode database and sqlite3 are available.',
      }
    : openCode.kind === 'db_missing'
      ? {
          id: 'opencode_sqlite',
          status: 'info',
          title: 'OpenCode database',
          message: 'No OpenCode database was found; this is expected if OpenCode is not used.',
        }
      : {
          id: 'opencode_sqlite',
          status: 'warning',
          title: 'OpenCode database',
          message: openCode.message ?? `OpenCode database unavailable (${openCode.kind}).`,
          repair:
            openCode.kind === 'sqlite_missing'
              ? 'Install sqlite3 and ensure the sqlite3 executable is on PATH, then rerun sidekick doctor.'
              : 'Make sqlite3 executable and verify the OpenCode database is readable.',
        };
  if (sessionProvider !== 'opencode' && openCodeCheck.status === 'warning') {
    openCodeCheck.status = 'info';
    openCodeCheck.message += ' This does not affect the selected session provider.';
  }
  checks.push(openCodeCheck);

  checks.push({
    id: 'accounts',
    status: accounts.ok ? 'ok' : 'info',
    title: 'Accounts and credentials',
    message: accounts.ok
      ? `Detected ${[accounts.claude.present && 'Claude', accounts.codex.present && 'Codex'].filter(Boolean).join(' and ')} credentials.`
      : (accounts.error ?? 'No Claude or Codex credentials were detected.'),
    ...(!accounts.ok
      ? {
          repair:
            'Sign in with claude or codex to refresh account quota. Existing sessions can be monitored without saved credentials.',
        }
      : {}),
  });

  const unavailableProviders = Object.entries(providerStatus)
    .filter(([, status]) => status.description === 'Status unavailable')
    .map(([name]) => name);
  const degradedProviders = Object.entries(providerStatus)
    .filter(([, status]) => status.indicator !== 'none')
    .map(([name]) => name);
  checks.push({
    id: 'provider_api',
    status: degradedProviders.includes(
      sessionProvider === 'codex' ? 'openai' : sessionProvider === 'claude-code' ? 'claude' : '',
    )
      ? 'warning'
      : degradedProviders.length > 0 || unavailableProviders.length > 0
        ? 'info'
        : 'ok',
    title: 'Provider API status',
    message:
      degradedProviders.length > 0
        ? `Provider incidents reported for: ${degradedProviders.join(', ')}.`
        : unavailableProviders.length > 0
          ? `Status pages unavailable for: ${unavailableProviders.join(', ')}.`
          : 'Claude and OpenAI status pages report normal operation.',
  });

  const deprecatedSettings = options.deprecatedSettings ?? [];
  checks.push({
    id: 'deprecated_settings',
    status: deprecatedSettings.length > 0 ? 'warning' : 'ok',
    title: 'Deprecated settings',
    message:
      deprecatedSettings.length > 0
        ? deprecatedSettings
            .map(
              (setting) =>
                `${setting.key}${setting.replacement ? ` → ${setting.replacement}` : ''}`,
            )
            .join(', ')
        : 'No deprecated Sidekick settings detected.',
    ...(deprecatedSettings.length > 0
      ? {
          repair:
            'Move each configured value to its replacement and remove the deprecated setting.',
        }
      : {}),
  });

  const status = checks.some((check) => check.status === 'error')
    ? 'unhealthy'
    : checks.some((check) => check.status === 'warning')
      ? 'attention'
      : 'healthy';
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project,
    status,
    checks,
    accounts,
    openCode,
    providerStatus,
    sessions,
    sessionProvider,
  };
}

export function formatHealthReport(report: HealthReport): string {
  const icon: Record<HealthCheckStatus, string> = { ok: '✓', warning: '!', error: '✕', info: '·' };
  const lines = [
    `Sidekick Doctor — ${report.status}`,
    `Project: ${report.project.resolvedCwd}`,
    '',
  ];
  for (const check of report.checks) {
    lines.push(`${icon[check.status]} ${check.title}: ${check.message}`);
    if (check.repair) lines.push(`  Repair: ${check.repair}`);
  }
  return lines.join('\n');
}
