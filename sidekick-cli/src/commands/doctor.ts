import type { Command } from 'commander';
import { formatHealthReport, runDoctor } from 'sidekick-shared';

export async function doctorAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const report = await runDoctor({
    cwd: (globalOpts.project as string | undefined) || process.cwd(),
  });
  process.stdout.write(
    globalOpts.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatHealthReport(report)}\n`,
  );
}
