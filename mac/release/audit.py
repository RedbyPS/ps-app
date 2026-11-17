#!/usr/bin/env python3 -I
"""Public PS audit: proves a build holds nothing of the developer's before anyone else downloads it.

  python3 -I release/audit.py <PS.app | PS.dmg | *.zip | *.apk | folder> ...
  python3 -I release/audit.py --source <folder>     the open source tree (web scripts/open-source.mjs)

--source is for source code, where tests and SQL name things a build never holds: an email is fine when its
domain is reserved (.example, .test, .invalid, RFC 2606) or its name is one of the export's placeholders
(person1, owner1 and so on), and "service_role" (the database ROLE named in grants, tests and key checks) only
blocks when a key value follows it. Everything else blocks exactly as for a build.

Looks inside every file (an app's binary and resources, a DMG, the update zips, an APK and its dex,
resources and binary XML) for:
  BLOCK   the developer's names and emails, client names, Google Drive paths, his other Supabase project,
          hardware ids, host names, background video files or names, private keys and tokens,
          and the exact value of every secret on this Mac that a build could ever pick up
          (update signing key, keychain password, drop secret, phone keystore passwords),
          and the words of any of the developer's PRIVATE release notes (web ps-notes-private.json, or the
          file in $PS_PRIVATE_NOTES): those go to his vault only, never into a build or the channel.
          Secret values and private notes are compared in memory and never printed.
  REVIEW  words that may be fine (the name "Owner" in shared web copy, a home timezone): listed
          with where they are, for a person to judge.
Exit code 1 when anything BLOCK is found. Writes nothing; mounts a DMG read only and ejects it.
"""
import os, re, subprocess, sys, tempfile, zipfile, json

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BLOCK = [
    r"YOUR[_]NAME", r"YOUR[_]EMAIL[_]NAME", r"YOUR[_]CLIENT[_]NAMES",   # fill in: anything of yours a public build must never hold ([_] keeps this file from matching itself)
    r"-----begin [a-z ]*private key-----", r"service_role", r"\bsk_live_", r"\.drop-secret",
]
REVIEW = [r"YOUR_FIRST_NAME", r"/users/[a-z0-9_.-]+/"]
EMAIL = re.compile(rb"[A-Za-z0-9._%+-]{2,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
EMAIL_OK = re.compile(rb"@(example\.(com|org)|company\.com|acme\.com|vault\.cincee\.app|[a-z0-9-]+\.example|[0-9.]+x?$)", re.I)
VIDEO = (".mp4", ".mov", ".m4v", ".webm")

def secrets():
    """Every secret value a build could pick up. Kept in memory only."""
    out = []
    def add(v):
        v = v.strip() if isinstance(v, str) else v
        if isinstance(v, str): v = v.encode()
        if len(v) >= 8: out.append(v)
    import base64
    for f in ["signing/update-ed25519.key", "signing/.keychain-pass"]:
        try:
            raw = open(os.path.join(HERE, f), "rb").read()
            add(raw.strip()); add(base64.b64encode(raw)); add(base64.b64encode(raw.strip()))
        except OSError: pass
    try: add(open(os.path.join(HOME, ".ps-secrets/.drop-secret")).read())
    except OSError: pass
    try:
        for line in open(os.path.join(HOME, ".ps-gos-signing/keystore.properties")):
            k, _, v = line.partition("=")
            if "pass" in k.lower(): add(v)
    except OSError: pass
    return out

def private_notes():
    """The developer's private release notes (web ps-notes-private.json), as patterns that still match when a
    bundle escapes or re-quotes them: the words in order, anything that is not a letter or digit between them.
    Kept in memory only and never printed."""
    f = os.environ.get("PS_PRIVATE_NOTES") or os.path.join(HOME, "Projects/web/ps-notes-private.json")
    try: data = json.load(open(f, encoding="utf-8"))
    except (OSError, ValueError): return []
    out = []
    for notes in (data.values() if isinstance(data, dict) else []):
        for n in (notes if isinstance(notes, list) else []):
            words = re.findall(r"[A-Za-z0-9]+", n) if isinstance(n, str) else []
            if len(words) < 3: continue   # too short to tell apart from ordinary words
            out.append(re.compile(r"[^A-Za-z0-9]{1,12}".join(re.escape(w) for w in words).encode(), re.I))
    return out

def video_names():
    """The names of the developer's own background videos on this Mac (names only, never the files)."""
    d = os.path.join(HOME, "Library/Application Support/PS/backgrounds")
    names = set()
    try:
        for n in os.listdir(d):
            if n.endswith(".json") and not n.startswith("."):
                try:
                    m = json.load(open(os.path.join(d, n)))
                    for k in ("name", "source"):
                        v = str(m.get(k) or "")
                        # A generic clip name ("Timeline 1") cannot point at anyone and is a common word pair in code.
                        if len(v) >= 4 and not re.fullmatch(r"(timeline|clip|video|background) ?\d*", v.strip().lower()):
                            names.add(re.escape(v.lower()))
                except Exception: pass
    except OSError: pass
    return sorted(names)

def text_of(data):
    """ASCII and UTF-16 strings of 4+ characters (binaries, dex, Android binary XML)."""
    parts = [m.group(0) for m in re.finditer(rb"[\x20-\x7e]{4,}", data)]
    parts += [m.group(0).decode("utf-16le").encode() for m in re.finditer(rb"(?:[\x20-\x7e]\x00){4,}", data)]
    return b"\n".join(parts) if b"\x00" in data[:4096] or not data.isascii() else data

def files_in(path, work):
    """(label, bytes) for every file inside path (folders, zips, apks, a DMG)."""
    if os.path.isdir(path):
        for root, _, names in os.walk(path):
            for n in names:
                p = os.path.join(root, n)
                if os.path.islink(p): continue
                yield from files_in(p, work)
        return
    low = path.lower()
    if low.endswith((".zip", ".apk")):
        with zipfile.ZipFile(path) as z:
            for i in z.infolist():
                if i.is_dir(): continue
                d = z.read(i)
                if i.filename.lower().endswith((".zip", ".apk", ".jar")):
                    p = os.path.join(work, os.path.basename(i.filename)); open(p, "wb").write(d)
                    yield from ((f"{path}!{l}", b) for l, b in files_in(p, work)); continue
                yield f"{path}!{i.filename}", d
        return
    if low.endswith(".dmg"):
        mnt = tempfile.mkdtemp(prefix="ps-audit-dmg-")
        subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mnt, path], check=True, stdout=subprocess.DEVNULL)
        try:
            for root, dirs, names in os.walk(mnt):
                for n in names + [d for d in dirs if d.lower().endswith(VIDEO)]:
                    p = os.path.join(root, n)
                    if os.path.isfile(p) and not os.path.islink(p): yield f"{path}!{os.path.relpath(p, mnt)}", open(p, "rb").read()
        finally:
            subprocess.run(["hdiutil", "detach", mnt, "-quiet"], check=False)
        return
    yield path, open(path, "rb").read()

SOURCE_EMAIL_OK = re.compile(rb"^(person|owner)\d+@|@([a-z0-9-]+\.)*[a-z0-9-]+\.(example|test|invalid)$|^noreply@anthropic\.com$|@users\.noreply\.github\.com$", re.I)
# In source mode, tests name secret SHAPES on purpose (a key header, ".drop-secret", the role name) to prove the code
# refuses them, and this audit names them as its patterns. Those files still block on every name, email and real
# secret value of the developer's; only these shape patterns are skipped there.
SHAPES = {r"-----begin [a-z ]*private key-----", r"service_role", r"\bsk_live_", r"\b\d{8,10}:aa[a-z0-9_-]{33}\b", r"\.drop-secret"}
def shapes_ok(label):
    f = label.split("!")[-1]
    return "/tests/" in f or "/test/" in f or f.endswith("/release/audit.py")
SOURCE_ROLE = re.compile(rb"""(?i)\bservice_role\b(?![\s"':=,]{1,6}(eyJ[A-Za-z0-9_-]{20,}\.|sb_secret_[A-Za-z0-9]{8,}))""")

def main(paths, source=False):
    block = [re.compile(p.encode(), re.I) for p in BLOCK + video_names()]
    review = [re.compile(p.encode(), 0 if p.startswith(r"\bRed") else re.I) for p in REVIEW]
    keys = secrets()
    mine = private_notes()
    found_block, found_review, nfiles = [], {}, 0
    work = tempfile.mkdtemp(prefix="ps-audit-")
    for top in paths:
        for label, data in files_in(top, work):
            nfiles += 1
            if label.lower().endswith(VIDEO): found_block.append((label, "a video file")); continue
            if "/.ps-payload/" in label or label.endswith("/.ps-payload"): found_block.append((label, "a hidden payload"))
            for k in keys:
                if k in data: found_block.append((label, "the value of a secret (not shown)"))
            t = text_of(data)
            for r in mine:
                if r.search(t) or r.search(data): found_block.append((label, "one of the developer's private release notes (not shown)")); break
            # The own Supabase kit (V1.36) names the service_role ROLE in its SQL grants and the env variable its
            # function reads; neither is a key. Any other service_role still blocks, and key values are caught above.
            tb = re.sub(rb"(?i)(\bto\s+|,\s*)service_role\b|supabase_service_role_key", b"", t)
            if source: tb = SOURCE_ROLE.sub(b"", tb)
            for r in block:
                if source and r.pattern.decode() in SHAPES and shapes_ok(label): continue
                for m in r.finditer(tb):
                    found_block.append((label, tb[max(0, m.start() - 50):m.end() + 50].decode("utf-8", "replace").replace("\n", " ")))
                    break
            # Only around each "@" (a regex over the whole file is far too slow on long runs).
            # A bundled font's own licence (fonts/OFL-*.txt, the SIL Open Font License that must ship with the
            # font) names the font designer's address: a third party notice, never the developer's. The developer's names still block.
            at = -1 if re.search(r"/fonts/OFL-[^/]*\.txt$", label) else t.find(b"@")
            while at != -1:
                off = max(0, at - 64)
                # the address this "@" belongs to (an earlier one in the window may be cut off at its start)
                m = next((x for x in EMAIL.finditer(t[off:at + 128]) if x.start() <= at - off < x.end()), None)
                if m and not EMAIL_OK.search(m.group(0)) and not (source and SOURCE_EMAIL_OK.search(m.group(0))):
                    found_block.append((label, "email " + m.group(0).decode("utf-8", "replace")))
                at = t.find(b"@", at + 1)
            for r in review:
                for m in r.finditer(t):
                    found_review.setdefault(r.pattern.decode(), []).append((label, t[max(0, m.start() - 60):m.end() + 60].decode("utf-8", "replace").replace("\n", " ")))
    print(f"PS audit: {nfiles} files looked at in {', '.join(paths)}")
    if found_block:
        print(f"\nBLOCK ({len(found_block)}): these must go before anyone else gets this build")
        for l, why in found_block[:200]: print(f"  {l}\n      {why[:200]}")
    else:
        print("\nBLOCK: nothing. No name, email, client, Drive path, video, key or secret of the developer's.")
    if found_review:
        print("\nREVIEW (a person decides):")
        for p, hits in found_review.items():
            print(f"  {p}: {len(hits)}")
            for l, ctx in hits[:6]: print(f"    {l.split('!')[-1][:70]}  ...{ctx[:150]}...")
    return 1 if found_block else 0

if __name__ == "__main__":
    args = sys.argv[1:]
    src = "--source" in args
    args = [a for a in args if a != "--source"]
    if not args: print(__doc__); sys.exit(2)
    sys.exit(main(args, source=src))
