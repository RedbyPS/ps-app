// PS Fitness: the vault side. Programs ("fprog"), workouts ("fwork") and the Fitness settings ("fit") are
// owner private records, encrypted like everything else in PS (zero knowledge: the server sees ciphertext).
// put() writes to this device first (its outbox), so the gym with no signal loses nothing; the vault sends
// the changes once there is signal, and the mergers below join two devices' copies (core/fitness.ts).
import { feature } from "../core/features";
import { useMemo } from "react";
import { moveEx, planFromWorkout, swapEx } from "./gym-logic";
import type { Doc } from "../core/model";
import { put, remove, setMerger, vaultStore, type Snapshot } from "../core/vault";
import { useVault, todayISO } from "../ui/kit";
import { fitPush } from "./sync";
import {
  addSet, endExercise, extraSet, fitSetCount, mergePrefs, mergeProgram, mergeWorkout, nextDay, patchSet, removeSet, setComment, startWorkout, stampPrefs, uidF,
  type FitDay, type FitLogEx, type FitPrefs, type FitProgram, type FitSet, type FitWorkout, type NextDay,
} from "../core/fitness";

setMerger("fwork", (a, b) => mergeWorkout(a as FitWorkout, b as FitWorkout));
setMerger("fprog", (a, b) => mergeProgram(a as FitProgram, b as FitProgram));
setMerger("fit", (a, b) => mergePrefs(a as FitPrefs, b as FitPrefs));

export const DEVICE: FitWorkout["device"] = import.meta.env.MODE === "gos" ? "phone" : import.meta.env.MODE === "ps" ? "mac" : "web";
/** A workout left open longer than this is treated as finished (the developer forgot to press Finish). */
const OPEN_FOR = 6 * 3600_000;

export interface FitView {
  ready: boolean;
  prefs: FitPrefs;
  prefsId: string | null;
  programs: Doc<FitProgram>[];            // newest first, archived last
  program: Doc<FitProgram> | null;        // the active one
  workouts: Doc<FitWorkout>[];            // newest first
  open: Doc<FitWorkout> | null;           // the workout in progress, if any
  next: NextDay | null;                   // which day is next in the active program
}

function view(s: Snapshot): FitView {
  const programs: Doc<FitProgram>[] = [], workouts: Doc<FitWorkout>[] = [], prefsDocs: Doc<FitPrefs>[] = [];
  for (const d of s.docs.values()) {
    const k = d.kind as string;
    if (k === "fprog") programs.push(d as Doc<FitProgram>);
    else if (k === "fwork") workouts.push(d as Doc<FitWorkout>);
    else if (k === "fit") prefsDocs.push(d as Doc<FitPrefs>);
  }
  programs.sort((a, b) => Number(!!a.data.archived) - Number(!!b.data.archived) || b.data.updatedAt.localeCompare(a.data.updatedAt));
  workouts.sort((a, b) => b.data.startedAt.localeCompare(a.data.startedAt));
  // Two devices that each made the settings record while offline: merged into one view, the oldest id kept.
  prefsDocs.sort((a, b) => a.id.localeCompare(b.id));
  const prefs = prefsDocs.reduce<FitPrefs>((acc, d) => mergePrefs(acc, d.data), {});
  const program = programs.find((p) => p.id === prefs.programId && !p.data.archived) ?? programs.find((p) => !p.data.archived) ?? null;
  const fresh = Date.now() - OPEN_FOR;
  const open = workouts.find((w) => !w.data.endedAt && Date.parse(w.data.startedAt) > fresh) ?? null;
  const next = program ? nextDay(program, workouts, prefs.lock) : null;
  return { ready: s.status === "unlocked", prefs, prefsId: prefsDocs[0]?.id ?? null, programs, program, workouts, open, next };
}
/** Everything Fitness shows, from the open vault. */
export function useFitness(): FitView {
  const s = useVault();
  return useMemo(() => view(s), [s]);
}
export const fitnessNow = () => view(vaultStore.get());

// ---------- writes, one at a time (put encrypts before the new copy lands in memory) ----------
// Each one is saved on this device first (put: the vault's encrypted outbox, kept in IndexedDB), and only then is a
// debounced push to the vault booked (sync.ts fitPush, V1.29: in the vault within a few seconds, retried when offline).
let lane: Promise<unknown> = Promise.resolve();
function queue<T>(f: () => Promise<T>): Promise<T> {
  const p = lane.then(f, f);
  lane = p.catch(() => {});
  return fitPush.write(() => p);
}
const nowIso = () => new Date().toISOString();

export function savePrefs(patch: Partial<FitPrefs>) {
  return queue(async () => {
    const v = fitnessNow();
    await put<FitPrefs>("fit", stampPrefs(v.prefs, patch), { id: v.prefsId ?? undefined, ws: null });
  });
}
export function saveProgram(data: FitProgram, id?: string | null) {
  return queue(() => put<FitProgram>("fprog", { ...data, updatedAt: nowIso() }, { id: id ?? undefined, ws: null }));
}
/** A new program, made active (an imported week replaces the last one; the old one is kept, archived). */
export async function addProgram(data: Omit<FitProgram, "createdAt" | "updatedAt">, opts: { activate?: boolean; archiveOld?: boolean } = {}) {
  const at = nowIso();
  const id = await saveProgram({ ...data, createdAt: at, updatedAt: at });
  if (opts.archiveOld) for (const p of fitnessNow().programs) if (p.id !== id && !p.data.archived) await saveProgram({ ...p.data, archived: true }, p.id);
  if (opts.activate !== false) await savePrefs({ programId: id, lock: null });
  return id;
}
export function deleteProgram(id: string) { return queue(() => remove(id)); }
export function newDay(n: number): FitDay { return { id: uidF(), name: `Day ${n}`, title: null, exercises: [] }; }

export function saveWorkout(id: string, w: FitWorkout) {
  return queue(() => put<FitWorkout>("fwork", w, { id, ws: null }));
}
/** Edits always start from the newest copy in memory, so quick taps never undo each other. */
function editWorkout(id: string, f: (w: FitWorkout, at: string) => FitWorkout) {
  return queue(async () => {
    const d = vaultStore.get().docs.get(id) as Doc<FitWorkout> | undefined;
    if (!d) return;
    const at = nowIso();
    await put<FitWorkout>("fwork", f(d.data, at), { id, ws: null });
  });
}
/** Starts the next day of the active program (or the day the developer picked, or a free workout). */
export async function startDay(opts: { dayId?: string | null; week?: number; free?: boolean } = {}): Promise<string> {
  const v = fitnessNow();
  if (v.open) return v.open.id;
  const p = opts.free ? null : v.program;   // a free workout belongs to no program, so it never moves the day on
  const day = p ? p.data.days.find((d) => d.id === (opts.dayId ?? v.next?.dayId)) ?? null : null;
  const week = opts.week ?? v.next?.week ?? 1;
  const w = startWorkout(p, day, week, v.workouts, new Date(), todayISO(), DEVICE, v.prefs);
  return queue(() => put<FitWorkout>("fwork", w, { ws: null }));
}
/** New sets start at the last weight: the feature "gym-scan-better" and Fitness settings, both default on. */
const startLastOn = () => feature("gym-scan-better") && fitnessNow().prefs.startLast !== false;
export const setPatch = (id: string, exId: string, setId: string, patch: Partial<FitSet>) => editWorkout(id, (w, at) => patchSet(w, exId, setId, patch, at));
export const setNote = (id: string, exId: string, setId: string, text: string) => editWorkout(id, (w, at) => setComment(w, exId, setId, text, at));
export const setAdd = (id: string, exId: string) => editWorkout(id, (w, at) => addSet(w, exId, at, fitnessNow().workouts.filter((x) => x.id !== id), startLastOn()));
/** Add set (same kg and reps as the last set) or Drop set (20 percent lighter, tagged DROP). Returns the new set's id. */
export function setExtra(id: string, exId: string, drop: boolean, step: number): string {
  const setId = uidF();
  void editWorkout(id, (w, at) => extraSet(w, exId, setId, drop, step, at, fitnessNow().workouts.filter((x) => x.id !== id), startLastOn()));
  return setId;
}
export const setRemove = (id: string, exId: string, setId: string) => editWorkout(id, (w, at) => removeSet(w, exId, setId, at));
/** Finish exercise (V1.40): the sets not done yet are taken out, the ones done count as normal. */
export const exEnd = (id: string, exId: string) => editWorkout(id, (w, at) => endExercise(w, exId, at).w);
/** Undo for Finish exercise: those sets come back, not done. */
export const setsBack = (id: string, exId: string, ids: string[]) => editWorkout(id, (w, at) => {
  const back = new Set(ids);
  return { ...w, exercises: w.exercises.map((e) => e.id !== exId ? e : { ...e, sets: e.sets.map((s) => back.has(s.id) ? { ...s, gone: false, at } : s) }) };
});
/** The gym's Sets chip: today's sets of this exercise brought to `n` (done sets are never taken out). */
export const exSetCount = (id: string, exId: string, n: number) => editWorkout(id, (w, at) => fitSetCount(w, exId, n, at));
export const exPatch = (id: string, exId: string, patch: Partial<FitLogEx>) =>
  editWorkout(id, (w, at) => ({ ...w, exercises: w.exercises.map((e) => (e.id === exId ? { ...e, ...patch, at } : e)) }));
/** An exercise added during the workout (not in the plan), at the end. */
export const exAdd = (id: string, ex: Omit<FitLogEx, "id" | "at" | "sets" | "order"> & { sets?: FitSet[] }) =>
  editWorkout(id, (w, at) => ({ ...w, exercises: [...w.exercises, { ...ex, id: uidF(), at, order: w.exercises.length, sets: ex.sets ?? [{ id: uidF(), kg: null, reps: null, rir: null, done: false, at }] }] }));
/** On the fly: one exercise a place earlier or later today, or another one in its place (today only). */
export const exMove = (id: string, exId: string, dir: -1 | 1) => editWorkout(id, (w, at) => moveEx(w, exId, dir, at));
export const exSwap = (id: string, exId: string, ex: Omit<FitLogEx, "id" | "at" | "sets" | "order"> & { sets: FitSet[] }) =>
  editWorkout(id, (w, at) => swapEx(w, exId, { ...ex, id: uidF(), at }, at));
/** "Save as a plan" after a free workout: a new one day program, made active only when there is none. */
export async function savePlanFrom(id: string, name: string) {
  const d = vaultStore.get().docs.get(id) as Doc<FitWorkout> | undefined;
  if (!d) return null;
  return addProgram(planFromWorkout(d.data, name), { activate: !fitnessNow().program });
}
export const workoutPatch = (id: string, patch: Partial<FitWorkout>) => editWorkout(id, (w, at) => ({ ...w, ...patch, at }));
export const finishWorkout = (id: string) => workoutPatch(id, { endedAt: nowIso() });
/** Throws the workout away (nothing ticked yet, or the developer said so). */
export function discardWorkout(id: string) { return queue(() => remove(id)); }
