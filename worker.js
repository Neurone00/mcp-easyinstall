/**
 * Moskito Easy MCP — landing page and anonymous usage collection.
 *
 * Public on purpose. The admin view lives in its own Worker
 * (wrangler.admin.jsonc) because Cloudflare Access protects a Worker's whole
 * production URL rather than a path inside it — protecting this one would have
 * answered every install's /collect with a login challenge and asked strangers
 * to sign in to Moskito just to download the app.
 *
 * Analytics Engine rather than D1: write-heavy, read-rare, free at this scale,
 * and it cannot quietly become a place a document name ends up.
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });
}
