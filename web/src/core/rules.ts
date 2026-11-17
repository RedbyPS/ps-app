// Left out of the public source: the PS rules. It only runs on the developer's own account, so this
// placeholder keeps the names the rest of the app imports and does nothing (scripts in the private tree:
// open-source.mjs). See README.md, "What is left out".
const inert: any = new Proxy(function () {}, {
  get: (_t: unknown, k: string | symbol): any => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : k === Symbol.iterator ? function* () {} : inert),
  apply: () => undefined,
  construct: () => ({}),
});
const _v0: any = [];
const _v1: any = [];
const _v2: any = [];
export function cleanRules(_p0?: any, ..._more: any[]): any[] { return _v0; }
export function moveRule(_p0?: any, _p1?: any, _p2?: any, ..._more: any[]): any[] { return _v1; }
export function placeRule(_p0?: any, _p1?: any, _p2?: any, ..._more: any[]): any[] { return _v2; }
export function checkOutcome(_p0?: any, _p1?: any, ..._more: any[]): "end" | "nuke" | "waiting" { return "end"; }
export function needsCheck(_p0?: any, ..._more: any[]): boolean { return false; }
export type Rule = { [k: string]: any; id: any; text: any; createdAt: any };
export const RULE_MAX: number = 0;
export const RULE_TEXT_MAX: number = 0;
export type Verdict = any;
export const NUKE_LOG: "PS nuke: a rule was failed, PS removed itself" = "PS nuke: a rule was failed, PS removed itself";
