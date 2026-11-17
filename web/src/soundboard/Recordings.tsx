// Screen recordings in the Soundboard and on the client's page (PS 1.60, pull request 12c). The rules are in core/recordings.ts (tested),
// the bridge in src/recstore.ts, the uploading, checking, deleting and playing in the Mac app (ScreenRecCloud.swift).
// One list for every device: this Mac shows its own list, the phone and the website show the small details that sync through the
// encrypted vault (never the media). Play: on the Mac it opens PS's own player; elsewhere it opens the cloud's own player when that cloud
// allows it without a server of ours, else it says "Play on your Mac".
// Esc closes the delete question and the rename box (the newest first). Reduced motion: the progress bar does not animate.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useVault } from "../ui/kit";
import { feature } from "../core/features";
import { SR_FEATURE } from "../core/screenrec";
import { useScreenRec } from "../screenrec";
import { askScreenRec } from "../screenrec";
import { askRecordings, clearAsk, recSend, useAsk, useCloud, useMacRecs } from "../recstore";
import {
  REC_WORDS, UP_LABEL, cleanRow, dateText, deleteButtons, deleteQuestion, forClient, lengthText, matchClient, mergeRows, playAction, whereText,
  type PlayDevice, type RecItem,
} from "../core/recordings";
import type { ClientRec, Doc } from "../core/model";
import { WHERE } from "./store";
import "./recordings.css";

const DEVICE: PlayDevice = WHERE;

/** Esc closes the top layer. */
function useEsc(on: boolean, close: () => void) {
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopImmediatePropagation(); close(); };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [on, close]);
}

/** Every recording this device can show: its own list (the Mac) plus the rows other devices synced. */
export function useRecItems(): { items: RecItem[]; clients: Doc<ClientRec>[]; on: boolean } {
  const s = useVault();
  const mac = useMacRecs();
  const st = useScreenRec();
  useEffect(() => { askScreenRec(); askRecordings(); }, []);
  const vaultRows = useMemo(() => [...s.docs.values()].filter((d) => d.kind === "srec").map((d) => cleanRow(d.data)).filter((r): r is NonNullable<typeof r> => !!r), [s.docs]);
  const clients = useMemo(() => [...s.docs.values()].filter((d) => d.kind === "client") as Doc<ClientRec>[], [s.docs]);
  const items = useMemo(() => mergeRows(mac?.rows ?? null, vaultRows), [mac, vaultRows]);
  const on = feature(SR_FEATURE) && (WHERE !== "mac" || !!st?.enabled || items.length > 0);
  return { items, clients, on };
}

export function RecordingsPanel({ clientId, query = "" }: { clientId?: string; query?: string }) {
  const { items, clients, on } = useRecItems();
  const shown = useMemo(() => {
    let list = clientId ? forClient(items, clientId, clients) : items;
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((it) => it.row.title.toLowerCase().includes(q) || (it.row.meeting ?? "").toLowerCase().includes(q));
    return list;
  }, [items, clients, clientId, query]);
  const ask = useAsk();
  const cloud = useCloud();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  useEsc(!!ask, clearAsk);
  useEsc(renaming !== null, () => setRenaming(null));
  if (!on) return <p className="rc-empty">{REC_WORDS.emptyOff}</p>;
  if (!shown.length) return <p className="rc-empty">{clientId ? REC_WORDS.clientEmpty : REC_WORDS.empty}</p>;
  const clientName = (it: RecItem) => { const id = matchClient(it.row.attendees, clients); return id ? clients.find((c) => c.id === id)?.data.name ?? null : null; };
  return (
    <>
      <ul className="rc-list" aria-label={REC_WORDS.tab}>
        {shown.map((it) => {
          const r = it.row, act = playAction(it, DEVICE), cn = clientName(it), up = r.upload;
          return (
            <li key={r.id} className="rc-row">
              <div className="rc-thumb" aria-hidden="true">{r.thumb ? <img src={r.thumb} alt="" /> : <span>{r.audioOnly ? "♪" : "▶"}</span>}</div>
              <div className="rc-main">
                {renaming === r.id ? (
                  <form className="rc-rename" onSubmit={(e) => { e.preventDefault(); if (name.trim()) recSend("recRename", { id: r.id, title: name }); setRenaming(null); }}>
                    <input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-label={REC_WORDS.rename} />
                    <button type="submit" className="rc-b">{REC_WORDS.save}</button>
                    <button type="button" className="rc-b" onClick={() => setRenaming(null)}>{REC_WORDS.cancel}</button>
                  </form>
                ) : <b className="rc-title">{r.title}</b>}
                <span className="rc-meta">
                  {dateText(r.startedAt)} · {lengthText(r.duration)}{r.audioOnly ? ` · ${REC_WORDS.audioOnly}` : ""} · {cn ?? REC_WORDS.noClient} · {whereText(it)}
                </span>
                {up && up.state !== "done" && (
                  <span className="rc-up" role="status">
                    {UP_LABEL[up.state]}{up.state === "uploading" ? ` ${Math.round(up.fraction * 100)}%` : ""}{up.note ? `. ${up.note}` : ""}
                    {up.state === "uploading" && <i style={{ ["--p" as string]: `${Math.round(up.fraction * 100)}%` }} />}
                  </span>
                )}
                {r.cloud?.encrypted && <span className="rc-note">{REC_WORDS.sealedNote}</span>}
                {r.lowered.length > 0 && <span className="rc-note">{REC_WORDS.lowered}</span>}
              </div>
              <div className="rc-actions">
                {act.kind === "play" && <button type="button" className="rc-b primary" onClick={() => recSend("recPlay", { id: r.id })}>{act.label}</button>}
                {act.kind === "open" && <a className="rc-b primary" href={act.url} target="_blank" rel="noopener noreferrer">{act.label}</a>}
                {act.kind === "macOnly" && <span className="rc-b ghost" aria-disabled="true">{act.label}</span>}
                {it.thisMac && (
                  <>
                    <button type="button" className="rc-b" onClick={() => { setName(r.title); setRenaming(r.id); }}>{REC_WORDS.rename}</button>
                    {r.mac && <button type="button" className="rc-b" onClick={() => recSend("recReveal", { id: r.id })}>{REC_WORDS.showInFinder}</button>}
                    {r.cloud && <button type="button" className="rc-b" onClick={() => recSend("recOpenCloud", { id: r.id })}>{REC_WORDS.openCloud}</button>}
                    {r.mac && !r.cloud && !up && cloud && cloud.provider !== "none" && <button type="button" className="rc-b" onClick={() => recSend("recUpload", { id: r.id })}>{REC_WORDS.upload}</button>}
                    {up && (up.state === "failed" || up.state === "unsure") && <button type="button" className="rc-b" onClick={() => recSend("cloudRetry", { id: r.id })}>{REC_WORDS.retry}</button>}
                    <button type="button" className="rc-b danger" onClick={() => recSend("recDelete", { id: r.id })}>{REC_WORDS.delete}</button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {ask && createPortal(
        <div className="rc-dim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) clearAsk(); }}>
          <div className="rc-dialog" role="alertdialog" aria-modal="true" aria-label={REC_WORDS.delete}>
            <p>{deleteQuestion(ask, false)}</p>
            {ask.hasLocal && ask.hasCloud && <p className="rc-note">{deleteQuestion(ask, true)}</p>}
            <div className="rc-dbtns">
              {deleteButtons(ask).map((b) => (
                <button key={b.id} type="button" className={`rc-b${b.danger ? " danger" : ""}`} autoFocus={b.id === "cancel"}
                  onClick={() => { if (b.id !== "cancel") recSend("recDelete", { id: ask.id, confirm: true, alsoCloud: b.also }); clearAsk(); }}>{b.label}</button>
              ))}
            </div>
          </div>
        </div>, document.body)}
    </>
  );
}
