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
      // The copy is a side job: if Analytics Engine refuses, the page still works.
      let syncError = "";
      try { await syncFromAE(env); } catch (e) { syncError = String(e.message); }
      const { from, to, lo, hi } = range(url);
      const W = `at >= ?1 AND at < ?2 AND install NOT IN ${TESTS}`;
      const all = (q) => env.DB.prepare(q).bind(lo, hi).all().then((r) => r.results || []);
      const [data, counted, people, clients, daily, errlog, latest, pushed] = await Promise.all([
        all(`SELECT name, kind, SUM(calls) AS calls, SUM(errors) AS errors, SUM(bytes) AS bytes,
                    SUM(script_errors) AS scriptErrors
             FROM rows WHERE ${W} AND kind IN ('app', 'client', 'tool', 'errtype')
             GROUP BY name, kind ORDER BY calls DESC`),
        all(`SELECT COUNT(DISTINCT install) AS n FROM rows WHERE ${W}`),
        // One row per install and kind: its newest name and version from the
        // reports, and what it ran; peopleOf puts them together.
        all(`SELECT install AS id, kind, mac AS name, version, MAX(at) AS last, SUM(calls) AS calls,
                    SUM(errors) AS errors, SUM(script_errors) AS scriptErrors, SUM(bytes) AS bytes,
                    COUNT(DISTINCT day) AS days
             FROM rows WHERE ${W} AND kind IN ('install', 'app') GROUP BY install, kind, mac, version`),
        all(`SELECT install AS id, name AS client, SUM(calls) AS calls
             FROM rows WHERE ${W} AND kind = 'client' GROUP BY install, name`),
        all(`SELECT day, SUM(calls) AS calls, COUNT(DISTINCT install) AS people
             FROM rows WHERE ${W} AND kind = 'app' GROUP BY day ORDER BY day`),
        all(`SELECT at, name AS app, version, mac AS name, tool, type, message, client, install AS id
             FROM rows WHERE ${W} AND kind = 'errlog' ORDER BY at DESC LIMIT 200`),
        latestRelease(),
        env.SIGNAL.get("push"),
      ]);
      const shape = (d) => ({
        name: d.name,
        calls: Number(d.calls) || 0,
        errors: Number(d.errors) || 0,
        tokens: Math.round((Number(d.bytes) || 0) / 4),
        scriptErrors: Number(d.scriptErrors) || 0,
      });
      return json({
        from, to, syncError,
        installs: Number(counted[0] && counted[0].n) || 0,
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

// Rows written while wiring this up, kept out of every figure.
const TESTS = "('test-uuid', 'probe-install-id', 'chain-check', 'split-check', 'heartbeat-check')";

// ?from=YYYY-MM-DD&to=YYYY-MM-DD, both days included, in UTC; the last 30 days
// when absent. A year at most.
function range(url) {
  const day = (d) => d.toISOString().slice(0, 10);
  const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && !isNaN(Date.parse(v));
  const today = day(new Date());
  const oldest = day(new Date(Date.now() - 365 * 864e5));
  let to = ok(url.searchParams.get("to")) ? url.searchParams.get("to") : today;
  let from = ok(url.searchParams.get("from")) ? url.searchParams.get("from")
    : day(new Date(Date.parse(to) - 29 * 864e5));
  if (to > today) to = today;
  if (from < oldest) from = oldest;
  if (from > to) from = to;
  return { from, to, lo: Date.parse(from), hi: Date.parse(to) + 864e5 };
}

// Until the collector wrote to D1 (2.54.0's release night), usage lived only in
// Analytics Engine, which forgets after three months. Each page load copies
// across whatever it has that D1 doesn't, up to the first row the collector
// wrote to D1 itself, so nothing is counted twice or lost in between. Once
// that point is reached this costs two small queries.
async function syncFromAE(env) {
  const one = (q) => env.DB.prepare(q).first("t");
  const first = await one("SELECT MIN(at) AS t FROM rows WHERE source = 'collect' AND kind != 'errlog'");
  const upper = Number(first) || Date.now();
  const lower = Number(await one("SELECT MAX(at) AS t FROM rows WHERE source = 'ae'")) || 0;
  if (lower >= upper - 1000) return;
  // 'YYYY-MM-DD hh:mm:ss' in UTC: a Unix-seconds string was rejected as a type error.
  const when = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  // ponytail: second resolution and 10,000 rows a pass; the next load continues.
  const got = await sql(env, `SELECT timestamp, index1, blob1, blob2, blob3, blob4, blob5, blob6, blob7,
      blob8, blob9, double1, double2, double3, double4 FROM moskito_easy_mcp_usage
    WHERE timestamp > ${lower ? `toDateTime('${when(lower)}')` : "NOW() - INTERVAL '90' DAY"}
      AND timestamp < toDateTime('${when(upper)}')
    ORDER BY timestamp LIMIT 10000`);
  if (!got.length) return;
  const ins = env.DB.prepare(`INSERT INTO rows (at, install, kind, name, version, day, mac, tool, type,
    message, client, calls, errors, bytes, script_errors, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ae')`);
  const stmts = got.map((r) => {
    const failure = r.blob1 === "errlog";
    const at = Date.parse(String(r.timestamp).replace(" ", "T") + "Z");
    const v = (x) => (x === "" || x === undefined ? null : x);
    return ins.bind(failure ? Number(r.double1) || at : at, r.index1, r.blob1, v(r.blob2), v(r.blob3),
      v(r.blob4), v(r.blob5), v(r.blob6), v(r.blob7), v(r.blob8), v(r.blob9),
      failure ? 0 : Number(r.double1) || 0, Number(r.double2) || 0, Number(r.double3) || 0,
      Number(r.double4) || 0);
  });
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}

function peopleOf(rows, clients) {
  const by = {};
  const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : "");
  for (const r of rows) {
    const p = by[r.id] || (by[r.id] = { id: String(r.id).slice(0, 6), name: "", version: "",
                                       last: "", lastUsed: "", calls: 0, errors: 0, tokens: 0, days: 0,
                                       assistants: {} });
    const last = iso(r.last);
    if (r.kind === "install") {
      // Several rows when the install changed name or version: keep the newest.
      if (last >= p.last) {
        p.last = last;
        if (r.version) p.version = r.version;
      }
      if (r.name && last >= (p.namedAt || "")) { p.name = r.name; p.namedAt = last; }
    } else {
      p.calls += Number(r.calls) || 0;
      p.errors += (Number(r.errors) || 0) + (Number(r.scriptErrors) || 0);
      p.tokens += Math.round((Number(r.bytes) || 0) / 4);
      p.days = Math.max(p.days, Number(r.days) || 0);
      if (Number(r.calls) > 0 && last > p.lastUsed) p.lastUsed = last;
    }
  }
  // Which assistant each install's commands came from, so an unlabelled one shows.
  for (const c of clients) {
    if (by[c.id]) by[c.id].assistants[c.client] = (by[c.id].assistants[c.client] || 0) + (Number(c.calls) || 0);
  }
  for (const p of Object.values(by)) delete p.namedAt;
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
  if (!r.ok) throw new Error(`query failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
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
