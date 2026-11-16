// gmail-inbox: your Gmail accounts -> sealed inbox items only you can open.
// op "poll" (pg_cron every 2 minutes, x-cron-secret): for each connected account, list new
// inbox mail not from you and new sent mail, read headers, snippet and the opening few sentences
// of the body (lib.ts bodyOpening, max 800 characters; never attachments), seal each
// to the owner's public key and store it in public.inbox (source 'gmail' / 'gmail-sent').
// The browser matches senders to clients; anything unmatched is pruned here after 7 days.
// op "refresh" (PS, when you holds Tab; owner's own login only, at most every 20 seconds): the
// same poll straight away, so a client's email shows without waiting for the next cron run.
// op "enroll" (scripts/gmail-connect.mjs, one-time code): stores Gmail logins in Supabase Vault
// after checking each one belongs to that address. Read-only logins only, except accounts you
// listed in allowWrite because Google blocked a new read-only sign-in (his existing connector login).
// Plaintext mail exists only in memory for the length of a request. Nothing here sends mail.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import {
  type Account, type GmailMessage, afterSec, errText, isSlowDown, inboundPayload, inboundQuery, mergeAccounts,
  parseAccounts, safeEqual, seal, sentPayload, sentQuery, sha256hex,
} from "./lib.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const LIST_CAP = 1000;     // ids listed per query per run
const FETCH_CAP = 120;     // new messages read per account per run (the rest wait for the next run)
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const WRITE_SCOPES = ["gmail.modify", "gmail.send", "gmail.compose", "gmail.insert", "https://mail.google.com/"];

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

// Egress: the config and the owner's public key are read once per warm instance (5 minutes), not on every run.
let cfgCache: { v: { accounts: Account[]; cronSecret: string | null }; at: number } | null = null;
async function config(fresh = false): Promise<{ accounts: Account[]; cronSecret: string | null }> {
  if (!fresh && cfgCache && Date.now() - cfgCache.at < 5 * 60_000) return cfgCache.v;
  const { data, error } = await admin.rpc("gmail_get_config");
  if (error) throw new Error("config: " + error.message);
  const v = { accounts: parseAccounts(data?.accounts), cronSecret: data?.cron_secret ?? null };
  cfgCache = { v, at: Date.now() };
  return v;
}
let keyCache: { pub: string; at: number } | null = null;
async function ownerKey(): Promise<string | null> {
  if (keyCache && Date.now() - keyCache.at < 5 * 60_000) return keyCache.pub;
  const { data: owner } = await admin.from("app_owner").select("user_id").maybeSingle();
  if (!owner) return null;
  const { data: k } = await admin.from("user_keys").select("public_key").eq("user_id", owner.user_id).maybeSingle();
  if (!k?.public_key) return null;
  keyCache = { pub: k.public_key, at: Date.now() };
  return k.public_key;
}

async function accessToken(a: Account): Promise<{ token: string; scope: string }> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: a.client_id, client_secret: a.client_secret, refresh_token: a.refresh_token }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`token refresh failed: ${j.error || r.status}`);
  return { token: j.access_token, scope: String(j.scope || "") };
}

async function gget<T>(token: string, path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(GMAIL + path, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) return await r.json() as T;
    // Keep Google's own reason (no mail, no token) so Settings can say what to fix instead of a bare number.
    const e = (await r.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
    const reason = e.error?.errors?.[0]?.reason || "";
    // Google says "slow down" as 429 or as 403 rateLimitExceeded / userRateLimitExceeded: wait and try again.
    const slowDown = r.status === 429 || (r.status === 403 && /ratelimit/i.test(reason));
    if ((slowDown || r.status >= 500) && attempt < 2) { await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); continue; }
    const why = [reason, e.error?.message].filter(Boolean).join(": ");
    throw new Error(`gmail ${r.status}${why ? " " + why : ""}`);
  }
}

async function listIds(token: string, q: string): Promise<{ id: string; threadId: string }[]> {
  const out: { id: string; threadId: string }[] = [];
  let page: string | undefined;
  do {
    const qs = new URLSearchParams({ q, maxResults: "500" });
    if (page) qs.set("pageToken", page);
    const j = await gget<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(token, `/messages?${qs}`);
    out.push(...(j.messages || []));
    page = j.nextPageToken;
  } while (page && out.length < LIST_CAP);
  return out.slice(0, LIST_CAP);
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** Ids from the list that have not been sealed before, oldest first. */
async function unseen(account: string, ids: { id: string; threadId: string }[]) {
  const hashed = await Promise.all(ids.map(async (m) => ({ ...m, h: await sha256hex(`${account}|${m.id}`) })));
  const seen = new Set<string>();
  for (let i = 0; i < hashed.length; i += 100) {
    const chunk = hashed.slice(i, i + 100).map((m) => m.h);
    const { data, error } = await admin.from("gmail_seen").select("h").in("h", chunk);
    if (error) throw new Error("seen lookup: " + error.message);
    for (const r of data || []) seen.add(r.h);
  }
  return hashed.filter((m) => !seen.has(m.h)).reverse(); // Gmail lists newest first
}

async function pollAccount(a: Account, pub: string, cursorMs: number | null, runStart: number) {
  const { token } = await accessToken(a);
  const after = afterSec(cursorMs, runStart);
  const [inIds, sentIds] = await Promise.all([listIds(token, inboundQuery(after)), listIds(token, sentQuery(after))]);
  const newIn = await unseen(a.email, inIds);
  const newSent = await unseen(a.email, sentIds);
  const takeIn = newIn.slice(0, FETCH_CAP);
  const takeSent = newSent.slice(0, FETCH_CAP);

  const rows: { source: string; sealed: string }[] = [];
  const hashes: string[] = [];
  // A quota refusal stops this run's reading but keeps everything already read: the first run on a busy
  // inbox reads a week of mail, and throwing it all away made every run hit the same quota forever.
  let stopped = false;
  const read = async <M>(path: string): Promise<M | null> => {
    if (stopped) return null;
    try { return await gget<M>(token, path); } catch (e) { if (isSlowDown(e)) { stopped = true; return null; } throw e; }
  };
  await pool(takeIn, 4, async (m) => {
    // "full" for the opening of the body (lib.ts bodyOpening); the rest of it is never kept.
    const msg = await read<GmailMessage>(`/messages/${m.id}?format=full`);
    if (!msg) return;
    hashes.push(m.h);
    if (msg.labelIds?.includes("SENT") || msg.labelIds?.includes("DRAFT")) return; // from you after all
    rows.push({ source: "gmail", sealed: await seal(pub, inboundPayload(a.email, msg)) });
  });
  await pool(takeSent, 4, async (m) => {
    const msg = await read<GmailMessage>(`/messages/${m.id}?format=minimal`);
    if (!msg) return;
    hashes.push(m.h);
    rows.push({ source: "gmail-sent", sealed: await seal(pub, sentPayload(a.email, msg)) });
  });

  for (let i = 0; i < rows.length; i += 50) {
    const { error } = await admin.from("inbox").insert(rows.slice(i, i + 50));
    if (error) throw new Error("store: " + error.message);
  }
  for (let i = 0; i < hashes.length; i += 200) {
    const { error } = await admin.from("gmail_seen").upsert(hashes.slice(i, i + 200).map((h) => ({ h })), { onConflict: "h", ignoreDuplicates: true });
    if (error) throw new Error("seen store: " + error.message);
  }
  // Only move the window forward once everything in it has been sealed.
  const complete = !stopped && takeIn.length === newIn.length && takeSent.length === newSent.length;
  return { sealed: rows.length, cursor: complete ? runStart : cursorMs, more: !complete };
}

async function poll() {
  const runStart = Date.now();
  const { accounts } = await config();
  if (!accounts.length) return json({ ok: true, note: "no accounts connected" });

  const pub = await ownerKey();
  if (!pub) return json({ error: "no inbox key" }, 503);

  const { data: states } = await admin.from("gmail_state").select("account, cursor_ms, last_ok");
  const cursors = new Map((states || []).map((s) => [s.account, s.cursor_ms as number | null]));
  const lastOks = new Map((states || []).map((s) => [s.account, s.last_ok as string | null]));

  // One write for every account's state (the refresh throttle reads updated_at, so it is still stamped each run).
  const stateRows: Record<string, unknown>[] = [];
  const results = await Promise.all(accounts.map(async (a) => {
    try {
      const r = await pollAccount(a, pub, cursors.get(a.email) ?? null, runStart);
      stateRows.push({ account: a.email, cursor_ms: r.cursor, last_ok: new Date().toISOString(), last_error: null, readonly: a.readonly !== false, updated_at: new Date().toISOString() });
      return { account: a.email, sealed: r.sealed, more: r.more };
    } catch (e) {
      const msg = errText(e);
      stateRows.push({ account: a.email, cursor_ms: cursors.get(a.email) ?? null, last_ok: lastOks.get(a.email) ?? null, last_error: msg, readonly: a.readonly !== false, updated_at: new Date().toISOString() });
      return { account: a.email, error: msg };
    }
  }));
  if (stateRows.length) await admin.from("gmail_state").upsert(stateRows);

  // Housekeeping, once an hour: unmatched mail goes after 7 days, the seen list after 30.
  if (new Date(runStart).getUTCMinutes() < 2) {
    const week = new Date(runStart - 7 * 86_400_000).toISOString();
    await admin.from("inbox").delete().in("source", ["gmail", "gmail-sent"]).lt("created_at", week);
    await admin.from("gmail_seen").delete().lt("at", new Date(runStart - 30 * 86_400_000).toISOString());
  }
  return json({ ok: true, results });
}

async function enroll(body: { code?: string; accounts?: Account[]; allowWrite?: string[] }) {
  if (!body.code || !Array.isArray(body.accounts) || !body.accounts.length) return json({ error: "bad request" }, 400);
  const h = await sha256hex(body.code);
  const { data: row } = await admin.from("gmail_enroll").select("code_hash").eq("code_hash", h).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!row) return json({ error: "invalid or expired code" }, 401);

  const add = parseAccounts(JSON.stringify(body.accounts));
  const checked: { email: string; ok: boolean; error?: string }[] = [];
  const good: Account[] = [];
  for (const a of add) {
    try {
      const { token, scope } = await accessToken(a);
      const scopes = scope.split(/\s+/);
      const canWrite = WRITE_SCOPES.some((s) => scopes.some((x) => x === s || x.endsWith("/auth/" + s)));
      // Read-only logins are the default. A send-capable one is stored only for an account you
      // listed in allowWrite (Google blocked a new read-only sign-in for it); it is still only read.
      const allowed = (body.allowWrite || []).map((e) => e.toLowerCase()).includes(a.email);
      if (canWrite && !allowed) throw new Error("login can write or send mail; refused");
      if (!canWrite && !scope.includes(READONLY)) throw new Error("no Gmail read access");
      a.readonly = !canWrite;
      const p = await gget<{ emailAddress: string }>(token, "/profile");
      if (p.emailAddress.toLowerCase() !== a.email) throw new Error("login belongs to a different address");
      good.push(a);
      checked.push({ email: a.email, ok: true });
    } catch (e) {
      checked.push({ email: a.email, ok: false, error: errText(e) });
    }
  }
  if (good.length) {
    const { accounts: old } = await config(true);
    const { error } = await admin.rpc("gmail_set_accounts", { p: JSON.stringify(mergeAccounts(old, good)) });
    if (error) return json({ error: "store failed" }, 500);
    cfgCache = null;
    await admin.from("gmail_enroll").delete().eq("code_hash", h);
  }
  return json({ ok: good.length > 0, accounts: checked });
}

// PS (and the vault) call "refresh" from the page: answer only your own apps.
// Your own site address(es) come from the secret PS_SITE_ORIGINS (comma separated, for example https://example.com).
const EXTRA_ORIGINS = (Deno.env.get("PS_SITE_ORIGINS") || "").split(",").map((x) => x.trim()).filter((x) => /^https:\/\/[a-z0-9.-]+$/i.test(x));
const ALLOWED_ORIGINS = ["ps://app", ...EXTRA_ORIGINS, "http://localhost:5173"];
function withCors(res: Response, origin: string | null) {
  const ok = !!origin && ALLOWED_ORIGINS.includes(origin);
  res.headers.set("Access-Control-Allow-Origin", ok ? origin! : ALLOWED_ORIGINS[0]);
  res.headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Vary", "Origin");
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return withCors(new Response("ok"), req.headers.get("origin"));
  return withCors(await handle(req), req.headers.get("origin"));
});

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  let body: { op?: string; code?: string; accounts?: Account[]; allowWrite?: string[] };
  try { body = await req.json(); } catch { return json({ error: "bad body" }, 400); }
  try {
    if (body.op === "enroll") return await enroll(body);
    if (body.op === "refresh") {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
      const { data: owner } = await admin.from("app_owner").select("user_id").maybeSingle();
      if (!u?.user || !owner || u.user.id !== owner.user_id) return json({ error: "unauthorized" }, 401);
      const { data: last } = await admin.from("gmail_state").select("updated_at").order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (last?.updated_at && Date.now() - Date.parse(last.updated_at) < 20_000) return json({ ok: true, throttled: true });
      const r = await poll();
      // Tell the page only whether it worked: no addresses, counts or errors leave the server.
      return json({ ok: r.ok });
    }
    if (body.op === "poll") {
      const { cronSecret } = await config();
      if (!cronSecret || !safeEqual(req.headers.get("x-cron-secret") || "", cronSecret)) return json({ error: "unauthorized" }, 401);
      return await poll();
    }
    return json({ error: "unknown op" }, 400);
  } catch (e) {
    return json({ error: errText(e) }, 500);
  }
}
