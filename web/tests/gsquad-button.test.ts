// Run: node --experimental-strip-types tests/gsquad-button.test.ts
// The G Squad button in the floating Tab list (V1.42 fix). V1.40 placed each button under the top bar by hand with
// its own right offset: the moon right 0, Second Computer right 42px, G Squad right 44px, the padlock right 84px.
// G Squad and Second Computer were 2px apart, so on the developer's Mac (the only account where Second Computer shows) the two
// drew as one icon and G Squad could not be seen, by Tab or by Open List. Friends had no Second Computer, so they
// saw it. Now the four sit in one flex row (TaskMap.tsx .tm-tr2), which can never stack two buttons on one spot.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const src = new URL("../src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(src, p), "utf8");
const map = read("views/TaskMap.tsx"), gs = read("views/GSquad.tsx"), mapCss = read("views/taskmap.css"), gsCss = read("views/gsquad.css");
const sheets = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? sheets(p) : p.endsWith(".css") ? [p] : [];
});
const rules = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((b) => { const i = b.lastIndexOf("{"); return i < 0 ? null : { sel: b.slice(0, i).replace(/^[\s\S]*\{/, "").trim(), body: b.slice(i + 1) }; })
  .filter((r): r is { sel: string; body: string } => !!r && !!r.sel);
// PS 1.70: the four are rows of the top right menu now (views/TopMenu.tsx); their real buttons sit hidden inside it.
const row = map.slice(map.indexOf("const rest = ("), map.indexOf("return isPhoneBuild() ? rest : <Slot id=\"menu\"><TopMenu>{rest}</TopMenu></Slot>;"));

ok("the cause: no stylesheet places a top bar button by hand with its own right offset", () => {
  // The exact V1.40 shape: `.tm-tr .<button> { position: absolute; ... right: Npx }`. Two of these 2px apart hid G Squad.
  const bad: string[] = [];
  for (const f of sheets(src)) for (const r of rules(readFileSync(f, "utf8"))) {
    if (!/\.tm-tr\s+\.(?!tm-tr2\b)[\w-]+/.test(r.sel)) continue;
    if (/position:\s*absolute/.test(r.body) && /(^|[;\s])right:\s*\d+px/.test(r.body) && /top:\s*calc\(100% \+/.test(r.body)) bad.push(`${f.slice(src.length)}: ${r.sel}`);
  }
  assert.deepEqual(bad, []);
});

ok("PS 1.70: the padlock, Second Computer and the moon are each one row of the top right menu; PS 1.72: The G Squad is its own button beside it", () => {
  assert.ok(row.length > 100, "the menu's block is in TaskMap.tsx");
  for (const c of ["SecurityButton", "SecondButton", "DndButton"]) assert.equal((row.match(new RegExp(`<${c}\\b`, "g")) ?? []).length, 1, c);
  assert.equal((row.match(/<GSquadButton\b/g) ?? []).length, 0, "The G Squad is not in the menu (Jan, 21 Nov 2026)");
  assert.equal((map.match(/<GSquadButton\b/g) ?? []).length, 1, "one G Squad button");
  const menu = read("core/topmenu.ts");
  for (const s of ['sel: ".sec-btn"', 'sel: ".sc-btn[aria-haspopup]"', 'sel: ".dnd-btn"']) assert.ok(menu.includes(s), s);
  assert.ok(!menu.includes('sel: ".gs-btn"'), "no G Squad row");
});

ok("the row is one flex box on the floating list and no box at all elsewhere (the website keeps them in the bar)", () => {
  const all = rules(mapCss);
  const base = all.find((r) => r.sel === ".tm-tr2");
  assert.ok(base && /display:\s*contents/.test(base.body), "default: display contents");
  const media = /@media \(min-width: 1101px\) \{([\s\S]*?)\n\}/.exec(mapCss.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1] ?? "";
  const float = rules(media).find((r) => r.sel.includes(".tm-overlay:not(.tm-docked)") && /\.tm-tr2$/.test(r.sel));
  assert.ok(float, "a floating list rule for the row");
  assert.match(float!.body, /display:\s*flex/);
  assert.match(float!.body, /position:\s*absolute/);
  assert.match(float!.body, /top:\s*calc\(100% \+ 8px\)/);
  assert.match(float!.body, /(^|[;\s])right:\s*0[;\s]/);
  assert.match(float!.body, /gap:\s*8px/);
  assert.ok(rules(media).some((r) => /:has\(\.tm-tr2 button\) \.tm-right$/.test(r.sel)), "the right column moves down for the row");
});

ok("G Squad has no placement of its own left in its stylesheet", () => {
  assert.ok(!rules(gsCss).some((r) => /\.gs-wrap$/.test(r.sel) && /right:/.test(r.body)), "no right offset on .gs-wrap");
  const wrap = rules(gsCss).find((r) => r.sel === ".gs-wrap");
  assert.ok(wrap && /position:\s*relative/.test(wrap.body), "the wrap stays the anchor for its tooltip");
});

ok("every account in PS gets the button: gated only on PS and the floating list, never on the developer or a setting", () => {
  const line = map.split("\n").find((l) => l.includes("<GSquadButton")) ?? "";
  // V1.44: also on the website's To-do page in web form (views/WebTodo.tsx), where the engine runs in the page itself.
  assert.match(line, /\{\(\(PS && !docked\) \|\| web\) && <Slot id="gsquad"><GSquadButton \/><\/Slot>\}/);
  assert.doesNotMatch(line, /\bred\b|st\.|settings/);
  const body = gs.slice(gs.indexOf("export function GSquadButton()"), gs.indexOf("\nfunction SquadLayers"));
  assert.ok(body.length > 100, "found the component");
  assert.doesNotMatch(body, /return null|return <>\s*<\/>|return undefined/, "the button always draws");
});

ok("not in yet: the button says Joining The G Squad (hover card, screen reader) and shows a plus", () => {
  assert.match(gs, /export const NO_SQUAD = "Joining The G Squad";/);   // V1.49: PS joins by itself
  const body = gs.slice(gs.indexOf("export function GSquadButton()"), gs.indexOf("\nfunction SquadLayers"));
  assert.match(body, /: `The G Squad\. \$\{outLine\}`\}/, "aria-label");
  assert.match(body, /data-tip-line=\{v\.in \? workingLine\(n\) : outLine\}/, "hover card line");
  assert.doesNotMatch(body, /"You left The G Squad"/, "PS 1.68: nobody leaves");
  assert.match(body, /\{!v\.in && <i className="gs-plus" aria-hidden="true" \/>\}/, "the plus");
  assert.ok(rules(gsCss).some((r) => r.sel === ".gs-plus"), "the plus is styled");
});

ok("while the list is kept over other apps, a click on the row (G Squad too) reaches PS (hit rects)", () => {
  const sel = /const sel = ("[^"]*")/.exec(map)?.[1] ?? "";
  for (const c of [".tm-tr2", ".gs-btn", ".sc-btn", ".sec-btn", ".dnd-btn"]) assert.ok(sel.includes(c), `${c} in ${sel}`);
});

console.log(`${n} passed`);
