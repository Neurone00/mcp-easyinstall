/**
 * Moskito Easy MCP — the usage figures, and the page that draws them.
 *
 * Separate from the public Worker because it holds the analytics credentials
 * and the public one does not need them.
 *
 * Behind Cloudflare Access (the "Admin" policy, one-time PIN by email). Access
 * signs every request it lets through, and the Worker checks that signature
 * itself: with Access switched off the page answers "Not found" to everyone
 * rather than falling open.
 *
 * The page ships from here rather than from a claude.ai Artifact because an
 * Artifact has no way to reach an external URL — published pages get no
 * network capability at all. Served from the same origin as the data, it
 * needs no CORS and holds no key: it reads the one that opened it.
 */

import PAGE from "./admin-page.html";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const page = url.pathname === "/" || url.pathname === "/usage";
    const push = url.pathname === "/push" && request.method === "POST";
    if (!page && !push && url.pathname !== "/usage.json") {
      return new Response("Not found.", { status: 404 });
    }
    // Not signed in through Access: the same answer for the page and the data.
    if (!(await signedIn(request))) {
      return page
        ? new Response("Not found.", { status: 404 })
        : json({ error: "not authorised" }, 403);
    }
    // Every running app picks this up within five minutes and checks for an
    // update straight away instead of waiting out its six-hour cache.
    if (push) {
      const at = Date.now();
      await env.SIGNAL.put("push", String(at));
      return json({ ok: true, at });
    }
    if (page) {
      return new Response(PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
      return json({ error: "analytics credentials are not set" }, 503);
    }

    try {
      const { from, to, where } = range(url);
      const run = (text) => sql(env, text);
      const [data, people, clients, daily, errlog, latest, pushed] = await Promise.all([
        run(`SELECT blob2 AS name, blob1 AS kind, SUM(double1) AS calls, SUM(double2) AS errors,
                    SUM(double3) AS bytes, SUM(double4) AS scriptErrors, COUNT(DISTINCT index1) AS people
             FROM ${T} WHERE ${where} GROUP BY name, kind ORDER BY calls DESC LIMIT 200`),
        // One row per install: its latest name and version from the daily report,
        // joined in code with what it ran (Analytics Engine has no joins).
        run(`SELECT index1 AS id, blob1 AS kind, blob5 AS name, blob3 AS version,
                    MAX(timestamp) AS last, SUM(double1) AS calls, SUM(double2) AS errors,
                    SUM(double4) AS scriptErrors, SUM(double3) AS bytes, COUNT(DISTINCT blob4) AS days
             FROM ${T} WHERE ${where} AND blob1 IN ('install', 'app')
             GROUP BY id, kind, name, version LIMIT 2000`),
        run(`SELECT index1 AS id, blob2 AS client, SUM(double1) AS calls
             FROM ${T} WHERE ${where} AND blob1 = 'client' GROUP BY id, client LIMIT 2000`),
        run(`SELECT blob4 AS day, SUM(double1) AS calls, COUNT(DISTINCT index1) AS people
             FROM ${T} WHERE ${where} AND blob1 = 'app' GROUP BY day ORDER BY day`),
        run(`SELECT double1 AS at, blob2 AS app, blob3 AS version, blob5 AS name, blob6 AS tool,
                    blob7 AS type, blob8 AS message, blob9 AS client, index1 AS id
             FROM ${T} WHERE ${where} AND blob1 = 'errlog' ORDER BY double1 DESC LIMIT 200`),
        latestRelease(),
        env.SIGNAL.get("push"),
      ]);
      const installs = Math.max(0, ...data.map((d) => Number(d.people) || 0));
      const shape = (d) => ({
        name: d.name,
        calls: Number(d.calls) || 0,
        errors: Number(d.errors) || 0,
        tokens: Math.round((Number(d.bytes) || 0) / 4),
        scriptErrors: Number(d.scriptErrors) || 0,
      });
      return json({
        from, to, installs,
        updated: new Date().toISOString(),
        apps: data.filter((d) => d.kind === "app").map(shape),
        clients: data.filter((d) => d.kind === "client").map(shape),
        errorTypes: data.filter((d) => d.kind === "errtype").map(shape),
        tools: data.filter((d) => d.kind === "tool").map(shape),
        people: peopleOf(people, clients),
        errors: errlog.map((e) => ({ at: Number(e.at) || 0, app: e.app, version: e.version,
          name: e.name, tool: e.tool, type: e.type, message: e.message, client: e.client,
          id: String(e.id).slice(0, 6) })),
        latest,
        pushedAt: Number(pushed) || 0,
        daily: daily.map((d) => ({ day: d.day, calls: Number(d.calls) || 0, people: Number(d.people) || 0 })),
      });
    } catch (e) {
      return json({ error: String(e.message) }, 502);
    }
  },
};

const T = "moskito_easy_mcp_usage";

// ?from=YYYY-MM-DD&to=YYYY-MM-DD, both days included; the last 30 days when
// absent. Analytics Engine keeps three months, so nothing older is asked for.
// Analytics Engine has no DELETE, so rows written while wiring this up are
// excluded by id instead.
function range(url) {
  const day = (d) => d.toISOString().slice(0, 10);
  const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && !isNaN(new Date(v));
  const today = day(new Date());
  const oldest = day(new Date(Date.now() - 89 * 864e5));
  let to = ok(url.searchParams.get("to")) ? url.searchParams.get("to") : today;
  let from = ok(url.searchParams.get("from")) ? url.searchParams.get("from")
    : day(new Date(Date.parse(to) - 29 * 864e5));
  if (to > today) to = today;
  if (from < oldest) from = oldest;
  if (from > to) from = to;
  const end = day(new Date(Date.parse(to) + 864e5));
  return { from, to, where: `timestamp >= toDateTime('${from} 00:00:00')
    AND timestamp < toDateTime('${end} 00:00:00')
    AND index1 NOT IN ('test-uuid', 'probe-install-id', 'chain-check', 'split-check', 'heartbeat-check')` };
}

function peopleOf(rows, clients) {
  const by = {};
  for (const r of rows) {
    const p = by[r.id] || (by[r.id] = { id: String(r.id).slice(0, 6), name: "", version: "",
                                       last: "", lastUsed: "", calls: 0, errors: 0, tokens: 0, days: 0,
                                       assistants: {} });
    if (r.kind === "install") {
      // Several rows when the install changed name or version: keep the newest.
      if (String(r.last) >= p.last) {
        p.last = String(r.last);
        p.version = r.version;
        if (r.name) p.name = r.name;
      }
    } else {
      p.calls += Number(r.calls) || 0;
      p.errors += (Number(r.errors) || 0) + (Number(r.scriptErrors) || 0);
      p.tokens += Math.round((Number(r.bytes) || 0) / 4);
      p.days = Math.max(p.days, Number(r.days) || 0);
      if (Number(r.calls) > 0 && String(r.last) > p.lastUsed) p.lastUsed = String(r.last);
    }
  }
  // Which assistant each install's commands came from, so an unlabelled one shows.
  for (const c of clients) {
    if (by[c.id]) by[c.id].assistants[c.client] = (by[c.id].assistants[c.client] || 0) + (Number(c.calls) || 0);
  }
  return Object.values(by).sort((a, b) => b.calls - a.calls || (b.last > a.last ? 1 : -1));
}

// What "out of date" is measured against: the release the apps update to.
async function latestRelease() {
  try {
    const r = await fetch("https://api.github.com/repos/Neurone00/mcp-easyinstall/releases/latest",
      { headers: { "User-Agent": "moskito-usage", Accept: "application/vnd.github+json" } });
    return r.ok ? String((await r.json()).tag_name || "").replace(/^v/, "") : "";
  } catch { return ""; }
}

async function sql(env, text) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: text });
  if (!r.ok) throw new Error(`query failed (${r.status})`);
  return (await r.json()).data || [];
}


const TEAM = "https://l-salvioni.cloudflareaccess.com";
const AUD = "b2e7db7be0f722e1d265636b7ea5ff13568be895f933c15e4911b8a4c8e27681";

// The Cf-Access-Jwt-Assertion header Access adds: signed by the team's keys,
// for this application, not expired.
async function signedIn(request) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return false;
  try {
    const [h, p, sig] = token.split(".");
    const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const header = JSON.parse(new TextDecoder().decode(b64(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64(p)));
    const { keys } = await (await fetch(`${TEAM}/cdn-cgi/access/certs`)).json();
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(sig),
      new TextEncoder().encode(`${h}.${p}`));
    const aud = [].concat(claims.aud);
    return ok && aud.includes(AUD) && claims.iss === TEAM && claims.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
