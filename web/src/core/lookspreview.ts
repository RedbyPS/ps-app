// What the Tab list draws behind and around the tasks, and what a Looks Preview needs on screen so the thing being
// previewed is really there (V1.40). Pure, no DOM; views/TaskMap.tsx draws exactly what these say.
//
// The preview bug (the developer, 7 Nov 2026: "it doesn't always preview the right thing"): a Preview only swapped the saved
// choice for the previewed one and drew the list as usual, so whenever the part it changes was not on screen the
// preview showed the plain list, which looked like the wrong thing:
//   - an Outline, or the Spotlight, All roads, Tunnel and Hypno backgrounds, with no task in Priority 1 (the frame and
//     those scenes are only drawn round a Priority 1 group);
//   - any background while the glass slider is all the way down (backgrounds fade with it and are not drawn at 0);
//   - a Working on style while no task is marked as working on;
//   - an Outline in a Notebook look (the notebook draws its own plain box instead).
// Now the preview stages what is missing (an example Priority 1 group, the first task as working on, the background
// at full strength) and says so in the chip, and tests/lookspreview.test.ts checks every option is on screen.
import { bgDesign, isImageBg, isVideoBg } from "./prio.ts";
import { isColourBg } from "./bgcolour.ts";
import type { LooksPart } from "./looksoptions";

/** How long a Looks Preview shows the real list (the developer's friend, 15 Nov 2026: "The preview should show, I think it's five seconds
 *  of what it will look like"; it was 2 seconds). A preview that explains what it staged stays a little longer. */
export const LOOKS_PREVIEW_MS = 5000;
export const LOOKS_PREVIEW_NOTE_MS = 6500;

export const SCENES = ["spotlight", "converge", "tunnel", "hypno"];

export type StageCtx = {
  hasP1: boolean;          // a task is in Priority 1
  hasWorking: boolean;     // a task is marked as working on
  hasTasks: boolean;       // the list has any task to mark
  bgFade: number;          // the glass slider's background strength, 0 to 1 (core/bgfade.ts)
  notebook: boolean;       // a Notebook look is on
  reduced: boolean;        // Reduce motion is on (nothing moving is drawn)
  hasOverdue?: boolean;    // a task is on the Overdue card (V1.44)
};
export type Stage = {
  /** Draw an example Priority 1 group (two example tasks) because there is none. */
  sampleP1: boolean;
  /** Show the first task as working on, because none is. */
  sampleWorking: boolean;
  /** Draw the background at full strength although the glass slider hides it. */
  forceBg: boolean;
  /** One plain sentence for the preview chip, or null. */
  note: string | null;
  /** Draw an example Overdue card (two example tasks) because nothing is overdue (V1.44). */
  sampleOverdue?: boolean;
};
export const NO_STAGE: Stage = { sampleP1: false, sampleWorking: false, forceBg: false, note: null };

/** What a preview of `part` (with the previewed value `id`, for backgrounds) needs staged. */
export function previewStage(part: LooksPart | null, id: string | null, c: StageCtx): Stage {
  if (!part) return NO_STAGE;
  if (part === "outline") {
    if (c.notebook) return { ...NO_STAGE, sampleP1: !c.hasP1, note: "Notebook looks draw a plain box round Priority 1, so outlines show in the other looks." };
    return c.hasP1 ? NO_STAGE : { ...NO_STAGE, sampleP1: true, note: "An example Priority 1 group, since none of your tasks is in Priority 1 yet." };
  }
  if (part === "work") {
    if (c.hasWorking || !c.hasTasks) return NO_STAGE;
    return { ...NO_STAGE, sampleWorking: true, note: "Shown on your first task. Click a task's words to mark what you are working on." };
  }
  if (part === "bg") {
    const bg = bgDesign(id);
    const scene = SCENES.includes(bg);
    const moving = scene || bg.startsWith("storm-");
    const forceBg = c.bgFade <= 0 && bg !== "none";
    const notes: string[] = [];
    if (moving && c.reduced) notes.push("Reduce motion is on in this device's settings, so this background stays still or hidden.");
    else if (forceBg) notes.push("Your glass slider is all the way down, which hides backgrounds. Raise it to keep this one showing.");
    if (scene && !c.hasP1) notes.push("It points at an example Priority 1 group.");
    return { sampleP1: scene && !c.hasP1, sampleWorking: false, forceBg, note: notes.join(" ") || null };
  }
  if (part === "overdue") {
    // Nothing overdue means no card at all, so the preview draws an example one.
    if (c.hasOverdue) return c.reduced ? { ...NO_STAGE, note: "Reduce motion is on in this device's settings, so moving effects stay still." } : NO_STAGE;
    return { ...NO_STAGE, sampleOverdue: true, note: "An example Overdue card, since none of your tasks is overdue." };
  }
  if (part === "rain" && c.reduced) return { ...NO_STAGE, note: "Reduce motion is on in this device's settings, so rain stays off." };
  return NO_STAGE;
}

export type Layers = {
  scene: boolean; storm: boolean; video: boolean; colour: boolean;
  /** PS 1.70: a still picture (Neon city), drawn like a video. */
  image: boolean;
  /** Whether any background is drawn at all. */
  drawn: boolean;
  /** Its strength, 0 to 1 (the glass slider, or 1 while a preview forces it). */
  fade: number;
  /** Rows and panels get solid backings (something fills or moves behind them). */
  calm: boolean;
  /** The Priority 1 frame is drawn (real tasks or the example group). */
  p1: boolean;
};

/** The background layers for a background id. `sliding`: the glass slider is being dragged (it stays drawn). */
export function bgLayers(o: { bg: string; docked: boolean; hasP1: boolean; fade: number; sliding: boolean; rain: boolean; stage: Stage }): Layers {
  const bg = bgDesign(o.bg);
  const p1 = o.hasP1 || o.stage.sampleP1;
  const scene = !o.docked && p1 && SCENES.includes(bg);
  const storm = !o.docked && bg.startsWith("storm-");
  const video = !o.docked && isVideoBg(bg);
  const colour = !o.docked && isColourBg(bg);
  const image = !o.docked && isImageBg(bg);
  const on = o.fade > 0 || o.sliding || o.stage.forceBg;
  const any = scene || storm || video || colour || image;
  return {
    scene, storm, video, colour, image, p1,
    drawn: any && on,
    fade: o.stage.forceBg ? 1 : o.fade,
    calm: !o.docked && (scene || storm || video || colour || image || o.rain),
  };
}
