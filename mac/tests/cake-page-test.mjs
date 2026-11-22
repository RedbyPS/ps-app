// Run: node tests/cake-page-test.mjs [shots-dir]
// The Cake page (ui/cake.html) in headless Chromium with a stand-in for the Mac: fixed timing, the hold while PS loads,
// Esc, signed in and signed out, the reveal, Reduce Motion, the headline and the running version. Silent (the page has
// no sound), nothing on screen, PS is never started. Needs playwright-core (PLAYWRIGHT_CORE=/path/to/playwright-core, or
// one of the folders below); without it the test says so and stops.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = pathToFileURL(path.join(HERE, '..', 'ui', 'cake.html')).href;
const SHOTS = process.argv[2] || '';
const NO_FONTS = false;   // every file the page loads is in ui/: any failed load is a page error
const spots = [process.env.PLAYWRIGHT_CORE, path.join(process.env.HOME || '', 'Projects/lbj-verify/node_modules/playwright-core')].filter(Boolean);
const where = spots.find(p => existsSync(path.join(p, 'package.json')));
if (!where) { console.log('SKIP - no playwright-core found (set PLAYWRIGHT_CORE)'); process.exit(0); }
const { chromium } = await import(pathToFileURL(path.join(where, 'index.mjs')).href);

let n = 0, bad = 0;
const okFirst = existsSync(path.join(HERE, '..', 'ui', 'cake-anton.ttf')) && existsSync(path.join(HERE, '..', 'ui', 'cake-anton-OFL.txt'));
const ok = (name, c, extra = '') => { n++; if (c) console.log('ok - ' + name); else { bad++; console.log('FAIL - ' + name + (extra ? ' (' + extra + ')' : '')); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

ok('the Anton font and its licence are in ui/', okFirst);
const browser = await chromium.launch({ headless: true });
// The Mac's side: records every message with the time since play(), answers "built" after `holdMs` with land(a).
async function run({ mode = 'boot', scene = 1, reduce = false, holdMs = 0, land = { real: true, signIn: false }, skipAt = 0, until = 'done', shot = '', target = null, notch = true, shown = true, w = 1710, h = 1112, aim = undefined, from = undefined, probe = null } = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, bypassCSP: true });   // the test's own probes only; the page's CSP stays as it is in PS
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !(NO_FONTS && /ERR_FILE_NOT_FOUND/.test(m.text()))) errors.push(m.text()); });
  await page.addInitScript(({ holdMs, land, aim }) => {
    window.__log = [];
    window.__t0 = 0;
    window.webkit = { messageHandlers: { cake: { postMessage: s => {
      const o = JSON.parse(s); o.at = performance.now() - window.__t0; window.__log.push(o);
      if (o.type === 'built') setTimeout(() => window.__cake.land(land), holdMs);
      if (o.type === 'aim' && aim !== undefined) setTimeout(() => window.__cake.aimed(aim), 5);   // PS 1.74: the Mac's answer (none: an old Mac)
    } } } };
  }, { holdMs, land, aim });
  await page.goto(PAGE);
  await page.waitForFunction(() => window.__log.some(m => m.type === 'ready'), null, { timeout: 5000 });
  await page.evaluate(o => { window.__t0 = performance.now(); window.__cake.play(o); }, { mode, scene, reduce, headline: 'CAKE', ver: 'PS 1.73', target: target || { x: 757, y: 0, w: 196, h: 34 }, notch, shown, from });
  if (skipAt) { await page.waitForTimeout(skipAt); await page.evaluate(() => window.__cake.skip()); }
  if (shot) {
    await page.waitForFunction(() => window.__log.some(m => m.type === 'exit'), null, { timeout: 40000 });
    await page.screenshot({ path: shot });
  }
  await page.waitForFunction(u => window.__log.some(m => m.type === u), until, { timeout: 40000 });
  const log = await page.evaluate(() => window.__log);
  const probed = probe ? await page.evaluate(probe) : null;
  const dom = await page.evaluate(() => ({ text: document.body.innerText, calmSeen: window.__calmSeen || false, letters: [...document.querySelectorAll('.b-l')].map(e => e.textContent).join('') }));
  await page.close();
  const at = t => (log.find(m => m.type === t) || {}).at;
  return { log, at, errors, dom, probed };
}

const DUR = { 1: 6000, 2: 5400, 3: 5400 };
// 1. Fixed speed, PS ready early: each boot scene asks once, ends at its own length, fades in 0.6 s.
for (const s of [1, 2, 3]) {
  const r = await run({ scene: s, shot: SHOTS ? path.join(SHOTS, `cake-c${s}-end.png`) : '' });
  ok(`scene ${s}: no page errors`, r.errors.length === 0, r.errors.join(' | '));
  ok(`scene ${s}: asks once when the neon island is built`, r.log.filter(m => m.type === 'built').length === 1);
  ok(`scene ${s}: the island is built before the end`, r.at('built') < DUR[s] - 600, String(r.at('built')));
  ok(`scene ${s}: the fade starts at its fixed length (${DUR[s]} ms)`, near(r.at('exit'), DUR[s], 220), String(Math.round(r.at('exit'))));
  ok(`scene ${s}: done 0.6 s after`, near(r.at('done') - r.at('exit'), 600, 150), String(Math.round(r.at('done') - r.at('exit'))));
  ok(`scene ${s}: the order is ready, aim, built, exit, done`, r.log.map(m => m.type).filter(t => t !== 'click').join(',') === 'ready,aim,built,exit,done');
}
// 2. Same scene twice: the same length (never tied to anything else).
{
  const a = await run({ scene: 2 }), b = await run({ scene: 2 });
  ok('the same scene runs the same length twice', near(a.at('exit'), b.at('exit'), 150), `${Math.round(a.at('exit'))} vs ${Math.round(b.at('exit'))}`);
}
// 3. PS still loading at the end: the calm loop holds, never an exit before PS is ready, then the rest at the same pace.
{
  const r = await run({ scene: 1, holdMs: 4000 });
  const built = r.at('built'), exit = r.at('exit');
  ok('held: no fade before PS is ready', exit >= built + 4000, `${Math.round(built)} then ${Math.round(exit)}`);
  ok('held: after ready only the settle (about 0.45 s), not the whole scene again', exit - (built + 4000) < 900, String(Math.round(exit - built - 4000)));
  ok('held: no page errors', r.errors.length === 0, r.errors.join(' | '));
}
// 4. Esc (the Mac calls skip): straight out, no exit fade of its own, done within 0.4 s.
for (const at of [800, 3000, 5000]) {
  const r = await run({ scene: 3, skipAt: at, holdMs: 99999 });
  ok(`Esc at ${at} ms: done within 0.4 s`, r.at('done') - at < 450, String(Math.round(r.at('done') - at)));
  ok(`Esc at ${at} ms: says it was skipped`, r.log.find(m => m.type === 'done').skipped === true);
  ok(`Esc at ${at} ms: no page errors`, r.errors.length === 0, r.errors.join(' | '));
}
// 5. Signed out and an island that will not show: the page ends the same way (the Mac shows the Sign in window).
{
  const r = await run({ scene: 2, land: { real: false, signIn: true } });
  ok('signed out: same length', near(r.at('exit'), 5400, 220), String(Math.round(r.at('exit'))));
  ok('signed out: no page errors', r.errors.length === 0, r.errors.join(' | '));
}
// 6. The logo reveal: 6.4 s, then its finished frame held 1.4 s, then the fade. It never asks about PS.
{
  const r = await run({ mode: 'reveal', shot: SHOTS ? path.join(SHOTS, 'cake-c4-end.png') : '' });
  ok('reveal: no page errors', r.errors.length === 0, r.errors.join(' | '));
  ok('reveal: never asks if PS is ready', !r.log.some(m => m.type === 'built'));
  ok('reveal: the fade starts at 6.4 s plus the 1.4 s hold', near(r.at('exit'), 7800, 250), String(Math.round(r.at('exit'))));
  ok('reveal: shows the headline and the running version', /CAKE/.test(r.dom.text) && /PS 1\.73/.test(r.dom.text));
  const s = await run({ mode: 'reveal', skipAt: 2000 });
  ok('reveal: Esc ends it within 0.4 s', s.at('done') - 2000 < 450, String(Math.round(s.at('done') - 2000)));
}
// 7. Reduce Motion: a short calm fade (no fixed long scene), still waits for PS.
{
  const r = await run({ scene: 1, reduce: true });
  ok('Reduce Motion: asks for the island after the fade in', near(r.at('built'), 600, 200), String(Math.round(r.at('built'))));
  ok('Reduce Motion: ends in about 2 s', r.at('exit') < 2600, String(Math.round(r.at('exit'))));
  const h = await run({ scene: 3, reduce: true, holdMs: 3000 });
  ok('Reduce Motion: still holds until PS is ready', h.at('exit') >= h.at('built') + 3000);
  const v = await run({ mode: 'reveal', reduce: true });
  ok('Reduce Motion reveal: short', v.at('exit') < 3500, String(Math.round(v.at('exit'))));
}
// 8. The words: CAKE from the Mac, the running version under it.
{
  const r = await run({ scene: 1, until: 'built', holdMs: 99999 });
  ok('boot: the headline letters are C, A, K, E', r.dom.letters === 'CAKE', r.dom.letters);
  ok('boot: the line under it is the running version', /PS 1\.73/.test(r.dom.text));
}
// 9. Other screens: a 16:9 screen and a moved (pill) island run clean.
{
  const r = await run({ scene: 1, w: 1920, h: 1080 });
  ok('1920 x 1080: no page errors, same length', r.errors.length === 0 && near(r.at('exit'), 6000, 220), r.errors.join(' | '));
  const p = await run({ scene: 3, target: { x: 40, y: 900, w: 270, h: 30 }, notch: false, shot: SHOTS ? path.join(SHOTS, 'cake-c3-pill.png') : '' });
  ok('a pill island low on the screen: no page errors', p.errors.length === 0, p.errors.join(' | '));
}
// 10. PS 1.74: the island where the person put it. The page asks again just before it builds; an answer moves the build there.
// Where the outline is (stage coordinates) and where each piece starts (its first keyframe's translate added to its box).
const OUTLINE = () => [...document.querySelectorAll('.nisl')].map(e => {
  const st = e.style, k = (e.getAnimations()[0] || null);
  const f = k ? (k.effect.getKeyframes()[0].transform || '') : '';
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(f);
  return { x: parseFloat(st.left), y: parseFloat(st.top), w: parseFloat(st.width), h: parseFloat(st.height), dx: m ? +m[1] : 0, dy: m ? +m[2] : 0 };
});
{
  const tl = { x: 6, y: 2, w: 270, h: 28 };
  for (const sc of [1, 2, 3]) {
    const r = await run({ scene: sc, until: 'built', holdMs: 99999, aim: { target: tl, notch: false, from: { x: 1, y: 1 } }, probe: OUTLINE });
    const o = r.probed[0] || {};
    ok(`scene ${sc}: asks where the island is just before it builds`, r.at('aim') < r.at('built') && r.log.filter(m => m.type === 'aim').length === 1);
    ok(`scene ${sc}: builds round the island moved to the top left, not the top centre`, near(o.x, tl.x - 3, 1.5) && near(o.y, tl.y - 3, 1.5) && near(o.w, tl.w + 6, 1.5), JSON.stringify(o));
    ok(`scene ${sc}: no page errors with the new aim`, r.errors.length === 0, r.errors.join(' | '));
  }
  const old = await run({ scene: 2, probe: OUTLINE, until: 'built', holdMs: 99999, target: { x: 1400, y: 1040, w: 270, h: 30 }, notch: false });
  ok('an old Mac that never answers: the place from the start is kept', near((old.probed[0] || {}).x, 1397, 1.5), JSON.stringify(old.probed[0]));
  const oldEnd = await run({ scene: 2 });
  ok('an old Mac that never answers: the scene keeps its length', near(oldEnd.at('exit'), 5400, 220), String(Math.round(oldEnd.at('exit'))));
}
// 11. The real island turns out somewhere else (moved while the scene ran): the outline glides onto it.
{
  const moved = { x: 1430, y: 1040, w: 270, h: 30 };
  const r = await run({ scene: 1, land: { real: true, signIn: false, target: moved, notch: false }, probe: () => ({ glide: document.getElementById('stage').dataset.glide }), until: 'exit' });
  ok('the outline glides onto the real island when it is elsewhere', r.probed.glide === '1');
  ok('the glide keeps the scene length', near(r.at('exit'), 6000, 250), String(Math.round(r.at('exit'))));
  const same = await run({ scene: 1, land: { real: true, signIn: false, target: { x: 757, y: 0, w: 196, h: 34 } }, probe: () => ({ glide: document.getElementById('stage').dataset.glide }), until: 'exit' });
  ok('no glide when the island is where it was built', same.probed.glide === '');
  const rm = await run({ scene: 2, reduce: true, land: { real: true, signIn: false, target: moved, notch: false }, probe: () => ({ glide: document.getElementById('stage').dataset.glide, moving: document.getAnimations().filter(a => a.playState === 'running' && /translate/.test(JSON.stringify(a.effect.getKeyframes()))).length }) });
  ok('Reduce Motion: no glide, no pieces flying', rm.probed.glide === '' && rm.probed.moving === 0, JSON.stringify(rm.probed));
}
// 12. Pieces fly in from the side facing the island: never from beyond the edge it sits at (corners, edges, the bottom).
{
  const spots = [
    ['top left', { x: 6, y: 2, w: 270, h: 28 }, { x: 1, y: 1 }],
    ['top right', { x: 1434, y: 2, w: 270, h: 28 }, { x: -1, y: 1 }],
    ['bottom left', { x: 6, y: 1080, w: 270, h: 28 }, { x: 1, y: -1 }],
    ['bottom right', { x: 1434, y: 1080, w: 270, h: 28 }, { x: -1, y: -1 }],
    ['left edge', { x: 6, y: 540, w: 270, h: 28 }, { x: 1, y: -1 }],
    ['bottom centre', { x: 720, y: 1080, w: 270, h: 28 }, { x: 0, y: -1 }],
  ];
  for (const [name, t, f] of spots) {
    const r = await run({ scene: 2, target: t, notch: false, from: f, until: 'built', holdMs: 99999, probe: OUTLINE });
    const starts = r.probed.map(o => ({ x: o.x + o.w / 2 + o.dx, y: o.y + o.h / 2 + o.dy }));
    const onScreen = starts.length === 4 && starts.every(p => p.x > -60 && p.x < 1770 && p.y > -90 && p.y < 1200);
    ok(`Harbor lights, island ${name}: every piece flies in from the screen's inside`, onScreen, JSON.stringify(starts.map(p => [Math.round(p.x), Math.round(p.y)])));
    if (SHOTS && name === 'bottom left') {
      // a picture of the build at a corner (no hold: the scene runs to its end)
      await run({ scene: 2, target: t, notch: false, from: f, shot: path.join(SHOTS, 'cake-c2-bottom-left.png') });
    }
  }
  const home = await run({ scene: 2, until: 'built', holdMs: 99999, probe: OUTLINE });
  const hs = home.probed.map(o => Math.round(o.dx));
  ok('Harbor lights at home: the pieces come in as on the approved demo', JSON.stringify(hs) === JSON.stringify([-520, 520, -460, 480]), JSON.stringify(hs));
  for (const sc of [1, 3]) {
    const r = await run({ scene: sc, target: { x: 6, y: 1080, w: 270, h: 28 }, notch: false, from: { x: 1, y: -1 }, until: 'built', holdMs: 99999 });
    ok(`scene ${sc} at the bottom left corner: no page errors`, r.errors.length === 0, r.errors.join(' | '));
  }
  const rv = await run({ mode: 'reveal', target: { x: 720, y: 1080, w: 270, h: 28 }, notch: false, from: { x: 0, y: -1 } });
  ok('the reveal with the island at the bottom: no page errors', rv.errors.length === 0, rv.errors.join(' | '));
}
await browser.close();
console.log(`\n${n - bad}/${n} passed`);
process.exit(bad ? 1 : 0);
