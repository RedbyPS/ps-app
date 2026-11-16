// Remote restart, shut down and lock of the developer's Macs from the phone (Second Computer protocol
// section 13, signer role "phone"). The GOS shell holds a P-256 key that needs the fingerprint for
// EVERY signature (ps-gos CmdKey.kt), so this page can ask but never sign by itself; the shell also
// refuses anything that is not a short lived cmd from this phone. The Macs check the signature
// against the phone key the developer trusted on each Mac.
import { gosPost, onShell } from "./bridge";

export type CmdAction = "restart" | "shutdown" | "lock" | "cancel";
export type PhoneKey = { device: string; pub: string };
export type Env = { body: string; sig: string; by: string };

let key: Promise<PhoneKey | null> | null = null;

/** This phone's command key (made on first use; no fingerprint needed to read the public half). */
export function phoneKey(): Promise<PhoneKey | null> {
  key ??= new Promise((res) => {
    const off = onShell((m) => {
      if (m.type !== "cmdKey") return;
      off(); clearTimeout(t)
      res(typeof m.device === "string" && typeof m.pub === "string" ? { device: m.device, pub: m.pub } : null);
    });
    const t = setTimeout(() => { off(); key = null; res(null); }, 10_000);
    gosPost({ type: "cmdKey:get" });
  });
  return key;
}

/** A signed command for one Mac, after the developer's fingerprint; null if he cancelled or the shell refused. */
export async function signCmd(to: string, toName: string, action: CmdAction, now = Date.now()): Promise<{ env: Env; id: string } | { error: string }> {
  const k = await phoneKey();
  if (!k) return { error: "No phone key" };
  const id = crypto.randomUUID();
  const body = JSON.stringify({ v: 1, t: "cmd", id, from: k.device, to, at: now, exp: now + 120_000, action });
  const req = crypto.randomUUID();
  return new Promise((res) => {
    const off = onShell((m) => {
      if (m.type !== "cmd:signed" || m.req !== req) return;
      off(); clearTimeout(t);
      if (typeof m.sig === "string" && m.by === k.device) res({ env: { body, sig: m.sig, by: k.device }, id });
      else res({ error: typeof m.error === "string" ? m.error : "Not signed" });
    });
    const t = setTimeout(() => { off(); res({ error: "No answer from the fingerprint prompt" }); }, 90_000);
    gosPost({ type: "cmd:sign", req, body, toName: toName.slice(0, 40) });
  });
}

export { phoneCode } from "../core/phonecode";
