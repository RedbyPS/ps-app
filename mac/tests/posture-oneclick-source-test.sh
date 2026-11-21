#!/bin/bash
# Source check (the developer, 21 Nov 2026: "it takes a lot of clicks to click ok to make the posture reminder go away"):
# PS cards close on ONE click. A card's panel is non activating and not key while it waits, so its web view must accept
# the first mouse, or the first click only makes the card key and is dropped.
# 1. The Posture card (Sources/Posture.swift): its web view is a PostureWebView that returns true from acceptsFirstMouse,
#    no plain WKWebView is made in that file, and the buttons' click gate opens at the same moment they fade in.
# 2. PS 1.72 sweep: every web view PS makes for a card or panel (all of Sources, self test files aside) must be a class
#    that returns true from acceptsFirstMouse (ClickThroughWebView, PostureWebView, ReplyWebView, SecondWebView), so no
#    card drops the first click. The one plain WKWebView allowed is main.swift's hidden engine page (`main`): it is never
#    a card, and its window only shows as the ordinary Sign in window.
# Then the same checks on planted copies must fail, so the checks themselves work.
# Reads source files only, writes only into a temporary folder. Safe while someone uses the Mac.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"; T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/check.py" <<'PY'
import re, sys
s = open(sys.argv[1], encoding="utf-8").read()
bad = []
cls = re.search(r"final class PostureWebView\s*:\s*WKWebView\s*\{(.*?)\n\}", s, re.S)
if not cls:
    bad.append("no PostureWebView: WKWebView class")
elif not re.search(r"override func acceptsFirstMouse\(for event: NSEvent\?\) -> Bool \{\s*true\s*\}", cls.group(1)):
    bad.append("PostureWebView must return true from acceptsFirstMouse (the first click on a button counts)")
code = "\n".join(l.split("//", 1)[0] for l in s.split("\n"))
if re.search(r"(?<![A-Za-z])WKWebView\(frame", code):
    bad.append("a plain WKWebView is made for the card: it drops the first click; use PostureWebView")
if not re.search(r"let w = PostureWebView\(frame", code):
    bad.append("the card's web view is not made as a PostureWebView")
if not re.search(r"private var web: PostureWebView\?", code):
    bad.append("the card keeps its web view as something other than PostureWebView")
# The click gate (.rdy) must open on the same wait the buttons fade in on (--w), never later.
if "setProperty('--w', wait + 'ms')" not in s or "setTimeout(go, wait)" not in s:
    bad.append("the buttons' click gate and their fade in must share one wait")
for b in bad: print("FAIL:", b)
sys.exit(1 if bad else 0)
PY
cat > "$T/sweep.py" <<'PY'
import os, re, sys
src = sys.argv[1]
files = {f: open(os.path.join(src, f), encoding="utf-8").read() for f in sorted(os.listdir(src))
         if f.endswith(".swift") and not f.endswith("SelfTest.swift")}
strip = lambda t: "\n".join(l.split("//", 1)[0] for l in t.split("\n"))
parent, first = {}, set()
for f, t in files.items():
    for m in re.finditer(r"class\s+(\w+)\s*:\s*(\w+)\s*\{(.*?)\n\}", strip(t), re.S):
        parent[m.group(1)] = m.group(2)
        if re.search(r"override func acceptsFirstMouse\(for event: NSEvent\?\) -> Bool \{\s*true\s*\}", m.group(3)):
            first.add(m.group(1))
def ok(c, seen=()):
    return c in first or (c in parent and c not in seen and ok(parent[c], seen + (c,)))
ALLOW = {("main.swift", "main = WKWebView(")}   # the hidden engine page, never a card
bad, n = [], 0
for f, t in files.items():
    for ln, line in enumerate(strip(t).split("\n"), 1):
        for m in re.finditer(r"\b(\w*WebView)\((frame|configuration)\b", line):
            n += 1
            if ok(m.group(1)) or any(f == a and k in line for a, k in ALLOW): continue
            bad.append(f"{f}:{ln}: {m.group(1)} drops the first click; use ClickThroughWebView (main.swift)")
if n < 10: bad.append(f"only {n} web views found: the sweep is not reading the sources")
for b in bad: print("FAIL:", b)
sys.exit(1 if bad else 0)
PY
SRC="$HERE/Sources/Posture.swift"
if ! python3 -I "$T/check.py" "$SRC"; then echo "posture one click: FAIL"; exit 1; fi
if ! python3 -I "$T/sweep.py" "$HERE/Sources"; then echo "cards one click: FAIL"; exit 1; fi
# Planted Posture copies: each must fail.
plant() { sed "$1" "$SRC" > "$T/p.swift"; if python3 -I "$T/check.py" "$T/p.swift" >/dev/null; then echo "posture one click: the check missed a planted fault ($2)"; exit 1; fi; }
plant 's/-> Bool { true }   \/\/ the first click on a button counts/-> Bool { false }/' "acceptsFirstMouse false"
plant 's/let w = PostureWebView(frame/let w = WKWebView(frame/' "plain WKWebView"
plant 's/setTimeout(go, wait)/setTimeout(go, wait + 2000)/' "click gate later than the fade in"
# Planted source folders: each card must be caught on its own.
plants() {
  rm -rf "$T/s"; cp -R "$HERE/Sources" "$T/s"; sed -i '' "$2" "$T/s/$1"
  if cmp -s "$HERE/Sources/$1" "$T/s/$1"; then echo "cards one click: the plant did not change $1"; exit 1; fi
  if python3 -I "$T/sweep.py" "$T/s" >/dev/null; then echo "cards one click: the sweep missed a planted fault ($1)"; exit 1; fi
}
plants Reminders.swift 's/let w = ClickThroughWebView(frame/let w = WKWebView(frame/'
plants AreYouSure.swift 's/let w = ClickThroughWebView(frame/let w = WKWebView(frame/'
plants Soundboard.swift 's/let w = ClickThroughWebView(frame/let w = WKWebView(frame/'
plants Toast.swift 's/web = ClickThroughWebView(frame/web = WKWebView(frame/'
plants main.swift 's/  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }$/  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { false }/'
echo "posture one click: PASS"
echo "cards one click: PASS"
