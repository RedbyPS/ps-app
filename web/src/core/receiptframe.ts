// Receipt scan framing (receipt accuracy fix, after 1.66). Pure, tested in tests/receiptframe.test.ts.
//
// What went wrong: the camera view fills the phone screen with object-fit: cover, so it shows only the middle of the camera
// frame, but the picture read was the WHOLE frame of the video stream, at the stream's modest resolution: the developer filled the screen
// with the receipt and the reader got a smaller receipt with the table around it. (The check screen made it look worse: on the
// phone it showed only the top of the photo in a small scroll box.) Now the picture read is exactly what the preview showed,
// taken from a full resolution still when the phone gives one.

/** A part of a picture, as fractions of its width and height (0 to 1). */
export interface Frac { x: number; y: number; w: number; h: number }
/** A part of a picture in pixels. */
export interface Rect { x: number; y: number; w: number; h: number }

/** The part of a vw x vh camera frame that a cw x ch box shows with object-fit: cover (the middle, cut on two sides). */
export function coverCrop(vw: number, vh: number, cw: number, ch: number): Frac {
  if (!(vw > 0 && vh > 0 && cw > 0 && ch > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  const k = Math.max(cw / vw, ch / vh);
  const w = Math.min(1, cw / k / vw), h = Math.min(1, ch / k / vh);
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** The same part in a still photo of a different shape (a 4:3 still behind a 16:9 stream: the stream is the middle of the
 *  sensor), in pixels. The still is first cut to the stream's shape around its middle, then the fractions are applied. */
export function stillRect(sw: number, sh: number, vw: number, vh: number, f: Frac): Rect {
  let bw = sw, bh = sh;
  const va = vw / vh, sa = sw / sh;
  if (sa > va) bw = sh * va; else if (sa < va) bh = sw / va;
  const bx = (sw - bw) / 2, by = (sh - bh) / 2;
  const r = { x: Math.round(bx + f.x * bw), y: Math.round(by + f.y * bh), w: Math.round(f.w * bw), h: Math.round(f.h * bh) };
  r.w = Math.max(1, Math.min(r.w, sw - r.x)); r.h = Math.max(1, Math.min(r.h, sh - r.y));
  return r;
}

/** The same orientation (both upright or both lying): a still that came back turned is not trusted. */
export const sameTurn = (aw: number, ah: number, bw: number, bh: number): boolean => (aw >= ah) === (bw >= bh);

/** How alike two small grey pictures of the same size are (Pearson correlation, -1 to 1). The still is used only when it looks
 *  like the frame on the screen at that moment: a still from another lens or angle falls back to the frame. */
export function likeness(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 4) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** The size to draw a w x h part at: at most `max` on the long side, never made bigger here (the phone enlarges small print). */
export function fitSize(w: number, h: number, max: number): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
