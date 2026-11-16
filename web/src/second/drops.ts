// Second Computer: a file dropped on the floating Tab list (which holds no vault) is handed to the main PS window
// through IndexedDB, which both windows share (same origin, same data store). Only the key crosses the bridge.
// The main window deletes the entry as soon as it has read it.
const DB = "ps-second", STORE = "drops";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode), q = f(t.objectStore(STORE));
      t.oncomplete = () => resolve(q.result);
      t.onerror = () => reject(t.error);
    });
  } finally { db.close(); }
}
export async function putDrop(file: File): Promise<string> {
  const key = crypto.randomUUID();
  await tx("readwrite", (s) => s.put({ name: file.name, type: file.type, blob: file, at: Date.now() }, key));
  return key;
}
export async function takeDrop(key: string): Promise<(Blob & { name: string }) | null> {
  const v = await tx<{ name: string; type: string; blob: Blob } | undefined>("readonly", (s) => s.get(key));
  await tx("readwrite", (s) => s.delete(key)).catch(() => {});
  if (!v?.blob) return null;
  return Object.assign(v.blob.slice(0, v.blob.size, v.type), { name: v.name });
}

// Previews (a picture, a PDF or a text file asked for with "preview") are kept the same way for the window to
// show, the newest 20 only. Nothing here leaves this Mac.
const PREVIEWS = "previews";
function openP(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(`${DB}-previews`, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(PREVIEWS); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function txP<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openP();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(PREVIEWS, mode), q = f(t.objectStore(PREVIEWS));
      t.oncomplete = () => resolve(q.result);
      t.onerror = () => reject(t.error);
    });
  } finally { db.close(); }
}
export type Preview = { name: string; mime: string; bytes: Uint8Array; at?: number };
export async function putPreview(key: string, p: Preview) {
  await txP("readwrite", (s) => s.put({ ...p, at: Date.now() }, key));
  const keys = await txP<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
  if (keys.length > 20) {
    const all = await txP<(Preview & { at: number })[]>("readonly", (s) => s.getAll());
    const old = keys.map((k, i) => ({ k, at: all[i]?.at ?? 0 })).sort((a, b) => a.at - b.at).slice(0, keys.length - 20);
    for (const o of old) await txP("readwrite", (s) => s.delete(o.k));
  }
}
export async function getPreview(key: string): Promise<Preview | null> {
  return (await txP<Preview | undefined>("readonly", (s) => s.get(key)).catch(() => undefined)) ?? null;
}
