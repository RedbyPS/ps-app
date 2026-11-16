// Run: node --experimental-strip-types tests/second-window.test.ts
// The Second Computer window (src/views/SecondWindow.tsx) before a second Mac is paired (1 Nov 2026: on the
// M4 "nothing can be clicked, Messages, Files and the rest are dead"). The window used to show the setup page
// whatever tab was picked, so clicking a tab changed nothing. Now every tab opens and says what is missing.
// The real component is bundled with esbuild and rendered to HTML with React (a tab click sets the same state
// as `initial`). FICTIONAL data only (src/dev/second-fake.ts). No network, no browser.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "ps-second-window-"));
const entry = join(dir, "entry.tsx"), out = join(dir, "out.mjs");
writeFileSync(entry, `
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SecondWindow } from ${JSON.stringify(root + "src/views/SecondWindow.tsx")};
import { fakeSecond } from ${JSON.stringify(root + "src/dev/second-fake.ts")};
import { setSecondMirror } from ${JSON.stringify(root + "src/second/store.ts")};
export function render(as, initial) {
  const x = fakeSecond(Date.parse("2026-11-01T12:00:00Z"), as);
  setSecondMirror(x.local);
  const s = { docs: new Map(x.docs.map((d) => [d.id, d])), status: "unlocked" };
  return renderToStaticMarkup(createElement(SecondWindow, { s, initial }));
}
`);
// Rendering to HTML needs a server snapshot for useSyncExternalStore: the page's own "react" import gets one
// that reads the same store (the bundle's react-dom keeps the real react).
const shim = join(dir, "react-shim.cjs");
writeFileSync(shim, `const R = require(${JSON.stringify(join(root, "node_modules/react/index.js"))});
module.exports = { ...R, useSyncExternalStore: (s, g, gs) => R.useSyncExternalStore(s, g, gs || g) };`);
await build({
  plugins: [{ name: "react-shim", setup(b) { b.onResolve({ filter: /^react$/ }, (a) => a.importer.startsWith(join(root, "src")) ? { path: shim } : undefined); } }],
  entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent",
  loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".woff2": "empty" },
  nodePaths: [join(root, "node_modules")],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },   // react-dom/server needs node's own modules
  // Every import.meta.env value the code reads, made up (nothing here talks to a server).
  define: { "import.meta.env": JSON.stringify({ MODE: "test", DEV: false, PROD: true, BASE_URL: "/client/", VITE_SUPABASE_URL: "https://example.invalid", VITE_SUPABASE_KEY: "test" }) },
});
const { render } = await import(pathToFileURL(out).href) as { render: (as: string | null, initial?: string) => string };

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const nav = (html: string) => [...html.matchAll(/<nav[^>]*>([\s\S]*?)<\/nav>/g)].map((m) => [...m[1].matchAll(/<span>([^<]+)<\/span>/g)].map((x) => x[1]))[0] ?? [];
const selected = (html: string) => (html.match(/class="sel" aria-current="page"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/) ?? [])[1];
const setupShown = (html: string) => text(html).includes("Your second computer");

try {
  // A primary with no second Mac (the M4 on 31 Oct): clicking a tab must open it.
  for (const [tab, label, says] of [["files", "Files", "shared folders"], ["messages", "Messages", "notes between your Macs"], ["outsource", "Outsource", "research"], ["machine", "Machine", "Restart"]] as const) {
    ok(`unpaired: clicking ${label} opens ${label} (not the setup page) and says no second Mac is paired`, () => {
      const h = render("unpaired", tab);
      assert.equal(selected(h), label);
      assert.ok(!setupShown(h), "the setup page is still showing: the tab is dead");
      const t = text(h);
      assert.ok(t.includes(says), `${label} does not say what it is for`);
      assert.ok(t.includes("Pair with your other Mac") && t.includes("One click"), `${label} does not say why it is empty`);
      assert.match(h, /<button type="button" class="sw-primary">Pair my Macs<\/button>/);
    });
  }
  ok("unpaired: the window opens on Set up, listed first in the sidebar", () => {
    const h = render("unpaired");
    assert.deepEqual(nav(h), ["Set up", "Files", "Messages", "Outsource", "Machine"]);
    assert.equal(selected(h), "Set up");
    assert.ok(setupShown(h));
  });
  ok("not set up: every tab still opens and leads to the one Pair button", () => {
    for (const tab of ["files", "messages", "outsource", "machine"]) {
      const h = render("none", tab);
      assert.ok(!setupShown(h));
      assert.ok(text(h).includes("Pair with your other Mac"));
      assert.match(h, />Pair my Macs</);
    }
    const h = render("none");
    assert.ok(setupShown(h) && text(h).includes("No role yet") && />Pair with my other Mac</.test(h));
  });
  ok("paired: no Set up item, tabs show their real panes", () => {
    const h = render(null, "files");
    assert.deepEqual(nav(h), ["Files", "Messages", "Outsource", "Machine"]);
    assert.equal(selected(h), "Files");
    assert.ok(!setupShown(h) && !text(h).includes("Pair with your other Mac"));
    assert.ok(text(h).includes("Brand boards"), "the paired Files pane lists the M1's shared folder");
    const m = render(null, "messages");
    assert.ok(text(m).includes("Remember to plug the M1 in"));
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${n} passed`);
