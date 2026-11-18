// Receipts (PS 1.65): the phone reads the text on a paper receipt. The page takes one still from its own camera view
// (src/views/ReceiptScan.tsx) and hands it to PS GOS (ps-gos ReceiptScan.kt), which reads it with the same offline Tesseract as
// the gym scan, with the Georgian and English models bundled in the app, and answers with the text. The picture is held in memory
// until the person saves or cancels; nothing is sent anywhere. Where there is no shell (the Mac, the website) available() is
// false: there the person can still add a receipt by typing it.
// Since the receipt accuracy fix the phone also answers with every word and its box ([[text, x0, y0, x1, y1], ...] per line), so
// the parser can put each number under its own column heading. Only words and positions, never the picture.
import { gosPost, onShell } from "./bridge";
import type { OcrLine } from "../core/receiptparse";

export type ReceiptRead = { text: string; conf: number; layout?: OcrLine[] } | { error: "busy" | "model" | "image" | "failed" | "timeout" };

/** The phone's word boxes, checked (anything odd is dropped, never trusted). */
export function layoutOf(v: unknown): OcrLine[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: OcrLine[] = [];
  for (const line of v.slice(0, 400)) {
    if (!Array.isArray(line)) continue;
    const ws: OcrLine = [];
    for (const w of line.slice(0, 80)) {
      if (!Array.isArray(w) || typeof w[0] !== "string" || w.length < 5) continue;
      const [x0, y0, x1, y1] = w.slice(1, 5).map(Number);
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      ws.push({ t: w[0].slice(0, 80), x0, y0, x1, y1 });
    }
    if (ws.length) out.push(ws);
  }
  return out.length ? out : undefined;
}

const hasShell = () => typeof window !== "undefined" && !!(window as Window & { gosNative?: unknown }).gosNative;
let seq = 0;

export const receiptScan = {
  available: hasShell,
  /** Read the text in one picture (a data: URL, JPEG or PNG). Times out after 60 s: the picture is bigger and cleaned first now. */
  read(img: string): Promise<ReceiptRead> {
    if (!hasShell()) return Promise.resolve({ error: "failed" });
    const id = `r${Date.now().toString(36)}${(seq++).toString(36)}`;
    return new Promise((done) => {
      let off = () => {};
      const t = window.setTimeout(() => { off(); done({ error: "timeout" }); }, 60_000);
      off = onShell((m) => {
        if (m.type !== "receiptscan" || m.id !== id) return;
        window.clearTimeout(t); off();
        if (typeof m.error === "string") done({ error: (["busy", "model", "image", "failed"].includes(m.error) ? m.error : "failed") as "failed" });
        else { const layout = layoutOf(m.words); done({ text: String(m.text ?? ""), conf: Number(m.conf ?? 0), ...(layout ? { layout } : {}) }); }
      });
      gosPost({ type: "receiptscan:read", id, img });
    });
  },
  /** Load the reader ahead (when the camera opens), so the first read is quick. */
  warm() { if (hasShell()) gosPost({ type: "receiptscan:warm" }); },
};
