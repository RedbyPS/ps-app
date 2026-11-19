// The Mac's half of "sign in by scanning the Mac" (V1.55, src/core/phonepair.ts), inside Settings, Link your iPhone, and
// Edit mode's Link your phone card. While the code is on screen, the Mac keeps one open offer at a time (a new one every
// minute), watches it, and when a phone claims it shows the six digit code with Allow and Not my phone: a PS panel,
// never a pop-up that blocks anything. Allow seals this Mac's sign in to that phone (core/vault.ts sealLinkFor). Below
// it, the phones signed in this way, each with Remove.
// V1.57 (phone-link-fast): the engine is core/pairengine.ts. In PS's Tab list (no keys there) the main window runs it
// and the Tab list shows the mirror (core/pairmac.ts); before, the Tab list quietly showed a code with no sign in in it.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { listPhones, removePhone, type LinkedPhone } from "../core/vault";
import { PAIR_PING_MS, PairEngine } from "../core/pairengine";
import { pairMirror, vaultPairDeps } from "../core/pairmac";
import { PS, psInOverlay, psPost } from "../ps";
import { sfx } from "../ui/sfx";

export type { PairPhase as Phase } from "../core/pairengine";

/** The offer to put in the QR ("" when there is none) and the panel's state. Only while `on`. */
export function usePhonePairing(on: boolean) {
  const viaMain = PS && psInOverlay();
  const local = useMemo(() => (viaMain ? null : new PairEngine(vaultPairDeps(() => sfx.click()))), [viaMain]);
  const store = local ?? pairMirror;
  const view = useSyncExternalStore(useCallback((f: () => void) => store.subscribe(f), [store]), () => store.get());
  const who = useRef(Math.random().toString(36).slice(2, 12).padEnd(8, "0"));
  const ask = useCallback((op: string) => psPost({ type: "looks", patch: { pairOp: { op, who: who.current } } }), []);

  useEffect(() => {
    if (!on) return;
    if (local) { local.start(); return () => local.stop(); }
    ask("start");
    const t = window.setInterval(() => ask("ping"), PAIR_PING_MS);
    return () => { window.clearInterval(t); ask("stop"); };
  }, [on, local, ask]);

  const allow = useCallback(async () => { if (local) await local.allow(); else ask("allow"); }, [local, ask]);
  const deny = useCallback(() => { if (local) local.deny(); else { sfx.click(); ask("deny"); } }, [local, ask]);
  const again = useCallback(async () => { if (local) local.again(); else ask("again"); }, [local, ask]);
  // In the Tab list, a phase from an earlier card must not show in a card that is not asking: only while on.
  const shown = on ? view : { phase: { k: "off" as const }, part: "" };
  return { phase: shown.phase, part: shown.part, allow, deny, again };
}

/** The code, Allow and Not my phone, under the QR. */
export function PairPanel({ p }: { p: ReturnType<typeof usePhonePairing> }) {
  const ph = p.phase;
  if (ph.k === "off" || ph.k === "ready") return null;
  return (
    <div className="li-pair" role="alert">
      {ph.k === "confirm" ? (<>
        <b>A phone scanned your code</b>
        <span className="li-pair-code" aria-label={`Code ${ph.code}`}>{ph.code}</span>
        <span>Does your phone show this same code? Allow signs it in to your PS, with no typing. Only press Allow for your own phone.</span>
        <div className="li-pair-btns">
          <button type="button" className="gs-go" onClick={() => void p.allow()}>Allow</button>
          <button type="button" className="gs-ghost" onClick={p.deny}>Not my phone</button>
        </div>
      </>) : ph.k === "sending" || ph.k === "sent" ? (
        <span>Signing your phone in...</span>
      ) : ph.k === "done" ? (<>
        <b>Your phone is signed in</b>
        <button type="button" className="gs-ghost" onClick={() => void p.again()}>Link another phone</button>
      </>) : (<>
        <span className="li-err">{ph.text}</span>
        <button type="button" className="gs-ghost" onClick={() => void p.again()}>Show a new code</button>
      </>)}
    </div>
  );
}

/** Phones signed in from a Mac, each with Remove. */
export function LinkedPhones({ refresh }: { refresh: unknown }) {
  const [list, setList] = useState<LinkedPhone[] | null>(null);
  const [sure, setSure] = useState<string | null>(null);
  const load = useCallback(() => { void listPhones().then(setList); }, []);
  useEffect(load, [load, refresh]);
  if (!list?.length) return null;
  const day = (s: string) => new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return (
    <div className="li-phones">
      <b>Phones that stay signed in</b>
      {list.map((d, i) => (
        <div className="li-phone" key={d.id}>
          <span>Phone {i + 1}, since {day(d.created_at)}</span>
          {sure === d.id
            ? <button type="button" className="gs-ghost" onClick={() => { sfx.click(); setSure(null); void removePhone(d.id).then(load); }}>Yes, remove</button>
            : <button type="button" className="gs-ghost" onClick={() => setSure(d.id)}>Remove</button>}
        </div>
      ))}
      <small>Remove signs that phone out the next time it opens. Lost a phone? Remove it, then change your passphrase too.</small>
    </div>
  );
}
