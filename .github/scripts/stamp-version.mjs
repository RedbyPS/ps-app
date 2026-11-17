#!/usr/bin/env node
// Puts the claimed version into a core checkout before the G Squad build (never committed; the runner throws it away).
//
//   node stamp-version.mjs <core> <version> <by> [<attempt>]
//
// web/ps-version.json  "version" (the number every part reads) and "by" (who made it, for the "by" line)
// phone/version.properties  code, name and keyword. The G Squad versionCode comes from the number, so it always
//   goes up with the version: 1.59 is 105900 + attempt (a rebuild of the same tag gets the next attempt).
// If versions-158 gives core its own stamping command, the release workflow calls that instead.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [core, version, by, attemptArg] = process.argv.slice(2);
const m = /^(\d{1,3})\.(\d{2,3})$/.exec(version || "");
if (!core || !m || !/^[a-z][a-z0-9-]{0,30}$/.test(by || "")) {
  console.error("usage: node stamp-version.mjs <core> <version 1.59> <by> [<attempt>]");
  process.exit(2);
}
const attempt = Math.min(Math.max(Number(attemptArg) || 1, 1), 99);

const vf = join(core, "web", "ps-version.json");
const v = JSON.parse(readFileSync(vf, "utf8"));
v.version = version;
v.by = by;
writeFileSync(vf, JSON.stringify(v, null, 1) + "\n");
const keyword = (v.names && v.names[version]) || "";

const pf = join(core, "phone", "version.properties");
const code = Number(m[1]) * 100000 + Number(m[2]) * 100 + attempt;
if (existsSync(pf)) writeFileSync(pf, `code=${code}\nname=V${version}\nkeyword=${keyword}\n`);
console.log(`stamped V${version}${keyword ? ` (${keyword})` : ""} by ${by}; phone versionCode ${code}`);
