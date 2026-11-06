#!/bin/sh
# One-step install: checks prerequisites, then runs install.py (extra flags are passed through).
set -e
cd "$(dirname "$0")"
missing=""
for tool in python3 omp lsof; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
if [ -n "$missing" ]; then echo "missing required tools:$missing" >&2; exit 1; fi
command -v herdr-app >/dev/null 2>&1 || echo "note: herdr-app not on PATH; mods are still installed, but cannot be checked here"
python3 install.py "$@"
for mod in omp-todos omp-models omp-detail omp-changes; do
  command -v herdr-app >/dev/null 2>&1 && herdr-app check "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/$mod" || true
done
[ -f "$HOME/.omp/agent/extensions/herdr-omp-agent-state.ts" ] || echo "warning: Herdr's OMP extension (~/.omp/agent/extensions/herdr-omp-agent-state.ts) is not installed; the panel will not see idle/working state"
