// This build's profile (V1.58, multiple developers; design: ps-handover-notes/v158-multidev-design.md section 2).
// A profile is one small settings file per build: core's profiles/gsquad.json for the G Squad build, a person's own
// profile.json in their layer (the developer's: ps-layer/profile.json). It says whose build this is (name), which updates it
// follows (channel), whether other people's shared features start on (othersShared), per build feature overrides
// (features) and the rules that differ per person (rules: the Tab list and the island over 1Password and Signal).
//
// Where it comes from: vite.config.ts (the flip) puts the bundled build file into __PS_BUILD__. A build made without
// one (the private tree as in V1.57, the dev server, an open-source.mjs build) has no profile: profile() is null and
// every rule keeps its per account answer exactly as in V1.57. Never a gsquad default there.
// Pure: no React, no DOM, so the unit tests (tests/profile.test.ts) load it as it is.

/** The rules that differ per person. Add one here, in core's gsquad.json and in each layer's profile. */
export const RULES = ["tabOverProtectedApps", "islandOverProtectedApps"] as const;
export type Rule = typeof RULES[number];

export type Channel = { kind: "gsquad" } | { kind: "local" } | { kind: "url"; url: string };

export interface Profile {
  schema: 1;
  /** Lowercase word: "gsquad" for the shared build, else the person's private release name ("red", "jan"). */
  name: string;
  /** How the build is named in words ("the G Squad", "Owner"). */
  display: string;
  channel: Channel;
  /** Shared features made by OTHER people: "on" in gsquad; a person picks for their own profile (the developer: "on" since V1.61). */
  othersShared: "on" | "off";
  /** Overrides of the registry default for this build, by feature id. */
  features: Record<string, boolean>;
  rules: Partial<Record<Rule, boolean>>;
}

export const NAME_RE = /^[a-z][a-z0-9]{0,31}$/;
export const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** A profile from JSON, or null when it is not one (a wrong file never half applies). */
export function cleanProfile(v: unknown): Profile | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (p.schema !== 1 || typeof p.name !== "string" || !NAME_RE.test(p.name)) return null;
  const channel = cleanChannel(p.channel);
  if (!channel) return null;
  if (p.othersShared !== "on" && p.othersShared !== "off") return null;
  const features: Record<string, boolean> = {};
  if (p.features && typeof p.features === "object") {
    for (const [k, b] of Object.entries(p.features as Record<string, unknown>)) if (ID_RE.test(k) && typeof b === "boolean") features[k] = b;
  }
  const rules: Partial<Record<Rule, boolean>> = {};
  if (p.rules && typeof p.rules === "object") {
    const r = p.rules as Record<string, unknown>;
    for (const k of RULES) if (typeof r[k] === "boolean") rules[k] = r[k] as boolean;
  }
  const display = typeof p.display === "string" && p.display.trim() ? p.display.trim().slice(0, 60) : p.name;
  return { schema: 1, name: p.name, display, channel, othersShared: p.othersShared, features, rules };
}

function cleanChannel(v: unknown): Channel | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (c.kind === "gsquad") return { kind: "gsquad" };
  if (c.kind === "local") return { kind: "local" };
  if (c.kind === "url" && typeof c.url === "string" && /^https:\/\/[^\s]+$/.test(c.url)) return { kind: "url", url: c.url };
  return null;
}

// ---------- the build file ----------
type Build = { profile?: unknown; features?: unknown; own?: unknown } | null;
let testBuild: { b: Build } | null = null;

/** The bundled build file (__PS_BUILD__, written by vite.config.ts), or null when this build has none. */
export function buildFile(): Build {
  if (testBuild) return testBuild.b;
  // @ts-ignore: __PS_BUILD__ is defined by vite.config.ts and declared in src/vite-env.d.ts (the flip's files)
  const b: unknown = typeof __PS_BUILD__ !== "undefined" ? __PS_BUILD__ : null;
  return b && typeof b === "object" ? (b as Build) : null;
}
/** Tests only: pretend this is the bundled build file (null: a build without one). Pass undefined to stop. */
export function setBuildForTests(b: Build | undefined): void {
  testBuild = b === undefined ? null : { b };
  memo = undefined;
}

let memo: Profile | null | undefined;
/** This build's profile, or null when the build has none (then every rule keeps its per account answer). */
export function profile(): Profile | null {
  if (memo === undefined) memo = cleanProfile(buildFile()?.profile);
  return memo;
}
/** What a build made the old way (no profile) says about its own person's account (V1.61): whether others' shared
 *  features start on there, and that person's per feature overrides. Read from the bundled `own` (vite.config.ts takes
 *  it from ps-layer/profile.json), never from the profile, so a wrong or missing file means null: core's defaults. */
export interface OwnDefaults { othersShared: "on" | "off"; features: Record<string, boolean> }
export function cleanOwn(v: unknown): OwnDefaults | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.othersShared !== "on" && o.othersShared !== "off") return null;
  const features: Record<string, boolean> = {};
  if (o.features && typeof o.features === "object" && !Array.isArray(o.features)) {
    for (const [k, b] of Object.entries(o.features as Record<string, unknown>)) if (ID_RE.test(k) && k.length <= 48 && typeof b === "boolean") features[k] = b;
  }
  return { othersShared: o.othersShared, features };
}
/** This build's own account defaults, or null (an assembled build, core, or no ps-layer/profile.json). */
export function ownDefaults(): OwnDefaults | null {
  const b = buildFile();
  return b && !cleanProfile(b.profile) ? cleanOwn(b.own) : null;
}

/** "gsquad", "red", "jan"..., or null when the build has no profile. */
export function profileName(): string | null {
  return profile()?.name ?? null;
}

/** What the profile says about a rule: true, false, or null when there is no profile or it does not say. */
export function profileRule(rule: Rule, p: Profile | null = profile()): boolean | null {
  const v = p?.rules[rule];
  return typeof v === "boolean" ? v : null;
}

/** A rule's answer for this build. PS 1.71 (the developer, 13 Nov 2026, again 19 Nov: "it's just turned off again"): the Tab
 *  list and the island over 1Password and Signal are two rules per BUILD, never one shared switch: on in the G Squad
 *  build, off in the developer's own build, whoever is signed in. So the profile decides whenever it says. Before 1.71 it was
 *  ANDed with the per account answer, so the G Squad build signed in with the developer's account was off.
 *  No profile, or one that does not say: the per account answer, as in V1.57. (The Mac's Profile.allows does the same,
 *  and a Mac built from a private tree also carries its layer's rules alone, Resources/build-rules.json.) */
export function joinRule(rule: Rule, perAccount: boolean, p: Profile | null = profile()): boolean {
  const v = profileRule(rule, p);
  return v === null ? perAccount : v;
}
