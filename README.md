# OMP sidebar for Herdr

A panel next to the focused **omp** terminal in the Herdr app.

| | |
|---|---|
| **Activity** | what omp is doing now, elapsed time, this turn's tool calls (repeats fold into `read ×6`; click one for its command and output, or an edit for its diff, hover for the full text; task calls show their subagents and what each is doing) |
| **Full diff** | an icon button on the Activity card opens every file omp changed (this turn or the whole session) as one diff, one collapsible card per file with syntax highlighting, line numbers and +/− counts |
| **Tasks** | omp's todo list with progress, completed ones collapsible |
| **Subagents** | running and finished workers, with a viewer for their reports |
| **Status** | the provider's 5-hour and 7-day limits (left, reset time, from `omp usage`), context use (amber at 60%, red at 80%, with a **Compact** button), git branch, folder |
| **Model** | searchable picker for omp's catalog, with pinned favourites (Ctrl+F) |
| **Effort** | one-click thinking level (off to max) |

A toolbar **OMP** button and `Ctrl+Shift+U` toggle the panel. It appears only when the focused terminal runs omp.

## Install

```sh
git clone https://github.com/vanyapoker/herdr-omp-sidebar.git
cd herdr-omp-sidebar
./install.sh
```

Options (passed through to `install.py`): `--home DIR` (default `~/.config/herdr-app`), `--layout NAME` (default `my`), `--no-toolbar`.

Requirements: `omp`, `python3`, `lsof` (preinstalled on macOS) on whichever machine runs omp, and Herdr's OMP extension (`~/.omp/agent/extensions/herdr-omp-agent-state.ts`) so the panel can see idle/working state.

The installer is idempotent and backs up everything it replaces as `*.bak`. It adds the mods, the OMP program entry and icon, the shortcut, and the panel block in your layout's `work-body`. If it can't find `work-body`, it prints the block to paste in by hand.

### Update / uninstall

- Update: `git pull && ./install.sh`
- Uninstall: delete `mods/omp-todos`, `mods/omp-models`, `mods/omp-detail`, `mods/omp-changes` in your Herdr folder, remove the `omp-todos` block from your layout and the `ctrl-shift-u` key, and restore `mods/tabs-address.bak` if you used the toolbar button.

## Limits

- **Remote terminals (Herdr SSH machines)** run `read.py` and `omp models` on the machine where omp runs, so that machine needs `python3` (and `lsof` if it is a Mac) but not this repo. Install the sidebar only on the computer that runs the Herdr app. Remote support is untested against a real second machine.
- `mods/tabs-address` is a modified copy of Herdr's mod (adds the toolbar button) from one Herdr version. Use `--no-toolbar` or diff it first if yours differs.
- Effort and model changes work only while omp is idle; they drive omp's own `Shift+Tab` and `Alt+P`.
- Tested on Linux. The macOS path (`lsof`, `ps`) is untested on a Mac.

## How it works

`mods/omp-todos/read.py <pid>` finds the session `.jsonl` the omp process holds open (`/proc` on Linux, `lsof` elsewhere) and summarises it. The picker lists `omp models --json` and switches via omp's session-only `Alt+P`. Compact sends `/compact`.
