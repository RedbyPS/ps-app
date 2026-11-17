// Left out of the public source: the follow up radar. It only runs on the developer's own account, so this
// placeholder keeps the names the rest of the app imports and does nothing (scripts in the private tree:
// open-source.mjs). See README.md, "What is left out".
const inert: any = new Proxy(function () {}, {
  get: (_t: unknown, k: string | symbol): any => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : k === Symbol.iterator ? function* () {} : inert),
  apply: () => undefined,
  construct: () => ({}),
});
const _v0: any = { at: "", items: [], notes: [], hidden: 0, engine: { at: "", repliesAt: "", counts: undefined, gate: [], parked: [], manual: [], declined: [], meetings: [], pins: [] } };
const _v1: any = { at: "", items: [], notes: [], hidden: 0, engine: { at: "", repliesAt: "", counts: undefined, gate: [], parked: [], manual: [], declined: [], meetings: [], pins: [] } };
const _v2: any = { handled: undefined, snoozed: undefined };
export function firstLines(_p0?: any, _p1?: any, ..._more: any[]): string { return ""; }
export function suppressedBy(_p0?: any, ..._more: any[]): (_p0?: any, ..._more: any[]) => boolean { return (..._a: any[]) => false; }
export function waitTone(_p0?: any, _p1?: any, ..._more: any[]): "ok" | "warn" | "bad" { return "ok"; }
export function waitText(_p0?: any, _p1?: any, ..._more: any[]): string { return ""; }
export function isHidden(_p0?: any, _p1?: any, _p2?: any, ..._more: any[]): boolean { return false; }
export function computeRadar(_p0?: any, _p1?: any, ..._more: any[]): { [k: string]: any; at: any; items: any[]; notes: any[]; hidden: any; engine: { [k: string]: any; at: any; repliesAt: any; counts: any; gate: any[]; parked: any[]; manual: any[]; declined: any[]; meetings: any[]; pins: any[] } } { return _v0; }
export function visibleRadar(_p0?: any, _p1?: any, _p2?: any, ..._more: any[]): { [k: string]: any; at: any; items: any[]; notes: any[]; hidden: any; engine: { [k: string]: any; at: any; repliesAt: any; counts: any; gate: any[]; parked: any[]; manual: any[]; declined: any[]; meetings: any[]; pins: any[] } } { return _v1; }
export function tidyRadarState(_p0?: any, _p1?: any, ..._more: any[]): { [k: string]: any; handled?: any; snoozed?: any } { return _v2; }
export type RadarSide = any;
export type RadarKind = any;
export type RadarItem = { [k: string]: any; key: any; side: "me" | "them"; kind: "client-email" | "fup-replied" | "instantly" | "gmail-prospect" | "sweep" | "proposal" | "invoice" | "project" | "quiet"; channel: "Gmail" | "Instantly" | "Vault" | "Stats"; name: any; company?: any; email?: any; subject?: any; said?: any; since: any; url?: any; clientId?: any; replyId?: any; amount?: any; note?: any; noDraft?: any };
export type RadarState = { [k: string]: any; handled?: any; snoozed?: any };
export type FupLead = { [k: string]: any; id: any; name: any; firstName?: any; fullName?: any; email: any; cc: any[]; account: any; threadId?: any; subject?: any; status: any; stage?: any; lastSentAt?: any; lastType?: any; resumeOn?: any; parked?: any; deferralQuote?: any; timezone?: any; location?: any; siteUrl?: any; declined?: any; declineReason?: any; ooo?: any; exempt?: any; travel?: any; events: any[] };
export type FupPin = { [k: string]: any; email: any; name: any; company?: any; since: any; said?: any; repliedFrom?: any; title: any };
export type FupSnap = { [k: string]: any; v: any; at: any; counts: any; bounced: any; laterHometown: any; leads: any[]; suppression: any[]; pins: any[] };
export type IRep = { [k: string]: any; id: any; threadId: any; lead: any; from: any; fromName?: any; account: any; at: any; subject: any; opening: any; campaignId?: any; url: any };
export type IRepSnap = { [k: string]: any; v: any; at: any; replies: any[]; sent: any[] };
export type GateRow = { [k: string]: any; key: any; name: any; email: any; subject?: any; channel: any; lastSentAt: any; due: any; hours: any };
export type ParkRow = { [k: string]: any; key: any; name: any; resumeOn: any; quote?: any; ooo: any; status: any };
export type NameRow = { [k: string]: any; key: any; name: any; why: "manual" | "exempt" };
export type DeclRow = { [k: string]: any; key: any; name: any; reason: any };
export type MeetRow = { [k: string]: any; key: any; title: any; start: any; link?: any; people: any[] };
export type PinRow = { [k: string]: any; key: any; title: any; name: any; company?: any; since: any; said?: any; repliedAt?: any };
export type Engine = { [k: string]: any; at: any; repliesAt: any; counts: any; gate: any[]; parked: any[]; manual: any[]; declined: any[]; meetings: any[]; pins: any[] };
export type RadarSnap = { [k: string]: any; at: any; items: any[]; notes: any[]; hidden: any; engine: { [k: string]: any; at: any; repliesAt: any; counts: any; gate: any[]; parked: any[]; manual: any[]; declined: any[]; meetings: any[]; pins: any[] } };
