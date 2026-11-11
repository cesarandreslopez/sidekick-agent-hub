/**
 * Typed read/write access to ~/.config/sidekick/cli-config.json.
 * Extracted from commands/account.ts so the dashboard and other commands
 * persist preferences through one code path. Writes are atomic
 * (tmp + rename) with owner-only permissions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir, isActivityStationId } from 'sidekick-shared';
import type {
  ActivityLabelMode,
  ActivityRecorderOptions,
  ActivityStationId,
  AutoSwitchConfig,
  ModelPricing,
} from 'sidekick-shared';

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

/**
 * The activity map (`sidekick map`, the dashboard's Map panel). Classification
 * settings apply to events read after they change; a checkpointed session
 * keeps how its earlier events were classified.
 */
export interface ActivityMapCliConfig {
  /** Text in the map's core (at most 10 characters). Default: the provider. */
  coreName?: string;
  /** `names`, `descriptive` (default for terminal output) or `none`. */
  labels?: ActivityLabelMode;
  memory?: {
    paths?: string[];
    mcpServers?: string[];
    commands?: string[];
    subcommands?: string[];
  };
  /** Tool name or MCP server (`mcp__server__*` or the bare server name) → station. */
  stationOverrides?: Record<string, string>;
}

export interface CliConfig {
  accounts?: { autoSwitch?: AutoSwitchConfig; keepAlive?: boolean } & Record<string, unknown>;
  dashboard?: DashboardCliConfig;
  pricing?: PricingCliConfig;
  activityMap?: ActivityMapCliConfig;
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

/** Activity-map settings ready for the recorder; anything malformed counts as not set. */
export interface ParsedActivityMapConfig {
  coreName?: string;
  recorder: Pick<ActivityRecorderOptions, 'labels' | 'memory' | 'stationOverrides'>;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  return list.length > 0 ? list.map((item) => item.trim()) : undefined;
}

export function parseActivityMapConfig(raw: unknown): ParsedActivityMapConfig {
  const result: ParsedActivityMapConfig = { recorder: {} };
  if (!isPlainObject(raw)) return result;
  if (typeof raw.coreName === 'string' && raw.coreName.trim() !== '') {
    result.coreName = raw.coreName.trim().slice(0, 10);
  }
  if (raw.labels === 'names' || raw.labels === 'descriptive' || raw.labels === 'none') {
    result.recorder.labels = raw.labels;
  }
  if (isPlainObject(raw.memory)) {
    const memory = {
      ...(stringList(raw.memory.paths) ? { paths: stringList(raw.memory.paths) } : {}),
      ...(stringList(raw.memory.mcpServers) ? { servers: stringList(raw.memory.mcpServers) } : {}),
      ...(stringList(raw.memory.commands) ? { commands: stringList(raw.memory.commands) } : {}),
      ...(stringList(raw.memory.subcommands)
        ? { subcommands: stringList(raw.memory.subcommands) }
        : {}),
    };
    if (Object.keys(memory).length > 0) result.recorder.memory = memory;
  }
  if (isPlainObject(raw.stationOverrides)) {
    const tools: Record<string, ActivityStationId> = {};
    const servers: Record<string, ActivityStationId> = {};
    for (const [key, station] of Object.entries(raw.stationOverrides)) {
      if (!isActivityStationId(station) || key.trim() === '') continue;
      const server = /^mcp__([^_].*?)__\*$/.exec(key.trim());
      if (server) servers[server[1]] = station;
      else if (key.includes('__') || /^[A-Z]/.test(key)) tools[key.trim()] = station;
      else servers[key.trim()] = station;
    }
    if (Object.keys(tools).length > 0 || Object.keys(servers).length > 0) {
      result.recorder.stationOverrides = {
        ...(Object.keys(tools).length > 0 ? { tools } : {}),
        ...(Object.keys(servers).length > 0 ? { servers } : {}),
      };
    }
  }
  return result;
}

export function readActivityMapConfig(): ParsedActivityMapConfig {
  return parseActivityMapConfig(readCliConfig().activityMap);
}

/** Merge a partial patch into the persisted dashboard section, keeping other sections intact. */
export function updateDashboardConfig(patch: Partial<DashboardCliConfig>): void {
  const config = readCliConfig();
  writeCliConfig({ ...config, dashboard: { ...(config.dashboard ?? {}), ...patch } });
}
