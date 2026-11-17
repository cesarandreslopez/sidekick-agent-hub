// Recording-only. Status pages answer "operational", the Claude usage endpoint answers with the
// demo login's quota (SK_DEMO_QUOTA from the sandbox), everything else fails. Every extension shares one extension-host process, so patching
// fetch here covers Sidekick too: it activates on onStartupFinished, after this
// shim's "*" activation, and looks fetch up at call time.
const OPERATIONAL = () =>
  JSON.stringify({
    page: { updated_at: new Date().toISOString() },
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [],
    incidents: [],
  });
const STATUS_HOSTS = new Set(['status.claude.com', 'status.anthropic.com', 'status.openai.com']);

function activate() {
  globalThis.fetch = async function demoFetch(input) {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
    let host = '';
    try {
      host = new URL(raw).hostname;
    } catch {
      /* not a URL */
    }
    if (STATUS_HOSTS.has(host)) {
      return new Response(OPERATIONAL(), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (host === 'api.anthropic.com' && String(raw).includes('/api/oauth/usage')) {
      return new Response(process.env.SK_DEMO_QUOTA || '{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new TypeError(`fetch failed: network is disabled in the demo sandbox (${host || raw})`);
  };
}

module.exports = { activate, deactivate() {} };
