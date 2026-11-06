// A small, line-at-a-time syntax tokenizer for diff rows. The host's editor does the real highlighting
// but cannot draw per-row backgrounds, so diffs are drawn as rows and coloured here. It knows the common
// shapes (comments, strings, numbers, keywords, calls, types, JSON keys, tags) and is deliberately forgiving.

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const JS_KW = words("break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch throw try typeof var void while with yield async await get set as type interface enum implements public private protected readonly declare namespace abstract keyof");
const RUST_KW = words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while");
const GO_KW = words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var");
const C_KW = words("auto break case char class const continue default do double else enum extern float for goto if inline int long namespace new private protected public register return short signed sizeof static struct switch template this typedef union unsigned using virtual void volatile while try catch throw final abstract extends implements import package interface boolean byte null override");
const PY_KW = words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case");
const SH_KW = words("if then else elif fi for while until do done case esac in function select time export local readonly return exit break continue source alias unset set shift trap eval exec");
const CSS_KW = words("important and or not only from to");
const CONSTS = words("true false null undefined None True False nil NaN Infinity this self");

const LANGS = {
  js: { line: ["//"], block: ["/*", "*/"], quotes: "'\"`", kw: JS_KW },
  rust: { line: ["//"], block: ["/*", "*/"], quotes: "\"", kw: RUST_KW },
  go: { line: ["//"], block: ["/*", "*/"], quotes: "\"`'", kw: GO_KW },
  c: { line: ["//"], block: ["/*", "*/"], quotes: "\"'", kw: C_KW },
  css: { line: [], block: ["/*", "*/"], quotes: "\"'", kw: CSS_KW, css: true },
  py: { line: ["#"], quotes: "\"'", kw: PY_KW, triple: true },
  sh: { line: ["#"], quotes: "\"'`", kw: SH_KW },
  yaml: { line: ["#"], quotes: "\"'", kw: new Set(), keys: true },
  toml: { line: ["#"], quotes: "\"'", kw: new Set(), keys: true },
  json: { line: [], quotes: "\"", kw: new Set(), keys: true },
  markup: { line: [], block: ["<!--", "-->"], quotes: "\"'", kw: new Set(), markup: true },
  md: { line: [], quotes: "", kw: new Set(), md: true },
};

const BY_EXT = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", vue: "js", svelte: "js",
  rs: "rust", go: "go", c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", java: "c", kt: "c", cs: "c", swift: "c", php: "c",
  css: "css", scss: "css", less: "css", py: "py", rb: "py", sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
  yml: "yaml", yaml: "yaml", toml: "toml", json: "json", jsonc: "json",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", md: "md", markdown: "md",
};

export function languageOf(path) {
  const name = path.split("/").pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : name.toLowerCase();
  return BY_EXT[ext] ?? null;
}

const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const IDENT = /^[A-Za-z_$][\w$]*/;
const IDENT_DASH = /^[A-Za-z_$][\w$-]*/; // css properties, yaml/toml keys, shell flags and html attributes contain "-"
const DASHED = new Set(["css", "yaml", "toml", "markup", "sh"]);
const TAG = /^<\/?[A-Za-z][\w:.-]*|^\/?>/;

// Tokenizes one line. `state` carries an open block comment / triple-quoted string between lines.
// Returns the line as [{ text, kind }] pieces and the state for the next line.
export function tokenize(lang, line, state = null) {
  const cfg = LANGS[lang];
  if (!cfg) return { tokens: [{ text: line, kind: "plain" }], state: null };
  const out = [];
  const push = (text, kind) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  if (cfg.md) {
    const heading = /^\s*#{1,6}\s/.test(line);
    const quote = /^\s*>/.test(line);
    const bullet = /^(\s*)([-*+]|\d+\.)(\s)/.exec(line);
    if (heading) push(line, "kw");
    else if (quote) push(line, "com");
    else if (bullet) { push(bullet[1], "plain"); push(bullet[2], "kw"); push(line.slice(bullet[0].length - 1), "plain"); }
    else push(line, "plain");
    return { tokens: out, state: null };
  }
  let i = 0;
  let open = state; // { end } while inside a block comment or a triple-quoted string
  const rest = () => line.slice(i);
  while (i < line.length) {
    if (open) {
      const at = line.indexOf(open.end, i);
      if (at < 0) { push(rest(), open.kind); i = line.length; break; }
      push(line.slice(i, at + open.end.length), open.kind);
      i = at + open.end.length;
      open = null;
      continue;
    }
    const ch = line[i];
    if (/\s/.test(ch)) {
      const m = /^\s+/.exec(rest());
      push(m[0], "plain");
      i += m[0].length;
      continue;
    }
    if (cfg.block && rest().startsWith(cfg.block[0])) {
      open = { end: cfg.block[1], kind: "com" };
      push(cfg.block[0], "com");
      i += cfg.block[0].length;
      continue;
    }
    const lineComment = cfg.line.find((c) => rest().startsWith(c));
    if (lineComment) {
      push(rest(), "com");
      i = line.length;
      break;
    }
    if (cfg.quotes.includes(ch)) {
      if (cfg.triple && rest().startsWith(ch.repeat(3))) {
        const end = ch.repeat(3);
        const at = line.indexOf(end, i + 3);
        if (at < 0) { open = { end, kind: "str" }; push(rest(), "str"); i = line.length; }
        else { push(line.slice(i, at + 3), "str"); i = at + 3; }
        continue;
      }
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      const text = line.slice(i, Math.min(j + 1, line.length));
      const after = line.slice(j + 1).trimStart();
      push(text, cfg.keys && after.startsWith(":") ? "key" : "str");
      i += text.length;
      continue;
    }
    if (cfg.markup) {
      const tag = TAG.exec(rest());
      if (tag) { push(tag[0], "kw"); i += tag[0].length; continue; }
    }
    const num = /[\d]/.test(ch) ? NUMBER.exec(rest()) : null;
    if (num) { push(num[0], "num"); i += num[0].length; continue; }
    const id = (DASHED.has(lang) ? IDENT_DASH : IDENT).exec(rest());
    if (id) {
      const word = id[0];
      const next = line.slice(i + word.length).trimStart()[0];
      let kind = "plain";
      if (CONSTS.has(word)) kind = "const";
      else if (cfg.kw.has(word)) kind = "kw";
      else if (cfg.markup && /^[a-z-]+$/.test(word) && line[i + word.length] === "=") kind = "fn";
      else if (cfg.keys && next === ":") kind = "key";
      else if (next === "(" ) kind = "fn";
      else if (/^[A-Z][a-z]/.test(word)) kind = "type";
      push(word, kind);
      i += word.length;
      continue;
    }
    push(ch, "plain");
    i += 1;
  }
  return { tokens: out, state: open };
}

// Splits tokens into word-sized pieces (a word keeps its trailing spaces) so a row can wrap between them.
export function pieces(tokens) {
  const out = [];
  for (const token of tokens) {
    const parts = token.text.match(/\s+|\S+\s*/g) ?? [token.text];
    for (const text of parts) out.push({ text, kind: token.kind });
  }
  return out;
}
