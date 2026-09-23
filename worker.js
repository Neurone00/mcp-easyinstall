/**
 * Moskito Easy MCP — landing page, anonymous usage collection, admin view.
 *
 * Analytics Engine rather than D1: this is write-heavy and read-rare, the
 * writes are free at any scale we will ever reach, and it cannot accidentally
 * become a place someone stores a document name.
 *
 * Nothing identifying is accepted. The install id is a random UUID with no
 * account behind it, and it exists only so "how many people" and "average per
 * person" can be answered at all — every query below aggregates across it and
 * none of them can return it.
 */

const ADMIN_PATH = "/admin";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/collect" && request.method === "POST") {
      return collect(request, env);
    }
    if (url.pathname === ADMIN_PATH) {
      return admin(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function collect(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (!body || typeof body.id !== "string" || body.id.length > 64) {
    return json({ error: "bad payload" }, 400);
  }
  if (!env.USAGE) return json({ ok: true, stored: false });

  const day = String(body.day || "").slice(0, 10);
  const version = String(body.version || "").slice(0, 16);

  // One row per app, plus one per tool. Blobs are dimensions, doubles are the
  // numbers; indexes are what Analytics Engine samples on, so the install id
  // goes there and is never selected back out.
  for (const [app, calls] of Object.entries(body.calls || {})) {
    env.USAGE.writeDataPoint({
      blobs: ["app", String(app).slice(0, 32), version, day],
      doubles: [
        Number(calls) || 0,
        Number((body.errors || {})[app]) || 0,
        Number((body.bytes || {})[app]) || 0,
      ],
      indexes: [body.id],
    });
  }
  for (const [key, calls] of Object.entries(body.tools || {})) {
    env.USAGE.writeDataPoint({
      blobs: ["tool", String(key).slice(0, 64), version, day],
      doubles: [Number(calls) || 0, 0, 0],
      indexes: [body.id],
    });
  }
  return json({ ok: true });
}

/**
 * Admin view.
 *
 * Put Cloudflare Access in front of this path and restrict it to the
 * moskitodesign.it domain — that is the whole of the authentication story, and
 * it means there is no password here for anyone to leak. The check below is a
 * guard, not the lock: it refuses to serve anything unless Access has actually
 * stamped the request.
 */
async function admin(request, env) {
  const who = request.headers.get("cf-access-authenticated-user-email");
  if (!who) {
    return new Response(
      "This page is protected by Cloudflare Access, which is not configured yet.\n" +
      "Until it is, there is nothing here worth showing.\n",
      { status: 403, headers: { "Content-Type": "text/plain" } });
  }
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return new Response("Analytics is not configured yet.", { status: 503 });
  }

  const sql = `
    SELECT
      blob2 AS name,
      blob1 AS kind,
      SUM(double1) AS calls,
      SUM(double2) AS errors,
      SUM(double3) AS bytes,
      COUNT(DISTINCT index1) AS people
    FROM USAGE
    WHERE timestamp > NOW() - INTERVAL '30' DAY
    GROUP BY name, kind
    ORDER BY calls DESC
    LIMIT 100`;

  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: sql });

  if (!r.ok) return new Response(`Query failed (${r.status}).`, { status: 502 });
  const { data = [] } = await r.json();

  const apps = data.filter((d) => d.kind === "app");
  const tools = data.filter((d) => d.kind === "tool");
  const people = Math.max(0, ...data.map((d) => Number(d.people) || 0));

  return new Response(page(who, people, apps, tools),
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const num = (n) => Number(n || 0).toLocaleString();

function page(who, people, apps, tools) {
  // Averages per person, not totals: a total tells you how much YOU used it.
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
<style>
 body{font:15px/1.6 Inter,-apple-system,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;
      background:#f4f7fb;color:#111827}
 h1{font-size:24px;margin:0 0 4px} .sub{color:#64748b;margin:0 0 28px;font-size:14px}
 h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:#64748b;margin:32px 0 8px}
 table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:10px;
       overflow:hidden}
 th,td{text-align:left;padding:9px 12px;border-top:1px solid #e2e8f0;font-size:14px}
 th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;border-top:0}
 td:not(:first-child),th:not(:first-child){text-align:right}
 .big{font-size:30px;font-weight:600}
 .note{color:#64748b;font-size:13px;margin-top:22px}
</style>
<h1>Moskito Easy MCP — usage</h1>
<p class="sub">Last 30 days. Signed in as ${esc(who)}.</p>
<p class="big">${num(people)} <span style="font-size:15px;font-weight:400;color:#64748b">
   ${people === 1 ? "person" : "people"} used it</span></p>
<h2>By app</h2>
<table><tr><th>App</th><th>Calls</th><th>Per person</th><th>Failed</th><th>Tokens / person</th></tr>
${apps.map(row).join("") || '<tr><td colspan="5">Nothing yet.</td></tr>'}</table>
<h2>Most used commands</h2>
<table><tr><th>Tool</th><th>Calls</th><th>Per person</th><th>Failed</th><th>Tokens / person</th></tr>
${tools.slice(0, 25).map(row).join("") || '<tr><td colspan="5">Nothing yet.</td></tr>'}</table>
<p class="note">Counts only. No document names, prompts, scripts, paths or artwork are
collected, and nothing here can be traced to a person — the install id exists only so
"per person" can be divided by something, and no query returns it.<br>
Tokens are estimated from the size of what the tools sent back, which is the part of
anyone's plan this app is responsible for. It is not their plan usage, which lives in
their Anthropic and OpenAI accounts and is not visible here.</p>`;
}
