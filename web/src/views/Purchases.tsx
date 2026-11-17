// Purchases (PS 1.65): the finance screen over the person's saved receipts, and the button that opens it (in the Tab list on the Mac,
// the website's list, and the phone's menu). It reads the vault's receipts (src/receipts.ts) and does every sum in core/purchases.ts,
// so this file only draws. Scanning a receipt is on the phone only (views/ReceiptScan.tsx); viewing is everywhere. On the Mac's Tab
// list the photo of a receipt is not available (that window holds no keys): it opens on the website and the phone.
// Esc (everywhere) and Back (the phone) close the newest screen first. Reduced motion turns the fade off.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { GOS } from "../gos/bridge";
import { sfx } from "../ui/sfx";
import { toISODate } from "../ui/kit";
import { receiptScan } from "../gos/receiptscan";
import { fmtMoney, type Receipt } from "../core/receipts";
import { byMonth, byShop, clickSort, defaultQuery, leftOut, mainCurrency, monthCompare, recent, shopsOf, tableRows, topItems, type Rc, type SortKey, type TableQuery } from "../core/purchases";
import { flushOrphans, useReceiptCurrency, useReceipts, useReceiptsOn } from "../receipts";
import { ReceiptCheck, ReceiptScan, ReceiptTyped, receiptHost, useCloseKeys } from "./ReceiptScan";
import { draftOf } from "../core/receipts";
import "./purchases.css";

export const PW = {
  button: "Purchases", title: "Purchases", close: "Close", scan: "Scan receipt", add: "Add by typing",
  thisMonth: "This month", lastMonth: "Last month", vs: "vs last month", more: "more", less: "less", same: "the same", nothingLast: "no spending last month",
  receipts: "Receipts", items: "Items", recent: "Recent purchases", top: "Most bought items", byShop: "Spending by shop", byMonth: "Spending by month", all: "All receipts and items",
  times: "times", search: "Search shops, dates and items", allShops: "All shops", from: "From", to: "To", clear: "Clear",
  date: "Date", shop: "Shop", item: "Item", qty: "Qty", amount: "Amount", count: "Items",
  none: "No purchases yet.", noneHint: "Scan a receipt on your phone and it shows up here.", noneTyped: "You can also add one by typing.",
  noRows: "Nothing matches.", noShop: "No shop name", leftOut: "left out of the sums, they are in another currency",
  receiptWord: "receipt", receiptsWord: "receipts", spent: "spent",
} as const;

// ---------- who has it open ----------
let open = false;
const subs = new Set<() => void>();
const setOpen = (v: boolean) => { open = v; subs.forEach((f) => f()); };
export const openPurchases = () => setOpen(true);
const useOpen = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => open, () => false);

const ICON = <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h12v18l-2.5-1.6L13 21l-2-1.6L9 21l-2.5-1.6L6 21zM9 8h6M9 12h6M9 16h3" /></svg>;

/** The Purchases button for the Tab list (and the website's list, and the phone's menu): shows only when Receipts is on. */
export function ReceiptButton() {
  const on = useReceiptsOn();
  if (!on) return null;
  return (
    <div className="rc-wrap" onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className="tm-pill-btn rc-btn" aria-label={PW.button} title={PW.button} onClick={() => { sfx.click(); openPurchases(); }}>
        {ICON}<span className="rc-lab">{PW.button}</span>
      </button>
      <PurchasesHost />
    </div>
  );
}

function PurchasesHost() {
  const isOpen = useOpen();
  return isOpen ? <PurchasesScreen onClose={() => setOpen(false)} /> : null;
}

// ---------- the pieces ----------
const mLabel = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }); };

function Bars({ data, cur, label }: { data: { label: string; value: number }[]; cur: string; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const W = 360, H = 120, pad = 18, bw = Math.max(6, (W - pad * 2) / data.length - 6);
  return (
    <svg className="pc-bars" viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={label}>
      {data.map((d, i) => {
        const h = Math.round((Math.max(0, d.value) / max) * H), x = pad + i * ((W - pad * 2) / data.length) + 3;
        const bh = Math.max(h, d.value > 0 ? 2 : 0);   // a tiny month still shows, and grows up from the line like the rest
        return (
          <g key={d.label}>
            <rect x={x} y={H - bh} width={bw} height={bh} rx="2"><title>{`${d.label}: ${fmtMoney(d.value, cur)}`}</title></rect>
            <text x={x + bw / 2} y={H + 13} textAnchor="middle">{mLabel(d.label)}</text>
          </g>
        );
      })}
    </svg>
  );
}
function HBars({ data, cur }: { data: { label: string; value: number }[]; cur: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="pc-hbars">
      {data.map((d) => (
        <li key={d.label}>
          <span className="pc-hl">{d.label}</span>
          <span className="pc-ht"><i style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }} /></span>
          <span className="pc-hv num">{fmtMoney(d.value, cur)}</span>
        </li>
      ))}
    </ul>
  );
}

function Delta({ m, cur }: { m: ReturnType<typeof monthCompare>; cur: string }) {
  if (m.spent === 0 && m.before === 0) return <span className="pc-dl">{PW.nothingLast}</span>;
  const dir = m.diff > 0 ? PW.more : m.diff < 0 ? PW.less : PW.same;
  return (
    <span className={`pc-dl ${m.diff > 0 ? "up" : m.diff < 0 ? "down" : ""}`}>
      {m.diff === 0 ? `${PW.same} ${PW.vs}` : `${fmtMoney(Math.abs(m.diff), cur)} ${dir} ${m.pct === null ? "" : `(${Math.abs(m.pct)}%) `}${PW.vs}`.replace("  ", " ")}
    </span>
  );
}

const SortHead = ({ k, q, set, children, num }: { k: SortKey; q: TableQuery; set: (q: TableQuery) => void; children: string; num?: boolean }) => (
  <th className={num ? "num" : ""} aria-sort={q.sort === k ? (q.dir === "asc" ? "ascending" : "descending") : "none"}>
    <button type="button" onClick={() => set(clickSort(q, k))}>{children}{q.sort === k ? (q.dir === "asc" ? " ↑" : " ↓") : ""}</button>
  </th>
);

// ---------- the screen ----------
export function PurchasesScreen({ onClose }: { onClose: () => void }) {
  const list = useReceipts();
  const pref = useReceiptCurrency();
  const [sub, setSub] = useState<null | "scan" | "type" | { id: string; r: Receipt }>(null);
  const [q, setQ] = useState<TableQuery>(defaultQuery());
  useCloseKeys(sub === null, onClose);
  const today = toISODate(new Date());
  const cur = useMemo(() => mainCurrency(list, pref), [list, pref]);
  const month = useMemo(() => monthCompare(list, cur, today), [list, cur, today]);
  const shops = useMemo(() => byShop(list, cur, 6, PW.noShop), [list, cur]);
  const months = useMemo(() => byMonth(list, cur, today, 12), [list, cur, today]);
  const top = useMemo(() => topItems(list, cur, 8), [list, cur]);
  const last = useMemo(() => recent(list, 6), [list]);
  const rows = useMemo(() => tableRows(list, q), [list, q]);
  const names = useMemo(() => shopsOf(list), [list]);
  const out = leftOut(list, cur);
  const byId = (id: string) => list.find((x) => x.id === id);
  const phone = GOS && receiptScan.available();
  useEffect(() => { void flushOrphans(); }, []);   // a photo whose delete failed before is tried again now
  useEffect(() => { document.body.classList.add("pc-open"); return () => document.body.classList.remove("pc-open"); }, []);
  return createPortal(
    <div className="pc-layer" role="dialog" aria-modal="true" aria-label={PW.title} onMouseDown={(e) => e.stopPropagation()}>
      <div className="pc-screen">
        <header className="pc-head">
          <h2>{PW.title}</h2>
          <span className="pc-gap" />
          {phone && <button type="button" className="pc-b on" onClick={() => setSub("scan")}>{PW.scan}</button>}
          <button type="button" className="pc-b" onClick={() => setSub("type")}>{PW.add}</button>
          <button type="button" className="pc-x" aria-label={PW.close} onClick={onClose}>&times;</button>
        </header>
        {list.length === 0 ? (
          <div className="pc-empty"><p>{PW.none}</p><p>{PW.noneHint}</p><p>{PW.noneTyped}</p></div>
        ) : (
          <div className="pc-scroll">
            <section className="pc-cards">
              <div className="pc-card"><small>{PW.thisMonth}</small><b className="num">{fmtMoney(month.spent, cur)}</b><Delta m={month} cur={cur} /></div>
              <div className="pc-card"><small>{PW.lastMonth}</small><b className="num">{fmtMoney(month.before, cur)}</b></div>
              <div className="pc-card"><small>{PW.receipts}</small><b className="num">{list.length}</b>{out > 0 && <span className="pc-dl">{out} {PW.leftOut}</span>}</div>
            </section>
            <section className="pc-grid">
              <div className="pc-box"><h3>{PW.byMonth}</h3><Bars data={months} cur={cur} label={PW.byMonth} /></div>
              <div className="pc-box"><h3>{PW.byShop}</h3><HBars data={shops} cur={cur} /></div>
              <div className="pc-box"><h3>{PW.recent}</h3>
                <ul className="pc-list">{last.map((x) => (
                  <li key={x.id}><button type="button" onClick={() => setSub(x)}><span className="pc-d num">{x.r.date}</span><span className="pc-n">{x.r.shop || PW.noShop}</span><span className="num">{fmtMoney(x.r.total, x.r.cur)}</span></button></li>
                ))}</ul>
              </div>
              <div className="pc-box"><h3>{PW.top}</h3>
                {top.length === 0 ? <p className="pc-mute">{PW.noRows}</p> : <ul className="pc-list">{top.map((t) => (
                  <li key={t.key}><span className="pc-row"><span className="pc-n">{t.name}</span><span className="pc-mute num">{t.times} {PW.times}</span><span className="num">{fmtMoney(t.spent, cur)}</span></span></li>
                ))}</ul>}
              </div>
            </section>
            <section className="pc-table">
              <h3>{PW.all}</h3>
              <div className="pc-tools">
                <div className="pc-seg" role="group" aria-label={PW.all}>
                  <button type="button" className={q.mode === "receipts" ? "on" : ""} aria-pressed={q.mode === "receipts"} onClick={() => setQ({ ...q, mode: "receipts", sort: q.sort === "name" || q.sort === "qty" ? "date" : q.sort })}>{PW.receipts}</button>
                  <button type="button" className={q.mode === "items" ? "on" : ""} aria-pressed={q.mode === "items"} onClick={() => setQ({ ...q, mode: "items" })}>{PW.items}</button>
                </div>
                <input type="search" className="pc-search" placeholder={PW.search} aria-label={PW.search} value={q.text} onChange={(e) => setQ({ ...q, text: e.target.value })} />
                <select aria-label={PW.shop} value={q.shop} onChange={(e) => setQ({ ...q, shop: e.target.value })}>
                  <option value="">{PW.allShops}</option>{names.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <label className="pc-dt"><span>{PW.from}</span><input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></label>
                <label className="pc-dt"><span>{PW.to}</span><input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></label>
                {(q.text || q.shop || q.from || q.to) && <button type="button" className="pc-link" onClick={() => setQ({ ...q, text: "", shop: "", from: "", to: "" })}>{PW.clear}</button>}
              </div>
              <div className="pc-tw">
                <table>
                  <thead><tr>
                    <SortHead k="date" q={q} set={setQ}>{PW.date}</SortHead>
                    <SortHead k="shop" q={q} set={setQ}>{PW.shop}</SortHead>
                    {q.mode === "items" ? <><SortHead k="name" q={q} set={setQ}>{PW.item}</SortHead><SortHead k="qty" q={q} set={setQ} num>{PW.qty}</SortHead></> : <th className="num">{PW.count}</th>}
                    <SortHead k="amount" q={q} set={setQ} num>{PW.amount}</SortHead>
                  </tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.id}:${i}`} tabIndex={0} onClick={() => { const x = byId(r.id); if (x) setSub(x); }} onKeyDown={(e) => { if (e.key === "Enter") { const x = byId(r.id); if (x) setSub(x); } }}>
                        <td className="dt">{r.date}</td><td>{r.shop || PW.noShop}</td>
                        {q.mode === "items" ? <><td>{r.name}</td><td className="num">{r.qty}</td></> : <td className="num">{r.count}</td>}
                        <td className="num">{fmtMoney(r.amount, r.cur)}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={5} className="pc-mute">{PW.noRows}</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </div>
      {sub === "scan" && <ReceiptScan onClose={() => setSub(null)} />}
      {sub === "type" && <ReceiptTyped onClose={() => setSub(null)} />}
      {sub && typeof sub === "object" && <ReceiptCheck id={sub.id} at={sub.r.at} from={sub.r.src} start={draftOf({ ...sub.r, total: sub.r.total }, sub.r.note ?? "")} photoId={sub.r.ph} onClose={() => setSub(null)} />}
    </div>, receiptHost());
}
