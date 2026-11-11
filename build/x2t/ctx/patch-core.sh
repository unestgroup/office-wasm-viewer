#!/usr/bin/bash
# Applies our changes to /core (the vendored OnlyOffice core sources) before any library is built.
# Patches are unified diffs made against upstream cryptpad/onlyoffice-x2t-wasm (see build/x2t/README.md).
set -euo pipefail
shopt -s nullglob
cd /core
for p in /patches/*.patch; do
  echo "applying $p"
  # --binary: several core sources use CRLF line endings; keep them untouched
  patch --binary -p1 < "$p"
done
