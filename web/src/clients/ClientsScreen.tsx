// The Clients workspace (PS 1.73, the developer 21 Nov 2026; design: ps-handover-notes/clients-designs.md, the one simple design).
// One screen, read top to bottom, one project at a time: the client tabs, the project (switcher, New project, the ... menu),
// the stage line, the next call (only when Google Calendar is linked), then Tasks, Checklist and Notes. Full screen; the host
// (ClientsButton.tsx) opens and closes it. Esc closes whatever is open on top first (bits.tsx cwEscape), then Clients.
// Everything is sealed in the vault like the rest (core/clientsact.ts). Nothing here reads or sends anything about 1Password
// or Signal, and nothing is ever sent to a client: 'Share with client' is only a placeholder for the next piece.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientRec, Doc, Project, Todo } from "../core/model";
import { allTodos, clientStatus, clientViews, type ClientView, type ProjectView } from "../core/select";
import { useVault, todayISO } from "../ui/kit";
import {
  colourOf, dayEndAt, dayWords, followCall, percentDone, projectTasks, reorder, stageLine, yourDayWords,
} from "../core/clientwork";
import {
  checkAdd, checkRemove, checkTick, editClientTodo, newClient, newProject, orderClients, projectFromTemplate, removeClient,
  renameClient, renameProject, saveNotes, saveTemplate, setProjectStatus, templates, addClientTodo,
} from "../core/clientsact";
import { calEvents, dayRuleOf, endHmOf, landDayNow, nextCallOf, useLandTick } from "./clientsday";
import { StageLine } from "./StageLine";
import { Tasks, type Call } from "./Tasks";
import { I, Pop, cwEscape, initials } from "./bits";
import "./clients.css";

export { cwEscape };
type Where = "mac" | "phone" | "web";
const SHOWN = new Set(["client", "pending"]);
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage blocked: this run only */ } },
};

export function ClientsScreen({ onClose, where }: { onClose: () => void; where: Where }) {
  const s = useVault();
  const tick = useLandTick(s);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 760);
  useEffect(() => { const f = () => setNarrow(window.innerWidth < 760); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  const phone = where === "phone" || narrow;
  const [msg, setMsg] = useState<{ t: string; n: number } | null>(null);
  const say = (t: string) => setMsg((m) => ({ t, n: (m?.n ?? 0) + 1 }));
  useEffect(() => { if (!msg) return; const h = window.setTimeout(() => setMsg(null), 4200); return () => window.clearTimeout(h); }, [msg]);

  // Esc: the top popover first, never Clients and a popover in one press.
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape" && cwEscape()) { e.preventDefault(); e.stopImmediatePropagation(); } };
    window.addEventListener("keydown", f, true);
    return () => window.removeEventListener("keydown", f, true);
  }, []);

  const clients = useMemo(() => clientViews(s).filter((c) => c.client && SHOWN.has(clientStatus(c))), [s]);
  const [sel, setSel] = useState<string | null>(() => store.get("ps-cw-client"));
  const cur = clients.find((c) => c.client!.id === sel) ?? clients[0] ?? null;
  const pick = (id: string) => { setSel(id); store.set("ps-cw-client", id); };
  const day = useMemo(() => landDayNow(s), [s, tick]);   // eslint-disable-line react-hooks/exhaustive-deps
  const todos = useMemo(() => allTodos(s).filter((d) => d.ws === null) as Doc<Todo>[], [s]);

  // A deadline that is a call follows it when it moves in Google Calendar (and says so when it is cancelled).
  useEffect(() => {
    const cal = calEvents(s);
    if (!cal) return;
    for (const d of todos) {
      const dl = d.data.deadline;
      if (!dl?.eventId || d.data.done || !d.data.clientId) continue;
      const ev = cal.byId.get(dl.eventId) ?? null;
      const when = Date.parse(`${dl.date}T12:00:00`);
      const p = followCall(d.data, ev && ev.start ? { start: ev.start, title: ev.title } : null, when >= cal.from && when <= cal.to);
      if (p) void editClientTodo(d.id, p);
    }
  }, [s]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`clw-screen${phone ? " clw-phone" : ""}`}>
      <Tabs clients={clients} cur={cur} pick={pick} onClose={onClose} phone={phone} say={say} />
      <div className="clw-main clw-scrl">
        {cur ? <ClientPage key={cur.client!.id} c={cur} day={day} todos={todos} phone={phone} say={say} where={where} />
          : <div className="clw-inner"><div className="clw-none"><b>No clients yet</b><span>Add your first client with + at the top.</span></div></div>}
      </div>
      {msg && <div key={msg.n} className="clw-toast" role="status">{msg.t}</div>}
    </div>
  );
}

// ---------- the client tabs ----------
function Tabs({ clients, cur, pick, onClose, phone, say }: { clients: ClientView[]; cur: ClientView | null; pick: (id: string) => void; onClose: () => void; phone: boolean; say: (t: string) => void }) {
  const [ren, setRen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  const startRen = (c: Doc<ClientRec>) => { setRen(c.id); setName(c.data.name); };
  const endRen = () => { if (ren && name.trim()) void renameClient(ren, name); setRen(null); };
  const add = async () => {
    let id: string;
    try { id = await newClient("New client", clients.length, todayISO()); }
    catch (e) { say(e instanceof Error ? e.message : "Could not add a client now."); return; }
    pick(id);
    setRen(id); setName("New client");
  };
  return (
    <div className="clw-tabs">
      <div className="clw-tabwrap">
        {clients.map((c, i) => {
          const d = c.client!;
          const on = cur?.client!.id === d.id;
          return (
            <div key={d.id} className={`clw-tab${on ? " on" : ""}${over === i ? " over" : ""}`} style={{ ["--c" as string]: colourOf(d.data, i) }}
              draggable={ren !== d.id} onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", d.data.name); }}
              onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOver(i); } }} onDragLeave={() => setOver((o) => (o === i ? null : o))}
              onDragEnd={() => { setDrag(null); setOver(null); }}
              onDrop={(e) => { e.preventDefault(); if (drag !== null && drag !== i) void orderClients(reorder(clients.map((x) => x.client!.id), drag, i)); setDrag(null); setOver(null); }}
              onClick={() => { if (on && phone) startRen(d); else pick(d.id); }} onDoubleClick={() => startRen(d)} title="Double click to rename. Drag to move.">
              <span className="clw-mono">{initials(d.data.name)}</span>
              {ren === d.id
                ? <input className="clw-ren" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={endRen} onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => { if (e.key === "Enter") endRen(); if (e.key === "Escape") { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setRen(null); } }} onClick={(e) => e.stopPropagation()} />
                : <span className="nm">{d.data.name}</span>}
              {on && ren !== d.id && <button type="button" className="clw-tabx" aria-label={`Remove ${d.data.name}`} onClick={(e) => { e.stopPropagation(); setAsk(d.id); }}>{I.x}</button>}
              {ask === d.id && (
                <Pop className="clw-menu l clw-confirm" onClose={() => setAsk(null)}>
                  <div className="clw-small">Remove {d.data.name} from Clients? Its projects and tasks stay in your vault.</div>
                  <div className="row">
                    <button type="button" className="clw-btn sm" onClick={() => setAsk(null)}>Cancel</button>
                    <button type="button" className="clw-btn sm danger" onClick={() => { setAsk(null); void removeClient(d.id).then(() => say(`${d.data.name} removed.`)); }}>Remove</button>
                  </div>
                </Pop>
              )}
            </div>
          );
        })}
        <button type="button" className="clw-newc" aria-label="New client" title="New client" onClick={() => void add()}>{I.plus}</button>
      </div>
      <div className="clw-right">
        {!phone && <span className="clw-esc">Esc</span>}
        <button type="button" className="clw-x" aria-label="Close Clients" onClick={onClose}>{I.x}</button>
      </div>
    </div>
  );
}

// ---------- one client ----------
const STATUS: Record<string, { w: string; c: string }> = { on_track: { w: "On track", c: "good" }, action_needed: { w: "Waiting on client", c: "warn" }, at_risk: { w: "Waiting on client", c: "warn" } };

function ClientPage({ c, day, todos, phone, say, where }: { c: ClientView; day: string; todos: Doc<Todo>[]; phone: boolean; say: (t: string) => void; where: Where }) {
  const s = useVault();
  const client = c.client!;
  const projects = c.projects.filter((p) => !p.p.archived);
  const selKey = `ps-cw-proj-${client.id}`;
  const [sel, setSel] = useState<string | null>(() => store.get(selKey));
  const pv = projects.find((p) => p.doc.id === sel) ?? projects[0] ?? null;
  const pick = (id: string) => { setSel(id); store.set(selKey, id); };
  const call = useMemo(() => { const n = nextCallOf(s, client); return n.ev && n.ev.start ? { ev: n.ev, who: n.who } as Call : null; }, [s, client]);
  const [prep, setPrep] = useState<string | null>(null);
  const today = todayISO();
  const rule = dayRuleOf(s), endHm = endHmOf(s);
  const dayLine = yourDayWords(day, dayEndAt(Date.now(), rule), endHm);

  if (!pv) {
    return (
      <div className="clw-inner">
        <div className="clw-none"><b>No projects yet</b><span>{client.data.name} has no projects here.</span>
          <button type="button" className="clw-btn pri" onClick={() => void newProject(client.data.ws, "First project", today).then(pick)}>{I.plus}New project</button></div>
      </div>
    );
  }
  const list = projectTasks(todos, pv.doc.id);
  const addPrep = async () => {
    if (!call) return;
    const dl = { date: "", time: null as string | null, eventId: call.ev.id, title: call.ev.title };
    const d = new Date(call.ev.start!);
    const p = (n: number) => String(n).padStart(2, "0");
    dl.date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; dl.time = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const id = await addClientTodo(client.id, pv.doc.id, { title: `Prep for the ${call.ev.title}`, type: "once", repeat: null, due: null, deadline: dl, doOn: dl.date });
    setPrep(id);
  };
  return (
    <div className="clw-inner">
      <Head c={c} pv={pv} projects={projects} pick={pick} say={say} today={today} list={list} />
      <StageLine id={pv.doc.id} p={pv.p} today={today} upright={phone} say={say} popOpen={() => {}} />
      {call && <NextCall call={call} onPrep={() => void addPrep()} where={where} />}
      <div className="clw-cols">
        <Tasks clientId={client.id} projectId={pv.doc.id} list={list} day={day} endHm={endHm} dayLine={dayLine} call={call} say={say} prep={prep} onPrepDone={() => setPrep(null)} />
        <Checklist id={pv.doc.id} pv={pv} />
        <Notes key={pv.doc.id} id={pv.doc.id} text={pv.priv?.data.notes ?? ""} />
      </div>
    </div>
  );
}

function Head({ c, pv, projects, pick, say, today, list }: { c: ClientView; pv: ProjectView; projects: ProjectView[]; pick: (id: string) => void; say: (t: string) => void; today: string; list: Doc<Todo>[] }) {
  const [menu, setMenu] = useState<"switch" | "new" | "more" | "tpl" | null>(null);
  const [ren, setRen] = useState(false);
  const [title, setTitle] = useState(pv.p.title);
  const [name, setName] = useState("");
  const p = pv.p, client = c.client!;
  const n = p.stages.length, done = Math.min(p.current, n);
  const allDone = n > 0 && done >= n;
  const st = allDone ? { w: "Done", c: "done" } : STATUS[p.status ?? "on_track"] ?? STATUS.on_track;
  const due = [...p.stages].reverse().find((x) => x.due)?.due;
  const tpls = menu ? templates() : [];
  const create = async () => {
    const t = name.trim();
    if (!t) return;
    const id = await newProject(client.data.ws, t, today);
    setMenu(null); setName(""); pick(id);
    say(`${t} added with three stages to start. Click a stage to change it.`);
  };
  const fromTpl = async (tid: string) => {
    setMenu(null);
    const r = await projectFromTemplate(tid, client, today);
    if (r) { pick(r.id); say(`${templates().find((x) => x.id === tid)?.data.name ?? "Project"} made from the template: ${r.stages} stages, ${r.steps} steps, ${r.tasks} tasks.`); }
  };
  const endRen = () => { setRen(false); if (title.trim() && title !== p.title) void renameProject(pv.doc.id, title); };
  const tplList = (
    <>
      {tpls.map((t) => <button key={t.id} type="button" className="clw-mi" onClick={() => void fromTpl(t.id)}>{I.tpl}{t.data.name}<span className="s">{t.data.stages.length} stages</span></button>)}
      {!tpls.length && <div className="clw-mi muted">No templates yet. Save one from the ... menu.</div>}
    </>
  );
  return (
    <div className="clw-phead">
      <div className="clw-pswitch">
        {ren
          ? <input className="clw-pren" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={endRen} onKeyDown={(e) => { if (e.key === "Enter") endRen(); }} />
          : <button type="button" className="clw-ptitle" onClick={() => setMenu(menu === "switch" ? null : "switch")}><span>{p.title}</span>{I.down}</button>}
        {menu === "switch" && (
          <Pop className="clw-menu l" onClose={() => setMenu(null)}>
            <div className="k">{c.name}</div>
            {projects.map((x) => (
              <button key={x.doc.id} type="button" className={`clw-mi${x.doc.id === pv.doc.id ? " on" : ""}`} onClick={() => { pick(x.doc.id); setMenu(null); }}>
                {x.p.title}<span className="s">{percentDone(x.p.stages, x.p.current)}%</span>
              </button>
            ))}
            <hr />
            <button type="button" className="clw-mi" onClick={() => setMenu("new")}>{I.plus}New project</button>
          </Pop>
        )}
        <div className="clw-pmeta">
          <button type="button" className={`clw-pill ${st.c}`} disabled={allDone}
            onClick={() => void setProjectStatus(pv.doc.id, p.status === "action_needed" ? "on_track" : "action_needed")}>{st.w}</button>
          <i className="dot" /><span>{stageLine(p.stages, done)}</span>
          {due && <><i className="dot" /><span>Due {dayWords(due).split(" ").slice(1).join(" ")}</span></>}
          {projects.length > 1 && <><i className="dot" /><span>{projects.length} projects</span></>}
        </div>
      </div>
      <div className="clw-pacts">
        <button type="button" className="clw-btn" onClick={() => setMenu(menu === "new" ? null : "new")}>{I.plus}New project</button>
        <button type="button" className="clw-btn icon" aria-label="Project menu" onClick={() => setMenu(menu === "more" ? null : "more")}>{I.dots}</button>
        {menu === "new" && (
          <Pop className="clw-menu r" onClose={() => setMenu(null)}>
            <div className="k">New project</div>
            <div className="form">
              <input className="clw-inp" autoFocus placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
              <button type="button" className="clw-btn pri" disabled={!name.trim()} onClick={() => void create()}>Create</button>
            </div>
            <div className="k">Or start from a template</div>
            {tplList}
          </Pop>
        )}
        {menu === "more" && (
          <Pop className="clw-menu r" onClose={() => setMenu(null)}>
            <button type="button" className="clw-mi" onClick={() => { setMenu(null); setTitle(p.title); setRen(true); }}>{I.pen}Rename project</button>
            <button type="button" className="clw-mi" onClick={() => { setMenu(null); void saveTemplate(pv.doc.id, client.data.name, list, today).then((nm) => nm && say(`Saved '${nm}' as a template. It is under New project.`)); }}>{I.tpl}Save as template</button>
            <button type="button" className="clw-mi" onClick={() => setMenu("tpl")}>{I.plus}New project from template</button>
            <hr />
            <button type="button" className="clw-mi muted" onClick={() => { setMenu(null); say(`Coming next: a private link so ${client.data.name} can see this project's stages.`); }}>{I.link}Share with client<span className="tag">Next</span></button>
          </Pop>
        )}
        {menu === "tpl" && (
          <Pop className="clw-menu r" onClose={() => setMenu(null)}>
            <div className="k">New project from template</div>
            {tplList}
          </Pop>
        )}
      </div>
    </div>
  );
}

function NextCall({ call, onPrep, where }: { call: Call; onPrep: () => void; where: Where }) {
  const a = new Date(call.ev.start!), b = call.ev.end ? new Date(call.ev.end) : null;
  const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const days = Math.round((Date.parse(`${iso(a)}T12:00:00`) - Date.parse(`${todayISO()}T12:00:00`)) / 864e5);
  const rel = days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  const join = call.ev.link || call.ev.open || null;
  return (
    <div className="clw-call">
      <div className="ic">{I.video}</div>
      <div className="txt">
        <div className="k">Next call</div>
        <div className="w">{dayWords(iso(a))}, {hm(a)}{b ? ` to ${hm(b)}` : ""}<em>{rel}</em></div>
        <div className="t">{call.ev.title}{call.who ? ` with ${call.who}` : ""}</div>
      </div>
      <span className="clw-sp" />
      <button type="button" className="clw-btn" title="A task with this call as its deadline" onClick={onPrep}>{I.flag}Add prep task</button>
      {join && <a className="clw-btn pri" href={join} target="_blank" rel="noreferrer noopener" onClick={(e) => { if (where === "mac") { e.preventDefault(); window.open(join, "_blank", "noopener"); } }}>{I.video}Join</a>}
    </div>
  );
}

function Checklist({ id, pv }: { id: string; pv: ProjectView }) {
  const list = pv.priv?.data.checklist ?? [];
  const [text, setText] = useState("");
  const done = list.filter((x) => x.done).length;
  const add = () => { const t = text.trim(); if (!t) return; void checkAdd(id, t); setText(""); };
  return (
    <div className="clw-col">
      <div className="clw-col-h"><b>Checklist</b><span>{list.length ? `${done} of ${list.length}` : ""}</span></div>
      <div className="clw-prog"><i style={{ width: `${list.length ? (done / list.length) * 100 : 0}%` }} /></div>
      <div className="clw-rows">
        {list.map((x) => (
          <div key={x.id} className={`clw-crow${x.done ? " done" : ""}`}>
            <button type="button" className={`clw-ck sm${x.done ? " on" : ""}`} aria-label={x.done ? "Not done" : "Done"} onClick={() => void checkTick(id, x.id)} />
            <span className="tt">{x.text}</span>
            <button type="button" className="clw-rm" aria-label={`Remove ${x.text}`} onClick={() => void checkRemove(id, x.id)}>{I.x}</button>
          </div>
        ))}
      </div>
      <div className="clw-addline">
        <input className="clw-inp" placeholder="Add a step" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <button type="button" className="clw-btn" disabled={!text.trim()} onClick={add}>Add</button>
      </div>
    </div>
  );
}

function Notes({ id, text }: { id: string; text: string }) {
  const [v, setV] = useState(text);
  const last = useRef(text);
  const timer = useRef<number | null>(null);
  const flush = (val = v) => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } if (val !== last.current) { last.current = val; void saveNotes(id, val); } };
  useEffect(() => { if (text !== last.current && document.activeElement?.className !== "clw-notes") { last.current = text; setV(text); } }, [text]);
  useEffect(() => () => { if (timer.current) { window.clearTimeout(timer.current); if (v !== last.current) void saveNotes(id, v); } });   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="clw-col">
      <div className="clw-col-h"><b>Notes</b></div>
      <textarea className="clw-notes" value={v} placeholder="Type here" onChange={(e) => { const val = e.target.value; setV(val); if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => flush(val), 900); }} onBlur={() => flush()} />
      <div className="clw-enc">{I.lock}End to end encrypted</div>
    </div>
  );
}

export type { Project };
