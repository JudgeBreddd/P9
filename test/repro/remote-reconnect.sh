#!/usr/bin/env bash
# Runs test/remote-reconnect.test.mjs N times (default 20) the way CI's Tests job does (xvfb-run -a, scripts/with-tmp.mjs)
# and stops at the first failure. The test is skipped on CI (0.1.9 O4b) because it lost its X display there once; run this
# where it may fail and look for "Missing X server or $DISPLAY" in the output. From the app folder.
set -euo pipefail
n=${1:-20}
for i in $(seq 1 "$n"); do
  echo "run $i of $n"
  CI= xvfb-run -a node scripts/with-tmp.mjs node --test test/remote-reconnect.test.mjs || { echo "failed on run $i"; exit 1; }
done
echo "passed $n of $n"
