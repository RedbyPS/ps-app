// The mobile web app's "Remember me": a phone signed in from the Mac (V1.55, src/core/phonepair.ts), and since PS 1.71 a
// passphrase sign in on the phone with Stay signed in on (src/core/phonestay.ts, vault.ts keepPhoneSignIn).
//
// What the Mac sends, or what the phone derived from the typed passphrase (the account's derived login password and key
// encryption key, never the passphrase itself), is kept here
// encrypted with AES-256-GCM under a device key that WebCrypto made NON-EXTRACTABLE: the browser keeps the key and
// lets this site's own page use it, but no script can read its bytes out. Both sit in this site's IndexedDB, one entry
// per project.
//
// Plainly: this is weaker than the PS GOS app (Android Keystore, hardware backed, behind the fingerprint) and the Mac
// (Keychain, Touch ID). On an iPhone the key and the box live in Safari's (or the Home Screen app's) storage, protected
// by iOS's file encryption while the phone is locked, not by the Secure Enclave and not by Face ID. Anyone who can run
// script on cincee.com in that browser, or who has the unlocked phone in hand, can open PS. That is the same as any web
// app that keeps you signed in. Lock in PS on the phone forgets it (the passphrase is needed again), Remove on the Mac
// makes the phone forget it the next time it opens or comes back to the front, a new passphrase does the same (1.71),
// Stay signed in off and Change project forget it, and a lost phone is closed for good by changing the passphrase.
import { setStay } from "./phonestay.ts";

const DB = "ps-phone-keys";
const STORE = "keys";
const AAD = new TextEncoder().encode("ps-phone-keys-v1");

export interface PhoneKeys { u: string; a: string; k: string; d: string }
interface Entry { key: CryptoKey; iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer; at: number }

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((res, rej) => {
      const t = db.transaction(STORE, mode);
      const q = f(t.objectStore(STORE));
      t.oncomplete = () => res(q ? q.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  } finally { db.close(); }
}
const slot = (projectUrl: string) => projectUrl.trim().replace(/\/+$/, "").toLowerCase();

/** Keep the phone's sign in for this project. A kept sign in means Stay signed in is on here (1.71: so the Mac's scan
 *  also turns the phone's switch on; a passphrase sign in only keeps it while the switch is on). */
export async function savePhoneKeys(projectUrl: string, p: PhoneKeys): Promise<void> {
  setStay(true);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify(p)));
  const e: Entry = { key, iv, ct, at: Date.now() };
  await tx("readwrite", (s) => s.put(e, slot(projectUrl)));
}
/** The phone's sign in for this project, or null. */
export async function readPhoneKeys(projectUrl: string): Promise<PhoneKeys | null> {
  try {
    const e = await tx<Entry>("readonly", (s) => s.get(slot(projectUrl)));
    if (!e?.key || !e.ct) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: e.iv, additionalData: AAD }, e.key, e.ct);
    const o = JSON.parse(new TextDecoder().decode(pt)) as PhoneKeys;
    return o && typeof o.u === "string" && typeof o.a === "string" && typeof o.k === "string" && typeof o.d === "string" ? o : null;
  } catch { return null; }
}
export async function hasPhoneKeys(projectUrl: string): Promise<boolean> {
  try { return !!(await tx<Entry>("readonly", (s) => s.get(slot(projectUrl)))); } catch { return false; }
}
export async function forgetPhoneKeys(projectUrl: string): Promise<void> {
  try { await tx("readwrite", (s) => s.delete(slot(projectUrl))); } catch { /* storage off: nothing kept */ }
}
