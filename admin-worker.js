/**
 * Moskito Easy MCP — usage figures as JSON, for the Artifact that displays them.
 *
 * Separate from the public Worker because it holds the analytics credentials
 * and the public one does not need them.
 *
 * No Cloudflare Access: an Artifact is a page on claude.ai and cannot carry an
 * Access session. A long random key in the query string is the whole of the
 * lock, which is proportionate — this is one person reading counts about their
 * own tool, and the figures contain nothing about anybody's work.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/usage.json") {
      return new Response("Not found.", { status: 404 });
    }
    if (!env.USAGE_KEY || url.searchParams.get("k") !== env.USAGE_KEY) {
      return json({ error: "not authorised" }, 403);
    }
    if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
      return json({ error: "analytics credentials are not set" }, 503);
    }

    try {
      const data = await query(env);
      // Aggregated here rather than in the page: the page should not need to
      // know the shape of an Analytics Engine row to draw a table.
      const installs = Math.max(0, ...data.map((d) => Number(d.people) || 0));
      const shape = (d) => ({
        name: d.name,
        calls: Number(d.calls) || 0,
        errors: Number(d.errors) || 0,
        tokens: Math.round((Number(d.bytes) || 0) / 4),
      });
      return json({
        installs,
        updated: new Date().toISOString(),
        apps: data.filter((d) => d.kind === "app").map(shape),
        tools: data.filter((d) => d.kind === "tool").map(shape),
      });
    } catch (e) {
      return json({ error: String(e.message) }, 502);
    }
  },
};

// Analytics Engine has no DELETE, so the rows written while wiring this up
// cannot be removed — they are excluded by id instead. Without this the
// headline read "4 installs" when there was one.
async function query(env) {
  const sql = `
    SELECT
      blob2 AS name,
      blob1 AS kind,
      SUM(double1) AS calls,
      SUM(double2) AS errors,
      SUM(double3) AS bytes,
      COUNT(DISTINCT index1) AS people
    FROM moskito_easy_mcp_usage
    WHERE timestamp > NOW() - INTERVAL \'30\' DAY
      AND index1 NOT IN (\'test-uuid\', \'probe-install-id\', \'chain-check\', \'split-check\')
    GROUP BY name, kind
    ORDER BY calls DESC
    LIMIT 100`;
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: sql });
  if (!r.ok) throw new Error(`query failed (${r.status})`);
  const { data = [] } = await r.json();
  return data;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Open on purpose: the Artifact that reads this renders on a sandboxed
      // origin, not claude.ai, so naming an origin would block it. The key in
      // the query string is the lock, and it is in the page's source anyway.
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Cache-Control": "no-store",
    },
  });
}
