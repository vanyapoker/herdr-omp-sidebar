// Every file omp changed, as one scrollable diff with a collapsible header per file.
// `read.py <pid> --changes turn|session` runs on the terminal's own machine and returns omp's own
// per-edit diffs (`+12|text`, `-12|text`, ` 12|context`), joined per file.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, hc, exec, appHome, readTextFile, theme, closeOverlay, settings } from "herdr";
import { languageOf, tokenize, pieces } from "./highlight.js";

const LINE = /^([+\- ])\s*(\d+)\|(.*)$/;

// Adds highlighted pieces to the code rows; block comments and docstrings carry over between the rows of a hunk.
function colour(rows, lang) {
  if (!lang) return rows;
  let state = null;
  for (const r of rows) {
    if (r.kind === "gap") { state = null; continue; }
    if (r.kind === "note") continue;
    const result = tokenize(lang, r.text, state);
    r.pieces = pieces(result.tokens);
    if (r.kind !== "-") state = result.state;
  }
  return rows;
}
const EXPAND_BUDGET = 700; // rows drawn open at first; later files start collapsed
let readerSource = null;

const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);
const compact = (path) => path.replace(/^\/(home|Users)\/[^/]+/, "~");

// " 12|ctx" / "+13|new" / "-12|old" become rows; a blank line between edits is a gap.
function parse(diff) {
  const rows = [];
  for (const line of diff.split("\n")) {
    const m = LINE.exec(line);
    if (m) rows.push({ kind: m[1], no: m[2], text: m[3] });
    else if (line === "") { if (rows.length && rows[rows.length - 1].kind !== "gap") rows.push({ kind: "gap" }); }
    else rows.push({ kind: "note", text: line });
  }
  while (rows.length && rows[rows.length - 1].kind === "gap") rows.pop();
  return rows;
}

export default class OmpChanges extends View {
  init(_props, cx) {
    this.address = props()?.address;
    this.scope = props()?.scope === "session" ? "session" : "turn";
    this.files = null;
    this.rows = new Map();
    this.collapsed = new Set();
    this.error = null;
    this.token = 0;
    this.wrap = localStorage.getItem("omp-detail-wrap") !== "false";
    this.load(cx);
  }

  load(cx) {
    const token = ++this.token;
    this.files = null;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const info = await hc(["get", this.address, "--json"]);
        if (info.code !== 0) throw new Error(info.stderr || "Cannot read terminal");
        const pid = JSON.parse(info.stdout).foreground?.pid;
        if (!pid) throw new Error("OMP is not running in that terminal");
        readerSource ??= await readTextFile(`${appHome()}/mods/omp-todos/read.py`);
        const run = await exec("python3", ["-c", readerSource, String(pid), "--changes", this.scope], { on: machineOf(this.address) });
        if (run.code !== 0) throw new Error(run.stderr || "Cannot read OMP session");
        const data = JSON.parse(run.stdout);
        if (data.error) throw new Error(data.error);
        if (token !== this.token) return;
        this.rows = new Map(data.files.map((f) => [f.path, colour(parse(f.diff), languageOf(f.path))]));
        this.collapsed = new Set();
        let drawn = 0;
        data.files.forEach((f, i) => {
          const n = this.rows.get(f.path).length;
          if (i > 0 && drawn + n > EXPAND_BUDGET) this.collapsed.add(f.path);
          else drawn += n;
        });
        this.files = data.files;
      } catch (e) {
        if (token === this.token) this.error = String(e).replace(/^Error: /, "");
      }
      cx.notify();
    });
  }

  setScope(scope, cx) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.load(cx);
  }

  toggleFile(path, cx) {
    if (this.collapsed.has(path)) this.collapsed.delete(path);
    else this.collapsed.add(path);
    cx.notify();
  }

  toggleAll(cx) {
    const open = this.files.some((f) => !this.collapsed.has(f.path));
    this.collapsed = open ? new Set(this.files.map((f) => f.path)) : new Set();
    cx.notify();
  }

  toggleWrap(cx) {
    this.wrap = !this.wrap;
    localStorage.setItem("omp-detail-wrap", String(this.wrap));
    cx.notify();
  }

  palette(t) {
    return { plain: t.foreground, kw: t.ansi5, str: t.ansi2, com: t.dim, num: t.ansi1, fn: t.ansi4, type: t.ansi3, const: t.ansi6, key: t.ansi4 };
  }

  row(r, t, tint) {
    if (r.kind === "gap") return div().h(22).flex().items_center().pl(70).text_size(11).text_color(t.dim).bg(t.surface).child("⋯");
    if (r.kind === "note") return div().px(12).py(4).text_color(t.dim).child(r.text);
    const sign = r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim;
    const colors = this.palette(t);
    return h_flex().items_start().min_w(0)
      .when(r.kind === "+", (el) => el.bg(tint(t.ansi2)))
      .when(r.kind === "-", (el) => el.bg(tint(t.ansi1)))
      .child(div().w(56).flex_none().flex().justify_end().pr(10).text_color(t.dim).child(r.no))
      .child(div().w(14).flex_none().text_color(sign).child(r.kind === " " ? "" : r.kind))
      .child(r.pieces
        // Highlighted: one child per word, so a long line wraps between words.
        ? h_flex().flex_1().min_w(0).pr(12).when(this.wrap, (el) => el.flex_wrap()).when(!this.wrap, (el) => el.flex_nowrap())
          .children(r.pieces.map((p) => div().flex_none().text_color(colors[p.kind]).child(p.text)))
        : div().flex_1().min_w(0).pr(12).text_color(t.foreground)
          .when(this.wrap, (el) => el.whitespace_normal()).when(!this.wrap, (el) => el.whitespace_nowrap())
          .child(r.text || " "));
  }

  fileCard(file, i, t, tint) {
    const closed = this.collapsed.has(file.path);
    const name = file.path.split("/").pop();
    const dir = compact(file.path.slice(0, file.path.length - name.length));
    return v_flex().rounded(8).border(1).border_color(t.border).overflow_hidden().bg(t.background)
      .child(h_flex().id(`changes-file-${i}`).h(34).flex_none().px(10).gap(8).items_center().bg(t.surface).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleFile(file.path, cx))
        .child(svg(`mods/files/chevron-${closed ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().flex_none().font_semibold().text_color(t.foreground).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
        .when(file.written, (el) => el.child(div().flex_none().text_size(10).px(5).rounded(4).bg(t.raised).text_color(t.muted).child("written")))
        .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${file.added}`))
        .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${file.removed}`)))
      .when(!closed, (el) => el.child(v_flex().py(4).children((this.rows.get(file.path) ?? []).map((r) => this.row(r, t, tint)))
        .when(file.truncated, (c) => c.child(div().px(12).py(4).text_color(t.dim).child("… the rest of this file's diff is not shown")))));
  }

  render() {
    const t = theme();
    // A translucent wash of the theme's green/red; themes that don't give plain #rrggbb get the surface colour.
    const tint = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? `${c}26` : t.surface);
    const files = this.files ?? [];
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const allClosed = files.length > 0 && files.every((f) => this.collapsed.has(f.path));
    const button = (id, text, on, onClick, tip) => div().id(id).flex_none().px(8).py(3).rounded(5).border(1).border_color(t.border).text_size(11).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover)).tooltip(tip).on_click(onClick).child(text);
    return v_flex().size_full().min_h(0).bg(t.background)
      .child(h_flex().h(46).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().text_color(t.foreground).child("Changes"))
        .when(files.length > 0, (el) => el.child(h_flex().gap(8).items_center().text_size(11)
          .child(div().text_color(t.dim).child(`${files.length} ${files.length === 1 ? "file" : "files"}`))
          .child(div().text_color(t.ansi2).child(`+${added}`))
          .child(div().text_color(t.ansi1).child(`−${removed}`))))
        .child(div().flex_1())
        .child(h_flex().gap(2).items_center()
          .child(button("changes-turn", "This turn", this.scope === "turn", (_e, cx) => this.setScope("turn", cx), "Files changed since your last message"))
          .child(button("changes-session", "Session", this.scope === "session", (_e, cx) => this.setScope("session", cx), "Every file changed in this session")))
        .when(files.length > 1, (el) => el.child(button("changes-all", allClosed ? "Expand all" : "Collapse all", false, (_e, cx) => this.toggleAll(cx), "Fold or unfold every file")))
        .child(button("changes-wrap", "Wrap", this.wrap, (_e, cx) => this.toggleWrap(cx), this.wrap ? "Word wrap on: click to scroll sideways instead" : "Word wrap off: click to wrap long lines"))
        .child(div().id("changes-close").px(6).text_color(t.muted).cursor_pointer().on_click(() => closeOverlay(props().overlay)).child("×")))
      .child(this.files && files.length > 0
        ? v_flex().id("omp-changes-body").flex_1().min_h(0).p(12).gap(10).text_size(12).font_family(settings().font_family)
            .when(this.wrap, (el) => el.overflow_y_scrollbar()).when(!this.wrap, (el) => el.overflow_scroll())
            .children(files.map((f, i) => this.fileCard(f, i, t, tint)))
        : div().p(16).text_color(this.error ? t.blocked : t.dim)
            .child(this.error ?? (this.files ? (this.scope === "turn" ? "No files changed since your last message. Try Session." : "No files changed in this session.") : "Loading changes…")));
  }
}
