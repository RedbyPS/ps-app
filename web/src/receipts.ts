// Receipts (PS 1.65), the page half: saves, edits and removes receipts in the person's own vault, and shrinks and loads the photo.
// The rules (what a receipt is, the sums) are core/receipts.ts and core/purchases.ts. Nothing here polls: a receipt is written when
// the person saves or edits it, and the vault's own change sync does the rest. A receipt is an owner only record sealed with the
// vault key; its photo is a small separate sealed file, fetched only when that receipt is opened.
import { useMemo } from "react";
import { docs, put, remove, getBlob, putBlob, deleteBlob, doc } from "./core/vault";
import { useVault } from "./ui/kit";
import { settingsData } from "./core/select";
import { feature } from "./core/features";
import { RC, RCPT_FEATURE, RCPT_KIND, ORPHAN_KEY, addOrphan, cleanReceipt, defaultCurrency, dropOrphan, parseOrphans, receiptsOn, type Receipt } from "./core/receipts";
import type { Rc } from "./core/purchases";

/** Receipts and Purchases are on: the registry (features.json, From the squad) and the switch in Settings. */
export function useReceiptsOn(): boolean {
  const v = useVault();
  return v.status === "unlocked" && v.role === "owner" && receiptsOn(feature(RCPT_FEATURE), settingsData(v).receipts);
}

/** The newest copy of every saved receipt (changes with the vault). */
export function useReceipts(): Rc[] {
  const v = useVault();
  return useMemo(() => {
    const out: Rc[] = [];
    for (const d of docs(RCPT_KIND)) { const r = cleanReceipt(d.data); if (r) out.push({ id: d.id, r }); }
    return out;
  }, [v]);   // eslint-disable-line react-hooks/exhaustive-deps
}

export const useReceiptCurrency = (): string => defaultCurrency(settingsData(useVault()).receiptCur);

/** A picture as JPEG bytes no bigger than RC.photoBytes: scaled down to RC.photoSide on the long side, then the quality lowered until it fits. */
export async function shrinkPhoto(dataUrl: string): Promise<Uint8Array | null> {
  const img = new Image();
  await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error("image")); img.src = dataUrl; });
  const k = Math.min(1, RC.photoSide / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const g = c.getContext("2d");
  if (!g) return null;
  g.drawImage(img, 0, 0, c.width, c.height);
  for (const q of [0.62, 0.5, 0.4, 0.3, 0.22]) {
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", q));
    if (blob && blob.size <= RC.photoBytes) return new Uint8Array(await blob.arrayBuffer());
  }
  return null;
}

/** Saves one receipt. A photo is stored first as its own sealed file; if that fails the receipt is still saved, without it.
 *  Pass the id (and ph) from an earlier try and the same receipt is written again, never a second one. */
export async function saveReceipt(r: Receipt, opts: { id?: string; photo?: string; onPhoto?: (ph: string) => void } = {}): Promise<{ id: string; photo: boolean; ph?: string }> {
  let ph = r.ph, photo = !!r.ph;
  if (opts.photo) {
    try {
      const bytes = await shrinkPhoto(opts.photo);
      // onPhoto hears the photo's id at once, so a receipt write that fails after it is retried with this photo, not a second copy.
      if (bytes) { ph = await putBlob(null, bytes); photo = true; opts.onPhoto?.(ph); }
    } catch { photo = false; }
  }
  const data: Receipt = { ...r, ...(ph ? { ph } : {}) };
  if (!ph) delete data.ph;
  const id = await put(RCPT_KIND, data, opts.id ? { id: opts.id } : {});
  return { id, photo, ...(ph ? { ph } : {}) };
}

const orphans = (): string[] => { try { return parseOrphans(localStorage.getItem(ORPHAN_KEY)); } catch { return []; } };
const setOrphans = (l: string[]) => { try { localStorage.setItem(ORPHAN_KEY, JSON.stringify(l)); } catch { /* storage off */ } };
/** Deletes one sealed photo; when that fails it is remembered on this device and tried again at the next delete or start. */
async function dropPhoto(ph: string): Promise<void> {
  try { await deleteBlob(ph); setOrphans(dropOrphan(orphans(), ph)); }
  catch { setOrphans(addOrphan(orphans(), ph)); }
}
/** Tries the photos whose delete failed before (a few at a time). Nothing polls: called when a receipt is deleted and when Purchases opens. */
export async function flushOrphans(): Promise<void> {
  for (const ph of orphans().slice(0, 5)) await dropPhoto(ph);
}

/** Removes a receipt and its photo (the photo is queued for later when it cannot be deleted now). */
export async function removeReceipt(id: string): Promise<void> {
  const d = doc(id);
  const ph = d && d.kind === RCPT_KIND ? cleanReceipt(d.data)?.ph : undefined;
  await remove(id);
  if (ph) await dropPhoto(ph);
  void flushOrphans();
}

/** The photo of one receipt as a picture address, fetched only now (null when there is none or it cannot be fetched). */
export async function receiptPhoto(ph: string): Promise<string | null> {
  try {
    const bytes = await getBlob(ph, null);
    return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
  } catch { return null; }
}
