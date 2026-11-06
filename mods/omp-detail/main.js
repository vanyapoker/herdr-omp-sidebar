import { View, div, image } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState } from "gpui-base";
import { props, readTextFile, theme, closeOverlay, settings, exec, appHome } from "herdr";

// A diff line is " 12|context", "+13|added" or "-12|removed"; anything else is a file heading.
const DIFF_LINE = /^[+\- ]\s*\d+\|/;

export default class OmpDetail extends View {
  init(_props, cx) {
    this.path = props()?.path;
    // Inline text (a tool call's command and output) is shown as given; a path is read from its machine.
    this.title = props()?.title;
    this.error = null;
    this.wrap = localStorage.getItem("omp-detail-wrap") !== "false";
    cx.spawn(async cx => {
      try {
        const inline = props()?.text;
        // The host loads images only from the app folder, so a picture is copied there for the preview.
        if (typeof inline !== "string" && !props()?.machine && /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(this.path ?? "")) {
          const ext = this.path.split(".").pop().toLowerCase();
          this.copy = `data/omp-preview/${Date.now()}.${ext}`;
          await exec("mkdir", ["-p", `${appHome()}/data/omp-preview`]);
          const done = await exec("cp", [this.path, `${appHome()}/${this.copy}`]);
          if (done.code !== 0) this.error = done.stderr || "Cannot load the picture.";
          else this.picture = this.copy;
          cx.notify();
          return;
        }
        const text = typeof inline === "string" ? inline : await readTextFile(this.path, { on: props()?.machine ?? null });
        if (text === null) this.error = "File is no longer available.";
        else if (text.includes("\0")) this.error = "Binary file cannot be previewed.";
        else if (props()?.language === "diff") this.diff = text.split("\n");
        else {
          this.text = text;
          this.language = typeof inline === "string" ? "txt" : this.path.split(".").pop() || "txt";
          this.build(this.wrap);
        }
      } catch (e) { this.error = /valid UTF-8/.test(String(e)) ? "Binary file cannot be previewed." : String(e); }
      cx.notify();
    });
  }

  // The editor takes soft_wrap only when it is created, so toggling rebuilds it over the same text.
  build(wrap) {
    this.editor?.release();
    this.editor = EditorState.new({ language: this.language, readonly: true, value: this.text, soft_wrap: wrap });
  }

  toggleWrap(cx) {
    this.wrap = !this.wrap;
    localStorage.setItem("omp-detail-wrap", String(this.wrap));
    if (this.editor) this.build(this.wrap);
    cx.notify();
  }

  close() {
    this.editor?.release();
    if (this.copy) exec("rm", ["-f", `${appHome()}/${this.copy}`]);
  }

  // Diffs are drawn as coloured lines: the editor has no diff highlighting.
  diffView(t) {
    const row = (line, i) => {
      const kind = DIFF_LINE.test(line) ? line[0] : "";
      const color = kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : kind === " " ? t.muted : t.foreground;
      return div().id(`diff-${i}`).px(12).py(line === "" ? 4 : 0).text_color(color).when(!kind && line !== "", el => el.font_semibold().pt(i ? 10 : 0))
        .when(kind === "+" || kind === "-", el => el.bg(t.surface))
        .when(this.wrap, el => el.whitespace_normal()).when(!this.wrap, el => el.whitespace_nowrap())
        .child(line || " ");
    };
    return v_flex().id("detail-diff").flex_1().min_h(0).py(8).overflow_scroll().text_size(12).font_family(settings().font_family)
      .children(this.diff.map(row));
  }

  render() {
    const t = theme();
    return v_flex().size_full().min_h(0).bg(t.background)
      .child(h_flex().h(42).px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(this.title || this.path || "Details"))
        .child(div().id("detail-wrap").flex_none().px(8).py(3).rounded(5).border(1).border_color(t.border).text_size(11).cursor_pointer()
          .text_color(this.wrap ? t.foreground : t.muted).when(this.wrap, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
          .tooltip(this.wrap ? "Word wrap on: click to scroll sideways instead" : "Word wrap off: click to wrap long lines")
          .on_click((_e, cx) => this.toggleWrap(cx)).child("Wrap"))
        .child(div().id("detail-close").px(6).text_color(t.muted).on_click(() => closeOverlay(props().overlay)).child("×")))
      .child(this.picture ? div().id("detail-image").flex_1().min_h(0).p(12).overflow_y_scrollbar()
          .child(image(this.picture).w_full())
        : this.diff ? this.diffView(t) : this.editor ? Editor.new(this.editor).flex_1().min_h(0) : div().p(14).text_color(t.dim).child(this.error || "Loading…"));
  }
}
