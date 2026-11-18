// The developer's private to-do list. One place for everything, with a Reset button he presses himself.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AgendaCard } from "./Agenda";
import { QuotesCard } from "./Quotes";
import { SeriesMap } from "./SeriesMap";
import { AutoResetSetting } from "./AutoReset";
import { resetAtOf, resetAtWords } from "../core/resetday";
import { ScreenTimeCard } from "./ScreenTime";
import { Overlay } from "./TaskMap";
import { endDayGate } from "../rulegate";
import { workingIdsOf, type Doc, type Todo } from "../core/model";
import { clientViews, settingsData, todos } from "../core/select";
import { addTodo, deleteTodo, pushTodo, resetTodos, saveSettings, setTodoOrder, setWorkingOn, toggleTodo, updateTodo } from "../core/actions";
import { useDragOrder } from "../ui/dragOrder";
import { RepeatPicker, StreakBadge } from "../ui/RepeatPicker";
import { draftOf, isDueNow, isEveryDay, patchOf, repeatLabel, type RepeatDraft } from "../core/repeat";
import { DueText, Icon, addDays, fmtDate, fmtDateTime, todayISO, toast, useVault } from "../ui/kit";
import "./todo.css";

// ---------- small helpers shared with the Today view ----------

/** "just now", "12 min ago", "3 hours ago", "yesterday", "4 days ago", else a date. */
export function relTime(ts?: string | null) {
  if (!ts) return "";
  const ms = Date.now() - new Date(ts).getTime();
  if (isNaN(ms)) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return fmtDateTime(ts);
}

export interface ClientOpt { id: string; name: string }
export function useClientOptions(): ClientOpt[] {
  const s = useVault();
  return useMemo(() => clientViews(s).filter((c) => c.client).map((c) => ({ id: c.client!.id, name: c.name })), [s]);
}

/** The Reset button: daily tasks stay and get unticked, finished one-offs are cleared. Always undoable. */
export function ResetButton({ small, label = "Reset list" }: { small?: boolean; label?: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const undo = await resetTodos();
      toast("List reset", { label: "Undo", run: () => { void undo().then(() => toast("Reset undone")); } }, 8000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className={small ? "btn ghost sm" : "btn primary td-reset"}
      onClick={() => endDayGate("docked", () => void run())}
      disabled={busy}
      title="Unticks your daily tasks and clears finished one-offs. Unfinished one-offs stay."
    >
      <Icon name="reset" size={small ? 16 : 18} /> {busy ? "Resetting" : label}
    </button>
  );
}

const HINT_KEY = "cv.todo.resetHintSeen";
function readFlag(k: string) { try { return localStorage.getItem(k) === "1"; } catch { return false; } }
function writeFlag(k: string) { try { localStorage.setItem(k, "1"); } catch { /* private window */ } }

/** Set the date (no date yet) or push it back (counts as a push). */
async function moveDate(d: Doc<Todo>, by: number | string) {
  if (!d.data.due) {
    const due = typeof by === "string" ? by : addDays(todayISO(), by);
    await updateTodo(d.id, { due });
    toast(`Due ${fmtDate(due)}`);
    return;
  }
  await pushTodo(d.id, by);
}

async function removeWithUndo(d: Doc<Todo>) {
  const data = structuredClone(d.data);
  await deleteTodo(d.id);
  toast("Task deleted", { label: "Undo", run: () => { void addTodo({ ...data }); } }, 8000);
}

/** Swap the order of two visible neighbours (keeps manual priority inside a group). */
async function swapOrder(a: Doc<Todo>, b: Doc<Todo>) {
  const ao = a.data.order ?? 0, bo = b.data.order ?? 0;
  if (ao === bo) { await updateTodo(a.id, { order: bo - 0.5 }); return; }
  await updateTodo(a.id, { order: bo });
  await updateTodo(b.id, { order: ao });
}

// ---------- a row ----------
const TD_REPEAT = { wrap: "td-repeat small", select: "select", input: "input td-num", date: "td-date" };

/** One-off, Every day, or Repeat (every other day, week, month, year, custom). */
function TypeToggle({ value, onChange }: { value: RepeatDraft; onChange: (d: RepeatDraft) => void }) {
  const set = (k: RepeatDraft["kind"]) => onChange({ ...value, kind: k });
  const opts = [["once", "One-off"], ["daily", "Every day"], ["repeat", "Repeat"]] as const;
  return (
    <>
      <div className="tabs" role="radiogroup" aria-label="Task type">
        {opts.map(([k, l]) => (
          <button key={k} type="button" className="tab" role="radio" aria-checked={value.kind === k} aria-selected={value.kind === k} onClick={() => set(k)}>{l}</button>
        ))}
      </div>
      {value.kind === "repeat" && <RepeatPicker value={value} onChange={onChange} cls={TD_REPEAT} />}
    </>
  );
}

function ClientSelect({ value, onChange, clients }: { value: string; onChange: (v: string) => void; clients: ClientOpt[] }) {
  if (!clients.length) return null;
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Link to a client">
      <option value="">No client</option>
      {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

function Editor({ d, clients, onDone }: { d: Doc<Todo>; clients: ClientOpt[]; onDone: () => void }) {
  const [title, setTitle] = useState(d.data.title);
  const [notes, setNotes] = useState(d.data.notes || "");
  const [rule, setRule] = useState<RepeatDraft>(() => draftOf(d.data, todayISO()));
  const type = rule.kind === "once" ? "once" : "daily";
  const [due, setDue] = useState(d.data.due || "");
  const [clientId, setClientId] = useState(d.data.clientId || "");
  const save = async () => {
    const t = title.trim();
    if (!t) { toast("A task needs a title"); return; }
    const r = patchOf(rule, todayISO(), d.data);
    await updateTodo(d.id, { title: t, notes: notes.trim() || null, type: r.type, repeat: r.repeat, due: r.type === "once" ? due || null : r.due ?? null, clientId: clientId || null });
    onDone();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onDone(); }
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); void save(); }
  };
  return (
    <div className="td-edit" onKeyDown={key}>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task title" autoFocus />
      <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Notes" />
      <div className="td-opts">
        <TypeToggle value={rule} onChange={(n) => setRule(n.kind === "repeat" && rule.kind !== "repeat" ? { ...n, from: due || todayISO() } : n)} />
        {type === "once" && (
          <label className="row small" style={{ gap: 6 }}>
            <span className="muted">Due</span>
            <input type="date" className="td-date" value={due} onChange={(e) => setDue(e.target.value)} />
            {due && <button type="button" className="btn quiet sm" onClick={() => setDue("")}>Clear</button>}
          </label>
        )}
        <ClientSelect value={clientId} onChange={setClientId} clients={clients} />
      </div>
      <div className="td-edit-actions">
        <button className="btn primary sm" onClick={() => void save()}><Icon name="check" size={16} /> Save</button>
        <button className="btn quiet sm" onClick={onDone}>Cancel</button>
        <span className="spacer" />
        <button className="btn danger sm" onClick={() => void removeWithUndo(d)}><Icon name="trash" size={16} /> Delete</button>
      </div>
    </div>
  );
}

type DragProps = ReturnType<ReturnType<typeof useDragOrder>["row"]>;

export function TodoRow({ d, clients, onUp, onDown, n, drag }: {
  d: Doc<Todo>;
  clients: ClientOpt[];
  onUp?: () => void;
  onDown?: () => void;
  n?: number;          // priority number (1 = most urgent), shown on the right
  drag?: DragProps;    // drag to reorder
}) {
  const [editing, setEditing] = useState(false);
  const [tray, setTray] = useState(false);
  const t = d.data;
  const once = t.type !== "daily";
  const every = isEveryDay(t);
  const late = !every && !t.done && !!t.due && t.due < todayISO();
  const waiting = !isDueNow(t, todayISO());
  const client = t.clientId ? clients.find((c) => c.id === t.clientId) : undefined;
  const working = workingIdsOf(settingsData(useVault())).includes(d.id) && !t.done;

  return (
    <li className={`todo-row td-row${t.done ? " done" : ""}${late ? " late" : ""}${waiting ? " waiting" : ""}${working ? " working" : ""}${drag ? " can-drag" : ""}`}
      ref={drag?.ref} style={drag?.style} data-dragging={drag?.["data-dragging"]} onPointerDown={editing ? undefined : drag?.onPointerDown}>
      {drag && !editing && <span className="drag-grip" aria-hidden="true" title="Drag to reorder"><Icon name="grip" size={16} /></span>}
      <input
        type="checkbox" className="check" checked={t.done}
        onChange={() => void toggleTodo(d.id)}
        aria-label={`${t.done ? "Untick" : "Tick off"}: ${t.title}`}
      />
      <div className="t-body">
        {editing ? <Editor d={d} clients={clients} onDone={() => setEditing(false)} /> : (
          <>
            <button className="td-plain td-title-btn" onClick={() => void setWorkingOn(d.id)} onDoubleClick={() => setEditing(true)}
              aria-pressed={working} title={working ? "Working on this. Click to stop, double-click to edit" : "Click: working on it. Double-click: edit"}>
              {working && <span className="td-working">Working on</span>}{t.title}
            </button>
            {t.notes && <p className="td-notes">{t.notes}</p>}
            <div className="td-meta">
              {once && t.due && <DueText iso={t.due} done={t.done} />}
              {!once && !every && <span className="chip td-chip rep">{repeatLabel(t.repeat)}</span>}
              {!once && !every && t.due && (waiting ? <span className="xs muted">next {fmtDate(t.due)}</span> : <DueText iso={t.due} done={t.done} />)}
              {t.source === "fireflies" && <span className="chip td-chip call"><Icon name="meetings" size={13} /> From call</span>}
              {t.claudeDoneAt && !t.done && (
                <span className="chip td-chip claude" title={`Claude finished this${t.claudeNote ? `: ${t.claudeNote}` : ""}. Tick it to clear it.`}>
                  <Icon name="check" size={13} /> Done by Claude
                </span>
              )}
              {client && <a className="chip td-chip" href={`#/client/${client.id}`}>{client.name}</a>}
              {(t.pushes || 0) > 1 && <span className="xs muted">pushed {t.pushes} times</span>}
            </div>
            {tray && (
              <div className="td-tray">
                {once && !t.done && (
                  <div className="td-tray-row">
                    <span className="label">{t.due ? "Push back" : "Set date"}</span>
                    <button className="btn ghost sm" onClick={() => void moveDate(d, 1)}>{t.due ? "+1 day" : "Tomorrow"}</button>
                    <button className="btn ghost sm" onClick={() => void moveDate(d, 7)}>{t.due ? "+1 week" : "In a week"}</button>
                    <input
                      type="date" className="td-date" min={todayISO()}
                      value={t.due || ""}
                      onChange={(e) => { if (e.target.value && e.target.value !== t.due) void moveDate(d, e.target.value); }}
                      aria-label="Pick a date"
                    />
                  </div>
                )}
                <div className="td-tray-row">
                  <span className="label">Order</span>
                  <button className="btn quiet sm" onClick={onUp} disabled={!onUp} aria-label="Move up"><Icon name="up" size={16} /> Up</button>
                  <button className="btn quiet sm" onClick={onDown} disabled={!onDown} aria-label="Move down"><Icon name="down" size={16} /> Down</button>
                  <span className="spacer" />
                  <button className="btn quiet sm" onClick={() => setEditing(true)}><Icon name="edit" size={16} /> Edit</button>
                  <button className="btn danger sm" onClick={() => void removeWithUndo(d)}><Icon name="trash" size={16} /> Delete</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {!editing && (
        <div className="td-side">
          {once && !t.done && t.due && (
            <>
              <button className="btn quiet sm td-quick" onClick={() => void moveDate(d, 1)} title="Push back one day">+1d</button>
              <button className="btn quiet sm td-quick" onClick={() => void moveDate(d, 7)} title="Push back one week">+1w</button>
            </>
          )}
          {n != null && <span className={`td-prio num${n === 1 ? " top" : ""}`} title={`Priority ${n}`}>P{n}</span>}
          <StreakBadge n={once ? 0 : t.streak} className="td-streak" rule={t.repeat} best={t.bestStreak} />
          <button className="btn quiet icon td-more" onClick={() => setTray((v) => !v)} aria-expanded={tray} aria-label={`More for: ${t.title}`}>
            <Icon name={tray ? "x" : "dots"} />
          </button>
        </div>
      )}
    </li>
  );
}

function RowList({ items, clients, reorder = true, numbered = false }: { items: Doc<Todo>[]; clients: ClientOpt[]; reorder?: boolean; numbered?: boolean }) {
  if (!reorder) {
    return <ul className="td-list">{items.map((d) => <TodoRow key={d.id} d={d} clients={clients} />)}</ul>;
  }
  return <DragRowList items={items} clients={clients} numbered={numbered} />;
}

/** Drag rows (or use Up and Down in the ... tray) to set the order. Numbered lists show P1, P2. */
function DragRowList({ items, clients, numbered }: { items: Doc<Todo>[]; clients: ClientOpt[]; numbered: boolean }) {
  const ids = items.map((d) => d.id);
  const byId = new Map(items.map((d) => [d.id, d]));
  const { order, row, dragging } = useDragOrder(ids, (next) => void setTodoOrder(next));
  const move = (i: number, j: number) => {
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    void setTodoOrder(next);
  };
  return (
    <ul className={`td-list${dragging ? " is-sorting" : ""}`}>
      {order.map((id, i) => {
        const d = byId.get(id);
        return d ? (
          <TodoRow key={id} d={d} clients={clients} n={numbered ? i + 1 : undefined} drag={row(id)}
            onUp={i > 0 ? () => move(i, i - 1) : undefined}
            onDown={i < order.length - 1 ? () => move(i, i + 1) : undefined} />
        ) : null;
      })}
    </ul>
  );
}

function Group({ title, items, clients, tone, reorder, note, numbered }: {
  title: string; items: Doc<Todo>[]; clients: ClientOpt[]; tone?: "overdue" | "today"; reorder?: boolean; note?: string; numbered?: boolean;
}) {
  if (!items.length) return null;
  return (
    <section className={`td-sub td-group${tone ? " " + tone : ""}`} aria-label={title}>
      <div className="td-group-h">
        <h3 className="h3">{title}</h3>
        <span className="count num">{items.length}</span>
        {note && <span className="xs muted">{note}</span>}
      </div>
      <RowList items={items} clients={clients} reorder={reorder} numbered={numbered} />
    </section>
  );
}

// ---------- the page ----------
/** The "How Reset works" help, behind a small i next to the Reset button. */
function ResetInfo() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <span className="td-info" ref={box}>
      <button type="button" className={`td-info-btn${open ? " on" : ""}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="How Reset works" title="How Reset works">i</button>
      {open && (
        <div className="td-info-pop" role="dialog" aria-label="How Reset works">
          <b>How Reset works</b>
          <ul>
            <li>Every day and repeating tasks stay and get unticked. Weekly, monthly and yearly ones move on to their next date.</li>
            <li>A repeating task that was due and not done loses its streak. Midnight never touches a streak, only Reset does.</li>
            <li>Finished one-offs are cleared.</li>
            <li>Unfinished one-offs stay where they are.</li>
          </ul>
          <p className="small muted">Everything you ticked is saved to the day you worked, so the Map shows it later. Before 3pm (Settings) a reset counts for the day before. You can always undo.</p>
        </div>
      )}
    </span>
  );
}

export function TodoView() {
  const s = useVault();
  const clients = useClientOptions();
  const st = settingsData(s);
  const t = todayISO();

  const all = todos(s);
  const byOrder = (a: Doc<Todo>, b: Doc<Todo>) => (a.data.order ?? 0) - (b.data.order ?? 0);
  // Repeating tasks: the ones due now first, then the ones waiting for their next date.
  const daily = all.filter((d) => d.data.type === "daily")
    .sort((a, b) => Number(!isDueNow(a.data, t)) - Number(!isDueNow(b.data, t)) || byOrder(a, b));
  const once = all.filter((d) => d.data.type !== "daily");
  const open = once.filter((d) => !d.data.done);
  const overdue = open.filter((d) => d.data.due && d.data.due < t).sort(byOrder);
  const today = open.filter((d) => d.data.due === t).sort(byOrder);
  const upcoming = open.filter((d) => d.data.due && d.data.due > t)
    .sort((a, b) => a.data.due!.localeCompare(b.data.due!) || byOrder(a, b));
  const nodate = open.filter((d) => !d.data.due).sort(byOrder);
  const done = once.filter((d) => d.data.done).sort((a, b) => (b.data.doneAt || "").localeCompare(a.data.doneAt || ""));

  const dailyLeft = daily.filter((d) => !d.data.done && isDueNow(d.data, t)).length;
  const leftToday = dailyLeft + overdue.length + today.length;
  const later = upcoming.length + nodate.length;
  const allClear = all.length > 0 && leftToday === 0;

  const [mapOpen, setMapOpen] = useState(false);

  return (
    <div className="stack loose">
      <QuotesCard />

      <header className="td-head">
        <div className="td-title-block">
          <span className="label">Your list</span>
          <h1 className="h1">To-do</h1>
          {all.length > 0 ? (
            <p className="td-summary">
              <b className="num">{leftToday} left today</b>
              {overdue.length > 0 && <span className="late num">{overdue.length} overdue</span>}
              {later > 0 && <span className="muted small num">{later} for later</span>}
            </p>
          ) : <p className="muted">One place for everything. Add the first thing below.</p>}
        </div>
        <div className="td-reset-block">
          <button type="button" className="btn ghost td-map" onClick={() => setMapOpen(true)} title="Open your series map: title each month, note each day">
            <Icon name="map" size={17} /> Map
          </button>
          <div className="td-reset-row">
            <ResetButton />
            <ResetInfo />
          </div>
          <span className="td-last">{st.lastResetAt ? `Last reset: ${relTime(st.lastResetAt)}` : "Not reset yet"}</span>
        </div>
      </header>

      {/* The same board as the Tab list (hold Tab anywhere): everything you change here shows there. */}
      <Overlay docked onClose={() => {}} hint="The same list as your Tab view. Click a task to work on it, drag it to set its priority, drag a new task in." />

      {allClear && (
        <div className="td-party" role="status">
          <div className="seal"><Icon name="check" size={26} /></div>
          <div className="stack tight">
            <span className="big">All done for today{st.ownerName ? `, ${st.ownerName}` : ""}.</span>
            <span className="muted small">{later > 0 ? `${later} thing${later > 1 ? "s" : ""} waiting for later. ` : ""}End your day with the moon button or Reset.</span>
          </div>
        </div>
      )}

      {done.length > 0 && (
        <section className="panel td-group td-done-group" aria-label="Done">
          <Group title="Done" items={done} clients={clients} reorder={false} note="saved to your Map and cleared on the next reset" />
        </section>
      )}

      <AgendaCard />

      <ScreenTimeCard />

      <AutoResetSetting className="td-setting" st={st} save={(p) => {
        const on = p.autoReset ? p.autoReset === "midnight" : st.autoReset === "midnight";
        void saveSettings(p).then(() => toast(!on ? (p.autoReset ? "Automatic reset off" : "Reset time saved")
          : `Will also reset at ${resetAtWords(p.autoResetAt ?? resetAtOf(st))}`));
      }} />
      {mapOpen && <SeriesMap onClose={() => setMapOpen(false)} />}
    </div>
  );
}
