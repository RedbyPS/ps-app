// Dates in plain words in the add boxes (PS 1.65, rules in core/nldates.ts). useNlDates follows one box's text: the words it
// recognises are painted and shown as a small chip ("Tomorrow, 10:00", "Every other Fri, 15:00") by PrioInput
// (views/TypedPrio.tsx), Add takes the date, the repeat and the cleaned title, and a click on the chip keeps the words as text.
// A typed time also puts ONE reminder on the new task, 15 minutes before that time (core/nlremind.ts, sent with the add), unless Settings, Your
// list, "A typed time adds a reminder" is off. Switch for it all: Settings, Your list, "Dates in plain words" (feature
// "nl-dates", on by default).
import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "../core/model";
import { feature } from "../core/features";
import { nlBackspace, nlDismiss, nlOnAdd, nlPicked, nlStart, nlStartFor, nlTyped, parseTaskText, reminderOf, settled, SETTLE_MS, type NlState, type ParsedTask } from "../core/nldates";
import { overdueZone } from "../core/overdue";
import { DAY_ENDS_DEFAULT } from "../core/daylog";
import { DEVICE_TZ } from "../core/tz";
import { settingsData } from "../core/select";
import type { TimeRemind } from "../core/nlremind";
import { useVault } from "../ui/kit";
import { scheduledOn } from "../core/scheduled";

/** The feature switch (Settings, Your list, and From the squad). */
export const nlDatesOn = () => feature("nl-dates");
/** A typed time adds a reminder (default on). */
export const nlRemindOn = (s: Pick<Settings, "tmNlRemind"> | null | undefined) => s?.tmNlRemind !== false;

// How this person writes dates and times, from the device's own settings.
const LOCALE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().locale || "en-US"; } catch { return "en-US"; } })();
const HOUR12 = (() => { try { return /h1[12]/.test(new Intl.DateTimeFormat(LOCALE, { hour: "numeric" }).resolvedOptions().hourCycle ?? ""); } catch { return false; } })();
const DAY_FIRST = (() => { try { return new Intl.DateTimeFormat(LOCALE).formatToParts(new Date(2026, 10, 20)).findIndex((p) => p.type === "day") < new Intl.DateTimeFormat(LOCALE).formatToParts(new Date(2026, 10, 20)).findIndex((p) => p.type === "month"); } catch { return false; } })();

/** The parser's zone and options for this person (the same as the add boxes use), for other callers (views/VoiceCapture.tsx). */
export function nlParseCtx(st: Pick<Settings, "tmHomeTz" | "dayEndsHour">) {
  return { tz: overdueZone(st.tmHomeTz), opts: { dayEndsHour: st.dayEndsHour ?? DAY_ENDS_DEFAULT, hour12: HOUR12, dayFirst: DAY_FIRST } };
}

export type NlCtl = {
  /** The chip to show now (null: nothing recognised, said no to, still settling, or switched off). */
  offer: ParsedTask | null;
  /** At Add: the parse to use (date, repeat, cleaned title), or null (the text and the controls as they are). */
  take: (text: string) => ParsedTask | null;
  /** A date or repeat was picked by clicking in Advanced: it wins over the typed words. */
  picked: () => void;
  /** No thanks: the words stay as typed. */
  dismiss: () => void;
  /** After Add: start fresh. */
  reset: () => void;
  backspace: (caret: number | null, selEnd: number | null) => boolean;
  /** The reminder a typed time asks for, to pass to taskMapActions.add as `remind` (core/nlremind.ts). */
  reminderFor: (p: ParsedTask) => TimeRemind | null;
  on: boolean;
};

/** One add box's typed date, following its text. `once`: only one-off dates (a box that cannot hold a repeat).
 *  `existing` (PS 1.75, editing a task): the name as it was; its date words start as said no to, so only a date typed now counts.
 *  `off`: nothing is read (a repeating task being edited). */
export function useNlDates(text: string, opts: { once?: boolean; existing?: string; off?: boolean; dateOnly?: boolean } = {}): NlCtl {
  const vault = useVault();
  const st = settingsData(vault);
  const on = nlDatesOn() && !opts.off;
  const tz = overdueZone(st.tmHomeTz);
  // PS 1.75: with scheduled tasks on, dates typed in numbers ("25.11", "25/11") are read too (core/nldates.ts numDates). "Today"
  // and "tomorrow" stay the calendar's, as in 1.74 (break-it 1.75: the land day can lag the calendar by hours, and `due` is a date).
  const parseOpts = { dayEndsHour: st.dayEndsHour ?? DAY_ENDS_DEFAULT, hour12: HOUR12, dayFirst: DAY_FIRST, numDates: scheduledOn() };
  const ref = useRef<NlState>(null as unknown as NlState);
  if (!ref.current) ref.current = opts.existing ? nlStartFor(parseTaskText(opts.existing, Date.now(), tz, parseOpts)) : nlStart();
  const [, redraw] = useState(0);
  const parse = (t: string, s: NlState) => {
    if (!on) return null;
    const p = parseTaskText(t, Date.now(), tz, { ...parseOpts, keep: s.kept });
    if (!p || !p.title || (opts.once && p.kind !== "once")) return null;   // nothing left to call the task: it stays as typed
    if (opts.dateOnly && p.time) return null;   // break-it 1.75: editing has no reminder to put a typed time on, so its words stay
    return p;
  };
  // Follows the text during render: the same text twice changes nothing, so this is safe to run again.
  const now = parse(text, ref.current);
  ref.current = nlTyped(ref.current, text, now);
  const usable = nlOnAdd(ref.current, now);
  // Calm while typing: words that end where the typing is wait a moment before they light up.
  const changed = useRef({ text, at: 0 });
  if (changed.current.text !== text) changed.current = { text, at: Date.now() };
  const idle = Date.now() - changed.current.at;
  const calm = settled(usable, text, idle);
  useEffect(() => {
    if (!usable || calm) return;
    const t = window.setTimeout(() => redraw((n) => n + 1), Math.max(30, SETTLE_MS - idle + 10));
    return () => window.clearTimeout(t);
  });
  const remindOk = nlRemindOn(st);
  const take = useCallback((t: string) => { const p = parse(t, ref.current); return nlOnAdd(nlTyped(ref.current, t, p), p); }, [on, tz, parseOpts.dayEndsHour, parseOpts.numDates]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = useCallback(() => { ref.current = nlPicked(ref.current); redraw((n) => n + 1); }, []);
  const dismiss = useCallback(() => { ref.current = nlDismiss(ref.current, now); redraw((n) => n + 1); }, [now?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = useCallback(() => { ref.current = nlStart(); redraw((n) => n + 1); }, []);
  const backspace = useCallback((caret: number | null, selEnd: number | null) => nlBackspace(usable, caret, selEnd), [usable?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The reminder a typed time asks for, ready for taskMapActions.add (null: no time, or the setting is off). */
  const reminderFor = useCallback((p: ParsedTask): TimeRemind | null => {
    const w = remindOk ? reminderOf(p) : null;
    return w ? { ...w, tz: tz === DEVICE_TZ ? "" : tz } : null;
  }, [remindOk, tz]);
  return { offer: calm ? usable : null, take, picked, dismiss, reset, backspace, reminderFor, on };
}
