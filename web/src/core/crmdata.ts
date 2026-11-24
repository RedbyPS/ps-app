import type { ProjectDoc, ProjectPrivate } from "./model";

export const CRM_LOOKS = ["match", "light", "midnight", "calm"] as const;
export type CrmLook = typeof CRM_LOOKS[number];

export function isCrmLook(value: unknown): value is CrmLook {
  return CRM_LOOKS.some((look) => look === value);
}

export interface CrmAppearance {
  look: CrmLook;
  density: "comfortable" | "compact";
  showClientColours: boolean;
  showTaskColours: boolean;
}
export function cleanCrmAppearance(value?: Partial<CrmAppearance> | null): CrmAppearance {
  return {
    look: isCrmLook(value?.look) ? value.look : "match",
    density: value?.density === "compact" ? "compact" : "comfortable",
    showClientColours: value?.showClientColours !== false,
    showTaskColours: value?.showTaskColours !== false,
  };
}

export const CRM_ACTIVITY_KINDS = ["note", "dm", "agreement", "update"] as const;
export const CRM_ACTIVITY_MAX = 200;
export interface CrmActivity {
  id: string;
  kind: typeof CRM_ACTIVITY_KINDS[number];
  text: string;
  at: string;
  source?: string | null;
  url?: string | null;
}

export const CRM_FILE_MAX = 5 * 1024 * 1024;
export const CRM_FILE_KINDS = ["proposal", "agreement", "other"] satisfies ProjectDoc["docKind"][];

export function encodeCrmFile(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(""));
}

export function decodeCrmFile(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > Math.ceil(CRM_FILE_MAX / 3) * 4) return null;
  try {
    const raw = atob(value);
    if (raw.length > CRM_FILE_MAX || !raw.startsWith("%PDF-")) return null;
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch { return null; }
}

export function crmFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "document.pdf";
}

/** A JSON response for private project details without internal record ids or shared content. */
export function projectDetails(value?: ProjectPrivate) {
  return {
    notes: value?.notes ?? null,
    nextStep: value?.nextStep ?? null,
    nextDue: value?.nextDue ?? null,
    waitingOn: value?.waitingOn ?? null,
    waitingWhat: value?.waitingWhat ?? null,
    waitingSince: value?.waitingSince ?? null,
    nextInvoiceDate: value?.nextInvoiceDate ?? null,
    checklist: value?.checklist ?? [],
    activity: value?.activity ?? [],
  };
}
