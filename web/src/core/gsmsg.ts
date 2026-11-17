// G Squad v3 (PS 1.65, feature "gsquad-v3"): rules for one message bubble. No DOM here, so tests can run them.

/** Read more, the way a messenger does it: the cut is by characters, not lines. Only text longer than SHOW + BUFFER is cut
 *  (a message just over the line is shown whole, a link that says "Read more" for three words is silly), the cut lands on a
 *  word edge, and each tap shows STEP more characters. */
export const READ_MORE = { show: 800, buffer: 100, step: 3000 } as const;

export interface Cut { text: string; cut: boolean }

/** The first part of a long message. shown = how many characters are open now (READ_MORE.show to begin with). */
export function readMoreCut(text: string, shown: number = READ_MORE.show): Cut {
  const t = typeof text === "string" ? text : "";
  const open = Number.isFinite(shown) ? Math.max(READ_MORE.show, Math.floor(shown)) : READ_MORE.show;
  if (t.length <= open + READ_MORE.buffer) return { text: t, cut: false };
  let end = open;
  // never split a surrogate pair (an emoji)
  const c = t.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  // back up to a space or a new line, but never more than 80 characters (one huge word is cut where it stands)
  const floor = Math.max(1, end - 80);
  for (let i = end; i > floor; i--) { if (/\s/.test(t[i] ?? "")) { end = i; break; } }
  return { text: t.slice(0, end).replace(/\s+$/, ""), cut: true };
}
/** What "shown" becomes after one tap on Read more. */
export const moreShown = (shown: number): number => (Number.isFinite(shown) ? Math.max(READ_MORE.show, Math.floor(shown)) : READ_MORE.show) + READ_MORE.step;

/** Where a bubble sits in its group: alone, the top, the middle or the bottom. The corners next to the neighbour are small
 *  (CSS reads this from data-shape), the others are round. */
export type Shape = "solo" | "top" | "mid" | "bottom";
export function bubbleShape(first: boolean, last: boolean): Shape {
  return first && last ? "solo" : first ? "top" : last ? "bottom" : "mid";
}
/** Radii in px on the side that touches the neighbour (the sender's side): [top, bottom]. Signal: 18 round, 4 small. */
export function sideRadii(shape: Shape, round = 18, small = 4): [number, number] {
  return [shape === "solo" || shape === "top" ? round : small, shape === "solo" || shape === "bottom" ? round : small];
}
/** The picture of a member sits beside the LAST bubble of a group (messages from others only). */
export const showsAvatar = (mine: boolean, last: boolean): boolean => !mine && last;

/** Quality pass: the list counts as "at the newest message" when its bottom is within `slack` px. While it is, a change in the
 *  list's own height (the box grows to a second line, a reply quote or the emoji panel opens, the window is resized) keeps the
 *  newest message in view instead of letting it slide under the bottom edge. */
export const nearBottom = (m: { scrollHeight: number; scrollTop: number; clientHeight: number }, slack = 40): boolean =>
  m.scrollHeight - m.scrollTop - m.clientHeight < slack;
