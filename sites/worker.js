export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return json({ error: "Hosted snapshot is read-only." }, 405);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname === "/api/bot/snapshot") return assetJson(env, url, "/data/snapshot.json");
    if (url.pathname === "/api/bot/events") return assetJson(env, url, "/data/events.json");
    if (url.pathname === "/api/bot/trades") return assetJson(env, url, "/data/trades.json");
    if (url.pathname === "/api/bot/health") return assetJson(env, url, "/data/health.json");
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not available on the hosted snapshot." }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
    },
  });
}

async function assetJson(env, url, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, url)));
  if (!res.ok) return json({ error: "Not found." }, 404);
  return json(await res.json(), 200);
}
