// PS Remote screen relay Worker (PS 1.77, "From anywhere"). NOT deployed: the developer deploys it himself, on his yes
// (~/Projects/ps-handover-notes/remote-anywhere-177.md lists the steps).
//
// Two small jobs, text only, never a picture:
//  1. POST /creds: short lived Cloudflare Realtime TURN credentials (a user name and a password that expire after 24 hours),
//     made from the TURN key that stays here as a Worker secret. The Macs never see the TURN key.
//  2. GET /room/<32 hex>?role=primary|secondary (a WebSocket): the two Macs' meeting point. It passes a signed offer from the
//     main Mac to the second Mac and the signed answer back (a relay address, an internet address, a signature). It checks
//     nothing inside them (the Macs check the signatures with their paired keys), keeps nothing, and stores nothing.
//     The socket hibernates while idle, so a second Mac waiting all day costs nothing.
//
// Who may use it: a request must carry the time and an HMAC-SHA256 of the time, method, path and body made with the relay
// key (secret PS_RELAY_KEY, the same key typed once into PS on each Mac). The key itself never travels.
// The screen picture never comes here: it goes through Cloudflare's TURN relay, sealed by PS (AES-256-GCM).
//
// Secrets (wrangler secret put, never in this file): TURN_KEY_ID, TURN_KEY_API_TOKEN, PS_RELAY_KEY.

export const SKEW_SECONDS = 120;
export const TTL_SECONDS = 86_400;
export const MAX_BODY = 1024;
export const MAX_MESSAGE = 12 * 1024;
export const MAX_PER_MINUTE = 30;
const ROLES = new Set(["primary", "secondary"]);
const enc = new TextEncoder();

function b64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function sha256hex(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The signature PS makes (ps-mac RemoteScreenRelayCore.swift RSRelayRules.requestSignature, the same two test vectors). */
export async function sign(key, time, method, path, body) {
  const msg = `ps-relay-v1\n${time}\n${method.toUpperCase()}\n${path}\n${await sha256hex(body)}`;
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** True when the request is signed with the relay key, within two minutes of now. */
export async function verify(request, key, body, nowSeconds) {
  if (typeof key !== "string" || key.length < 32) return false;
  const t = request.headers.get("X-PS-Time"), s = request.headers.get("X-PS-Sign");
  if (!t || !s || !/^\d{9,11}$/.test(t)) return false;
  if (Math.abs(nowSeconds - Number(t)) > SKEW_SECONDS) return false;
  const u = new URL(request.url);
  return same(await sign(key, Number(t), request.method, u.pathname + u.search, body), s);
}

/** Short lived TURN credentials from the TURN key (Cloudflare's generate-ice-servers), as {username, credential, urls, ttl}. */
export async function creds(env, fetchImpl = fetch) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return null;
  const r = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: TTL_SECONDS }),
  });
  if (!r.ok) return null;
  const o = await r.json().catch(() => null);
  const list = Array.isArray(o?.iceServers) ? o.iceServers : o?.iceServers ? [o.iceServers] : [];
  const turn = list.find((s) => typeof s?.username === "string" && typeof s?.credential === "string");
  if (!turn) return null;
  const urls = list.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).filter((u) => typeof u === "string" && /^(stun|turns?):[a-z0-9.-]+:\d{1,5}(\?transport=(udp|tcp))?$/i.test(u));
  return { username: turn.username, credential: turn.credential, urls, ttl: TTL_SECONDS };
}

const plain = (status, text = "") => new Response(text, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" } });

/** The Worker's front door. `nowSeconds` and `fetchImpl` are for the tests. */
export async function handle(request, env, nowSeconds = Math.floor(Date.now() / 1000), fetchImpl = fetch) {
  if (typeof env.PS_RELAY_KEY !== "string" || env.PS_RELAY_KEY.length < 32) return plain(503, "not set up");
  const u = new URL(request.url);
  let body = new ArrayBuffer(0);
  if (request.method === "POST") {
    const n = Number(request.headers.get("Content-Length") ?? "0");
    if (n > MAX_BODY) return plain(413);
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY) return plain(413);
  }
  if (!(await verify(request, env.PS_RELAY_KEY, body, nowSeconds))) return plain(401);   // nothing more, to anyone
  if (request.method === "POST" && u.pathname === "/creds") {
    const c = await creds(env, fetchImpl);
    if (!c) return plain(502, "no credentials");
    return new Response(JSON.stringify(c), { status: 200, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });
  }
  const m = /^\/room\/([0-9a-f]{32})$/.exec(u.pathname);
  if (request.method === "GET" && m) {
    const role = u.searchParams.get("role");
    if (!ROLES.has(role) || [...u.searchParams.keys()].length !== 1) return plain(400);
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") return plain(426);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    // The original request (its Upgrade headers make the WebSocket), at a plain address that says only the role.
    return stub.fetch(new Request(`https://room/${m[1]}?role=${role}`, request));
  }
  return plain(404);
}

/** One message from a socket with role `from`: where it goes, or null (dropped). Only {to, env} to the other role. */
export function route(from, text) {
  if (typeof text !== "string" || text.length > MAX_MESSAGE) return null;
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !keys.includes("to") || !keys.includes("env")) return null;
  if (!ROLES.has(o.to) || o.to === from) return null;
  const e = o.env;
  if (!e || typeof e !== "object" || typeof e.body !== "string" || typeof e.sig !== "string" || typeof e.by !== "string") return null;
  return { to: o.to, text: JSON.stringify({ to: o.to, env: { body: e.body, sig: e.sig, by: e.by } }) };
}

/** At most MAX_PER_MINUTE messages a minute per socket. Returns the new count state, or null when over. */
export function rate(state, nowMs) {
  const s = state && nowMs - state.start < 60_000 ? state : { start: nowMs, n: 0 };
  if (s.n >= MAX_PER_MINUTE) return null;
  return { start: s.start, n: s.n + 1 };
}

/** The room (a Durable Object per pair of Macs). Hibernating WebSockets, tagged by role; nothing is ever stored. */
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // "ping" is answered by Cloudflare itself, without waking the room (the Macs' keepalive).
    if (globalThis.WebSocketRequestResponsePair) ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  pair() { const p = new WebSocketPair(); return [p[0], p[1]]; }
  upgrade(client) { return new Response(null, { status: 101, webSocket: client }); }

  async fetch(request) {
    const role = new URL(request.url).searchParams.get("role");
    if (!ROLES.has(role)) return plain(400);
    // One socket per role: a Mac that reconnects replaces its old socket.
    for (const old of this.ctx.getWebSockets(role)) { try { old.close(4000, "replaced"); } catch {} }
    const [client, server] = this.pair();
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, rate: null });
    return this.upgrade(client);
  }

  webSocketMessage(ws, message) {
    const a = ws.deserializeAttachment() ?? {};
    if (!ROLES.has(a.role)) return;
    const next = rate(a.rate, Date.now());
    if (!next) return;
    ws.serializeAttachment({ role: a.role, rate: next });
    const r = route(a.role, typeof message === "string" ? message : "");
    if (!r) return;
    for (const peer of this.ctx.getWebSockets(r.to)) { try { peer.send(r.text); } catch {} }
  }

  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {} }
  webSocketError(ws) { try { ws.close(1011, "error"); } catch {} }
}

export default { fetch: (request, env) => handle(request, env) };
