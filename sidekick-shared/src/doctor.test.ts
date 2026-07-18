import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
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
