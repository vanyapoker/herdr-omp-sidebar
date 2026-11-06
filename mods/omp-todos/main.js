import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, focused, hc, exec, appHome, theme, run, openOverlay, readTextFile } from "herdr";

// A remote terminal's address is "machine/t7"; local ones have no prefix.
const machineOf = address => (address?.includes("/") ? address.split("/")[0] : null);
let readerSource = null;

function selected() {
  const f = focused();
  const address = f?.shown ?? f?.terminal ?? f?.agent;
  return agents().find(a => a.address === address && a.app === "omp")?.address ?? null;
}

// OMP shows the thinking effort as a glyph in its status line; Shift+Tab cycles through them.
const EFFORTS = [["off", "⦸"], ["low", "◔"], ["medium", "◑"], ["high", "◒"], ["xhigh", "◕"], ["max", "◉"], ["auto", "⟳"]];
// The glyph leads the model segment: "π > ◑ Sonnet" in the default status line, "── ◑ Sonnet" in a minimal one.
// Only the screen's last lines are searched, so a glyph in the transcript is never mistaken for it.
const effortOf = (screen) => {
  const tail = (screen ?? "").split("\n").slice(-6).join("\n");
  const glyph = /(?:π > |[─╭┌]+ )([^\s\w]) \S/.exec(tail)?.[1];
  return EFFORTS.find(([, g]) => g === glyph)?.[0] ?? null;
};

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default class OmpTodos extends View {
  init(_props, cx) {
    this.address = null;
    this.phases = [];
    this.actions = [];
    this.turn = null;
    this.workers = [];
    this.status = null;
    this.model = null;
    this.effort = null;
    this.switching = false;
    this.switchError = null;
    this.error = null;
    this.loading = false;
    this.refresh(cx);
    cx.timer.every(2000, cx => this.refresh(cx));
  }

  refresh(cx) {
    const address = selected();
    if (address !== this.address) {
      this.address = address;
      this.phases = [];
      this.actions = [];
      this.turn = null;
      this.workers = [];
      this.status = null;
      this.model = null;
      this.effort = null;
      this.switchError = null;
      this.error = null;
      this.loading = false;
    }
    if (!address || this.loading) { cx.notify(); return; }
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const terminal = await hc(["get", address, "--json"]);
        if (terminal.code !== 0) throw new Error(terminal.stderr || "Cannot read terminal");
        const info = JSON.parse(terminal.stdout);
        const pid = info.foreground?.pid;
        if (!pid || info.foreground?.name !== "omp") throw new Error("OMP is not the foreground process");
        // read.py runs on the terminal's own machine: the session file and process live there.
        readerSource ??= await readTextFile(`${appHome()}/mods/omp-todos/read.py`);
        const result = await exec("python3", ["-c", readerSource, String(pid)], { on: machineOf(address) });
        if (result.code !== 0) throw new Error(result.stderr || "Cannot read OMP session");
        const data = JSON.parse(result.stdout);
        if (this.address !== address || selected() !== address) return;
        // The session file lags effort changes until the next message; OMP's own status line is live.
        const screen = await hc(["read", address, "--lines", "0"]);
        const live = screen.code === 0 ? effortOf(screen.stdout) : null;
        this.phases = data.phases ?? [];
        this.actions = data.actions ?? [];
        this.turn = data.turn ?? null;
        this.workers = data.workers ?? [];
        this.status = info.status?.state ?? null;
        this.model = data.model ?? null;
        this.stats = { cost: data.cost, tokens: data.tokens, window: data.window, branch: data.branch, cwd: data.cwd };
        this.effort = live ?? data.effort ?? null;
        this.error = data.error ?? null;
      } catch (e) {
        if (this.address === address && selected() === address) this.error = String(e);
      } finally {
        if (this.address === address) this.loading = false;
        cx.notify();
      }
    });
  }

  // Sends /compact to OMP, which summarises the conversation to free context.
  compactContext(cx) {
    const address = selected();
    if (!address || this.switching) return;
    this.switching = true;
    this.switchError = null;
    cx.spawn(async cx => {
      try {
        const sent = await hc(["send", address, "/compact"]);
        if (sent.code !== 0) throw new Error(sent.stderr || "Cannot send /compact");
      } catch (e) {
        if (selected() === address) this.switchError = String(e);
      } finally {
        this.switching = false;
        cx.notify();
      }
    });
  }

  // Presses Shift+Tab until OMP's status line shows the wanted effort.
  setEffort(cx, target) {
    const address = selected();
    if (!address || this.switching || target === this.effort) return;
    this.switching = true;
    this.switchError = null;
    cx.spawn(async cx => {
      try {
        const result = await hc(["get", address, "--json"]);
        if (result.code !== 0) throw new Error(result.stderr || "Cannot inspect terminal");
        const terminal = JSON.parse(result.stdout);
        const state = terminal.status?.state;
        if (selected() !== address || terminal.foreground?.name !== "omp" || (state !== "idle" && state !== "done")) {
          throw new Error("Available when OMP is idle.");
        }
        const glyphNow = async () => {
          const screen = await hc(["read", address, "--lines", "0"]);
          return screen.code === 0 ? effortOf(screen.stdout) : null;
        };
        let current = await glyphNow();
        for (let i = 0; i < EFFORTS.length; i++) {
          const sent = await hc(["keys", address, "shift+tab"]);
          if (sent.code !== 0) throw new Error(sent.stderr || "Could not change effort");
          // The status line redraws after the key lands: wait for it to change.
          let now = current;
          for (let wait = 0; wait < 20 && (!now || now === current); wait++) {
            await exec("sleep", ["0.1"]);
            now = await glyphNow();
          }
          if (!now || now === current) break;
          current = now;
          this.effort = now;
          cx.notify();
          if (now === target) return;
        }
        throw new Error(`"${target}" is not available for this model.`);
      } catch (e) {
        if (selected() === address) this.switchError = String(e);
      } finally {
        this.switching = false;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const address = selected();
    const mine = Boolean(address) && address === this.address;
    const phases = mine ? this.phases : [];
    const tasks = phases.flatMap(p => p.tasks ?? []);
    const doneCount = tasks.filter(x => x.status === "completed").length;
    const error = mine ? this.error : null;
    const workers = mine ? this.workers : [];
    const status = mine ? this.status : null;
    const actions = mine ? this.actions : [];
    const turn = mine ? this.turn : null;
    const now = Date.now();
    const running = actions.find(a => a.state === "running");
    const recent = actions.filter(a => a !== running).slice(0, 5);
    const lastEnd = actions.reduce((latest, a) => Math.max(latest, a.ended ?? 0), 0);
    const busy = status === "working" || status === "blocked";
    const elapsed = turn?.started ? duration((busy ? now : lastEnd || now) - turn.started) : null;
    const counts = Object.entries(turn?.counts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, n]) => `${n} ${name}`).join(" · ");
    const machine = machineOf(address);
    const open = path => openOverlay({ mod: "omp-detail", kind: "dialog", width: 680, height: 560, props: { path, machine } });
    const canControl = (status === "idle" || status === "done") && !this.switching;
    const tone = status === "blocked" ? t.blocked : status === "working" ? t.working : status === "done" ? t.done : t.idle;
    const label = { blocked: "Needs you", working: "Working", done: "Done", idle: "Idle" }[status] ?? "";
    const toggle = (id, text, open_, onClick) => h_flex().id(id).gap(6).px(8).py(4).rounded(6).cursor_pointer().text_size(11).text_color(t.dim)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(onClick)
      .child(svg(`mods/files/chevron-${open_ ? "down" : "right"}.svg`).size(11).flex_none()).child(text);
    const section = (title, right) => h_flex().items_center().gap(8)
      .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(title))
      .when(Boolean(right), el => el.child(div().text_size(11).text_color(t.dim).child(right)));

    const header = h_flex().h(46).px(14).items_center().gap(10).flex_none().border_b(1).border_color(t.border)
      .child(div().font_semibold().text_color(t.foreground).child("OMP"))
      .when(Boolean(label), el => el.child(h_flex().gap(6).items_center().px(8).py(2).rounded(10).bg(t.raised)
        .child(div().size(6).rounded(3).bg(tone))
        .child(div().text_size(11).text_color(t.muted).child(label))))
      .child(div().flex_1())
      .child(div().id("close-omp-todos").size(22).flex().items_center().justify_center().rounded(5).text_color(t.dim)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Hide panel (Ctrl+Shift+U)")
        .on_click(() => run("layout.hide", { id: "omp-todos" })).child(svg("mods/pane/close.svg").size(12)));

    const headline = status === "blocked" ? running?.reason || "Needs your input"
      : status === "working" ? running?.label || "Thinking…"
      : status === "done" ? "Finished" : "Idle";
    const activity = v_flex().gap(8).p(10).rounded(8).bg(t.surface).border(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(status === "working"
          ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
          : div().size(7).flex_none().rounded(4).bg(tone))
        .child(div().flex_1().min_w(0).truncate().text_color(status === "blocked" ? t.blocked : t.foreground).child(headline))
        .when(Boolean(elapsed), row => row.child(div().flex_none().text_size(11).text_color(t.dim).child(busy ? elapsed : `took ${elapsed}`))))
      .when(Boolean(running?.detail), c => c.child(div().text_size(11).text_color(t.dim).truncate().child(running.detail)))
      .when(status === "working" && !running && lastEnd > 0, c => c.child(div().text_size(11).text_color(t.dim).child(`Last tool finished ${duration(now - lastEnd)} ago`)))
      .when(recent.length > 0, c => c.child(v_flex().gap(2).pt(8).border_t(1).border_color(t.border)
        .children(recent.map((item, i) => {
          const failed = item.state === "error";
          const took = item.started && item.ended && item.ended - item.started >= 1000 ? duration(item.ended - item.started) : "";
          return h_flex().id(`activity-${i}`).gap(7).items_center().px(4).py(2).rounded(4)
            .when(Boolean(item.path), el => el.cursor_pointer().hover(s => s.bg(t.hover)).tooltip(`Open ${item.path}`).on_click(() => open(item.path)))
            .child(div().w(10).flex_none().text_size(11).text_color(failed ? t.blocked : t.done).child(failed ? "✗" : "✓"))
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(item.label))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(took));
        }))))
      .when(Boolean(counts), c => c.child(div().text_size(11).text_color(t.dim).child(`${turn.tools} tool calls · ${counts}`)));

    const hideDone = !this.showDone && doneCount > 0 && doneCount < tasks.length;
    const multiPhase = phases.length > 1 || (phases[0] && phases[0].name !== "Tasks");
    const taskList = v_flex().gap(10)
      .child(section("Tasks", tasks.length ? `${doneCount}/${tasks.length}` : null))
      .when(tasks.length > 0, c => c.child(h_flex().gap(2).children(tasks.map(x => div().flex_1().h(3).rounded(2)
        .bg(x.status === "completed" ? t.done : x.status === "in_progress" ? t.working : x.status === "blocked" ? t.blocked : t.border)))))
      .when(tasks.length === 0, c => c.child(div().text_color(t.dim).child("No tasks yet. OMP builds a task list for multi-step work.")))
      .when(doneCount > 0 && doneCount < tasks.length, c => c.child(toggle("omp-toggle-done", `${doneCount} completed`, !hideDone,
        (_e, cx) => { this.showDone = !this.showDone; cx.notify(); })))
      .children(phases.map(phase => v_flex().gap(4)
        .when(multiPhase, c => c.child(div().px(8).text_size(11).text_color(t.dim).child(phase.name)))
        .children((phase.tasks ?? []).filter(x => !(hideDone && x.status === "completed")).map(task => {
          const active = task.status === "in_progress";
          const why = task.reason || task.blockedReason || task.blockReason;
          return h_flex().gap(9).items_start().px(8).py(4).rounded(6)
            .when(active, el => el.bg(t.raised))
            .child(div().w(12).flex_none().text_color(task.status === "completed" ? t.done : active ? t.working : task.status === "blocked" ? t.blocked : t.dim)
              .child(task.status === "completed" ? "✓" : active ? "●" : task.status === "blocked" ? "!" : "○"))
            .child(v_flex().flex_1().min_w(0).gap(3)
              .child(div().text_color(task.status === "completed" ? t.dim : t.foreground).child(task.content))
              .when(Boolean(why), c => c.child(div().text_size(11).text_color(t.blocked).child(why))));
        }))));

    const runningWorkers = workers.filter(w => w.status === "started" || w.status === "running").length;
    const shownWorkers = this.showAllWorkers ? workers : workers.slice(0, 5);
    const workerTone = w => w.status === "completed" ? t.done : w.status === "failed" || w.status === "blocked" ? t.blocked : t.working;
    const subagents = v_flex().gap(8)
      .child(section("Subagents", runningWorkers ? `${runningWorkers} running · ${workers.length}` : `${workers.length}`))
      .child(v_flex().gap(2).children(shownWorkers.map((worker, i) => h_flex().gap(8).items_center().px(8).py(5).rounded(6)
        .child(div().size(6).flex_none().rounded(3).bg(workerTone(worker)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(worker.id))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(worker.status === "started" ? "running" : worker.status))
        .when(Boolean(worker.report), row => row.child(div().id(`worker-report-${i}`).flex_none().text_size(11).cursor_pointer().text_color(t.accent)
          .hover(s => s.text_color(t.foreground)).on_click(() => open(worker.report)).child("View"))))))
      .when(workers.length > 5, c => c.child(toggle("omp-toggle-workers", this.showAllWorkers ? "Show fewer" : `${workers.length - 5} more`, Boolean(this.showAllWorkers),
        (_e, cx) => { this.showAllWorkers = !this.showAllWorkers; cx.notify(); })));

    const parts = (this.model ?? "").split("/");
    const provider = parts.length > 1 ? parts[0] : "";
    const modelName = parts.length > 1 ? parts.slice(1).join("/") : this.model;
    const modelRow = h_flex().id("omp-switch-model").gap(8).items_center().px(10).py(7).rounded(7).border(1).border_color(t.border).bg(t.surface)
      .tooltip(canControl ? "Choose a model for this session" : "Available when OMP is idle")
      .when(canControl, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click(() => openOverlay({ mod: "omp-models", kind: "dialog", width: 560, height: 600, props: { address, model: this.model } })))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(canControl ? t.foreground : t.muted).child(modelName || "Unavailable"))
        .when(Boolean(provider), c => c.child(div().text_size(11).text_color(t.dim).child(provider))))
      .child(svg("mods/files/chevron-down.svg").size(12).flex_none().text_color(t.dim));
    const effortRow = h_flex().gap(2).p(2).rounded(7).bg(t.surface).border(1).border_color(t.border)
      .children(EFFORTS.map(([name]) => {
        const current = this.effort === name;
        return div().id(`omp-effort-${name}`).flex_1().flex().items_center().justify_center().py(4).rounded(5).text_size(11)
          .when(current, el => el.bg(t.selected))
          .text_color(current ? t.foreground : canControl ? t.muted : t.dim)
          .tooltip(canControl ? `Set effort to ${name}` : "Available when OMP is idle")
          .when(canControl && !current, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.setEffort(cx, name)))
          .child(name === "medium" ? "med" : name);
      }));
    const stats = this.stats ?? {};
    const pct = stats.tokens && stats.window ? Math.min(100, Math.round(stats.tokens / stats.window * 100)) : null;
    const compact = n => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;
    const stat = (label, value, tone) => h_flex().gap(8).items_center().justify_between()
      .child(div().text_color(t.dim).child(label))
      .child(div().min_w(0).truncate().text_color(tone ?? t.foreground).child(value));
    const ctxTone = pct >= 80 ? t.blocked : pct >= 60 ? t.working : null;
    const statusBlock = v_flex().gap(6).pb(4)
      .child(section("Status"))
      .when(Boolean(address && !error), el => el
        .when(stats.tokens != null, c => c.child(v_flex().gap(4)
          .child(h_flex().gap(8).items_center().justify_between()
            .child(div().text_color(t.dim).child("Context"))
            .when(pct != null && pct >= 60 && canControl, r => r.child(div().id("omp-compact").flex_none().text_size(11).px(6).py(1).rounded(4).border(1).border_color(t.border)
              .text_color(ctxTone).cursor_pointer().hover(s => s.bg(t.hover)).tooltip("Summarise the conversation to free context (/compact)")
              .on_click((_e, cx) => this.compactContext(cx)).child("Compact")))
            .child(div().min_w(0).truncate().text_color(ctxTone ?? t.foreground).child(pct != null ? `${pct}% · ${compact(stats.tokens)} / ${compact(stats.window)}` : compact(stats.tokens))))
          .when(pct != null, b => b.child(div().h(3).rounded(2).bg(t.border).child(div().h(3).rounded(2).w(`${pct}%`).bg(ctxTone ?? t.accent))))))
        .when(stats.cost != null, c => c.child(stat("Cost", `$${stats.cost.toFixed(2)}`)))
        .when(Boolean(stats.branch), c => c.child(stat("Branch", stats.branch)))
        .when(Boolean(stats.cwd), c => c.child(stat("Folder", stats.cwd.replace(/^\/(home|Users)\/[^/]+/, "~").split("/").slice(-2).join("/")))))
      .when(!address || Boolean(error), el => el.child(div().text_color(t.dim).child("Unavailable")));
    const footer = v_flex().flex_none().gap(8).px(14).py(12).border_t(1).border_color(t.border)
      .child(statusBlock)
      .child(section("Model"))
      .child(modelRow)
      .child(div().pt(4).child(section("Effort")))
      .child(effortRow)
      .when(Boolean(this.switchError), el => el.child(div().text_size(11).text_color(t.blocked).child(this.switchError)));

    return v_flex().id("omp-todos").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_size(12)
      .child(header)
      .child(v_flex().id("omp-todos-list").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(20)
        .when(!address, el => el.child(div().text_color(t.dim).child("Select an OMP terminal to see its session.")))
        .when(Boolean(address && error), el => el.child(div().p(10).rounded(8).bg(t.surface).border(1).border_color(t.border).text_color(t.blocked).child(error)))
        .when(Boolean(address && !error), el => el.child(v_flex().gap(8).child(section("Activity")).child(activity)).child(taskList))
        .when(Boolean(address && !error && workers.length), el => el.child(subagents)))
      .child(footer);
  }
}
