/**
 * Typed read/write access to ~/.config/sidekick/cli-config.json.
 * Extracted from commands/account.ts so the dashboard and other commands
 * persist preferences through one code path. Writes are atomic
 * (tmp + rename) with owner-only permissions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from 'sidekick-shared';
import type { AutoSwitchConfig, ModelPricing } from 'sidekick-shared';

/** Dashboard UI preferences persisted across runs. */
export interface DashboardCliConfig {
  mouseEnabled?: boolean;
}

/**
 * Custom per-model prices (USD per million tokens), registered with
 * `registerModelPricing` before any command prices usage. Keys are model ids;
 * an entry also answers the id's dated, region-prefixed, and Bedrock spellings
 * (matching goes through `canonicalModelId`). The two cache rates are optional
 * and default to the input rate.
 */
export interface PricingCliConfig {
  models?: Record<
    string,
    Pick<ModelPricing, 'inputCostPerMillion' | 'outputCostPerMillion'> &
      Partial<Pick<ModelPricing, 'cacheWriteCostPerMillion' | 'cacheReadCostPerMillion'>>
  >;
  /**
   * `false` (default): a configured price wins over the catalog, as negotiated
   * rates should. `true`: only fill gaps, never replacing an exact catalog or
   * built-in price.
   */
  onlyIfMissing?: boolean;
}

export interface CliConfig {
  accounts?: { autoSwitch?: AutoSwitchConfig; keepAlive?: boolean } & Record<string, unknown>;
  dashboard?: DashboardCliConfig;
  pricing?: PricingCliConfig;
  [key: string]: unknown;
}

/** The valid part of a `pricing` section, plus one warning per ignored part. */
export interface ParsedPricingConfig {
  entries: Record<string, ModelPricing>;
  onlyIfMissing: boolean;
  warnings: string[];
}

const REQUIRED_RATES = ['inputCostPerMillion', 'outputCostPerMillion'] as const;
const OPTIONAL_RATES = ['cacheWriteCostPerMillion', 'cacheReadCostPerMillion'] as const;
const RATE_KEYS = new Set<string>([...REQUIRED_RATES, ...OPTIONAL_RATES]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validate a `pricing` section. Never throws: anything malformed is skipped
 * with a warning naming it, and the rest still applies.
 */
export function parsePricingConfig(raw: unknown): ParsedPricingConfig {
  const result: ParsedPricingConfig = { entries: {}, onlyIfMissing: false, warnings: [] };
  if (raw === undefined || raw === null) return result;
  if (!isPlainObject(raw)) {
    result.warnings.push('cli-config.json "pricing" must be an object; ignored.');
    return result;
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'models' && key !== 'onlyIfMissing') {
      result.warnings.push(`cli-config.json pricing.${key} is not a known setting; ignored.`);
    }
  }
  if (raw.onlyIfMissing !== undefined) {
    if (typeof raw.onlyIfMissing === 'boolean') result.onlyIfMissing = raw.onlyIfMissing;
    else
      result.warnings.push(
        'cli-config.json pricing.onlyIfMissing must be true or false; using false.',
      );
  }
  if (raw.models === undefined) return result;
  if (!isPlainObject(raw.models)) {
    result.warnings.push('cli-config.json pricing.models must be an object of model ids; ignored.');
    return result;
  }
  for (const [rawId, value] of Object.entries(raw.models)) {
    const id = rawId.trim();
    const where = `cli-config.json pricing.models[${JSON.stringify(rawId)}]`;
    if (!id) {
      result.warnings.push(`${where}: the model id is empty; entry ignored.`);
      continue;
    }
    if (!isPlainObject(value)) {
      result.warnings.push(`${where}: expected an object of per-million rates; entry ignored.`);
      continue;
    }
    const invalid = [
      ...REQUIRED_RATES.filter((key) => !isRate(value[key])),
      ...OPTIONAL_RATES.filter((key) => value[key] !== undefined && !isRate(value[key])),
    ];
    if (invalid.length > 0) {
      result.warnings.push(
        `${where}: ${invalid.join(', ')} must be ${invalid.length === 1 ? 'a non-negative number' : 'non-negative numbers'}; entry ignored.`,
      );
      continue;
    }
    const unknown = Object.keys(value).filter((key) => !RATE_KEYS.has(key));
    if (unknown.length > 0) {
      result.warnings.push(`${where}: unknown field(s) ${unknown.join(', ')} ignored.`);
    }
    const input = value.inputCostPerMillion as number;
    result.entries[id] = {
      inputCostPerMillion: input,
      outputCostPerMillion: value.outputCostPerMillion as number,
      cacheWriteCostPerMillion: (value.cacheWriteCostPerMillion as number | undefined) ?? input,
      cacheReadCostPerMillion: (value.cacheReadCostPerMillion as number | undefined) ?? input,
    };
  }
  return result;
}

/** The `pricing` section of cli-config.json, validated. */
export function readPricingConfig(): ParsedPricingConfig {
  return parsePricingConfig(readCliConfig().pricing);
}

export function cliConfigPath(): string {
  return path.join(getConfigDir(), 'cli-config.json');
}

export function readCliConfig(): CliConfig {
  try {
    return JSON.parse(fs.readFileSync(cliConfigPath(), 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

export function writeCliConfig(config: CliConfig): void {
  const filePath = cliConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function readDashboardConfig(): DashboardCliConfig {
  return readCliConfig().dashboard ?? {};
}

/** Merge a partial patch into the persisted dashboard section, keeping other sections intact. */
export function updateDashboardConfig(patch: Partial<DashboardCliConfig>): void {
  const config = readCliConfig();
  writeCliConfig({ ...config, dashboard: { ...(config.dashboard ?? {}), ...patch } });
}
