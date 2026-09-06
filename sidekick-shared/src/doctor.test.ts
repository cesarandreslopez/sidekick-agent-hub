import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const providerState = vi.hoisted(() => ({
  detected: 'codex',
  sessions: ['/virtual/session'],
  runtime: { available: true, kind: 'available' } as {
    available: boolean;
    kind: string;
    message?: string;
  },
  requested: [] as string[],
}));
vi.mock('./providers/detect', () => ({ detectProvider: () => providerState.detected }));
vi.mock('./accountStatus', () => ({
  getActiveAccountStatus: () => ({
    ok: false,
    claude: { present: false },
    codex: { present: false },
  }),
}));
vi.mock('./providers/factory', () => ({
  createSessionProviders: ({ providerIds }: { providerIds: string[] }) => ({
    providers: providerIds.map((id) => {
      providerState.requested.push(id);
      return {
        id,
        displayName: { 'claude-code': 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode' }[id],
        listSessionFilesAsync: async () => providerState.sessions,
        getRuntimeStatus: () => providerState.runtime,
        getSessionDirectory: () => `/virtual/${id}`,
        dispose: vi.fn(),
      };
    }),
  }),
}));

beforeEach(() => {
  providerState.detected = 'codex';
  providerState.sessions = ['/virtual/session'];
  providerState.runtime = { available: true, kind: 'available' };
  providerState.requested = [];
});

import { formatHealthReport, runDoctor } from './doctor';
import type { ProviderStatusState } from './providerStatus';

const temporaryDirectories: string[] = [];
const healthyStatus: ProviderStatusState = {
  indicator: 'none',
  description: 'All Systems Operational',
  affectedComponents: [],
  activeIncident: null,
  updatedAt: '2026-07-18T00:00:00.000Z',
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe('runDoctor', () => {
  it.skipIf(process.platform === 'win32')(
    'names a symlink slug mismatch and its repair',
    async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-doctor-'));
      temporaryDirectories.push(directory);
      const realProject = path.join(directory, 'real-project');
      const linkedProject = path.join(directory, 'linked-project');
      await fs.promises.mkdir(realProject);
      await fs.promises.symlink(realProject, linkedProject, 'dir');

      const report = await runDoctor({
        cwd: linkedProject,
        openCodeStatus: { available: false, kind: 'db_missing' },
        fetchStatuses: async () => ({ claude: healthyStatus, openai: healthyStatus }),
      });
      const slug = report.checks.find((check) => check.id === 'project_slug');
      expect(slug).toMatchObject({ status: 'warning', title: expect.stringContaining('slug') });
      expect(slug?.message).toContain(report.project.legacySlug);
      expect(slug?.message).toContain(report.project.canonicalSlug);
      expect(slug?.repair).toContain(report.project.resolvedCwd);
    },
  );

  it('prints the actionable sqlite3 repair', async () => {
    const report = await runDoctor({
      provider: 'opencode',
      openCodeStatus: {
        available: false,
        kind: 'sqlite_missing',
        message: 'sqlite3 executable not found in PATH.',
      },
      fetchStatuses: async () => ({ claude: healthyStatus, openai: healthyStatus }),
    });
    const text = formatHealthReport(report);
    expect(text).toContain('sqlite3 executable not found in PATH.');
    expect(text).toContain('Install sqlite3');
  });
});

it.each(['codex', 'opencode', 'claude-code'] as const)(
  'diagnoses %s without requiring unused agents or account credentials',
  async (provider) => {
    const report = await runDoctor({
      provider,
      openCodeStatus: { available: false, kind: 'db_missing' },
      fetchStatuses: async () => ({ claude: healthyStatus, openai: healthyStatus }),
    });
    expect(providerState.requested).toEqual([provider]);
    expect(report.checks.find((check) => check.id === 'session_discovery')?.status).toBe('ok');
    expect(report.checks.find((check) => check.id === 'accounts')?.status).toBe('info');
    expect(report.status).toBe('healthy');
    expect(report.schemaVersion).toBe(1);
    expect(report.sessions).toHaveProperty('expectedSessionDir');
  },
);

it('auto-detects the provider and treats unrelated sqlite problems as informational', async () => {
  const report = await runDoctor({
    provider: 'auto',
    openCodeStatus: { available: false, kind: 'sqlite_missing' },
    fetchStatuses: async () => ({ claude: healthyStatus, openai: healthyStatus }),
  });
  expect(providerState.requested).toEqual(['codex']);
  expect(report.checks.find((check) => check.id === 'opencode_sqlite')?.status).toBe('info');
  expect(report.status).toBe('healthy');
});

it('names the selected provider when no sessions exist', async () => {
  providerState.sessions = [];
  const report = await runDoctor({
    provider: 'codex',
    openCodeStatus: { available: false, kind: 'db_missing' },
    fetchStatuses: async () => ({ claude: healthyStatus, openai: healthyStatus }),
  });
  const check = report.checks.find((check) => check.id === 'session_discovery');
  expect(check?.status).toBe('warning');
  expect(check?.message).toContain('No Codex CLI sessions');
  expect(check?.repair).toContain('Start Codex CLI');
  expect(check?.repair).not.toContain('Claude');
});
