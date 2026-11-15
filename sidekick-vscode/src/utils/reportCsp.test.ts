import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { REPORT_INLINE_HANDLERS, buildReportCsp } from './reportCsp';

const directive = (csp: string, name: string) =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `)) ?? '';

describe('buildReportCsp', () => {
  const csp = buildReportCsp('vscode-webview://x', 'abc123');

  it('allows each known report handler by its SHA-256 hash', () => {
    const scriptSrc = directive(csp, 'script-src');
    expect(scriptSrc).toContain("'nonce-abc123'");
    expect(scriptSrc).toContain("'unsafe-hashes'");
    for (const handler of REPORT_INLINE_HANDLERS) {
      const hash = createHash('sha256').update(handler, 'utf8').digest('base64');
      expect(scriptSrc).toContain(`'sha256-${hash}'`);
    }
  });

  it('never allows arbitrary inline script', () => {
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
    expect(directive(csp, 'default-src')).toBe("default-src 'none'");
  });

  it('allows inline style attributes but keeps <style> blocks behind the nonce', () => {
    expect(directive(csp, 'style-src-attr')).toBe("style-src-attr 'unsafe-inline'");
    expect(directive(csp, 'style-src')).toBe("style-src vscode-webview://x 'nonce-abc123'");
  });
});

describe('REPORT_INLINE_HANDLERS', () => {
  it('covers every inline handler the shared report generator emits', () => {
    // A new handler in the shared report would otherwise be blocked silently.
    const reportDir = path.resolve(__dirname, '../../../sidekick-shared/src/report');
    const emitted = new Set<string>();
    for (const file of fs.readdirSync(reportDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const source = fs.readFileSync(path.join(reportDir, file), 'utf-8');
      for (const match of source.matchAll(/\son[a-z]+="([^"]*)"/g)) emitted.add(match[1]);
    }
    expect(emitted.size).toBeGreaterThan(0);
    expect([...emitted].sort()).toEqual([...new Set(REPORT_INLINE_HANDLERS)].sort());
  });
});
