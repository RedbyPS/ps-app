// Settings > Tab overlay shortcuts (V1.47, the developer, 10 Nov 2026: "Make it so you can create your own rhythm for how you
// open PS."). The list of shortcuts that open the Tab list on this Mac: add, change, remove (one always stays), and
// Reset to Tab. Record shortcut listens to the real keys and keeps them by key code, so any keyboard layout works;
// each key shows what it types on this Mac's layout. The rules are in core/openkeys.ts; the Mac checks the list again
// and matches the keys (ps-mac Sources/OpenKeysCore.swift). Clicks only: nothing is saved by typing alone.
import { useEffect, useRef, useState } from "react";
import { psPost, usePsSettings } from "../ps";
import { sfx } from "../ui/sfx";
import { appName } from "../core/appname";
import {
  DEFAULT_LIST, KIND_NAME, describe, edit, keysOf, legacyList, macKeyCode, problems, recPrompt, recStep, tidy,
  worksOverProtected, type OpenKind, type OpenShortcut, type RecState,
} from "../core/openkeys";
import { PermissionRow } from "./PsSettings";
import "./openshortcuts.css";

const KINDS: OpenKind[] = ["hold", "combo", "chord"];

/** The list the Mac uses now (saved, or the old settings as a list until someone changes it). */
function useShortcuts() {
  const st = usePsSettings();
  const sc = st?.shortcuts;
  const list: OpenShortcut[] = sc?.list?.length ? sc.list.map(tidy) : legacyList(st?.triggerKey, st?.slashChord);
  // V1.58: one rule per account (the Mac's BuildRules.swift); PS 1.71: per BUILD. The developer's own build: PS never opens over
  // 1Password or Signal. The G Squad build: it does, for every account.
  const overProtected = sc?.overProtected !== false;
  return { ready: !!st, list, custom: !!sc?.custom, labels: sc?.labels, layout: sc?.layout, taken: new Set(sc?.taken ?? []), error: st?.error, overProtected };
}

/** permission: the Accessibility row on top (off where the page shows it already). */
export function OpenShortcuts({ permission = true }: { permission?: boolean }) {
  const { ready, list, custom, labels, layout, taken, error, overProtected } = useShortcuts();
  // What is being recorded: a new one (index -1) or a change to one in the list.
  const [rec, setRec] = useState<{ index: number; st: RecState } | null>(null);
  const [kind, setKind] = useState<OpenKind>("hold");
  const [note, setNote] = useState<string | null>(null);
  const recRef = useRef(rec);
  recRef.current = rec;

  const save = (next: OpenShortcut[]) => {
    const bad = problems(next).find((p) => p.error);
    if (bad) { setNote(bad.index >= 0 ? `Shortcut ${bad.index + 1}: ${bad.text}` : bad.text); return false; }
    setNote(null);
    psPost({ type: "shortcuts:set", list: next.map(tidy) });
    return true;
  };
  const stop = () => { setRec(null); psPost({ type: "shortcuts:record", on: false }); };
  const start = (index: number, k: OpenKind) => {
    sfx.click();
    setNote(null);
    setRec({ index, st: { kind: k } });
    psPost({ type: "shortcuts:record", on: true });   // the list takes the keyboard, combos rest while it listens
  };

  // The recorder: every key goes here while it listens (nothing else on the page sees it). Esc cancels and still
  // does what Esc always does (it backs out of Settings).
  useEffect(() => {
    if (!rec) return;
    const onKey = (ev: KeyboardEvent) => {
      const cur = recRef.current;
      if (!cur) return;
      if (ev.key === "Escape" || ev.code === "Escape") { stop(); return; }
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const code = macKeyCode(ev.code);
      if (code === undefined) { if (ev.type === "keydown") setNote("PS app cannot use that key. Try another."); return; }
      const step = recStep(cur.st, {
        type: ev.type === "keydown" ? "down" : "up", code, repeat: ev.repeat,
        mods: { cmd: ev.metaKey, ctrl: ev.ctrlKey, opt: ev.altKey, shift: ev.shiftKey },
      });
      if (step.hint) setNote(step.hint);
      if (step.done) {
        stop();
        if (save(edit(list, cur.index, step.done))) sfx.click();
        return;
      }
      setRec({ ...cur, st: step.st });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    const t = window.setTimeout(stop, 29000);   // the Mac stops listening after 30 s by itself too
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("keyup", onKey, true); window.clearTimeout(t); };
  }, [!!rec]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (recRef.current) psPost({ type: "shortcuts:record", on: false }); }, []);

  const probs = problems(list);
  const over = list.filter(worksOverProtected);
  const legacyOver = !custom;   // never changed: plain Tab opens PS over 1Password and Signal, as before

  return (
    <div className="osc">
      {permission && <PermissionRow />}
      <p className="gs-set-note">
        Pick the keys that open your list. A quick tap of any of these keys still types as normal. Your keys are kept by
        where they sit on the keyboard, so any language works{layout ? ` (this Mac types ${layout})` : ""}.
      </p>

      <ul className="osc-list" aria-label="Your shortcuts">
        {list.map((s, i) => {
          const mine = probs.filter((p) => p.index === i);
          const recording = rec?.index === i;
          return (
            <li key={`${i}-${s.kind}-${s.first ?? ""}-${s.key}-${(s.mods ?? []).join("")}`} className={`osc-item${recording ? " rec" : ""}`}>
              <div className="osc-main">
                <span className="osc-kind">{s.kind === "hold" ? "Hold" : s.kind === "combo" ? "Combo" : "Hold, then press"}</span>
                <span className="osc-keys" aria-label={describe(s, labels)}>
                  {keysOf(s, labels).map((k, n) => (
                    <span key={n} className="osc-kgrp">
                      {n > 0 && <span className="osc-join">{s.kind === "chord" ? "then" : "+"}</span>}
                      <kbd className="osc-cap">{k}</kbd>
                    </span>
                  ))}
                </span>
                <span className="osc-acts">
                  <button type="button" className="btn quiet sm" disabled={!ready || !!rec} onClick={() => start(i, s.kind)}>Change</button>
                  <button type="button" className="btn quiet sm" disabled={!ready || !!rec || list.length <= 1}
                    data-tip={list.length <= 1 ? "Keep at least one shortcut" : undefined}
                    onClick={() => { sfx.click(); save(edit(list, i, null)); }}>Remove</button>
                </span>
              </div>
              {recording && <RecBox st={rec!.st} labels={labels} onCancel={stop} />}
              <div className="osc-tags">
                {overProtected && (worksOverProtected(s)
                  ? <span className="osc-tag good">Works over 1Password and Signal</span>
                  : <span className="osc-tag">Not over 1Password or Signal</span>)}
                {s.kind === "combo" && taken.has(comboPlace(list, i)) && <span className="osc-tag bad">Another app already uses this combo</span>}
              </div>
              {mine.map((p, n) => <p key={n} className={`osc-msg${p.error ? " bad" : ""}`}>{p.text}</p>)}
            </li>
          );
        })}
      </ul>

      <div className="osc-add">
        <span className="small osc-add-l" id="osc-kind-l">Add a shortcut</span>
        <div className="tm-ed-seg osc-kinds" role="radiogroup" aria-labelledby="osc-kind-l">
          {KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={`dwell${kind === k ? " on" : ""}`}
              disabled={!!rec} onClick={() => { sfx.hover(); setKind(k); }}>{KIND_NAME[k]}</button>
          ))}
        </div>
        {rec?.index === -1
          ? <RecBox st={rec.st} labels={labels} onCancel={stop} />
          : <button type="button" className="btn sm osc-rec" disabled={!ready || !!rec || list.length >= 12} onClick={() => start(-1, kind)}>
              <span className="osc-dot" aria-hidden="true" />Record shortcut
            </button>}
        <small className="hint">
          {kind === "hold" && "Hold one key, like Tab, Right Option or F13. Letters work too, but make typing wait a moment."}
          {kind === "combo" && "Press keys together once, like Control Option Space. The list stays open until you press it again, Tab or Esc."}
          {kind === "chord" && "Hold one key down, then press a second, like / then . or P then O. Letting go of the first key on its own types it."}
        </small>
      </div>

      {note && <p className="osc-msg bad" role="alert">{note}</p>}
      {error && !note && <p className="osc-msg bad" role="alert">{error}</p>}

      <div className="osc-safe">
        {overProtected ? (
          <p className="gs-set-note">
            <b>Over 1Password and Signal</b> {appName()} never reads a single key, so only shortcuts macOS can match by itself
            work there: holding Tab or an F key, and combos. Chords and holding a letter or a modifier do not.{" "}
            {legacyOver ? "Right now: hold Tab." : over.length
              ? `Right now: ${over.map((s) => describe(s, labels)).join(", ")}.`
              : "Nothing in your list works there yet: add a combo, or hold Tab or an F key."}
          </p>
        ) : (
          <p className="gs-set-note">
            <b>Over 1Password and Signal</b> On your account {appName()} never opens over them, whatever is in this list.
          </p>
        )}
        <p className="gs-set-note">
          If a shortcut ever stops working, Open list on the {appName()} pop-up and in the {appName()} menu always opens your list,
          and Reset to Tab is always here.
        </p>
        <button type="button" className="btn ghost sm" disabled={!ready || !!rec || (!custom && sameAsDefault(list))}
          onClick={() => { sfx.click(); setNote(null); psPost({ type: "shortcuts:reset" }); }}>Reset to Tab</button>
      </div>
    </div>
  );
}

/** Its place among the list's combos (the Mac reports a combo another app holds by that place). */
const comboPlace = (l: OpenShortcut[], i: number) => l.slice(0, i).filter((x) => x.kind === "combo").length;
const sameAsDefault = (l: OpenShortcut[]) => JSON.stringify(l.map(tidy)) === JSON.stringify(DEFAULT_LIST.map(tidy));

function RecBox({ st, labels, onCancel }: { st: RecState; labels?: Record<string, string>; onCancel: () => void }) {
  return (
    <div className="osc-recbox" role="status" aria-live="polite">
      <span className="osc-dot live" aria-hidden="true" />
      <span>{recPrompt(st, labels)}</span>
      <button type="button" className="btn quiet sm" onClick={onCancel}>Cancel</button>
    </div>
  );
}
