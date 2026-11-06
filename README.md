# OMP sidebar for Herdr

A panel next to the focused **omp** terminal in the Herdr app.

| | |
|---|---|
| **Activity** | what omp is doing now, elapsed time, the last tool calls |
| **Tasks** | omp's todo list with progress, completed ones collapsible |
| **Subagents** | running and finished workers, with a viewer for their reports |
| **Status** | context use (amber at 60%, red at 80%, with a **Compact** button), session cost, git branch, folder |
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

Requirements: `omp`, `python3`, `lsof` (preinstalled on macOS), and Herdr's OMP extension (`~/.omp/agent/extensions/herdr-omp-agent-state.ts`) so the panel can see idle/working state.

The installer is idempotent and backs up everything it replaces as `*.bak`. It adds the mods, the OMP program entry and icon, the shortcut, and the panel block in your layout's `work-body`. If it can't find `work-body`, it prints the block to paste in by hand.

### Update / uninstall

- Update: `git pull && ./install.sh`
- Uninstall: delete `mods/omp-todos`, `mods/omp-models`, `mods/omp-detail` in your Herdr folder, remove the `omp-todos` block from your layout and the `ctrl-shift-u` key, and restore `mods/tabs-address.bak` if you used the toolbar button.

## Limits

- **Local terminals only.** Terminals on another machine (Herdr SSH spaces) show "Remote OMP sessions are not supported". The panel reads omp's session file and process from this computer, and both live on the remote host.
- `mods/tabs-address` is a modified copy of Herdr's mod (adds the toolbar button) from one Herdr version. Use `--no-toolbar` or diff it first if yours differs.
- Effort and model changes work only while omp is idle; they drive omp's own `Shift+Tab` and `Alt+P`.
- Tested on Linux. The macOS path (`lsof`, `ps`) is untested on a Mac.

## How it works

`mods/omp-todos/read.py <pid>` finds the session `.jsonl` the omp process holds open (`/proc` on Linux, `lsof` elsewhere) and summarises it. The picker lists `omp models --json` and switches via omp's session-only `Alt+P`. Compact sends `/compact`.
