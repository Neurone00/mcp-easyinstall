/**
 * Moskito Easy MCP — the admin view, and nothing else.
 *
 * Separate from the public Worker on purpose. Cloudflare Access protects a
 * Worker's whole production URL, not a path within it, so putting Access on
 * the public Worker would also have gated the download page and /collect —
 * every install would have been answered with a login challenge instead of
 * storing its usage. Two Workers, one public and one behind Access, keeps
 * each of them simple to reason about.
 *
 * Reads the same Analytics Engine dataset the public Worker writes to.
 */

export default {
  async fetch(request, env) {
    // Access stamps this header once someone has signed in. It is a guard
    // rather than the lock — if Access is not actually in front of this
    // Worker, refuse to render rather than quietly serving the numbers.
    const who = request.headers.get("cf-access-authenticated-user-email");
    if (!who) {
      return new Response(
        "This page is protected by Cloudflare Access, which is not in front of it yet.\n" +
        "Until it is, there is nothing here worth showing.\n",
        { status: 403, headers: { "Content-Type": "text/plain" } });
    }
    if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
      return new Response("Analytics credentials are not set on this Worker.", { status: 503 });
    }

    const sql = `
      SELECT
        blob2 AS name,
        blob1 AS kind,
        SUM(double1) AS calls,
        SUM(double2) AS errors,
        SUM(double3) AS bytes,
        COUNT(DISTINCT index1) AS people
      FROM moskito_easy_mcp_usage
      WHERE timestamp > NOW() - INTERVAL '30' DAY
      GROUP BY name, kind
      ORDER BY calls DESC
      LIMIT 100`;

    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: sql });

    if (!r.ok) {
      return new Response(`Query failed (${r.status}). ${await r.text()}`.slice(0, 500),
        { status: 502 });
    }
    const { data = [] } = await r.json();

    const apps = data.filter((d) => d.kind === "app");
    const tools = data.filter((d) => d.kind === "tool");
    const people = Math.max(0, ...data.map((d) => Number(d.people) || 0));

    return new Response(page(who, people, apps, tools),
      { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const num = (n) => Number(n || 0).toLocaleString();

function page(who, people, apps, tools) {
  // Per person, not totals: a total mostly tells you how much you used it.
  const row = (d) => {
    const calls = Number(d.calls) || 0;
    const per = people ? calls / people : 0;
    const fail = calls ? ((Number(d.errors) || 0) / calls) * 100 : 0;
    const tok = Math.round((Number(d.bytes) || 0) / 4);
    return `<tr><td>${esc(d.name)}</td><td>${num(calls)}</td>
      <td>${per.toFixed(1)}</td><td>${fail.toFixed(1)}%</td>
      <td>${people ? num(Math.round(tok / people)) : "—"}</td></tr>`;
  };
  return `<!doctype html><meta charset="utf-8"><title>Usage</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font:15px/1.6 Inter,-apple-system,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;
      background:#f4f7fb;color:#111827}
 h1{font-size:24px;margin:0 0 4px} .sub{color:#64748b;margin:0 0 28px;font-size:14px}
 h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:#64748b;margin:32px 0 8px}
 table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;
       border-radius:10px;overflow:hidden}
 th,td{text-align:left;padding:9px 12px;border-top:1px solid #e2e8f0;font-size:14px}
 th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;border-top:0}
 td:not(:first-child),th:not(:first-child){text-align:right}
 .big{font-size:30px;font-weight:600;margin:0}
 .note{color:#64748b;font-size:13px;margin-top:22px}
</style>
<h1>Moskito Easy MCP — usage</h1>
<p class="sub">Last 30 days. Signed in as ${esc(who)}.</p>
<p class="big">${num(people)} <span style="font-size:15px;font-weight:400;color:#64748b">
   ${people === 1 ? "install" : "installs"}</span></p>
<h2>By app</h2>
<table><tr><th>App</th><th>Calls</th><th>Per install</th><th>Failed</th><th>Tokens / install</th></tr>
${apps.map(row).join("") || '<tr><td colspan="5">Nothing yet.</td></tr>'}</table>
<h2>Most used commands</h2>
<table><tr><th>Tool</th><th>Calls</th><th>Per install</th><th>Failed</th><th>Tokens / install</th></tr>
${tools.slice(0, 25).map(row).join("") || '<tr><td colspan="5">Nothing yet.</td></tr>'}</table>
<p class="note">Counts only. No document names, prompts, scripts, paths or artwork are
collected, and nothing here can be traced to a person — the id exists so &ldquo;per
install&rdquo; has something to divide by, and no query returns it. Counted per install,
not per person: a reinstall looks like a new one.<br>
Tokens are estimated from the size of what the tools sent back, which is the share of
anyone's plan this app is responsible for. It is not their plan usage, which lives in
their Anthropic and OpenAI accounts and is not visible here.</p>`;
}
