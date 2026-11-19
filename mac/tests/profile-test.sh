#!/bin/bash
# Offline test for Sources/Profile.swift and Sources/Features.swift (V1.58). No app is run.
# The G Squad profile comes from web core-root/profiles/gsquad.json (PS_GSQUAD_PROFILE to point elsewhere).
set -e
cd "$(dirname "$0")/.."
P="${PS_GSQUAD_PROFILE:-$HOME/Projects/ps/web/core-root/profiles/gsquad.json}"
mkdir -p build/profile
cp tests/profile-test.swift build/profile/main.swift
swiftc build/profile/main.swift Sources/BuildRules.swift Sources/Profile.swift Sources/Features.swift -o build/profile/test
# V1.61: the bundled registry a build made the old way gets (build.sh), from core's features.json next to the G Squad profile.
node tools/bundle-features.mjs "$(dirname "$(dirname "$P")")/.." build/profile/ps-build.json >/dev/null
# PS 1.71: build.sh's OWN line that writes Resources/build-rules.json for a private tree, run on the developer's layer profile
# (PS_LAYER_PROFILE to point elsewhere). A tree without one (core) uses a stand in with the developer's two rules.
L="${PS_LAYER_PROFILE:-$HOME/Projects/ps/web/ps-layer/profile.json}"
if [ ! -f "$L" ]; then
  L=build/profile/layer-profile.json
  echo '{"schema":1,"name":"red","channel":{"kind":"url","url":"https://example.com/own-x/"},"othersShared":"on","features":{},"rules":{"tabOverProtectedApps":false,"islandOverProtectedApps":false}}' > "$L"
  echo "layer-profile=stand in (no ps-layer/profile.json here)"
fi
JS="$(node -e 'const s=require("fs").readFileSync("build.sh","utf8"); const m=s.match(/node -e \x27(const fs=require\("fs"\); const p=JSON\.parse[^\x27]*)\x27/); if (!m) process.exit(1); process.stdout.write(m[1])')" \
  || { echo "build-rules-line=FAIL (build.sh has no line writing build-rules.json)"; exit 1; }
rm -f build/profile/build-rules.json
node -e "$JS" "$L" build/profile/build-rules.json
PS_SELFTEST=1 build/profile/test "$P" build/profile/ps-build.json build/profile/build-rules.json
# PS 1.71: the wiring. build.sh writes the rules file only in the private tree branch, from the layer profile; the app
# asks the build first everywhere (BuildRules.now); the old AND join is gone.
grep -q '"$WEB/ps-layer/profile.json" "$APP/Contents/Resources/build-rules.json"' build.sh && echo "build-writes-layer-rules=ok" || { echo "build-writes-layer-rules=FAIL"; exit 1; }
grep -q 'forResource: "build-rules", withExtension: "json"' Sources/Profile.swift && echo "app-reads-layer-rules=ok" || { echo "app-reads-layer-rules=FAIL"; exit 1; }
grep -q 'return testAccount != nil ? a : fromProfile(a)' Sources/Owner.swift && echo "now-asks-the-build=ok" || { echo "now-asks-the-build=FAIL"; exit 1; }
! grep -q 'v && account' Sources/Profile.swift && echo "no-and-join=ok" || { echo "no-and-join=FAIL"; exit 1; }
# V1.61: the wiring the test above cannot run: main.swift hands the page's answers to Features.handle, and build.sh
# bundles the registry when there is no assembled ps-build.json.
grep -q 'if fromMain && Features.handle(type, msg) { return }' Sources/main.swift && echo "main-routes-features=ok" || { echo "main-routes-features=FAIL"; exit 1; }
grep -q 'node "$HERE/tools/bundle-features.mjs" "$WEB" "$APP/Contents/Resources/ps-build.json"' build.sh && echo "build-bundles-registry=ok" || { echo "build-bundles-registry=FAIL"; exit 1; }
