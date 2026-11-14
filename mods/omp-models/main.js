// A searchable model picker for one OMP terminal. It lists OMP's own catalog
// (`omp models --json`) and applies the choice through OMP's session-only
// model switcher (Alt+P), so the session's roles and settings stay untouched.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { hc, exec, theme, props, closeOverlay, shared, setShared, readTextFile, appHome } from "herdr";

const CACHE = "omp.models";
const FAVORITES = "omp.favoriteModels";
const ROW = 50;

const context = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const price = (c) => (!c || (!c.input && !c.output) ? "free" : `$${c.input}/${c.output}`);
// Every keystroke typed into OMP's filter costs about 30 ms, so type as little as will do: the shortest
// fragment (starting at a word boundary) that no other model's name contains. A model whose id is the start
// of another's (haiku-4-5 / haiku-4-5-20251001) gets the fragment that leaves the fewest others matching.
function searchText(model, models) {
  const id = model.id.toLowerCase();
  const others = models.filter((m) => m.selector !== model.selector).map((m) => `${m.selector} ${m.name}`.toLowerCase());
  let best = null;
  for (let len = 3; len <= id.length; len++) {
    for (let start = 0; start + len <= id.length; start++) {
      if (start > 0 && !/[-.\/:_ ]/.test(id[start - 1])) continue;
      const q = id.slice(start, start + len);
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(q)) continue; // no "/", ":" or spaces: OMP's filter may treat them specially
      const hits = others.reduce((n, h) => n + (h.includes(q) ? 1 : 0), 0);
      if (hits === 0) return q;
      if (!best || hits < best.hits) best = { q, hits };
    }
  }
  return best?.q ?? model.id.split(/[\/:]/).sort((a, b) => b.length - a.length)[0];
}

const POLL = 0.02; // seconds between screen reads: each read costs about 5 ms
const sleep = (s) => exec("sleep", [String(s)]);

async function screenOf(address) {
  const r = await hc(["read", address, "--lines", "0"]);
  return r.code === 0 ? r.stdout : "";
}
// The row OMP's picker has highlighted: "❯ provider/model …".
const highlighted = (screen) => /^[^\w❯]*❯\s+(\S+)/m.exec(screen)?.[1] ?? null;

async function untilScreen(address, ok, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const screen = await screenOf(address);
    if (ok(screen)) return screen;
    await sleep(POLL);
  }
  return null;
}

// Drives OMP's own picker: open it, filter to the model, confirm the highlighted row is
// the wanted one (walking down if several match), then press Enter.
async function applyModel(address, model, models = []) {
  const info = await hc(["get", address, "--json"]);
  if (info.code !== 0) throw new Error("Cannot inspect the terminal");
  const terminal = JSON.parse(info.stdout);
  const state = terminal.status?.state;
  if (terminal.foreground?.name !== "omp" || (state !== "idle" && state !== "done")) throw new Error("Available when OMP is idle.");

  await hc(["keys", address, "alt+p"]);
  if (!(await untilScreen(address, (s) => s.includes("Switch Model")))) throw new Error("OMP's model picker did not open.");

  await hc(["keys", address, ...searchText(model, models).split("")]);
  // The wanted model is normally the first row once the filter has applied; wait for it, then fall back to walking down.
  let seen = (await untilScreen(address, (s) => highlighted(s) === model.selector, 25)) ?? (await screenOf(address));
  try {
    for (let i = 0; i < 40; i++) {
      const current = highlighted(seen);
      if (current === model.selector) {
        await hc(["keys", address, "enter"]);
        if (!(await untilScreen(address, (s) => !s.includes("Switch Model"), 150))) throw new Error("OMP did not confirm the switch.");
        return;
      }
      if (current === null) break;
      await hc(["keys", address, "down"]);
      seen = await untilScreen(address, (s) => highlighted(s) !== current, 60);
      if (!seen) break;
    }
    throw new Error(`${model.selector} is not selectable in this session.`);
  } catch (e) {
    await hc(["keys", address, "escape"]);
    throw e;
  }
}

// The model list comes from omp-todos/read.py, which keeps it in ~/.cache/omp-catalog.json on the
// machine omp runs on: a warm read takes about 30 ms, a cold `omp models --json` one to three seconds.
let readerSource = null;
async function loadCatalog(address) {
  const info = await hc(["get", address, "--json"]);
  const pid = JSON.parse(info.stdout).foreground?.pid;
  if (!pid) throw new Error("OMP is not running in that terminal");
  readerSource ??= await readTextFile(`${appHome()}/mods/omp-todos/read.py`);
  const on = address.includes("/") ? address.split("/")[0] : null;
  const result = await exec("python3", ["-c", readerSource, String(pid), "--catalog"], { on });
  if (result.code !== 0) throw new Error(result.stderr || "Cannot list models");
  return JSON.parse(result.stdout).models ?? [];
}

export default class OmpModels extends View {
  init(_props, cx) {
    this.address = props()?.address;
    this.current = props()?.model;
    this.cacheKey = `${CACHE}:${this.address?.split("/")[0] ?? ""}`;
    // The last list opens instantly (this run's, else the one saved by an earlier run); a fresh one replaces it below.
    this.models = shared(this.cacheKey) ?? (() => { try { return JSON.parse(localStorage.getItem(this.cacheKey) ?? "[]"); } catch { return []; } })();
    this.cursor = 0;
    this.offset = 0;
    this.areaHeight = 400;
    this.busy = null;
    this.error = null;
    this.query = "";
    this.input = InputState.new({ placeholder: "Search models" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.cursor = 0; this.offset = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => { const m = this.filtered()[this.cursor]; if (m) this.choose(m, cx); });
    this.input.focus();
    cx.spawn(async (cx) => {
      try {
        this.models = await loadCatalog(this.address);
        setShared(this.cacheKey, this.models);
        localStorage.setItem(this.cacheKey, JSON.stringify(this.models));
        this.error = null;
      } catch (e) { if (!this.models.length) this.error = String(e); }
      cx.notify();
    });
  }

  favorites() { return shared(FAVORITES) ?? []; }

  toggleFavorite(selector) {
    const favorites = this.favorites();
    setShared(FAVORITES, favorites.includes(selector) ? favorites.filter((s) => s !== selector) : [...favorites, selector]);
  }

  // Favourites first (in the order they were starred), then the current model, then the rest.
  filtered() {
    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = this.models.filter((m) => terms.every((term) => `${m.selector} ${m.name}`.toLowerCase().includes(term)));
    const favorites = this.favorites();
    const starred = favorites.map((s) => matches.find((m) => m.selector === s)).filter(Boolean);
    const rest = matches.filter((m) => !favorites.includes(m.selector));
    return [...starred, ...rest.filter((m) => m.selector === this.current), ...rest.filter((m) => m.selector !== this.current)];
  }

  visibleRows() { return Math.max(1, Math.floor(this.areaHeight / ROW)); }

  reveal() {
    const rows = this.visibleRows();
    if (this.cursor < this.offset) this.offset = this.cursor;
    else if (this.cursor >= this.offset + rows) this.offset = this.cursor - rows + 1;
  }

  choose(model, cx) {
    if (this.busy || model.selector === this.current) return;
    this.busy = model.name;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await applyModel(this.address, model, this.models);
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = String(e).replace(/^Error: /, "");
        this.busy = null;
        cx.notify();
      }
    });
  }

  move(by, cx) {
    const count = this.filtered().length;
    if (!count) return;
    this.cursor = Math.max(0, Math.min(count - 1, this.cursor + by));
    this.reveal();
    cx.notify();
  }

  close() { this.input.release(); }

  row(m, i, t) {
    const current = m.selector === this.current;
    const starred = this.favorites().includes(m.selector);
    const selectable = !this.busy && !current;
    return h_flex().id(`model-${m.selector}`).h(ROW).flex_none().px(14).gap(10).items_center()
      .when(i === this.cursor, (el) => el.bg(t.selected))
      .when(selectable, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.choose(m, cx)))
      .when(!selectable, (el) => el.cursor_default())
      .child(div().id(`star-${m.selector}`).w(22).h(28).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
        .text_size(16).text_color(starred ? t.ansi3 : t.muted).hover((s) => s.bg(t.raised))
        .tooltip(starred ? "Remove from favourites" : "Pin to the top")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggleFavorite(m.selector); cx.notify(); })
        .child(starred ? "★" : "☆"))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center()
          .child(div().truncate().text_color(t.foreground).child(m.name))
          .when(current, (el) => el.child(div().flex_none().text_size(10).px(5).rounded(4).bg(t.raised).text_color(t.accent).child("current"))))
        .child(div().truncate().text_size(11).text_color(t.dim).child(m.selector)))
      .child(v_flex().flex_none().items_end().gap(1)
        .child(div().text_size(11).text_color(t.muted).child(`${context(m.contextWindow)} · ${price(m.cost)}`))
        .child(div().text_size(11).text_color(t.dim).child(m.reasoning ? "reasoning" : "")));
  }

  render() {
    const t = theme();
    const list = this.filtered();
    const rows = this.visibleRows();
    const maxOffset = Math.max(0, list.length - rows);
    this.offset = Math.min(this.offset, maxOffset);
    const shown = list.slice(this.offset, this.offset + rows + 1);
    const thumb = Math.max(24, this.areaHeight * rows / Math.max(1, list.length));
    const thumbTop = maxOffset ? (this.areaHeight - thumb) * this.offset / maxOffset : 0;
    return v_flex().id("omp-models").size_full().min_h(0).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "down") { this.move(1, cx); cx.stop_propagation(); }
        else if (e.key === "up") { this.move(-1, cx); cx.stop_propagation(); }
        else if (e.key === "f" && e.modifiers.control) {
          const m = list[this.cursor];
          if (m) { this.toggleFavorite(m.selector); cx.notify(); }
          cx.stop_propagation();
        }
      })
      .child(h_flex().flex_none().p(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).h(34).px(12).flex().items_center().rounded(8).border_1().border_color(t.accent).cursor_text()
          .child(Input.new(this.input).h_full().text_size(13).text_color(t.foreground)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${list.length} models`)))
      .child(div().id("omp-models-area").flex_1().min_h(0).relative().overflow_hidden()
        .on_size_change((size, cx) => { if (Math.abs(size.height - this.areaHeight) > 1) { this.areaHeight = size.height; cx.notify(); } })
        .on_scroll_wheel((e, cx) => {
          if (Math.abs(e.delta.y) < 1) return;
          this.offset = Math.max(0, Math.min(maxOffset, this.offset + (e.delta.y > 0 ? -1 : 1)));
          cx.notify();
        })
        .child(v_flex().children(shown.map((m, k) => this.row(m, this.offset + k, t))))
        .when(list.length > rows, (el) => el.child(div().absolute().right(3).top(thumbTop).w(4).h(thumb).rounded(2).bg(t.border)))
        .when(!list.length, (el) => el.child(div().absolute().top(0).p(16).text_color(t.dim)
          .child(this.models.length ? "No model matches your search." : this.error || "Loading models…"))))
      .child(h_flex().flex_none().px(14).py(8).gap(8).border_t(1).border_color(t.border).text_size(11)
        .child(div().flex_1().min_w(0).truncate().text_color(this.error ? t.blocked : t.dim)
          .child(this.busy ? `Switching to ${this.busy}…` : this.error || "↑↓ navigate · Enter select · Ctrl+F favourite · Esc close")));
  }
}
