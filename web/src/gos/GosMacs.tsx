// "Your Macs" on the phone (PS GOS settings): restart, shut down or lock the developer's Macs, each command
// signed by the phone's own key after his fingerprint (ps-gos CmdKey.kt, src/gos/cmdsign.ts). The
// phone announces that key in an UNSIGNED sdev record; it counts only once the developer clicks Trust phone on
// each Mac and checks the six digit code shown here. The Mac checks every signature, the 2 minute
// window and replays, shows a 10 second Cancel card when it is unlocked, and answers with an ack.
import { useEffect, useState, useSyncExternalStore } from "react";
import { docs, pokeSecond, put, vaultStore } from "../core/vault";
import { isOnline, machineMs, type AckBody, type StatBody } from "../core/second";
import { EMPTY_LOCAL, parseEnv, secondView } from "../second/view";
import { phoneCode, phoneKey, signCmd, type CmdAction, type PhoneKey } from "./cmdsign";
import { haptic } from "./bridge";

/** Announce this phone's command key once (one record per phone, updated if the key changed). */
async function announce(k: PhoneKey) {
  const old = docs<{ phone?: boolean; device?: string; pub?: string }>("sdev").find((d) => d.data.phone && d.data.device === k.device);
  if (old && old.data.pub === k.pub) return;
  await put("sdev", { phone: true, device: k.device, pub: k.pub, name: "Phone", at: Date.now() }, old ? { id: old.id } : {});
  void pokeSecond("stat");
}

const fmt = (ms: number | null) => ms ? new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";

export function GosMacs() {
  const snap = useSyncExternalStore(vaultStore.subscribe, vaultStore.get);
  const [key, setKey] = useState<PhoneKey | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, { id: string; action: CmdAction; at: number; err?: string }>>({});

  useEffect(() => { void phoneKey().then((k) => { setKey(k); if (k && snap.status === "unlocked") void announce(k).catch(() => {}); }); }, [snap.status]);
  const all = [...(snap.docs?.values?.() ?? [])];
  const macs = secondView(all, EMPTY_LOCAL).devices.filter((d) => d.role !== "none" && d.pub);
  useEffect(() => {
    if (!key) return;
    for (const m of macs) if (!codes[m.device]) void phoneCode(m.pub, key.pub).then((c) => setCodes((x) => ({ ...x, [m.device]: c })));
  }, [key, macs.map((m) => m.device).join()]);

  // The newest status per Mac, and the Mac's answer to our last command.
  const stats = new Map<string, StatBody>();
  for (const d of docs<{ env?: unknown }>("sstat")) {
    const b = parseEnv<StatBody>(d.data.env);
    if (b?.t === "stat" && (!stats.has(b.from) || b.at > stats.get(b.from)!.at)) stats.set(b.from, b);
  }
  const ackOf = (id: string) => {
    for (const d of docs<{ ref?: string; env?: unknown }>("sack")) {
      const b = parseEnv<AckBody>(d.data.env);
      if (b?.ref === id) return b;
    }
    return null;
  };

  async function send(to: string, name: string, action: CmdAction) {
    if (busy) return;
    setBusy(to + action); haptic("press");
    const r = await signCmd(to, name, action);
    if ("error" in r) { setSent((x) => ({ ...x, [to]: { id: "", action, at: Date.now(), err: r.error } })); setBusy(null); return; }
    await put("scmd", { env: r.env });
    void pokeSecond("cmd");
    setSent((x) => ({ ...x, [to]: { id: r.id, action, at: Date.now() } }));
    setBusy(null);
  }

  if (!key) return null;
  return (
    <section className="gos-group">
      <h3>Your Macs</h3>
      <p className="gos-note">Restart, shut down or lock a Mac from here. Each one asks for your fingerprint, and a Mac someone is using shows a 10 second Cancel first. First trust this phone once on each Mac: Second Computer, Machine, Trust phone, and check the code matches.</p>
      {macs.length === 0 && <p className="gos-note">No Mac has announced itself yet (PS app V1.23 on the Mac, Second Computer set up).</p>}
      {macs.map((m) => {
        const st = stats.get(m.device), mc = st?.machine, online = isOnline(st);
        const s = sent[m.device], ack = s?.id ? ackOf(s.id) : null;
        const verb = s ? (s.action === "restart" ? "Restart" : s.action === "shutdown" ? "Shut down" : s.action === "lock" ? "Lock" : "Cancel") : "";
        const reply = !s ? "" : s.err ? `${verb}: ${s.err}` : ack ? (ack.ok ? `${verb}: done` : `${verb}: ${ack.reason || "refused"}`)
          : Date.now() - s.at > 120_000 ? `${verb}: no answer in 2 minutes (asleep or offline), dropped` : `${verb}: sent, waiting for the Mac`;
        const deadline = mc?.timer?.deadline ? machineMs(mc.timer.deadline) : null;
        return (
          <div key={m.device} className="gos-mac">
            <div className="gos-mac-h"><b>{m.name}</b><span className={`gos-dot ${online ? "on" : ""}`}>{online ? "Online" : "Offline"}</span></div>
            <p className="gos-note">
              {mc ? `${mc.locked ? "Locked" : "Unlocked"}` : "No status yet"}
              {mc?.timer && mc.timer.mode !== "off" ? ` · Auto reboot ${mc.timer.mode === "active" ? "on" : "watch only"}, ${mc.timer.hours} h${deadline ? `, ${mc.timer.mode === "active" ? "restarts" : "would restart"} ${fmt(deadline)}` : ""}` : ""}
              {mc?.lastRestart ? ` · Last restart ${fmt(machineMs(mc.lastRestart.at))}` : mc?.bootedAt ? ` · Up since ${fmt(machineMs(mc.bootedAt))}` : ""}
            </p>
            <p className="gos-note">Code for Trust phone on this Mac: <b>{codes[m.device] ?? "..."}</b></p>
            <div className="gos-mac-b">
              {(["restart", "shutdown", "lock"] as const).map((a) => (
                <button key={a} type="button" className="gos-btn" disabled={!!busy} onClick={() => void send(m.device, m.name, a)}>
                  {a === "restart" ? "Restart" : a === "shutdown" ? "Shut down" : "Lock"}
                </button>
              ))}
              {s && !s.err && !ack && s.action !== "lock" && s.action !== "cancel" && (
                <button type="button" className="gos-btn" disabled={!!busy} onClick={() => void send(m.device, m.name, "cancel")}>Cancel it</button>
              )}
            </div>
            {reply && <p className="gos-note">{reply}</p>}
          </div>
        );
      })}
    </section>
  );
}
