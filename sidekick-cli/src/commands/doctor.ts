import type { Command } from 'commander';
import {
  formatHealthReport,
  getPricingCatalogInfo,
  runDoctor,
  type HealthReport,
  type ProviderId,
} from 'sidekick-shared';
import { pricingHealthCheck } from '../pricingBasis';

/**
 * Add the CLI's pricing check to a shared health report. The shared check ids
 * are a closed set; this one is CLI-owned, so it widens the id here, and a
 * warning lifts a healthy report to `attention` the way shared checks do.
 */
export function withPricingCheck(
  report: HealthReport,
  check: ReturnType<typeof pricingHealthCheck> = pricingHealthCheck(),
): HealthReport {
  const checks = [...report.checks, check as unknown as HealthReport['checks'][number]];
  const status =
    report.status === 'healthy' && check.status === 'warning' ? 'attention' : report.status;
  return { ...report, status, checks };
}

export async function doctorAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const report = withPricingCheck(
    await runDoctor({
      provider: globalOpts.provider as ProviderId | 'auto' | undefined,
      cwd: (globalOpts.project as string | undefined) || process.cwd(),
    }),
  );
  process.stdout.write(
    globalOpts.json
      ? `${JSON.stringify({ ...report, pricingCatalog: getPricingCatalogInfo() }, null, 2)}\n`
      : `${formatHealthReport(report)}\n`,
  );
}
