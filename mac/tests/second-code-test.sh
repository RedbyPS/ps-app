#!/bin/bash
# Second Computer code jobs on the owner's protocol (tests/second-code-test.swift), plus the owner's own outsource test
# (tests/second-outsource-test.swift), which now compiles with the code job files. Fictional claude, temp keys and repos.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
S="$HERE/Sources"
FILES=("$S/SecondSeal.swift" "$S/SecondOutsource.swift" "$S/SecondJobs.swift" "$S/SecondProc.swift" "$S/SecondCrypto.swift" "$S/SecondHost.swift" "$S/SecondShare.swift" "$S/SecondFiles.swift" "$S/SafeSignal.swift" "$S/KeychainQuiet.swift" "$S/SecondCodeCore.swift" "$S/SecondCodeRunner.swift")
for t in second-code second-outsource; do
  mkdir -p "$OUT/$t"; cp "$HERE/tests/$t-test.swift" "$OUT/$t/main.swift"
  swiftc -Onone "$OUT/$t/main.swift" "${FILES[@]}" -o "$OUT/$t/test" 2>&1 | grep -E "error" || true
  "$OUT/$t/test" | grep -E "FAIL" || true
done
