import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';

const pkgRoot = path.resolve(__dirname, '..');
const distDir = path.join(pkgRoot, 'dist');
const browserJs = path.join(distDir, 'browser.js');
const nodeJs = path.join(distDir, 'node.js');
const schemasJs = path.join(distDir, 'schemas', 'index.js');
const rootDts = path.join(distDir, 'index.d.ts');
const browserDts = path.join(distDir, 'browser.d.ts');
const nodeDts = path.join(distDir, 'node.d.ts');
const schemasDts = path.join(distDir, 'schemas', 'index.d.ts');
const statuslineJs = path.join(distDir, 'statusline', 'index.js');

// Rooted at the package itself so require.resolve exercises the real
// package.json `exports` map as a self-consumer.
const pkgRequire = createRequire(path.join(pkgRoot, 'package.json'));

describe('packaging contract', () => {
  it('dist/browser.js exposes the browser-safe surface', () => {
    expect(existsSync(browserJs)).toBe(true);
    const m = require(browserJs);
    for (const k of [
      'getModelContextWindowSize',
      'parseModelId',
      'getModelPricing',
      'getModelInfo',
      'calculateCost',
      'calculateCostWithPricing',
      'calculateCostWithProvenance',
      'normalizeProviderUsage',
      'extractNormalizedUsage',
      'calculateNormalizedUsageCost',
      'estimateTextTokens',
      'estimateSerializedTokens',
      'parseMcpToolName',
      'projectSessionTranscript',
      'mergeCostSources',
      'shortModelName',
      'getModelDisplayInfo',
      'compareModelIds',
      'sortModelIds',
      'formatCost',
      'formatDurationMs',
      'formatTokenCount',
      'buildSessionContextSnapshot',
      'calculateSessionContextPressure',
      'createSessionContextProjector',
      'assistantTurnEventsFromSessionEvents',
      'extractTurnSubagents',
      'reasoningSummary',
      'segmentAssistantTurn',
    ]) {
      expect(typeof m[k]).toBe('function');
    }
    expect(typeof m.DEFAULT_CONTEXT_WINDOW).toBe('number');
    // Schemas live on the dedicated `/schemas` subpath, not here — keeping
    // zod out of bundles that only need the pure math/formatting helpers.
    expect(m.quotaStateSchema).toBeUndefined();
    expect(m.sessionEventSchema).toBeUndefined();
  });

  it('dist/schemas/index.js exposes the boundary-validation surface', () => {
    expect(existsSync(schemasJs)).toBe(true);
    const m = require(schemasJs);
    for (const k of [
      'messageUsageSchema',
      'sessionMessageSchema',
      'sessionEventSchema',
      'userSessionEventSchema',
      'assistantSessionEventSchema',
      'summarySessionEventSchema',
      'systemSessionEventSchema',
      'toolUseSessionEventSchema',
      'toolResultSessionEventSchema',
      'permissionModeSchema',
      'sessionEvidenceRefV1Schema',
      'pendingUserRequestV1Schema',
      'observedAgentSessionV1Schema',
      'providerCapabilitiesV1Schema',
      'providerSessionAdapterV1Schema',
      'quotaWindowSchema',
      'quotaStateSchema',
      'peakHoursStateSchema',
      'quotaFailureDescriptorSchema',
      'providerQuotaStateSchema',
      'claudeProviderQuotaStateSchema',
      'codexProviderQuotaStateSchema',
      'providerQuotaMapSchema',
      'quotaHistorySampleSchema',
      'quotaHistoryDailyBucketSchema',
      'activeProviderAccountStatusSchema',
      'activeAccountStatusSchema',
      'accountProviderIdSchema',
      'accountManagerResultSchema',
      'beginAccountLoginResultSchema',
      'accountLoginStatusSchema',
      'accountEntrySchema',
      'savedAccountProfileSchema',
      'listAllAccountsResultSchema',
      'assistantTurnEventSchema',
      'assistantTurnProjectionSchema',
      'assistantTurnReasoningTimelineItemSchema',
      'assistantTurnSubagentSchema',
      'assistantTurnTimelineItemSchema',
      'normalizedUsageSchema',
      'normalizedUsageCostSchema',
      'tokenEstimateSchema',
      'canonicalTranscriptBlockSchema',
      'transcriptSourceProvenanceSchema',
      'canonicalToolCallSchema',
      'canonicalTranscriptMessageSchema',
      'canonicalSessionTranscriptSchema',
    ]) {
      expect(typeof m[k]?.safeParse).toBe('function');
    }
    expect(typeof m.observedValueV1Schema).toBe('function');
    expect(typeof m.extractSessionEvents).toBe('function');
  });

  it('dist/statusline/index.js exposes the lightweight prompt-render surface', () => {
    expect(existsSync(statuslineJs)).toBe(true);
    const m = require(statuslineJs);
    for (const name of [
      'getActiveAccountStatus',
      'readQuotaSnapshot',
      'formatStatusline',
      'estimateTimeToQuota',
    ]) {
      expect(typeof m[name]).toBe('function');
    }
  });

  it('dist/node.js exposes pricing hydration', () => {
    expect(existsSync(nodeJs)).toBe(true);
    const m = require(nodeJs);
    expect(typeof m.hydratePricingCatalog).toBe('function');
    expect(typeof m.normalizeLiteLlmCatalog).toBe('function');
    expect(typeof m.LITELLM_CATALOG_URL).toBe('string');
    expect(typeof m.listRecentSessions).toBe('function');
    expect(typeof m.readSessionTranscript).toBe('function');
    expect(typeof m.ObservedSessionCollector).toBe('function');
    expect(typeof m.observedSessionSourceFromProvider).toBe('function');
    expect(typeof m.fileFingerprint).toBe('function');
  });

  it('dist/index.js exposes account bootstrap', () => {
    const m = require(path.join(distDir, 'index.js'));
    expect(typeof m.ensureDefaultAccounts).toBe('function');
    expect(typeof m.getActiveAccountStatus).toBe('function');
    for (const k of [
      'getClaudeProfilesDir',
      'getClaudeProfileHome',
      'claudeKeychainSuffix',
      'claudeKeychainService',
      'isClaudeProfileAuthenticated',
      'readClaudeProfileIdentity',
      'beginAccountLogin',
      'getAccountLoginStatus',
      'finalizeAccountLogin',
      'spawnAccountLogin',
      'switchAccount',
      'listAllAccounts',
      'resolveActiveClaudeHome',
      'applyActiveClaudeToLiveHome',
      'reconcileClaudeAuthState',
      'setTerminalActiveProfile',
      'installShellHook',
      'uninstallShellHook',
      'isShellHookInstalled',
      'writeLauncher',
      'removeLauncher',
      'decideAutoSwitch',
    ]) {
      expect(typeof m[k]).toBe('function');
    }
    expect(typeof m.AutoSwitchController).toBe('function');
    expect(typeof m.CodexQuotaWatcher).toBe('function');
    expect(typeof m.MultiProviderQuotaService).toBe('function');
    expect(typeof m.createJsonlTail).toBe('function');
    expect(typeof m.formatDurationMs).toBe('function');
    expect(typeof m.formatTokenCount).toBe('function');
    expect(typeof m.extractToolCall).toBe('function');
    expect(typeof m.extractUrls).toBe('function');
    expect(typeof m.extractFilePaths).toBe('function');
    expect(typeof m.extractCommands).toBe('function');
    expect(typeof m.gatherAssetsForCwd).toBe('function');
    expect(typeof m.readClaudeAssets).toBe('function');
    expect(typeof m.readCodexAssets).toBe('function');
    expect(typeof m.readSessionContextSnapshot).toBe('function');
    expect(typeof m.buildSessionContextSnapshot).toBe('function');
    expect(typeof m.extractSessionEvents).toBe('function');
    expect(typeof m.segmentAssistantTurn).toBe('function');
    expect(typeof m.normalizeProviderUsage).toBe('function');
    expect(typeof m.calculateNormalizedUsageCost).toBe('function');
    expect(typeof m.estimateTextTokens).toBe('function');
    expect(typeof m.projectSessionTranscript).toBe('function');
    expect(typeof m.listRecentSessions).toBe('function');
    expect(typeof m.readSessionTranscript).toBe('function');
    expect(typeof m.ObservedSessionCollector).toBe('function');
    expect(typeof m.assistantTurnProjectionSchema?.safeParse).toBe('function');
    expect(typeof m.quotaStateSchema?.safeParse).toBe('function');
    expect(typeof m.activeAccountStatusSchema?.safeParse).toBe('function');
    expect(typeof m.beginAccountLoginResultSchema?.safeParse).toBe('function');
    expect(typeof m.listAllAccountsResultSchema?.safeParse).toBe('function');
  });

  it('dist/phrases.js exposes flat and categorized phrase surfaces', () => {
    const m = require(path.join(distDir, 'phrases.js'));
    expect(Array.isArray(m.ALL_PHRASES)).toBe(true);
    expect(Array.isArray(m.PHRASE_CATEGORIES)).toBe(true);
    expect(m.PHRASE_CATEGORIES.length).toBeGreaterThan(0);
  });

  it('dist/browser.js does not transitively load node:fs or node:path', async () => {
    const src = await fs.readFile(browserJs, 'utf8');
    expect(src).not.toMatch(/require\(["']node:fs["']\)/);
    expect(src).not.toMatch(/require\(["']node:path["']\)/);
    expect(src).not.toMatch(/require\(["']fs["']\)/);
    expect(src).not.toMatch(/require\(["']path["']\)/);
    // The whole point is to keep pricing hydration out of browser bundles.
    expect(src).not.toMatch(/pricingCatalog/);
  });

  it('dist/schemas/* does not transitively load node:fs or node:path', async () => {
    // The schema modules `import type` from Node-flavored sources
    // (quotaHistory, accountStatus); those must stay erased at emit.
    const schemasDir = path.join(distDir, 'schemas');
    const files = (await fs.readdir(schemasDir)).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = await fs.readFile(path.join(schemasDir, file), 'utf8');
      expect(src).not.toMatch(/require\(["']node:fs["']\)/);
      expect(src).not.toMatch(/require\(["']node:path["']\)/);
      expect(src).not.toMatch(/require\(["']fs["']\)/);
      expect(src).not.toMatch(/require\(["']path["']\)/);
    }
  });

  it('publishes the new types from their supported declaration surfaces', async () => {
    const [root, browser, node, schemas] = await Promise.all(
      [rootDts, browserDts, nodeDts, schemasDts].map((file) => fs.readFile(file, 'utf8')),
    );

    expect(root).toContain('ProviderObservedSessionCollectionSource');
    expect(node).toContain('ProviderObservedSessionCollectionSource');
    expect(browser).toContain('TranscriptSourceProvenance');
    expect(browser).toContain('CanonicalSessionTranscript');
    expect(schemas).toContain('TranscriptSourceProvenance');
    expect(schemas).toContain('transcriptSourceProvenanceSchema');
  });

  // Consumer-perspective resolution: exercises the real package.json exports
  // map. Catches typos (wrong subpath key, missing `types`, bad default path)
  // that file-existence checks miss.
  it('package.json `exports` resolves the advertised subpaths', () => {
    const expected: Record<string, string> = {
      'sidekick-shared': path.join(distDir, 'index.js'),
      'sidekick-shared/browser': browserJs,
      'sidekick-shared/node': nodeJs,
      'sidekick-shared/schemas': schemasJs,
      'sidekick-shared/phrases': path.join(distDir, 'phrases.js'),
      'sidekick-shared/modelContext': path.join(distDir, 'modelContext.js'),
      'sidekick-shared/modelInfo': path.join(distDir, 'modelInfo.js'),
      'sidekick-shared/formatting': path.join(distDir, 'formatting.js'),
      'sidekick-shared/statusline': statuslineJs,
      // Compat path — downstream consumers still rely on these in this release.
      'sidekick-shared/dist/phrases': path.join(distDir, 'phrases.js'),
      'sidekick-shared/dist/providers/types': path.join(distDir, 'providers', 'types.js'),
    };
    for (const [specifier, resolvedPath] of Object.entries(expected)) {
      expect(pkgRequire.resolve(specifier)).toBe(resolvedPath);
    }
  });

  // `files: ["dist"]` excluded both of these, and npm only auto-includes a
  // LICENSE from the package directory — so the published tarball carried no
  // license text and no changelog at all.
  it('ships license and changelog text in the published tarball', () => {
    const pkg = require(path.join(pkgRoot, 'package.json'));
    expect(existsSync(path.join(pkgRoot, 'LICENSE'))).toBe(true);
    expect(existsSync(path.join(pkgRoot, 'CHANGELOG.md'))).toBe(true);
    expect(pkg.files).toContain('CHANGELOG.md');
    expect(pkg.files).toContain('LICENSE');
  });

  it('declares the metadata npm and consumers rely on', () => {
    const pkg = require(path.join(pkgRoot, 'package.json'));
    // `directory` is what points npm's source link at this package rather
    // than the monorepo root.
    expect(pkg.repository?.directory).toBe('sidekick-shared');
    expect(pkg.repository?.url).toContain('sidekick-agent-hub');
    expect(pkg.bugs?.url).toContain('/issues');
    expect(pkg.homepage).toBeTruthy();
    expect(pkg.author?.name).toBeTruthy();
    expect(pkg.license).toBe('MIT');
    expect(Array.isArray(pkg.keywords)).toBe(true);
    expect(pkg.keywords.length).toBeGreaterThan(0);
    // zod 4 is the binding constraint, matching the sibling CLI.
    expect(pkg.engines?.node).toBe('>=20.0.0');
  });

  // typesVersions is the Node10-resolution fallback for consumers whose
  // tsconfig still uses `moduleResolution: "node"`, which cannot read
  // `exports` at all. Modern resolvers ignore it when `exports` is present.
  it('typesVersions covers every non-wildcard exports subpath', () => {
    const pkg = require(path.join(pkgRoot, 'package.json'));
    const subpaths = Object.keys(pkg.exports)
      .filter((k) => k !== '.' && k !== './package.json' && !k.includes('*'))
      .map((k) => k.slice(2));

    expect(subpaths.length).toBeGreaterThan(0);
    for (const sub of subpaths) {
      const entry = pkg.typesVersions['*'][sub];
      expect(entry, `typesVersions is missing "${sub}"`).toBeDefined();
      expect(existsSync(path.join(pkgRoot, entry[0]))).toBe(true);
      // Must agree with what the exports map itself declares as `types`.
      expect(entry[0]).toBe(pkg.exports[`./${sub}`].types.replace(/^\.\//, ''));
    }
  });

  it('has no typesVersions catch-all that would shadow root resolution', () => {
    // A `"*": ["dist/*"]` entry makes TS consult typesVersions for the bare
    // specifier and stop honoring the top-level `types` field.
    const pkg = require(path.join(pkgRoot, 'package.json'));
    expect(Object.keys(pkg.typesVersions['*'])).not.toContain('*');
  });

  // The legacy z.ai estimator stays reachable through the ./dist/* wildcard,
  // so the only signal a consumer gets is the JSDoc tag in the .d.ts.
  it('marks every legacy z.ai export as deprecated in the published types', async () => {
    for (const file of ['zaiQuota.d.ts', 'zaiQuotaWatcher.d.ts']) {
      const src = await fs.readFile(path.join(distDir, file), 'utf8');
      const exportCount = (src.match(/^export (declare|interface|type|const|class)/gm) ?? [])
        .length;
      const tagCount = (src.match(/@deprecated/g) ?? []).length;
      expect(exportCount, `${file} has no exports to check`).toBeGreaterThan(0);
      expect(tagCount, `${file} has untagged exports`).toBeGreaterThanOrEqual(exportCount);
    }
  });
});
