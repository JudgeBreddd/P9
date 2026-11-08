#!/usr/bin/env bash
# Stands alone (Builder, 2026-11-07): nothing shipped in P9 may need the builder's ICM workspace to work, and no optional setting
# shaped like an ICM thing may be added either. This greps the shipped source for the strings those leaks are made of and
# compares the count per file and pattern against scripts/stands-alone-baseline.txt (the leaks that already shipped, kept
# only until each is made P9-native or removed). New hits fail; a smaller count passes and is printed so the baseline
# can shrink. A review row that must grow the baseline says why, then runs `stands-alone.sh --baseline`.
#   bash scripts/stands-alone.sh             check (exit 1 on any new hit)
#   bash scripts/stands-alone.sh --baseline  rewrite the baseline from the current source
# ponytail: a string grep, not a dependency graph; a leak spelled differently (a new folder name) needs a new pattern here.
set -u
cd "$(dirname "$0")/.."
PAT='_tyler|status\.json|plan\.md|_private|/ICM[/]|workspace-hub|hindsight|llm.vault|needs.you|icm-|ICM workspace'
BASE=scripts/stands-alone-baseline.txt
scan() {
  grep -rnoiE "$PAT" --include='*.mjs' --include='*.ts' --include='*.js' --include='*.html' --include='*.sh' --include='*.ps1' apps packages 2>/dev/null \
    | grep -vE 'node_modules|\.test\.|/test/|/dist/|\.astro/' | awk -F: '{print $1" "tolower($3)}' | sort | uniq -c | awk '{print $2" "$3" "$4" "$1}'
}
if [ "${1:-}" = "--baseline" ]; then scan > "$BASE"; echo "baseline: $(wc -l < "$BASE") file+pattern rows"; exit 0; fi
[ -f "$BASE" ] || { echo "no $BASE; run with --baseline once, in a review row that explains the leaks it records"; exit 1; }
fail=0
while read -r file pat rest; do
  n=${rest##* }; p="$pat"; [ "${rest% *}" != "$rest" ] && p="$pat ${rest% *}"
  b=$(awk -v f="$file" -v p="$p" '$1==f && substr($0, length(f)+2, length(p))==p {print $NF; exit}' "$BASE"); b=${b:-0}
  if (( n > b )); then echo "NEW  $file '$p' $n (baseline $b)"; fail=1
  elif (( n < b )); then echo "less $file '$p' $n (baseline $b): shrink the baseline"; fi
done < <(scan)
if (( fail )); then echo "FAIL: shipped code gained an ICM-shaped string. Make it P9-native or drop it; see the header."; exit 1; fi
echo "stands alone: no new ICM-shaped strings (baseline $(wc -l < "$BASE") rows)"
