import { View, div } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState } from "gpui-base";
import { props, readTextFile, theme, closeOverlay } from "herdr";

export default class OmpDetail extends View {
  init(_props, cx) {
    this.path = props()?.path;
    // Inline text (a tool call's command and output) is shown as given; a path is read from its machine.
    this.title = props()?.title;
    this.error = null;
    cx.spawn(async cx => {
      try {
        const inline = props()?.text;
        const text = typeof inline === "string" ? inline : await readTextFile(this.path, { on: props()?.machine ?? null });
        if (text === null) this.error = "File is no longer available.";
        else if (text.includes("\0")) this.error = "Binary file cannot be previewed.";
        else this.editor = EditorState.new({ language: typeof inline === "string" ? "txt" : this.path.split(".").pop() || "txt", readonly: true, value: text });
      } catch (e) { this.error = String(e); }
      cx.notify();
    });
  }
  close() { this.editor?.release(); }
  render() {
    const t = theme();
    return v_flex().size_full().min_h(0).bg(t.background)
      .child(h_flex().h(42).px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(this.title || this.path || "Details"))
        .child(div().id("detail-close").px(6).text_color(t.muted).on_click(() => closeOverlay(props().overlay)).child("×")))
      .child(this.editor ? Editor.new(this.editor).flex_1().min_h(0) : div().p(14).text_color(t.dim).child(this.error || "Loading…"));
  }
}
