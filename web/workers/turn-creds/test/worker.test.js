// Tests for the relay Worker (node --test). No network: Cloudflare's API is a fake, the room's sockets are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, verify, creds, handle, route, rate, Room, MAX_PER_MINUTE } from "../src/index.js";

// A fictional relay key, built from plain parts so a secret scanner does not take it for a real one.
const DIGITS = "0123456789", LETTERS = "abcdefghijklmnop";
const KEY = `test-relay-key-${DIGITS}${LETTERS}`;
const NOW = 1_764_000_000;
const enc = new TextEncoder();
const env = (extra = {}) => ({ PS_RELAY_KEY: KEY, TURN_KEY_ID: "fictional-key-id", TURN_KEY_API_TOKEN: "fictional-token", ...extra });

async function signed(method, path, body = "", t = NOW, key = KEY, headers = {}) {
  const b = enc.encode(body);
  const s = await sign(key, t, method, path, b);
  return new Request("https://ps-relay.example.workers.dev" + path, {
    method, headers: { "X-PS-Time": String(t), "X-PS-Sign": s, ...headers }, ...(method === "POST" ? { body } : {}),
  });
}

test("signature matches PS (the same vectors as tests/remote-relay-test.swift)", async () => {
  assert.equal(await sign(KEY, NOW, "POST", "/creds", enc.encode("{}")), "ygD2z_GEt6sFQPCz3KKzW8A5xYwM_r3i8n2EUgWvy5c");
  assert.equal(await sign(KEY, NOW, "get", "/room/0123456789abcdef0123456789abcdef?role=secondary", new Uint8Array()), "AO6INzRCLfKsWMFDzP7R7matIuSH0d2FodqQ-DGGT5s");
});

test("verify: right key and time only", async () => {
  const r = await signed("POST", "/creds", "{}");
  assert.equal(await verify(r, KEY, enc.encode("{}"), NOW), true);
  assert.equal(await verify(r, KEY, enc.encode("{}"), NOW + 121), false, "too late");
  assert.equal(await verify(r, KEY, enc.encode("{ }"), NOW), false, "another body");
  assert.equal(await verify(r, KEY.replace("t", "T"), enc.encode("{}"), NOW), false, "another key");
  assert.equal(await verify(r, "short", enc.encode("{}"), NOW), false, "a key too short is never accepted");
  const bare = new Request("https://x/creds", { method: "POST", body: "{}" });
  assert.equal(await verify(bare, KEY, enc.encode("{}"), NOW), false, "no headers");
});

const cfOK = async (url, init) => {
  assert.equal(url, "https://rtc.live.cloudflare.com/v1/turn/keys/fictional-key-id/credentials/generate-ice-servers");
  assert.equal(init.headers.Authorization, "Bearer fictional-token");
  assert.deepEqual(JSON.parse(init.body), { ttl: 86400 });
  return new Response(JSON.stringify({ iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:5349?transport=tcp", "javascript:alert(1)"], username: "u-1", credential: "c-1" },
  ] }), { status: 201 });
};

test("creds: Cloudflare's answer made small, the TURN key never in it", async () => {
  const c = await creds(env(), cfOK);
  assert.equal(c.username, "u-1"); assert.equal(c.credential, "c-1"); assert.equal(c.ttl, 86400);
  assert.ok(c.urls.includes("turn:turn.cloudflare.com:3478?transport=udp"));
  assert.ok(!c.urls.some((u) => u.startsWith("javascript")));
  assert.ok(!JSON.stringify(c).includes("fictional-token") && !JSON.stringify(c).includes("fictional-key-id"));
  assert.equal(await creds(env(), async () => new Response("no", { status: 403 })), null);
  assert.equal(await creds({ ...env(), TURN_KEY_ID: "" }, cfOK), null);
  // The older shape (one object) works too.
  const old = async () => new Response(JSON.stringify({ iceServers: { urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" } }), { status: 201 });
  assert.equal((await creds(env(), old)).username, "u");
});

test("front door: /creds signed gives credentials; anything unsigned gets a bare 401", async () => {
  const ok = await handle(await signed("POST", "/creds", "{}"), env(), NOW, cfOK);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  assert.equal((await ok.json()).username, "u-1");
  const no = await handle(new Request("https://x/creds", { method: "POST", body: "{}" }), env(), NOW, cfOK);
  assert.equal(no.status, 401); assert.equal(await no.text(), "");
  const old = await handle(await signed("POST", "/creds", "{}", NOW - 600), env(), NOW, cfOK);
  assert.equal(old.status, 401);
  const notSet = await handle(await signed("POST", "/creds", "{}"), { ...env(), PS_RELAY_KEY: undefined }, NOW, cfOK);
  assert.equal(notSet.status, 503);
  const big = await handle(await signed("POST", "/creds", "x".repeat(2000)), env(), NOW, cfOK);
  assert.equal(big.status, 413);
  assert.equal((await handle(await signed("GET", "/nothing"), env(), NOW, cfOK)).status, 404);
  const down = await handle(await signed("POST", "/creds", "{}"), env(), NOW, async () => new Response("", { status: 500 }));
  assert.equal(down.status, 502);
});

test("front door: the room needs a signed WebSocket with one role", async () => {
  const seen = [];
  const rooms = { idFromName: (n) => ({ n }), get: (id) => ({ fetch: async (r) => { seen.push([id.n, new URL(r.url).searchParams.get("role")]); return new Response("room", { status: 200 }); } }) };
  const room = "0123456789abcdef0123456789abcdef";
  const r = await handle(await signed("GET", `/room/${room}?role=secondary`, "", NOW, KEY, { Upgrade: "websocket" }), env({ ROOMS: rooms }), NOW);
  assert.equal(r.status, 200); assert.deepEqual(seen, [[room, "secondary"]]);
  assert.equal((await handle(await signed("GET", `/room/${room}?role=boss`, "", NOW, KEY, { Upgrade: "websocket" }), env({ ROOMS: rooms }), NOW)).status, 400);
  assert.equal((await handle(await signed("GET", `/room/${room}?role=primary&x=1`, "", NOW, KEY, { Upgrade: "websocket" }), env({ ROOMS: rooms }), NOW)).status, 400);
  assert.equal((await handle(await signed("GET", `/room/${room}?role=primary`), env({ ROOMS: rooms }), NOW)).status, 426);
  assert.equal((await handle(await signed("GET", `/room/NOTHEX?role=primary`, "", NOW, KEY, { Upgrade: "websocket" }), env({ ROOMS: rooms }), NOW)).status, 404);
  // Signed for another role: refused (the role is part of what is signed).
  const s = await sign(KEY, NOW, "GET", `/room/${room}?role=primary`, new Uint8Array());
  const swapped = new Request(`https://x/room/${room}?role=secondary`, { headers: { "X-PS-Time": String(NOW), "X-PS-Sign": s, Upgrade: "websocket" } });
  assert.equal((await handle(swapped, env({ ROOMS: rooms }), NOW)).status, 401);
  assert.equal(seen.length, 1);
});

const envl = { body: "{\"t\":\"scr-rly\"}", sig: "c2ln", by: "dev-1" };
test("route: only {to, env} to the other role, nothing else", () => {
  assert.deepEqual(JSON.parse(route("primary", JSON.stringify({ to: "secondary", env: envl })).text), { to: "secondary", env: envl });
  assert.equal(route("primary", JSON.stringify({ to: "secondary", env: envl })).to, "secondary");
  assert.equal(route("primary", JSON.stringify({ to: "primary", env: envl })), null, "never back to itself");
  assert.equal(route("primary", JSON.stringify({ to: "secondary", env: envl, extra: 1 })), null);
  assert.equal(route("primary", JSON.stringify({ to: "everyone", env: envl })), null);
  assert.equal(route("primary", JSON.stringify({ to: "secondary", env: { body: 1, sig: "s", by: "b" } })), null);
  assert.equal(route("primary", "not json"), null);
  assert.equal(route("primary", JSON.stringify({ to: "secondary", env: { ...envl, body: "x".repeat(13_000) } })), null, "too big");
  // Extra fields inside env are dropped, not passed on.
  assert.deepEqual(JSON.parse(route("secondary", JSON.stringify({ to: "primary", env: { ...envl, more: "x" } })).text).env, envl);
});

test("rate: 30 a minute per socket", () => {
  let s = null;
  for (let i = 0; i < MAX_PER_MINUTE; i++) { s = rate(s, 1000 + i); assert.ok(s); }
  assert.equal(rate(s, 2000), null);
  assert.ok(rate(s, 1000 + 60_001), "a new minute");
});

class FakeWS {
  constructor() { this.sent = []; this.closed = null; this.att = null; }
  send(t) { this.sent.push(t); }
  close(c, r) { this.closed = [c, r]; }
  serializeAttachment(a) { this.att = structuredClone(a); }
  deserializeAttachment() { return this.att; }
}
class FakeCtx {
  constructor() { this.sockets = []; }
  acceptWebSocket(ws, tags) { ws.tags = tags; this.sockets.push(ws); }
  getWebSockets(tag) { return this.sockets.filter((w) => w.tags.includes(tag) && !w.closed); }
  setWebSocketAutoResponse() {}
}
function room() {
  const ctx = new FakeCtx(), r = new Room(ctx, {});
  r.pair = () => { const s = new FakeWS(); return [{ client: true }, s]; };
  r.upgrade = () => new Response("upgraded", { status: 200 });
  return { ctx, r };
}

test("room: passes the offer to the second Mac and the answer back, one socket per role", async () => {
  const { ctx, r } = room();
  await r.fetch(new Request("https://room/x?role=secondary"));
  await r.fetch(new Request("https://room/x?role=primary"));
  const [sec, pri] = ctx.sockets;
  r.webSocketMessage(pri, JSON.stringify({ to: "secondary", env: envl }));
  assert.equal(sec.sent.length, 1); assert.equal(pri.sent.length, 0);
  r.webSocketMessage(sec, JSON.stringify({ to: "primary", env: envl }));
  assert.equal(pri.sent.length, 1);
  r.webSocketMessage(sec, JSON.stringify({ to: "secondary", env: envl }));
  assert.equal(sec.sent.length, 1, "never to itself");
  // A second Mac that reconnects replaces its old socket.
  await r.fetch(new Request("https://room/x?role=secondary"));
  assert.deepEqual(sec.closed, [4000, "replaced"]);
  assert.equal(ctx.getWebSockets("secondary").length, 1);
  // Over the rate: dropped.
  const fresh = ctx.getWebSockets("secondary")[0];
  for (let i = 0; i < MAX_PER_MINUTE + 5; i++) r.webSocketMessage(pri, JSON.stringify({ to: "secondary", env: envl }));
  assert.equal(fresh.sent.length, MAX_PER_MINUTE - 1);
  assert.equal((await r.fetch(new Request("https://room/x?role=nobody"))).status, 400);
});

test("nothing is stored: the room has no storage calls at all", async () => {
  const src = await (await import("node:fs/promises")).readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.ok(!/ctx\.storage|\.storage\./.test(src));
  assert.ok(!/console\.log/.test(src), "never logs a request (no key, token or address in the logs)");
});
