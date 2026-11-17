// Left out of the public source: the follow up radar. It only runs on the developer's own account, so this
// placeholder keeps the names the rest of the app imports and does nothing (scripts in the private tree:
// open-source.mjs). See README.md, "What is left out".
const inert: any = new Proxy(function () {}, {
  get: (_t: unknown, k: string | symbol): any => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : k === Symbol.iterator ? function* () {} : inert),
  apply: () => undefined,
  construct: () => ({}),
});
const _v0: any = [];
const _v1: any = { at: "", items: [], notes: [], hidden: 0, engine: { at: "", repliesAt: "", counts: undefined, gate: [], parked: [], manual: [], declined: [], meetings: [], pins: [] } };
const _v2: any = { clientId: "", projectId: "", template: "", to: "", subject: "", body: "", status: "draft", approvedAt: "", approvedText: "", sentAt: "" };
const _v3: any = { snap: { at: "", items: [], notes: [], hidden: 0, engine: { at: "", repliesAt: "", counts: undefined, gate: [], parked: [], manual: [], declined: [], meetings: [], pins: [] } }, state: { handled: undefined, snoozed: undefined }, actions: { handled: (..._a: any[]) => undefined, snooze: (..._a: any[]) => undefined, task: (..._a: any[]) => undefined, draft: (..._a: any[]) => undefined } };
export function myAddresses(_p0?: any, ..._more: any[]): any[] { return _v0; }
export function radarFromVault(_p0?: any, ..._more: any[]): { [k: string]: any; at: any; items: any[]; notes: any[]; hidden: any; engine: { [k: string]: any; at: any; repliesAt: any; counts: any; gate: any[]; parked: any[]; manual: any[]; declined: any[]; meetings: any[]; pins: any[] } } { return _v1; }
export function radarDraft(_p0?: any, ..._more: any[]): { [k: string]: any; clientId: any; projectId?: any; template: any; to?: any; subject: any; body: any; status: "draft" | "approved" | "sent"; approvedAt?: any; approvedText?: any; sentAt?: any } { return _v2; }
export function useRadar(..._more: any[]): { [k: string]: any; snap: { [k: string]: any; at: any; items: any[]; notes: any[]; hidden: any; engine: { [k: string]: any; at: any; repliesAt: any; counts: any; gate: any[]; parked: any[]; manual: any[]; declined: any[]; meetings: any[]; pins: any[] } }; state: { [k: string]: any; handled?: any; snoozed?: any }; actions: { [k: string]: any; handled: (_p0?: any, _p1?: any, ..._more: any[]) => void; snooze: (_p0?: any, _p1?: any, ..._more: any[]) => void; task: (_p0?: any, ..._more: any[]) => void; draft: (_p0?: any, ..._more: any[]) => void } } { return _v3; }
export function radarTaskTitle(_p0?: any, ..._more: any[]): string { return ""; }
