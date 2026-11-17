/**
 * Text-level leak check for recordings. Directors sample what is on screen (the
 * terminal buffer, the workbench and webview text) during a take; any sample that
 * names the real user, their home, a non-example.com address or a private project
 * fails the take before anything is encoded. It does not replace looking at every
 * frame: pixels can leak what text extraction misses.
 */
import os from 'node:os';

const EMAIL = /[A-Z0-9._%+-]+@([A-Z0-9-]+\.)+[A-Z]{2,}/gi;
const ALLOWED_EMAIL_DOMAINS = new Set(['example.com']);

function forbiddenNeedles() {
  const needles = new Set([os.homedir(), os.userInfo().username]);
  for (const extra of (process.env.SK_DEMO_FORBIDDEN ?? '').split(',')) if (extra.trim()) needles.add(extra.trim());
  // Never on screen in Sidekick footage: the maintainer's other products and real config homes.
  needles.add('contextful');
  needles.add(`${os.homedir()}/.claude`);
  return [...needles].filter((n) => n && n.length >= 4);
}

export class LeakCheck {
  constructor(label) {
    this.label = label;
    this.samples = 0;
    this.problems = [];
    this.needles = forbiddenNeedles();
  }

  check(where, text) {
    this.samples += 1;
    const lower = text.toLowerCase();
    for (const needle of this.needles) {
      if (lower.includes(needle.toLowerCase())) this.problems.push(`${where}: contains "${needle}"`);
    }
    for (const match of text.matchAll(EMAIL)) {
      const domain = match[0].split('@')[1].toLowerCase();
      if (!ALLOWED_EMAIL_DOMAINS.has(domain)) this.problems.push(`${where}: email ${match[0]}`);
    }
  }

  assertClean() {
    if (this.samples === 0) throw new Error(`${this.label}: the leak check never sampled the screen`);
    if (this.problems.length) {
      const unique = [...new Set(this.problems)];
      throw new Error(`${this.label}: leak check failed:\n- ${unique.join('\n- ')}`);
    }
    return `${this.label}: leak check clean (${this.samples} samples)`;
  }
}
