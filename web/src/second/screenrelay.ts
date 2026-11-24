// Main Mac WebView only. The vault carries encrypted setup messages and requests short-lived TURN credentials.
import { onScreenSignal, sb, sendScreenSignal, vaultStore } from "../core/vault";
import { screenOn } from "../core/screenswitch";
import { secondOnSnap } from "../core/secondsnap";
import { settingsData } from "../core/select";
import { accountOf } from "../featuresync";

type Post = (message: object) => void;
type RelayMessage = { type?: string; signal?: unknown; req?: unknown; role?: unknown };

function enabled() {
  const vault = vaultStore.get();
  return screenOn(vault, secondOnSnap(vault), settingsData(vault).squadFeatures, accountOf(vault));
}

export function startScreenRelay(post: Post) {
  onScreenSignal((signal) => {
    if (enabled()) post({ type: "screenRelay:signal", signal });
  });
}

export function screenRelayMessage(message: RelayMessage, post: Post): boolean {
  if (message.type === "screenRelay:send") {
    if (enabled()) void sendScreenSignal(message.signal).catch(() => {});
    return true;
  }
  if (message.type !== "screenRelay:creds") return false;
  const req = message.req;
  if (typeof req !== "string" || !/^[0-9A-Fa-f-]{36}$/.test(req)) return true;
  const role = message.role;
  if (role === "primary" || role === "secondary") void credentials(req, role, post);
  return true;
}

async function credentials(req: string, role: "primary" | "secondary", post: Post) {
  const reply = (error: string, creds?: unknown) => post({ type: "screenRelay:creds", req, error, creds });
  if (!enabled()) { reply("sign-in"); return; }
  if (vaultStore.get().local) { reply("setup"); return; }
  try {
    const { data, error } = await sb.functions.invoke("screen-relay", { method: "POST", body: { role } });
    if (!enabled()) { reply("sign-in"); return; }
    if (!error && data) { reply("", data); return; }
    const status = (error as { context?: Response } | null)?.context?.status;
    reply(status === 404 || status === 503 ? "setup" : status === 401 || status === 403 ? "sign-in" : "network");
  } catch {
    reply("network");
  }
}
