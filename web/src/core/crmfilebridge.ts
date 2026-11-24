// The Tab list has no vault key. The main page encrypts and decrypts CRM PDFs on request.
// Only the active transfer crosses the local WebKit bridge, in small messages.
import { CRM_FILE_KINDS, CRM_FILE_MAX, crmFileName, encodeCrmFile } from "./crmdata";
import { attachCrmDoc, readCrmDoc, removeCrmDoc } from "./crmstore";
import { uid, type ProjectDoc } from "./model";
import { vaultStore } from "./vault";

const PIECE = 32 * 1024;
const TIMEOUT = 60_000;
const LIMIT = 4;
const idOf = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{4,64}$/.test(v);
type FileInfo = { name: string; label: string; docKind: ProjectDoc["docKind"] };
type Transfer =
  | { mode: "upload"; projectId: string; info: FileInfo; bytes: Uint8Array; offset: number }
  | { mode: "download"; bytes: Uint8Array; offset: number };

const transfers = new Map<string, { transfer: Transfer; timer: number }>();
const pending = new Map<string, { finish: (v: unknown, error?: string) => void }>();
let send: ((m: object) => void) | null = null;

export function setCrmFileRelay(post: (m: object) => void) { send = post; }

function request(op: string, data: object = {}): Promise<unknown> {
  if (!send) return Promise.reject(new Error("The CRM connection is unavailable."));
  const req = uid();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(req);
      reject(new Error("The CRM connection timed out. Try again."));
    }, TIMEOUT);
    pending.set(req, { finish: (v, error) => {
      window.clearTimeout(timer);
      pending.delete(req);
      if (error) reject(new Error(error)); else resolve(v);
    } });
    send?.({ type: "crm:request", req, op, ...data });
  });
}

export function cancelCrmFileRequests() {
  for (const request of pending.values()) request.finish(undefined, "Unlock your vault to open CRM documents.");
}

export function applyCrmFileReply(m: { type?: string; req?: unknown; value?: unknown; error?: unknown }): boolean {
  if (m.type !== "crm:reply") return false;
  if (idOf(m.req)) pending.get(m.req)?.finish(m.value, typeof m.error === "string" ? m.error : undefined);
  return true;
}

function bytesOf(piece: unknown): Uint8Array {
  if (typeof piece !== "string" || piece.length > Math.ceil(PIECE / 3) * 4) throw new Error("Invalid PDF data.");
  const raw = atob(piece);
  if (raw.length > PIECE) throw new Error("Invalid PDF data.");
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function drop(id: string, wipe = true) {
  const found = transfers.get(id);
  if (!found) return;
  window.clearTimeout(found.timer);
  if (wipe) found.transfer.bytes.fill(0);
  transfers.delete(id);
}
function keep(id: string, transfer: Transfer) {
  if (transfers.size >= LIMIT) throw new Error("Too many documents are open. Try again.");
  transfers.set(id, { transfer, timer: window.setTimeout(() => drop(id), TIMEOUT) });
}
export function clearCrmFileTransfers() {
  for (const id of transfers.keys()) drop(id);
}
function ownerUnlocked() {
  const s = vaultStore.get();
  return s.status === "unlocked" && s.role === "owner";
}
function sizeIsValid(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 5 && v <= CRM_FILE_MAX;
}

async function run(m: Record<string, unknown>): Promise<unknown> {
  if (!ownerUnlocked()) throw new Error("Unlock your vault to open CRM documents.");
  const { op, projectId, docId, size, name, label, docKind, transferId, offset, piece } = m;
  if (op === "beginUpload" && idOf(projectId) && sizeIsValid(size) &&
    typeof name === "string" && name.length <= 200 && typeof label === "string" && label.trim() && label.length <= 200 &&
    CRM_FILE_KINDS.includes(docKind as ProjectDoc["docKind"])) {
    const id = uid();
    keep(id, { mode: "upload", projectId, info: { name: crmFileName(name), label: label.trim(), docKind: docKind as ProjectDoc["docKind"] }, bytes: new Uint8Array(size), offset: 0 });
    return id;
  }
  if (op === "beginDownload" && idOf(projectId) && idOf(docId)) {
    const f = await readCrmDoc(projectId, docId, true);
    if (!ownerUnlocked()) throw new Error("Unlock your vault to open CRM documents.");
    if (!sizeIsValid(f.bytes.length)) throw new Error("This PDF exceeds the CRM file limit.");
    const id = uid();
    keep(id, { mode: "download", bytes: f.bytes, offset: 0 });
    return { transferId: id, size: f.bytes.length };
  }
  if (op === "remove" && idOf(projectId) && idOf(docId)) return removeCrmDoc(projectId, docId);
  const t = idOf(transferId) ? transfers.get(transferId)?.transfer : undefined;
  if (!t || !idOf(transferId)) throw new Error("This document transfer has expired.");
  if (op === "cancel") { drop(transferId); return; }
  if (op === "write" && t.mode === "upload" && offset === t.offset) {
    const block = bytesOf(piece);
    if (block.length === 0 || t.offset + block.length > t.bytes.length) throw new Error("Invalid PDF data.");
    t.bytes.set(block, t.offset);
    t.offset += block.length;
    return;
  }
  if (op === "save" && t.mode === "upload" && t.offset === t.bytes.length) {
    drop(transferId, false);
    try {
      return await attachCrmDoc(t.projectId, { bytes: t.bytes, name: t.info.name }, t.info.label, t.info.docKind, transferId);
    } finally { t.bytes.fill(0); }
  }
  if (op === "read" && t.mode === "download" && offset === t.offset) {
    const block = t.bytes.subarray(t.offset, t.offset + PIECE);
    const encoded = encodeCrmFile(block);
    t.offset += block.length;
    if (t.offset >= t.bytes.length) drop(transferId);
    return encoded;
  }
  throw new Error("Invalid document request.");
}

export function runCrmFileRequest(m: Record<string, unknown>, post: (reply: object) => void): boolean {
  if (m.type !== "crm:request") return false;
  if (idOf(m.req)) {
    const req = m.req;
    void run(m).then(
      (value) => post({ type: "crm:reply", req, value }),
      (err) => post({ type: "crm:reply", req, error: err instanceof Error ? err.message : "Could not open the document." }),
    );
  }
  return true;
}

export async function addFile(projectId: string, bytes: Uint8Array, info: FileInfo) {
  if (!sizeIsValid(bytes.length)) throw new Error("Choose a PDF up to 5 MB.");
  if (!send) return attachCrmDoc(projectId, { bytes, name: info.name }, info.label, info.docKind);
  const transferId = await request("beginUpload", { projectId, size: bytes.length, ...info, name: crmFileName(info.name) });
  if (!idOf(transferId)) throw new Error("Could not start the upload.");
  try {
    for (let offset = 0; offset < bytes.length; offset += PIECE) {
      await request("write", { transferId, offset, piece: encodeCrmFile(bytes.subarray(offset, offset + PIECE)) });
    }
    return await request("save", { transferId });
  } catch (e) {
    void request("cancel", { transferId }).catch(() => undefined);
    throw e;
  }
}

export async function openFile(projectId: string, docId: string): Promise<Uint8Array> {
  if (!send) return (await readCrmDoc(projectId, docId, true)).bytes;
  const r = await request("beginDownload", { projectId, docId }) as { transferId?: unknown; size?: unknown } | null;
  if (!r || !idOf(r.transferId) || !sizeIsValid(r.size)) throw new Error("Could not open the document.");
  const { transferId, size } = r;
  const bytes = new Uint8Array(size);
  try {
    for (let offset = 0; offset < size; offset += PIECE) {
      const block = bytesOf(await request("read", { transferId, offset }));
      if (block.length !== Math.min(PIECE, size - offset)) throw new Error("Invalid PDF data.");
      bytes.set(block, offset);
    }
    return bytes;
  } catch (e) {
    bytes.fill(0);
    void request("cancel", { transferId }).catch(() => undefined);
    throw e;
  }
}

export function removeFile(projectId: string, docId: string): Promise<unknown> {
  return send ? request("remove", { projectId, docId }) : removeCrmDoc(projectId, docId);
}
