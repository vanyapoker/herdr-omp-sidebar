# OMP sidebar for Herdr

A right-hand panel for the focused **omp** terminal: live activity, tasks, subagents, context/cost/branch status,
a model picker (with favourites) and a thinking-effort control. A toolbar **OMP** button and `Ctrl+Shift+U` toggle it.

## Install

    git clone <this repo> && cd omp-herdr-sidebar
    python3 install.py            # --home DIR, --layout NAME, --no-toolbar

Needs `omp`, `python3`, and `lsof` (macOS has it). Backs up anything it replaces as `*.bak`.
Also install Herdr's OMP integration extension (`~/.omp/agent/extensions/herdr-omp-agent-state.ts`) so the panel sees idle/working state.

`mods/tabs-address` is a modified copy of Herdr's mod that adds the OMP toolbar button; use `--no-toolbar` to keep yours.
It is a snapshot of one Herdr version: diff before overwriting if your Herdr differs.

## How it works

- `omp-todos/read.py <pid>` finds the session `.jsonl` the omp process holds open (`/proc` on Linux, `lsof` on macOS) and summarises it.
- The model picker drives omp's own `Alt+P` switcher; effort cycles with `Shift+Tab` until the status line shows the wanted level.
- Compact sends `/compact`.

## Status

Developed and tested on Linux. The macOS code path (`lsof`, `ps`) is untested on a Mac.
