// G Squad on your own tasks: "Share with G Squad" and "Anonymise this task?" in the Add task box, and the right click
// menu's Share with G Squad, Anonymise and Hand to. V1.43 (the developer, 8 Nov 2026: "you have to go out of your way to make
// your tasks shared"): a task is shared only when you pick Share with G Squad AND the Tasks switch is on, and both
// start off. While the Tasks switch is off, both places say so and offer to switch it on. Client names are matched
// here against your own vault's clients only to decide whether to ask; the main page matches again before sealing
// (core/squadanon.ts), so the squad copy never depends on this window.
import { useMemo } from "react";
import type { ClientRec, Todo } from "../core/model";
import { clientTerms, namesClient, squadTitle } from "../core/squadanon";
import { cleanShareOpts, shareOn, taskShared } from "../core/squadshare";
import { feature } from "../core/features";
import { P1_FEATURE, p1HideItem } from "../core/squadp1";
import { settingsData } from "../core/select";
import { vaultStore } from "../core/vault";
import { squadNow, squadOp, useSquad } from "../squad/mirror";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";

export type SquadAdd = { sqOn: boolean; sqAnon?: boolean };
/** Switch on task sharing (the Tasks switch in What you share). */
export const shareTasksOn = () => squadOp({ op: "share", piece: "tasks", on: true });
const tasksOn = () => shareOn(cleanShareOpts(settingsData(vaultStore.get()).squadShare), "tasks");

function useTerms() {
  const s = useVault();
  return useMemo(() => clientTerms([...s.docs.values()].filter((d) => d.kind === "client").map((d) => d.data as ClientRec)), [s.docs]);
}

/** Under the task's name in the Add task box, while you are in a squad. Starts at Only you will see this task. */
export function SquadAddRow({ title, clientId, value, onChange }: { title: string; clientId: string; value: SquadAdd; onChange: (v: SquadAdd) => void }) {
  const v = useSquad();
  const st = settingsData(useVault());
  const terms = useTerms();
  if (!v.in) return null;
  if (!shareOn(cleanShareOpts(st.squadShare), "tasks")) return (
    <div className="tm-sq">
      <span className="tm-sq-off">Only you will see this task. Task sharing with G Squad is off.</span>
      <button type="button" className="tm-sq-turn" onMouseDown={(e) => e.preventDefault()} onClick={() => { sfx.click(); shareTasksOn(); }}
        title="Switches Tasks on in What you share. Each task stays yours until you pick Share with G Squad.">Turn on task sharing</button>
    </div>
  );
  const shared = value.sqOn;
  const ask = shared && title.trim() !== "" && namesClient({ title, clientId: clientId || null }, terms);
  return (
    <div className="tm-sq">
      <button type="button" role="switch" aria-checked={shared} className={`tm-sq-sw${shared ? " on" : ""}`} onMouseDown={(e) => e.preventDefault()}
        onClick={() => { sfx.click(); onChange({ ...value, sqOn: !shared }); }} title={shared ? "Your squad will see this task" : "Switch on to share this task with your squad"}>
        <i className="gs-tog" aria-hidden="true"><b /></i>{shared ? "Shared with G Squad" : "Only you will see this task"}
      </button>
      {ask && (
        <span className="tm-sq-ask" role="group" aria-label="Anonymise this task?">
          Anonymise this task?
          <button type="button" className={value.sqAnon !== false ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => { sfx.click(); onChange({ ...value, sqAnon: true }); }}
            title="Your squad sees Client task. You keep the real name.">Anonymous</button>
          <button type="button" className={value.sqAnon === false ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => { sfx.click(); onChange({ ...value, sqAnon: false }); }}
            title="Your squad sees the name as you typed it">Show the name</button>
        </span>
      )}
    </div>
  );
}

export type SquadMenuItem = { key: string; label: string; hint: string; run: () => void; keep?: boolean };
/** The right click menu's G Squad lines for one of your tasks (nothing when you are not in a squad). */
export function squadMenuItems(id: string, t: Todo, clients: ClientRec[], toggleHand: () => void): SquadMenuItem[] {
  const v = squadNow();
  if (!v.in) return [];
  // PS 1.63 Priority 1: a P1 you share with the squad (the Priority 1 switch) can be hidden from it, one task at a time.
  const hide = p1HideItem(t, { featureOn: feature(P1_FEATURE), shareP1: shareOn(cleanShareOpts(settingsData(vaultStore.get()).squadShare), "p1") });
  const p1Line: SquadMenuItem[] = hide ? [{ key: "g", label: hide.label, hint: "G", run: () => { sfx.click(); squadOp({ op: "task", id, sqOff: hide.sqOff }); } }] : [];
  // Task sharing switched off: say so, and offer to switch it on and share this one task.
  if (!tasksOn()) return [...p1Line, { key: "s", label: "Share with G Squad (task sharing is off: this turns it on)", hint: "S",
    run: () => { sfx.click(); shareTasksOn(); squadOp({ op: "task", id, sqOn: true }); } }];
  const shared = taskShared(t);
  const out: SquadMenuItem[] = [...p1Line, { key: "s", label: shared ? "Stop sharing with G Squad" : "Share with G Squad", hint: "S", run: () => { sfx.click(); squadOp({ op: "task", id, sqOn: !shared }); } }];
  if (!shared) return out;
  const terms = clientTerms(clients);
  const anon = squadTitle(t, terms).anon;
  if (anon || namesClient(t, terms)) out.push({ key: "a", label: anon ? "Show the name to G Squad" : "Anonymise for G Squad", hint: "A",
    run: () => { sfx.click(); squadOp({ op: "task", id, sqAnon: !anon }); } });
  if (v.members.some((m) => !m.me)) out.push({ key: "h", label: "Hand to someone", hint: "H", keep: true, run: toggleHand });
  return out;
}
/** The people you can hand a task to, under "Hand to someone". */
export function HandPicker({ id, onDone }: { id: string; onDone: () => void }) {
  const v = useSquad();
  const others = v.members.filter((m) => !m.me);
  return (
    <div className="tm-ctx-date" role="group" aria-label="Hand to someone">
      {others.map((m) => (
        <button key={m.id} type="button" className="tm-ed-chip" onClick={() => { sfx.drop(); squadOp({ op: "hand", id, to: m.id }); onDone(); }}>{m.name}</button>
      ))}
    </div>
  );
}
