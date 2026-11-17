// Checklist reminder (PS 1.65). Three pieces, all thin: the rules are core/chkremind.ts, the clock is src/chkwatch.ts.
//  - ChecklistReminderHost (the website): starts the clock and draws the pop-up, the same pink card as the Annoying 15 minute reminder
//    (views/remind.css rm-card). On the Mac the card is the shell's (Sources/Reminders.swift) and the clock runs in PS's engine page.
//  - ChecklistScreens (inside the Tab list, Mac and website): "Rethink to do list" (the big headline, the counter, every task with
//    Delete and Send to Dimension X, an Undo) and "I forgot" (pick one task, then "Add it to the Dynamic Island?").
// Every change goes through the list's own actions (taskMapActions.remove and restore, the same Dimension X write as dragging a task out
// of the list, setWorkingOn for the island), so Undo, sync and the island behave exactly as they do from the list. Esc closes everything.
// Nothing here takes the keyboard focus on its own and nothing is saved except those ordinary task changes.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { remLook } from "../core/remind";
import { sfx } from "../ui/sfx";
import { useLeave } from "../ui/leave";
import { startChkWatch, chkAnswered, useChkCard } from "../chkwatch";
import { closeChkScreen, openChkScreen, useChkScreen } from "../chkscreen";
import { feature } from "../core/features";
import { CHK_FEATURE, CHK_BANDS, CHK_BG, CHK_ACCENT, CHK_CHOICES, CHK_WORDS, checklistTasks, counter, dimxCard, dimxQueue, needsIslandPin, sureOk, type ChkChoice } from "../core/chkremind";
import type { DimxItem, DimxZone, Doc, Todo } from "../core/model";
import type { TabLists } from "../core/groups";
import { taskMapActions } from "./TaskMap";
import "./remind.css";
import "./chkremind.css";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- the website's pop-up ----------
/** Mounted once on the website (App.tsx): starts the clock there and draws the pop-up when it is time. */
export function ChecklistReminderHost() {
  useEffect(() => { startChkWatch(null); }, []);
  const c = useChkCard();
  // It fades out like the Mac's card (ui/leave.ts); Esc and the buttons only work while it is really open.
  const { shown, out } = useLeave(c.open ? (c.test ? "test" : "live") : null);   // a plain value: the card object is new every render
  return shown ? <ChkCard test={shown === "test"} out={out} /> : null;
}

function ChkCard({ test, out }: { test: boolean; out: boolean }) {
  const [box, setBox] = useState(false);
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const l = remLook(CHK_BG, CHK_ACCENT);
  const style = { "--rc-bg": CHK_BG, "--rc-acc": CHK_ACCENT, "--rc-ink": l.ink, "--rc-sub": l.sub, "--rc-lift": l.lift, "--rc-glow": `${l.glow}%`,
    "--rc-pill": l.pill, "--rc-btn": `${l.btn}%`, "--rc-on": l.on, "--rc-field": l.field, "--rc-ph": l.ph } as CSSProperties;
  const answer = (o: "rethink" | "forgot" | "sure" | "esc") => { sfx.click(); chkAnswered(o); };
  const pick = (i: ChkChoice) => { if (i === 1) { setBox(true); window.setTimeout(() => input.current?.focus(), 30); } else answer(i === 0 ? "rethink" : "forgot"); };
  const confirm = () => { if (sureOk(typed)) answer("sure"); else { setWrong((n) => n + 1); input.current?.select(); } };
  // Esc backs out of the typed yes first, then closes the card (one layer at a time, before anything behind it hears the key).
  const boxRef = useRef(box);
  boxRef.current = box;
  useEffect(() => {
    if (out) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (boxRef.current) { setBox(false); setTyped(""); } else answer("esc");
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [out]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`chk-pop${out ? " out" : ""}`} role="dialog" aria-label={CHK_WORDS.headline}>
      <div className={`rm-card live chk-card${box ? " box" : ""}`} style={style}>
        <span className="rm-card-pill"><i />{CHK_WORDS.pill}{test ? " · test" : ""}</span>
        <button type="button" className="chk-x" aria-label="Close (Esc)" onClick={() => answer("esc")}>&times;</button>
        <h3>{CHK_WORDS.headline}</h3>
        {!box ? (
          <div className="chk-choices">
            {CHK_CHOICES.map((w, i) => <button key={w} type="button" className={`rm-card-b chk-b${i === 0 ? " main" : ""}`} onClick={() => pick(i as ChkChoice)}>{w}</button>)}
          </div>
        ) : (
          <div className="rm-card-box chk-box">
            <small>{CHK_WORDS.areYouSure} {CHK_WORDS.typeYes}</small>
            <div className="rm-card-in">
              <input ref={input} key={wrong} className={`chk-in${wrong ? " wrong" : ""}`} value={typed} placeholder={`Type ${CHK_WORDS.yesWord}`} maxLength={30} autoComplete="off" spellCheck={false}
                onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirm(); } }} />
              <button type="button" className="rm-card-b main chk-b" onClick={confirm}>{CHK_WORDS.done}</button>
            </div>
            {wrong > 0 && <p className="chk-hint">{CHK_WORDS.onlyYes}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- the screens inside the Tab list ----------
type Props = { lists: TabLists; dimx: DimxItem[]; working: string[]; docked?: boolean };
type Undo = { key: number; at: number; text: string; verb: string; restore: () => Promise<unknown> };
/** How long an Undo stays, and how many a stack keeps. */
const UNDO_MS = 6000, UNDO_MAX = 8;

/** Mounted once in the Tab list (views/TaskMap.tsx), next to Dimension X. Draws nothing until a screen is opened. */
export function ChecklistScreens(p: Props) {
  const screen = useChkScreen();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  // The Mac's shell calls window.__psChk("rethink" | "forgot") after a choice on its card (Sources/main.swift onChk).
  useEffect(() => {
    const w = window as Window & { __psChk?: (s: unknown) => void };
    w.__psChk = (s) => { if (feature("checklist-reminder")) openChkScreen(s); };
    return () => { delete w.__psChk; };
  }, []);
  useLayoutEffect(() => { setHost(p.docked ? document.body : anchor.current?.closest<HTMLElement>(".tm-overlay") ?? document.body); }, [p.docked, screen]);
  return (
    <>
      <span ref={anchor} className="chk-anchor" aria-hidden="true" />
      {screen && host && createPortal(<Screen key={screen} kind={screen} {...p} />, host)}
    </>
  );
}

function Screen({ kind, lists, dimx, working }: Props & { kind: "rethink" | "forgot" }) {
  const tasks = useMemo(() => checklistTasks(lists), [lists]);
  const total0 = useRef(tasks.length);            // how many there were when it opened: the counter counts against this
  const [gone, setGone] = useState(0);
  const [undos, setUndos] = useState<Undo[]>([]);       // a short stack: each Delete or Send keeps its own Undo
  const [menu, setMenu] = useState<string | null>(null);     // the task whose Dimension X bands are showing
  const [picked, setPicked] = useState<Doc<Todo> | null>(null);
  const live = useRef({ dimx, working });
  live.current = { dimx, working };
  // Dimension X writes and deletes go one after the other (core/chkremind.ts dimxQueue): two quick sends never drop a card.
  const q = useRef<ReturnType<typeof dimxQueue> | null>(null);
  if (!q.current) q.current = dimxQueue(() => live.current.dimx, (l) => taskMapActions.dimx(l), (id) => taskMapActions.remove(id));
  useEffect(() => { q.current!.fresh(); }, [dimx]);
  const push = (u: Omit<Undo, "key" | "at">) => setUndos((l) => [...l, { ...u, key: Date.now() + Math.random(), at: Date.now() }].slice(-UNDO_MAX));
  const close = () => { sfx.drop(); closeChkScreen(); };
  // Esc closes everything, before anything behind it hears the key.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopImmediatePropagation(); close(); };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  useEffect(() => {
    if (!undos.length) return;
    const t = window.setTimeout(() => setUndos((l) => l.filter((u) => Date.now() - u.at < UNDO_MS)), Math.max(50, UNDO_MS - (Date.now() - undos[0].at)));
    return () => window.clearTimeout(t);
  }, [undos]);

  const del = (d: Doc<Todo>) => {
    sfx.click();
    const data = d.data;
    setMenu(null);
    void q.current!.run(() => taskMapActions.remove(d.id)).then((ok) => {
      if (!ok) return;
      setGone((n) => n + 1);
      push({ text: data.title, verb: CHK_WORDS.deleted, restore: () => q.current!.run(async () => { await taskMapActions.restore(d.id, data); setGone((n) => Math.max(0, n - 1)); }) });
    });
  };
  const send = (d: Doc<Todo>, zone: DimxZone) => {
    sfx.click();
    const data = d.data;
    setMenu(null);
    // The card is saved first; the task is deleted only after that write went through.
    void q.current!.send(dimxCard({ id: d.id, title: data.title }, zone, new Date().toISOString())).then((ok) => {
      if (!ok) return;
      setGone((n) => n + 1);
      push({ text: data.title, verb: CHK_WORDS.sent, restore: () => q.current!.unsend(d.id, async () => { await taskMapActions.restore(d.id, data); setGone((n) => Math.max(0, n - 1)); }) });
    });
  };
  const toIsland = (yes: boolean) => {
    sfx.click();
    if (yes && picked && needsIslandPin(live.current.working, picked.id)) void taskMapActions.work(picked.id);
    closeChkScreen();
  };

  const c = counter(total0.current, gone);
  return (
    <div className={`chk-layer${reduced() ? " still" : ""}`} onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) close(); }}>
      <section className={`chk-win chk-${kind}`} role="dialog" aria-modal="true" aria-label={kind === "rethink" ? CHK_WORDS.rethink : CHK_WORDS.forgot}>
        <button type="button" className="chk-close" onClick={close} aria-label="Close (Esc)" title="Close (Esc)">&times;</button>
        {kind === "rethink" ? (
          <>
            <h2 className="chk-big">{CHK_WORDS.rethinkHeadline}</h2>
            {c.need > 0 && (
              <p className={`chk-count${c.reached ? " reached" : ""}`} role="status" aria-live="polite">
                <span className="num">{c.label}</span>
                {c.reached && <button type="button" className="chk-done" onClick={close}>{CHK_WORDS.done}</button>}
              </p>
            )}
            <ul className="chk-list">
              {tasks.map((d) => (
                <li key={d.id} className="chk-row">
                  <span className="chk-t" title={d.data.title}>{d.data.title || "Untitled task"}</span>
                  <span className="chk-acts">
                    {menu === d.id ? (
                      <span className="chk-bands" role="group" aria-label={CHK_WORDS.send}>
                        {CHK_BANDS.map((b) => <button key={b.zone} type="button" className="chk-btn" onClick={() => send(d, b.zone)}>{b.title}</button>)}
                      </span>
                    ) : (
                      <>
                        <button type="button" className="chk-btn" onClick={() => { sfx.click(); setMenu(d.id); }}>{CHK_WORDS.send}</button>
                        <button type="button" className="chk-btn danger" onClick={() => del(d)}>{CHK_WORDS.del}</button>
                      </>
                    )}
                  </span>
                </li>
              ))}
              {!tasks.length && <li className="chk-empty">{CHK_WORDS.empty}</li>}
            </ul>
          </>
        ) : !picked ? (
          <>
            <h2 className="chk-big">{CHK_WORDS.pickTitle}</h2>
            <ul className="chk-list">
              {tasks.map((d) => (
                <li key={d.id}><button type="button" className="chk-pick" onClick={() => { sfx.click(); setPicked(d); }}>{d.data.title || "Untitled task"}</button></li>
              ))}
              {!tasks.length && <li className="chk-empty">{CHK_WORDS.empty}</li>}
            </ul>
          </>
        ) : (
          <div className="chk-ask">
            <p className="chk-task">{picked.data.title || "Untitled task"}</p>
            <h2 className="chk-big">{CHK_WORDS.islandAsk}</h2>
            <div className="chk-yn">
              <button type="button" className="chk-btn main" onClick={() => toIsland(true)}>{CHK_WORDS.yes}</button>
              <button type="button" className="chk-btn" onClick={() => toIsland(false)}>{CHK_WORDS.no}</button>
            </div>
          </div>
        )}
        {undos.length > 0 && (() => {
          const undo = undos[undos.length - 1];
          return (
            <div className="chk-undo" role="status">
              <span>{undo.verb}: {undo.text.length > 40 ? `${undo.text.slice(0, 40)}...` : undo.text}{undos.length > 1 ? ` (+${undos.length - 1})` : ""}</span>
              <button type="button" onClick={() => { sfx.click(); setUndos((l) => l.filter((u) => u.key !== undo.key)); void undo.restore(); }}>{CHK_WORDS.undo}</button>
            </div>
          );
        })()}
      </section>
    </div>
  );
}
