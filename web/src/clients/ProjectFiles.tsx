import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { removeClientActivity, saveClientActivity } from "../core/clientsact";
import { CRM_ACTIVITY_KINDS, CRM_ACTIVITY_MAX, CRM_FILE_MAX, type CrmActivity } from "../core/crmdata";
import { addFile, openFile, removeFile } from "../core/crmfilebridge";
import type { Doc, ProjectDoc, Proposal } from "../core/model";
import { useVault } from "../ui/kit";
import { I, Pop } from "./bits";

const activityLabels: Record<CrmActivity["kind"], string> = { note: "Note", dm: "DM", agreement: "Agreement", update: "Update" };
const fileLabels: Record<ProjectDoc["docKind"], string> = { proposal: "Proposal", agreement: "Agreement", other: "Other" };

function https(value: string | null | undefined): string | null {
  if (!value) return null;
  try { return new URL(value).protocol === "https:" ? value : null; } catch { return null; }
}

function FileViewer({ file, close }: { file: Doc<ProjectDoc>; close: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    let objectUrl = "";
    void openFile(file.data.projectId, file.id).then((bytes) => {
      if (!live) { bytes.fill(0); return; }
      objectUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
      bytes.fill(0);
      setSrc(objectUrl);
    }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not open the PDF."); });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.id, file.data.projectId]);
  const root = document.querySelector(".clw-screen");
  if (!root) return null;
  return createPortal(
    <div className="clw-file-shade" role="dialog" aria-modal="true" aria-label={file.data.label}>
      <Pop className="clw-file-pop" onClose={close}>
        <div className="clw-file-head">
          <strong>{file.data.label}</strong>
          {src && <a className="clw-btn sm" href={src} download={file.data.name}>Download</a>}
          <button type="button" autoFocus className="clw-x" aria-label="Close PDF" onClick={close}>{I.x}</button>
        </div>
        {src ? <iframe title={file.data.label} src={src} /> : <p role="status">{error || "Opening PDF..."}</p>}
      </Pop>
    </div>,
    root,
  );
}

export function ProjectFiles({ projectId, activity, proposal, say }: {
  projectId: string; activity: CrmActivity[]; proposal: Proposal; say: (message: string) => void;
}) {
  const s = useVault();
  const files = useMemo(() => [...s.docs.values()]
    .filter((d): d is Doc<ProjectDoc> => d.kind === "doc" && (d.data as ProjectDoc).projectId === projectId
      && (d.data as ProjectDoc).mime === "application/pdf")
    .sort((a, b) => (b.data.addedAt ?? "").localeCompare(a.data.addedAt ?? "")), [s, projectId]);
  const [fileKind, setFileKind] = useState<ProjectDoc["docKind"]>("proposal");
  const [opening, setOpening] = useState<Doc<ProjectDoc> | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busyFile, setBusyFile] = useState(false);
  const [activityKind, setActivityKind] = useState<CrmActivity["kind"]>("note");
  const [value, setValue] = useState("");
  const [busyActivity, setBusyActivity] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const fileInput = async (file?: File) => {
    if (!file) return;
    if (file.size > CRM_FILE_MAX) { say("Choose a PDF up to 5 MB."); return; }
    setBusyFile(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const label = file.name.replace(/\.pdf$/i, "").trim().slice(0, 120) || fileLabels[fileKind];
      try { await addFile(projectId, bytes, { name: file.name, label, docKind: fileKind }); }
      finally { bytes.fill(0); }
      say("PDF attached to this project.");
    } catch (e) { say(e instanceof Error ? e.message : "Could not attach the PDF."); }
    finally { setBusyFile(false); }
  };
  const saveActivity = async () => {
    if (!value.trim() || busyActivity) return;
    setBusyActivity(true);
    try { await saveClientActivity(projectId, activityKind, value); setValue(""); }
    catch (e) { say(e instanceof Error ? e.message : "Could not save the activity."); }
    finally { setBusyActivity(false); }
  };
  const original = https(proposal?.url);
  const links = (proposal?.links ?? []).filter((link) => https(link.url));
  return (
    <details className="clw-project-files">
      <summary>Files and activity</summary>
      <div className="clw-extra">
        <div className="clw-col-h"><b>Proposal and files</b></div>
        {proposal?.status && <div className="clw-small">Proposal: {proposal.status}</div>}
        {proposal?.scope?.length > 0 && <ul className="clw-scope">{proposal.scope.map((line, i) => <li key={i}>{line}</li>)}</ul>}
        {original && !links.some((link) => link.url === original) && <a href={original} target="_blank" rel="noopener noreferrer">Open proposal</a>}
        {links.map((link, i) => <a key={i} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>)}
        {files.map((file) => <div className="clw-file-row" key={file.id}>
          <button type="button" className="clw-file-name" onClick={() => setOpening(file)}>{file.data.label}<small>{fileLabels[file.data.docKind]} · PDF</small></button>
          {file.ws !== null ? null : deleting === file.id
            ? <button type="button" className="clw-btn sm danger" onClick={() => {
              setDeleting(null);
              void removeFile(projectId, file.id).catch((e) => say(e instanceof Error ? e.message : "Could not remove the PDF."));
            }}>Remove PDF</button>
            : <button type="button" className="clw-rm" aria-label={`Remove ${file.data.label}`} onClick={() => setDeleting(file.id)}>{I.x}</button>}
        </div>)}
        <div className="clw-extra-row">
          <select aria-label="Document kind" value={fileKind} onChange={(e) => setFileKind(e.target.value as ProjectDoc["docKind"])}>
            {Object.entries(fileLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          </select>
          <button type="button" className="clw-btn sm" disabled={busyFile} onClick={() => input.current?.click()}>{busyFile ? "Attaching..." : "Attach PDF"}</button>
          <input type="file" ref={input} accept=".pdf,application/pdf" hidden onChange={(e) => { void fileInput(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        <div className="clw-col-h"><b>Activity</b></div>
        {activity.map((entry) => <article key={entry.id} className="clw-activity">
          <div className="clw-extra-row">
            <strong>{activityLabels[entry.kind]}{entry.source ? ` · ${entry.source}` : ""}</strong>
            <time dateTime={entry.at}>{new Date(entry.at).toLocaleDateString()}</time>
            <button type="button" className="clw-rm" aria-label={`Remove ${activityLabels[entry.kind].toLowerCase()}`} onClick={() => {
              void removeClientActivity(projectId, entry.id).catch((e) => say(e instanceof Error ? e.message : "Could not remove the activity."));
            }}>{I.x}</button>
          </div>
          <p>{entry.text}</p>
          {https(entry.url) && <a href={entry.url!} target="_blank" rel="noopener noreferrer">Open source</a>}
        </article>)}
        <textarea aria-label="Activity details" rows={2} value={value} maxLength={20_000} onChange={(e) => setValue(e.target.value)} placeholder="Add a note, DM or update" />
        <div className="clw-extra-row">
          <select aria-label="Activity kind" value={activityKind} onChange={(e) => setActivityKind(e.target.value as CrmActivity["kind"])}>
            {CRM_ACTIVITY_KINDS.map((kind) => <option key={kind} value={kind}>{activityLabels[kind]}</option>)}
          </select>
          <button type="button" className="clw-btn sm" disabled={!value.trim() || busyActivity || activity.length >= CRM_ACTIVITY_MAX} onClick={() => void saveActivity()}>Add</button>
        </div>
      </div>
      {opening && <FileViewer key={opening.id} file={opening} close={() => setOpening(null)} />}
    </details>
  );
}
