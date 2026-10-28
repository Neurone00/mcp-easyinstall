/**
 * Moskito Easy MCP — landing page and anonymous usage collection.
 *
 * Public on purpose. The admin view lives in its own Worker
 * (wrangler.admin.jsonc) because Cloudflare Access protects a Worker's whole
 * production URL rather than a path inside it — protecting this one would have
 * answered every install's /collect with a login challenge and asked strangers
 * to sign in to Moskito just to download the app.
 *
 * D1 since 2.54.0's release: Analytics Engine kept three months, could not
 * delete a row and sampled; D1 keeps the year and can be cleaned. Error
 * messages arrive already scrubbed of quoted names and paths by the Mac.
 *
 * Nothing identifying is accepted. The install id is a random UUID with no
 * account behind it, and exists only so "per install" has something to divide
 * by; the admin queries aggregate across it and never return it.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/collect" && request.method === "POST") {
      return collect(request, env);
    }
    // Polled by every running app every five minutes. A change in "push"
    // means: stop trusting your cached update check and look now.
    if (url.pathname === "/signal") {
      const push = env.SIGNAL ? Number(await env.SIGNAL.get("push")) || 0 : 0;
      return new Response(JSON.stringify({ push }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
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
  if (!env.USAGE && !env.DB) return json({ ok: true, stored: false });
  const rows = [];
  const put = (row) => rows.push(row);

  const day = String(body.day || "").slice(0, 10);
  const version = String(body.version || "").slice(0, 16);

  // One row per report, whether or not anything was used. Without it an install
  // only existed once somebody drove an app with it, so the install count was
  // really an active-user count wearing the wrong label.
  // blob5: the Mac's name, from 2.55.0 on, so the usage page can list people.
  put({
    blobs: ["install", "", version, day, String(body.name || "").slice(0, 64)],
    doubles: [0, 0, 0],
  });

  // One row per app, plus one per tool. Blobs are dimensions, doubles are the
  // numbers; indexes are what Analytics Engine samples on, so the install id
  // goes there and is never selected back out.
  for (const [app, calls] of Object.entries(body.calls || {})) {
    put({
      blobs: ["app", String(app).slice(0, 32), version, day],
      doubles: [
        Number(calls) || 0,
        Number((body.errors || {})[app]) || 0,
        Number((body.bytes || {})[app]) || 0,
        // Scripts that threw inside the app: replied SUCCESS, carried {error}.
        Number((body.scriptErrors || {})[app]) || 0,
      ],
    });
  }
  // The same calls again, cut by which assistant asked rather than which app
  // answered, so Claude and ChatGPT can be compared on the same work.
  for (const [client, calls] of Object.entries(body.clients || {})) {
    put({
      blobs: ["client", String(client).slice(0, 32), version, day],
      doubles: [
        Number(calls) || 0,
        0,
        Number((body.clientBytes || {})[client]) || 0,
      ],
    });
  }
  // The failures themselves (2.55.0+), already scrubbed of quoted names and
  // paths on the Mac. One row each, for the usage page's error log.
  for (const f of (Array.isArray(body.failures) ? body.failures : []).slice(0, 20)) {
    put({
      blobs: ["errlog", String(f.app || "").slice(0, 32), version, day,
              String(body.name || "").slice(0, 64), String(f.tool || "").slice(0, 64),
              String(f.type || "").slice(0, 24), String(f.message || "").slice(0, 200),
              String(f.client || "").slice(0, 32)],
      doubles: [Number(f.at) || 0],
    });
  }
  // What kind of error, from a fixed list of type names — never the message.
  for (const [type, n] of Object.entries(body.errorTypes || {})) {
    put({
      blobs: ["errtype", String(type).slice(0, 24), version, day],
      doubles: [Number(n) || 0, 0, 0, 0],
    });
  }
  for (const [key, calls] of Object.entries(body.tools || {})) {
    put({
      blobs: ["tool", String(key).slice(0, 64), version, day],
      doubles: [Number(calls) || 0, 0, 0],
    });
  }
  // D1 is what the usage page reads (it keeps everything and can be cleaned);
  // Analytics Engine still gets the same rows while D1 proves itself.
  // ponytail: drop the USAGE writes once nobody needs the old dataset.
  const now = Date.now();
  if (env.USAGE) for (const r of rows) env.USAGE.writeDataPoint({ ...r, indexes: [body.id] });
  if (env.DB && rows.length) {
    const ins = env.DB.prepare(`INSERT INTO rows (at, install, kind, name, version, day, mac, tool, type,
      message, client, calls, errors, bytes, script_errors) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    await env.DB.batch(rows.map(({ blobs: b, doubles: d }) => {
      const failure = b[0] === "errlog";
      return ins.bind(failure ? Number(d[0]) || now : now, body.id, b[0], b[1] ?? null, b[2] ?? null,
        b[3] ?? null, b[4] || null, b[5] ?? null, b[6] ?? null, b[7] ?? null, b[8] ?? null,
        failure ? 0 : Number(d[0]) || 0, Number(d[1]) || 0, Number(d[2]) || 0, Number(d[3]) || 0);
    }));
  }
  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });
}
