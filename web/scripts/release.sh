#!/bin/bash
# One command for both: the website (cincee.com/client, LIVE) and PS, the Mac app.
# Same source, so a change can never ship to one and not the other.
#   npm run release           build both, deploy the website, install the new PS files
#   npm run release -- --app  also rebuild the PS app itself (only needed when ~/Projects/ps/mac
#                             changes; one Little Snitch prompt for the new build)
#   add --wait                this Mac's PS is NOT updated straight away either: it shows "Update available"
#                             in the gear like every other Mac and waits for the developer's Update now (V1.33).
#                             Without --wait the Mac that runs the release installs it at once (the developer asked for
#                             that release himself); every other Mac and the phone always wait for the click.
# Both also put the update where PS looks for it (ps-mac/release/publish.sh): the public channel that
# every PS reads, the developer's Macs included (staged in ps-release/, only after ps-mac/release/audit.py found
# nothing of the developer's in it). Since V1.57 PS asks the public repo's newest GitHub release, never cincee.com
# (scripts/github-channel.mjs, right after the website deploy below); cincee.com/client/ps/ and
# /client/gos/ are still filled with the website so PS V1.56 and older can move on. And
# your sync folder for builds older than the channel. web-only stays web-only; --app
# also refreshes PS.dmg. The download pages read release.json there: its patch notes are public
# copy, so they are in it only once the developer approved the exact words (scripts/ps-public.mjs).
# V1.69 (the developer, 18 Nov 2026, after the G Squad's V1.68 reached his Mac and macOS dropped Accessibility and Input
# Monitoring): a tree with a layer profile (the developer's: ps-layer/profile.json) has its OWN update channel, an unlisted folder
# on the website (scripts/own-channel.mjs). Its Mac build carries that channel alone (Resources/channel.json) and trusts
# only the developer's key and certificate. Its releases go ONLY there (ps-own-release/, signed for that channel): never to the
# G Squad channel on GitHub and never to the public download folder, so friends never get his build and his Macs never
# get theirs. The G Squad's builds come from the G Squad release workflow. No layer profile: everything as before.
# The developer's PRIVATE notes for the version (ps-notes-private.json) are never in any build, the channel or the APK:
# the audit below refuses any of their words, and they are sealed to his own vault instead (scripts/ps-private.ts),
# where only his PS shows them, as "For you" under the public ones.
#   add --fast                (with --app --wait) the faster release: once the PS web build is done, the Mac app and
#                             the phone APK build and sign side by side, then the audit and the rest as always. It
#                             first checks free memory and other heavy builds (scripts/release-fast.mjs check) and
#                             falls back to one build after the other when the Mac is busy. If either build fails,
#                             nothing is published. Every release ends with each step's time and the total.
#   add --dry-run             runs the checks and prints every step instead of doing it: nothing is built, signed,
#                             installed, deployed or sent. Only a dry run reads the PS_DRY_* overrides below (tests).
set -euo pipefail
cd "$(dirname "$0")/.."
SITE=YOUR_NETLIFY_SITE_ID
# Options first, so a mistyped one stops before anything is built.
APPFLAG=""; WAIT=""; FAST=""; DRY=""
for a in "$@"; do case "$a" in --app) APPFLAG=1;; --wait) WAIT=1;; --fast) FAST=1;; --dry-run) DRY=1;; *) echo "unknown option $a (use --app, --wait, --fast and/or --dry-run)"; exit 1;; esac; done
[ -z "$DRY" ] || echo "Dry run (app=${APPFLAG:-0} wait=${WAIT:-0} fast=${FAST:-0}): nothing is built, signed, installed, deployed or sent."

# Each step's time, printed at the end (also when a step stops the release), so the two modes can be compared.
T0=$SECONDS; TIMES=(); MODE=slower; [ -z "$FAST" ] || MODE=faster
exec 3>&1   # a dry run prints its steps here, past any >/dev/null on the step itself
step() {   # step <label> <command...>: runs it (a dry run only prints it) and keeps its time
  local label="$1"; shift
  local t0=$SECONDS rc=0
  if [ -n "$DRY" ]; then
    echo "DRY  [$label] $*" >&3
    [ -z "${PS_DRY_SLEEP:-}" ] || sleep "$PS_DRY_SLEEP"
    case ",${PS_DRY_FAIL:-}," in *",$label,"*) rc=1;; esac
  else
    "$@" || rc=$?
  fi
  TIMES+=("$label|$((SECONDS - t0))|$rc")
  return $rc
}
run() { if [ -n "$DRY" ]; then echo "DRY  $*" >&3; else "$@"; fi; }   # a small side effect, not timed
times_on_exit() {
  local rc=$?
  if [ ${#TIMES[@]} -gt 0 ]; then node scripts/release-fast.mjs summary "$MODE" "$((SECONDS - T0))" "$rc" "${DRY:+dry}" "${TIMES[@]}" || true; fi
  exit $rc
}
trap times_on_exit EXIT

# Every release carries a NEW version number, the same for the developer's PS and the public build (the developer, 7 Nov 2026,
# after two quick fixes went out as "1.36 to 1.36": "Do not let this happen again"). So this stops when the
# version in ps-version.json is the one already live, and when the live one cannot be read. No way around it.
VER_NOW="$(node -pe 'JSON.parse(require("fs").readFileSync("ps-version.json","utf8")).version')"
if [ -n "$DRY" ] && [ -n "${PS_DRY_LIVE_VERSION:-}" ]; then VER_LIVE="$PS_DRY_LIVE_VERSION"
else VER_LIVE="$(curl -s --max-time 20 https://cincee.com/client/ps/release.json | node -pe 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).version||""}catch(e){""}')"; fi
if [ -z "$VER_LIVE" ]; then
  echo "STOP: could not read the live version (https://cincee.com/client/ps/release.json). Nothing was built."
  exit 1
fi
if [ "$VER_NOW" = "$VER_LIVE" ]; then
  echo "STOP: V$VER_NOW is already live. Every release needs a new number: node scripts/ps-version.mjs bump, commit ps-version.json, get the developer's yes on the What's new words, then release. Nothing was built."
  exit 1
fi

# V1.69: the own update channel (empty: none, the public channel as before). A layer profile whose channel cannot be
# used stops here: its build would follow the G Squad channel.
OWN_URL=""; OWN_NAME=""
if [ -f ps-layer/profile.json ]; then
  OWN_URL="$(node scripts/own-channel.mjs url)" || { echo "STOP: ps-layer/profile.json has no usable own update channel (https, an unlisted folder under /client/ps/, ending in /). Nothing was built."; exit 1; }
  OWN_NAME="$(node scripts/own-channel.mjs name)"
  if [ -z "$DRY" ]; then
    # Friends get this same number as the G Squad build (scripts/gsquad-follow.mjs, after the export): it must still be
    # free on core, or already the developer's own shared claim.
    node scripts/gsquad-follow.mjs check "$VER_NOW" || { echo "Nothing was built."; exit 1; }
    VER_OWN="$(curl -s --max-time 20 "${OWN_URL}ps-update.json" | node scripts/own-channel.mjs note-version)"
    if [ "$VER_NOW" = "$VER_OWN" ]; then
      echo "STOP: V$VER_NOW is already live on your own channel. Every release needs a new number: node scripts/ps-version.mjs bump, commit ps-version.json, get the developer's yes on the What's new words, then release. Nothing was built."
      exit 1
    fi
  fi
fi

# V1.58 (multiple developers): this script makes the release everyone gets (the cincee.com pages and the G Squad channel
# on GitHub). A private release (ps-version.json "made" says shared: false) goes only to its maker's own channel, which
# is built with tools/build.mjs after the cut over, never here. So it stops before anything is built.
if [ "$(node -pe 'const v=JSON.parse(process.argv[1]); v.shared===false?"private":"shared"' "$(node scripts/ps-version.mjs)")" = private ]; then
  echo "STOP: V$VER_NOW is marked as a private release. This script makes shared releases only (cincee.com and the G Squad channel on GitHub). Nothing was built."
  exit 1
fi

# The developer's private notes: no long dashes or HTML, checked before anything is built. The audit reads the same file and
# refuses a public build or APK holding any of their words.
node scripts/ps-private.ts check || { echo "STOP: fix the private notes first (node scripts/ps-private.ts show). Nothing was built."; exit 1; }
export PS_PRIVATE_NOTES="$PWD/ps-notes-private.json"

# A personal Supabase project (supabase/ps-core.json) is set up and updated from the kit inside the signed
# Mac app only. So a release that changes the kit must carry the app, or Macs linked to their own project
# would run new web code against an old database.
if [ -z "$APPFLAG" ] && [ -d /Applications/PS.app ]; then
  KIT_NOW="$(node -e 'import("./scripts/ps-kit.mjs").then((m) => console.log(m.kit().kit))')"
  KIT_APP="$(node -pe 'try{require("/Applications/PS.app/Contents/Resources/project-kit/kit.json").kit}catch(e){""}')"
  if [ "$KIT_NOW" != "$KIT_APP" ]; then
    echo "STOP: the Supabase project kit changed (supabase/ps-core.json or a core migration or function). Release with the app: npm run release -- --app"
    exit 1
  fi
fi

# The phone app always carries the same version as the Mac (the developer, 27 Oct 2026), even with no phone
# changes: when the staged PS GOS build is not this version yet, build it first (signed, from
# committed code only) so this deploy publishes it at /client/gos/. PS_NOTES = its "What's new".
GOSV="$(node -pe 'JSON.parse(process.argv[1]).name' "$(node scripts/ps-version.mjs)")"
NEED_GOS=""
if [ -x ../phone/scripts/release.sh ] || [ -f ../phone/scripts/release.sh ]; then
  if [ "$(node -pe 'try{require("./gos-release/version.json").versionName}catch(e){""}')" != "$GOSV" ]; then NEED_GOS=1; fi
fi
[ -z "$DRY" ] || [ -z "${PS_DRY_GOS:-}" ] || NEED_GOS="$PS_DRY_GOS"
# The phone's "What's new" is public too (everyone gets the same APK): the developer's approved notes or nothing.
gos_build() { bash ../phone/scripts/release.sh "${PS_NOTES:-$(node scripts/ps-public.mjs notes-text)}"; }
# The version the developer sees in PS on the Mac and the phone (ps-version.json, bumped by the manager
# before a release with `node scripts/ps-version.mjs bump`): this script only reads it.
write_psv() { echo "$PSV" > dist-ps/ps-version.json; }
# This Mac's PS under whatever name it has (V1.36: PS can be renamed; /Applications/PS.app when there is none).
find_installed() {
  INSTALLED=/Applications/PS.app
  if [ -f ../mac/tools/installed-app.sh ]; then . ../mac/tools/installed-app.sh; INSTALLED="$(ps_installed_app)"; fi
  if [ -n "$DRY" ] && [ -n "${PS_DRY_INSTALLED:-}" ]; then INSTALLED="$PS_DRY_INSTALLED"; fi
}

# V1.69: this Mac's PS must already follow the own channel to see this release there. One that does not yet (V1.68 and
# older, no Resources/channel.json) still follows the G Squad channel: this release must carry the app and install it
# here at once (no --wait), which moves this Mac over. Dry runs skip the look.
if [ -n "$OWN_URL" ] && [ -z "$DRY" ]; then
  find_installed
  if [ -d "$INSTALLED" ] && [ "$(node scripts/own-channel.mjs installed "$INSTALLED")" != "$OWN_URL" ] && { [ -z "$APPFLAG" ] || [ -n "$WAIT" ]; }; then
    echo "STOP: PS on this Mac ($INSTALLED) does not follow your own update channel yet, so it would never see this release there. Release this one with the app and without --wait (it installs here at once and moves this Mac over): npm run release -- --app. Nothing was built."
    exit 1
  fi
fi

# --fast: can the two builds run side by side at all? If not, say why in one line and release as normal.
if [ -n "$FAST" ]; then
  find_installed
  WHY_NOT="$(node -e 'import("./scripts/release-fast.mjs").then((m) => { const r = m.fastPossible({ needPhone: !!process.argv[1], needMac: !!process.argv[2], wait: !!process.argv[3], installed: process.argv[4] === "1" }); console.log(r.ok ? "" : r.why); })' "$NEED_GOS" "$APPFLAG" "$WAIT" "$([ -d "$INSTALLED" ] && echo 1 || echo 0)")"
  if [ -n "$WHY_NOT" ]; then echo "Faster release: $WHY_NOT; the normal order is used."; FAST=""; MODE="slower (asked for faster)"; fi
fi

if [ -z "$FAST" ]; then
  # The normal (slower) release: the phone app, the PS web files, then the Mac app, one after another.
  if [ -n "$NEED_GOS" ]; then step phone gos_build; fi

  step web npm run build:ps     # PS: dist-ps/ (To-do page only, same code)
  PSV="$(node scripts/ps-version.mjs)"
  run write_psv
  KIND=web
  find_installed
  if [ -n "$APPFLAG" ] || [ ! -d "$INSTALLED" ]; then
    KIND=app
    if [ -n "$WAIT" ] && [ -d "$INSTALLED" ]; then
      step mac env NO_INSTALL=1 SKIP_WEB=1 bash ../mac/build.sh   # builds build/PS.app only: this Mac's PS waits for the click too
    else
      step mac env SKIP_WEB=1 bash ../mac/build.sh   # builds and installs PS on this Mac
    fi
  fi
else
  # The faster release. Both builds need the PS web files first (the Mac app carries dist-ps/), so that goes alone.
  step web npm run build:ps
  PSV="$(node scripts/ps-version.mjs)"
  run write_psv
  KIND=app
  # Right before the heavy part: enough memory, and not too many other builds? Otherwise one after the other.
  CHECK=(node scripts/release-fast.mjs check)
  if [ -n "$DRY" ] && [ -n "${PS_DRY_MEMORY:-}" ]; then CHECK+=("--assume=$PS_DRY_MEMORY"); fi
  if ! "${CHECK[@]}"; then
    MODE="slower (fell back from faster)"
    step phone gos_build
    step mac env NO_INSTALL=1 SKIP_WEB=1 bash ../mac/build.sh   # --fast always has --wait: builds build/PS.app only
  else
    PAR="$(mktemp -d)"
    par() {   # par <label> <command...>: in the background, every line marked with its label, time and result kept
      local label="$1"; shift
      (
        t0=$SECONDS; rc=0
        if [ -n "$DRY" ]; then
          echo "[$label] DRY  $*"
          [ -z "${PS_DRY_SLEEP:-}" ] || sleep "$PS_DRY_SLEEP"
          case ",${PS_DRY_FAIL:-}," in *",$label,"*) rc=1;; esac
        else
          "$@" 2>&1 < /dev/null | while IFS= read -r l || [ -n "$l" ]; do printf '[%s] %s\n' "$label" "$l"; done || rc=$?
        fi
        echo "$label|$((SECONDS - t0))|$rc" > "$PAR/$label.time"
        exit $rc
      ) &
    }
    killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill -TERM "$1" 2>/dev/null || true; }
    TB=$SECONDS
    par phone gos_build; PID_PHONE=$!
    par mac env NO_INSTALL=1 SKIP_WEB=1 bash ../mac/build.sh; PID_MAC=$!   # builds build/PS.app only, never installs
    # Ctrl+C stops both builds (the shell does not pass it to background jobs by itself). Nothing is published.
    trap 'echo "Stopping both builds. Nothing was published."; killtree $PID_PHONE; killtree $PID_MAC; exit 130' INT TERM
    SAID=""; WARNED=""; TICK=0
    while [ ! -f "$PAR/phone.time" ] || [ ! -f "$PAR/mac.time" ]; do
      for l in phone mac; do
        if [ -f "$PAR/$l.time" ] && [ "${SAID#*$l}" = "$SAID" ]; then
          SAID="$SAID $l"
          NAME=phone; OTHER=mac; [ "$l" = phone ] || { NAME=Mac; OTHER=phone; }
          if [ "$(cut -d'|' -f3 "$PAR/$l.time")" != 0 ]; then
            if [ -f "$PAR/$OTHER.time" ]; then echo "The $NAME build FAILED. Nothing will be published."
            else echo "The $NAME build FAILED. Letting the other build finish so nothing is left half done; nothing will be published."; fi
          elif [ ! -f "$PAR/$OTHER.time" ]; then
            echo "The $NAME build is done; waiting for the other one."
          fi
        fi
      done
      TICK=$((TICK + 1))
      if [ -z "$DRY" ] && [ -z "$WARNED" ] && [ $((TICK % 8)) -eq 0 ] && [ "$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo 1)" = 4 ]; then
        WARNED=1; echo "WARNING: macOS reports critical memory pressure. Ctrl+C stops both builds (nothing is published); release again without --fast."
      fi
      sleep 2
    done
    RC_PHONE=0; wait $PID_PHONE || RC_PHONE=$?
    RC_MAC=0; wait $PID_MAC || RC_MAC=$?
    trap - INT TERM
    TIMES+=("both|$((SECONDS - TB))|$(( RC_PHONE || RC_MAC ))" "$(cat "$PAR/phone.time")" "$(cat "$PAR/mac.time")")
    rm -rf "$PAR"
    if [ "$RC_PHONE" != 0 ] || [ "$RC_MAC" != 0 ]; then
      echo "STOP: the $([ "$RC_PHONE" != 0 ] && echo "phone")$([ "$RC_PHONE" != 0 ] && [ "$RC_MAC" != 0 ] && echo " and the ")$([ "$RC_MAC" != 0 ] && echo "Mac") build failed (see the lines marked [phone] and [mac] above). Nothing was published: no deploy, no channel, no notes."
      exit 1
    fi
  fi
fi

# The channel, staged in a copy first: it replaces its folder only when the audit is clean. The public channel
# (ps-release/, cincee.com/client/ps/ and the G Squad channel on GitHub), or V1.69 with an own channel only that
# (ps-own-release/, signed for it alone; postbuild.mjs puts it in its unlisted folder).
CH=ps-release; [ -z "$OWN_URL" ] || CH=ps-own-release
run mkdir -p "$CH"
PUB="$(mktemp -d)/$CH"; run cp -R "$CH" "$PUB"
# The Mac's gear menu shows the developer's approved notes under the version (none until he approved them).
export PS_NOTES="$(node scripts/ps-public.mjs notes-text 2>/dev/null || true)"
# V1.52: and the earlier versions' approved notes (last 20), so an update across several versions shows every skipped one.
export PS_HISTORY="$(node scripts/ps-public.mjs history-json 2>/dev/null || echo '[]')"
if [ "$KIND" = app ]; then step stage env PS_RELEASE_OUT="$PUB" PS_UPDATE_CHANNEL="${OWN_NAME:-gsquad}" PS_FLAVOUR="$OWN_NAME" bash ../mac/release/publish.sh app dist-ps ../mac/build/PS.app
else step stage env PS_RELEASE_OUT="$PUB" PS_UPDATE_CHANNEL="${OWN_NAME:-gsquad}" PS_FLAVOUR="$OWN_NAME" bash ../mac/release/publish.sh web dist-ps; fi
# The phone's APK is one for everyone: the download pages offer it only when it is clean too.
GOSOK=gos-release; step audit-apk python3 -I ../mac/release/audit.py gos-release >/dev/null || { GOSOK=""; echo "The phone APK is not clean (python3 -I ../mac/release/audit.py gos-release): the download pages will not offer it."; }
swap_channel() {
  rm -rf "$CH.old" && mv "$CH" "$CH.old" && mv "$PUB" "$CH" && rm -rf "$CH.old"
  [ -n "$OWN_URL" ] || node scripts/ps-public.mjs stage ps-release $GOSOK   # the download pages: the public build only
}
CHANNEL_OK=""
if step audit python3 -I ../mac/release/audit.py "$PUB"; then
  step channel swap_channel
  CHANNEL_OK=1
  node scripts/ps-public.mjs approved || echo "Public patch notes for this version are not approved by the developer yet: release.json has no notes (node scripts/ps-public.mjs show)."
else
  echo "STOP: the audit found something of the developer's in the build. The channel ($CH/) keeps its last good release; nothing new goes to cincee.com/client/ps/."
fi

# The build prompt page (cincee.com/client/build/<path>/): the newest prompt, encrypted again. A STOP
# here (the prompt holds something of the developer's) only keeps the page's last good version.
# The developer's private notes for this version go to his vault only, sealed to his key (only his PS opens them). His PS
# shows them next to the update in the gear and in the What's new panel. A failed drop never stops the release.
step notes node scripts/ps-private.ts drop || echo "The developer's private notes did not reach his vault: send them again with node scripts/ps-private.ts drop"
step site npm run build        # website: dist/ (strict CSP headers, version.json; copies client/gos and client/ps)
step deploy netlify deploy --prod --dir=dist --site "$SITE"
# V1.57: the same channel on GitHub, where PS V1.57 and newer look (no addresses for the developer there): a release v<version>
# with exactly the files the notes name, marked latest, then the website's web-version.json. After the deploy, so the
# website's note never points at a build that is not live yet. Only a clean channel goes up. A failure stops nothing
# that already happened; it says how to send it again.
if [ -n "$OWN_URL" ]; then
  echo "Your own release: it went to your own update channel only, never to the G Squad channel on GitHub, so friends' PS never gets your build and yours never gets theirs."
  # V1.69 (the developer, 19 Nov 2026: "No, friends too"): friends get this same version as the G Squad build (G Squad
  # certificate, so their Macs keep Accessibility and Input Monitoring). Not done from here: the export pull request's
  # words need the developer's yes and its diff a look (it must not undo the G Squad's own work on core).
  echo "Friends get V$VER_NOW as the G Squad build in two steps: (1) export this version to core and merge that pull request (its words need the developer's yes; commits as the developer's GitHub identity, as the core checks want); (2) then: node scripts/gsquad-follow.mjs claim $VER_NOW"
elif [ -n "$CHANNEL_OK" ]; then
  step github node scripts/github-channel.mjs publish || echo "STOP: the GitHub channel was not updated, so PS V1.57 and newer do not see this release yet. Send it again: node scripts/github-channel.mjs publish"
else
  echo "The GitHub channel keeps its last good release (the audit stopped the public channel)."
fi

if [ "$KIND" = app ]; then
  step drive bash ../mac/release/publish.sh app dist-ps ../mac/build/PS.app   # Google Drive, for older builds
else
  # Without --wait: an open PS on this Mac reloads itself to it within about 20 s (the developer asked for this release).
  [ -n "$WAIT" ] || step install bash ../mac/install-web.sh dist-ps
  step drive bash ../mac/release/publish.sh web dist-ps
fi
[ -z "$WAIT" ] || echo "PS on this Mac was left as it is: it shows Update available in the gear within 30 minutes (or on Check) and updates when the developer clicks Update now."
if [ -n "$DRY" ]; then echo "Dry run finished: nothing was built, signed, installed, deployed or sent."; exit 0; fi
echo "Released PS $(node -pe 'const v=JSON.parse(process.argv[1]); v.name+" · "+v.keyword' "$PSV"): website and PS are on the same code ($(cat dist-ps/version.json))."
