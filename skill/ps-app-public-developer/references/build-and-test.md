# Build, run and test PS from the public repo

All commands run from your clone of github.com/RedbyPS/ps-app (core; a fork's clone works the same). Paths are
relative to the repo root.

## The whole thing in one command

```bash
node tools/build.mjs gsquad all --check --tests          # what GitHub checks: tsc, web tests, Swift type check, phone compile
node tools/build.mjs gsquad web                          # the G Squad build's Mac page (dist-ps), in .build/gsquad/
node tools/build.mjs ../ps-<release name>-layer/layer.json mac   # your own Mac app, in .build/<release name>/mac/build/PS.app
```

`tools/build.mjs` assembles a tree in `.build/<name>/` first and builds there, so your clone stays as it is.
`--allow-fail a,b` names web tests that already fail on a clean `main`. It installs nothing and never signs with
anyone else's key. The sections below are the same steps by hand, part by part.

## What you need

| Part | Needs |
| --- | --- |
| Web app | Node.js 22 or newer (tests use `node --experimental-strip-types`). Works on macOS, Windows and Linux. |
| Mac app | A Mac (Apple silicon: the build targets `arm64-apple-macos13`), Xcode command line tools (`xcode-select --install`). |
| Phone app | JDK 21, Android Studio's SDK (or the command line tools), the Gradle wrapper in `phone/`. |
| Audits | `gitleaks` 8 or newer, Python 3. |
| Your own Supabase (optional) | A free Supabase project, or the Supabase CLI with Docker for a local one. |

## The web app

```bash
cd web
cp .env.example .env        # the hosted vault's public address and publishable key, or your own (below)
npm ci
npx tsc --noEmit -p .       # type check, seconds; run it after every change
npm run dev                 # the website at http://localhost:5173/client/
npm run build               # website build into dist/client
npm run build:ps            # the Mac app's page into dist-ps
```

The phone page is built by `phone/scripts/build-web.sh` (it runs `vite build --mode gos`).

Fake data for trying screens without an account: the dev server (only) shows fictional data when the address has
`?fake` (`web/src/App.tsx`, `web/src/dev/`; the phone web app in `web/src/mobile/main.tsx` also takes `?fake=guide`
and `?fake=connect`). Never put real data in tests or fixtures.

## Unit tests

One file per area in `web/tests/`, each a plain Node script:

```bash
cd web
node --experimental-strip-types tests/prio.test.ts
for f in tests/*.test.ts; do node --experimental-strip-types "$f" >/dev/null || echo "FAIL $f"; done
```

Run the files for the area you touched, plus any that import the files you changed (`grep -l "core/<file>" tests/*.ts`).
A few suites also fail on a clean checkout (looks, ps-core, pages-webkit and esc-always did at V1.58): run
the suite on a clean `main` first, so you only report failures you caused.

Every change brings a test. Most logic lives in `web/src/core/` precisely so it can be tested without a browser:
put new rules there, keep components thin.

## The Mac app

```bash
cd mac
NO_INSTALL=1 ./build.sh     # builds web (--mode ps) and mac/build/PS.app; installs nothing
```

Read before the first run:

- **Without `NO_INSTALL=1`, `build.sh` installs into `/Applications`**, moving any installed PS to the Trash and
  replacing it. If you also use the downloaded PS, always build with `NO_INSTALL=1` and quit the downloaded PS
  before opening yours: only one PS runs at a time (a second one quits at once).
- **The middle click helper's folder is not in the repo.** `build.sh` builds "PS Middle Click.app" from a sibling
  folder `../middle-click` (or `PS_MIDDLECLICK_DIR`). Since V1.58, without it the build carries on, prints a
  WARNING and makes PS without the Force Touch middle click helper (that one feature then cannot start).
- **Signing.** With no signing keychain in `mac/signing/` the build signs ad hoc and says so. Ad hoc means macOS asks
  for Accessibility again after every rebuild. For a stable identity, make your own self signed code signing
  certificate (`mac/signing/cert.cnf` shows the settings) and point `build.sh` at it in a private change. Never
  commit a key, keychain or password (`.gitignore` already blocks the usual names).
- **What a self built copy cannot do:** take updates from the G Squad channel (they only install over the
  signature they were made for; your build follows your own channel, `local` by default: you install your own
  builds), and use the pinned restart helper (it is tied to the certificate that signed it). Everything else runs.
- The offline translator in `mac/tools/translate/` may fail to build; the script warns and carries on (that
  feature is switched off anyway).
- Only one Swift or Gradle build at a time on a laptop: they use a lot of memory.

Quick Swift check without a full build (the same check `tools/build.mjs ... mac --check` runs):

```bash
cd mac && swiftc -typecheck -target arm64-apple-macos13 Sources/*.swift Helper/RebootXPC.swift
```

Swift and shell tests live in `mac/tests/`. Most `*-test.sh` files copy the matching `*-test.swift` to a temporary
`main.swift`, compile it with only the `Sources/*Core.swift` files it needs and run it (no socket, no Keychain, safe
while someone uses the Mac), for example `bash tests/taskapi-test.sh`. A `.swift` test with no `.sh` (for example
`safepeek-test.swift`) is compiled the same way by hand. Run the ones for the files you changed; a new pure rule goes
in a `*Core.swift` file so it can be tested like this.

**The Mac self test** (`mac/tests/selftest.sh`) runs a test copy of PS with fictional data and real mouse events.
It takes over the mouse and keyboard for minutes. Run it only when the person says they are away from the Mac,
one area at a time where possible (`PS_SELFTEST_ONLY=<area>`), never two at once. Test copies park their windows
off screen and must make no network requests.

## The phone app

```bash
cd phone
./scripts/build-web.sh --fake && ./gradlew assembleDebug    # emulator build with fictional data
./scripts/build-web.sh && ./gradlew assembleDebug           # normal debug build
./gradlew testDebugUnitTest                                 # unit tests in app/src/test
```

Keep the emulator offline when testing with fake data (`phone/docs/release.md` shows how the emulator is run).
`phone/scripts/release.sh` is the owner's release script: contributors never run it. A debug build has a
different signature from the official APK, so it installs beside it only after uninstalling the official one,
which loses that phone's saved sign in and settings (the vault itself is on the server and safe).

## Your own Supabase

What a personal project needs is listed in `web/supabase/ps-core.json`: the migrations under `migrations`, applied
in that order, and the one function `vault-auth` (deployed with JWT checking off: it checks requests itself). The
`redOnly` part lists what belongs to the owner's server only: never apply those.

- **The Mac app (tested route):** at setup, or Settings, Sync and account, "Supabase project". PS walks you through
  making a Supabase access token (a guide window docks beside the browser), then applies the kit, deploys
  `vault-auth`, makes a one time setup code for the first account and signs you up. Code:
  `mac/Sources/ProjectSetup.swift`, `ProjectEngine.swift`, `SetupGuide.swift`, `web/scripts/ps-kit.mjs`.
- **A web build of your own:** put your project's URL and publishable key in `web/.env`. Apply the migrations in
  `ps-core.json` order (SQL editor or `psql`), deploy `web/supabase/functions/vault-auth`, and add your site's
  origin to its `ALLOWED_ORIGINS`. The first account needs a setup code in `setup_codes`: read how `vault-auth`
  checks it before inserting one.
- **A phone build of your own** reads `web/.env` too, but that path is untested. The downloaded phone app only
  talks to the owner's server (`PRIVACY.md`).
- **A local Supabase for tests:** `web/supabase/tests/own-project/` has a stand in for the Supabase management API
  and a server that serves the Mac page against a local project (LOCAL ONLY, both refuse anything else).
  `web/tests/own-project.test.ts` and `web/tests/ps-core.test.ts` are the unit tests.
- Never put a service role key, access token or database password in the repo, in `.env` files you commit, or in
  chat. If one leaks, rotate it in Supabase at once.
- Free plans have small transfer limits: keep syncs change only (see `architecture.md`).

`PRIVACY.md`, "Your own Supabase: what changes", says what still talks to the owner's services when you use your own project and how
to switch those off.

## The audits (before every push)

Run all three from the repo root. Fix every hit; never add an allowlist line to pass without the owner's yes.

```bash
gitleaks dir . --config .gitleaks.toml                     # secrets (gitleaks 8.19 or newer; older: gitleaks detect --no-git --source .)
python3 -I mac/release/audit.py --source .                 # the public audit in source mode
git diff origin/main --stat                                # only the files you meant to change
node tools/guard.mjs --layer ../ps-<release name>-layer/layer.json   # the push guard by hand (it also runs on every git push)
```

`mac/release/audit.py` starts its BLOCK list with three fill in placeholders written in capitals (your name, your
email name, your client names). For your own checks you may put your own private words there locally, but never
commit them: those lines must stay as placeholders in the repo. (This is also why a document that quotes those
placeholder words is itself blocked by the audit.)

**The term check** (what the term audit and the source audit on GitHub block, so a pull request that trips them
cannot merge; the term audit also reads commit messages and the pull request's title and text). Search your
changed files for:

- any email address that is not on a reserved example domain (`example.com`, `.example`, `.test`, `.invalid`,
  `localhost`) or a GitHub noreply address;
- keys and tokens of any kind: JWTs (`eyJ...` with two dots), `sk-`, Stripe live keys, `sb_secret_`, `ghp_`,
  `github_pat_`, Slack `xox`, AWS `AKIA`, Telegram bot tokens, private key or certificate blocks, long hex or
  base64 strings that are not a published checksum;
- a Supabase project URL other than the ones already in the repo;
- personal paths (`/Users/<name>/`, `C:\Users\<name>\`, cloud drive folders), machine names, hardware ids;
- real names of people, clients or companies, home towns, birthdays, your VPN or other kit;
- files that must never ship: `.env`, keys, keystores, `.bak` copies, videos, screenshots, notes, anything under
  a `.claude` folder.

```bash
git diff origin/main -U0 | grep -nE '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}|eyJ[A-Za-z0-9_-]{10,}\.|sk-|sb_secret_|ghp_|github_pat_|AKIA|BEGIN [A-Z ]*PRIVATE KEY|/Users/|C:\\\\Users'
```

Anything it prints needs a look. Made up test values are fine when they are obviously fake (a run of the alphabet,
`FAKE`, `0123456789`) and use reserved example domains.

## Testing habits that keep a Mac usable

- Never attach a debugger (lldb, debugserver, Instruments, xctrace): macOS pops a password or Touch ID prompt.
  Find crashes with `swiftc -Onone -g` (Swift prints `file:line`), unbuffered prints and assertions.
- Never open an app that carries the quarantine flag (a downloaded copy you did not open yourself). Check it
  without opening: `spctl --assess --type execute -vv <app>`.
- Never wrap long jobs in `caffeinate -i` (it keeps a laptop awake on battery until it dies). Never freeze a
  process with SIGSTOP to pause it.
- Test with fictional data only. Report "not tried on a real screen" when that is the truth.
