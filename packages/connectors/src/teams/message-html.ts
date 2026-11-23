// Teams message HTML -> a small typed list of safe nodes (T-281, spec 8.4, rule 9). A message body is untrusted: it may carry any markup. Nothing here produces HTML. The output is DATA
// (strings and a fixed set of node kinds) that React draws as text, so no raw HTML ever reaches the browser. What survives, and nothing else:
//   text, line break, paragraph (p, div, headings), bold, italic, underline, strike, inline code, code block, quote, bullet and numbered list with items, a link, a mention (as "@Name" text),
//   an emoji (its alt text), an image placeholder (only for hosted content of Microsoft itself; any other image is dropped, never loaded).
// Everything else is dropped with its content (script, style, iframe, object, embed, form controls, svg, math, template, noscript, ...) or flattened to its text (unknown and table tags).
// Attributes are read ONLY for: a link's `href` (https only, no credentials, at most 2,048 characters, no control or space character, normalised by the URL parser so what is checked is what is
// drawn), an emoji's `alt`, and an image's `src` (to tell hosted content from anything else; the address is never kept). Event handlers, styles, classes and `javascript:`/`data:` URLs are never read.
// Text has bidirectional overrides, zero-width spaces and control characters removed, so a message cannot reorder or hide what the person reads. Bounded: one linear pass, at most MAX_NODES
// nodes, nesting capped at MAX_DEPTH, and the text cut at MAX_TEXT_CHARS (the cut is reported, never silent). The converter never throws on input and never builds a message from content.

/** Text kept per message (spec 8.4). */
export const MAX_TEXT_CHARS = 20_000;
export const MAX_NODES = 5_000;
export const MAX_DEPTH = 12;
const MAX_HREF = 2_048;

export type MessageNode =
  | { t: "text"; v: string }
  | { t: "br" }
  | { t: "mention"; v: string }
  | { t: "emoji"; v: string }
  /** A picture the message holds in Microsoft's own storage: drawn as a neutral placeholder only (T-285 adds the proxy). Never a URL. */
  | { t: "image" }
  | { t: "link"; href: string; host: string; c: MessageNode[] }
  | { t: "b" | "i" | "u" | "s" | "code" | "p" | "quote" | "codeblock" | "ul" | "ol" | "li"; c: MessageNode[] };

export type ConvertedMessage = { nodes: MessageNode[]; truncated: boolean };

// ---- characters
// Bidirectional controls (embeddings, overrides, isolates, marks), zero-width space/joiner-less invisibles, word joiner, BOM, soft hyphen and C0/C1 controls except tab and newline.
// U+200C/U+200D (joiners) are kept: emoji sequences and several scripts need them.
const UNWANTED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­؜​‎‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]/g;
export const cleanText = (s: string): string => s.replace(UNWANTED, "");

const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", euro: "€" };
/** One pass, never re-decoded (`&amp;lt;` stays `&lt;` as text). An unknown or invalid entity stays as written. */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// ---- links
/**
 * The normalised address of an https link, or null. https only; no user name or password; a host; at most 2,048 characters; no whitespace or control character in what was written
 * (after trimming the ends). The URL parser's own `href` is returned, so the checked address is the drawn one (a backslash, an encoded dot or a mixed-case scheme cannot differ between check and use).
 */
export function safeHttpsUrl(raw: string): { href: string; host: string } | null {
  const s = raw.trim();
  if (s.length === 0 || s.length > MAX_HREF) return null;
  if (/[\u0000- \u007f-\u009f​-‏‪-‮⁠-⁯﻿]/.test(s)) return null;
  if (!/^https:\/\//i.test(s)) return null; // `https:example` and `https:\\host` are accepted by the URL parser as hosts; only the written `https://` form is a link
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.hostname === "") return null;
  if (u.href.length > MAX_HREF) return null;
  return { href: u.href, host: u.hostname };
}

// ---- tokenizer (linear; never backtracks)
type Token = { k: "text"; v: string } | { k: "open"; name: string; attrs: Map<string, string>; selfClosing: boolean } | { k: "close"; name: string };

/** Elements removed together with everything inside them (their content is never text the person should read). */
const DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "template", "svg", "math", "title", "head", "audio", "video", "canvas", "select", "textarea", "button", "form", "xmp", "plaintext", "noembed", "noframes", "link", "meta", "base"]);
const VOID = new Set(["br", "hr", "img", "input", "wbr", "area", "col", "source", "track", "param", "attachment", "emoji", "at"]);

const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/** Reads one tag starting at `<` (index i). Returns the token and the index after its `>`; null when this `<` is not a tag. Quote-aware, so `>` inside an attribute value does not end the tag. */
function readTag(h: string, i: number): { token: Token | null; next: number } | null {
  const n = h.length;
  let j = i + 1;
  const closing = h.charCodeAt(j) === 47;
  if (closing) j += 1;
  if (!isNameStart(h.charCodeAt(j))) return null;
  const nameStart = j;
  while (j < n && !isSpace(h.charCodeAt(j)) && h.charCodeAt(j) !== 62 && h.charCodeAt(j) !== 47) j += 1;
  const name = h.slice(nameStart, j).toLowerCase();
  const attrs = new Map<string, string>();
  let selfClosing = false;
  while (j < n) {
    const c = h.charCodeAt(j);
    if (c === 62) {
      j += 1;
      return { token: closing ? { k: "close", name } : { k: "open", name, attrs, selfClosing }, next: j };
    }
    if (isSpace(c)) {
      j += 1;
      continue;
    }
    if (c === 47) {
      selfClosing = true;
      j += 1;
      continue;
    }
    selfClosing = false;
    const a = j;
    while (j < n && !isSpace(h.charCodeAt(j)) && h.charCodeAt(j) !== 62 && h.charCodeAt(j) !== 61 && h.charCodeAt(j) !== 47) j += 1;
    if (j === a) {
      j += 1; // a stray character such as `=`: skip it, so every loop makes progress
      continue;
    }
    const attr = h.slice(a, j).toLowerCase();
    while (j < n && isSpace(h.charCodeAt(j))) j += 1;
    let value = "";
    if (h.charCodeAt(j) === 61) {
      j += 1;
      while (j < n && isSpace(h.charCodeAt(j))) j += 1;
      const q = h.charCodeAt(j);
      if (q === 34 || q === 39) {
        const end = h.indexOf(String.fromCharCode(q), j + 1);
        if (end < 0) return { token: null, next: n }; // an unterminated quoted value: the rest of the input is inside it; nothing after it is read as markup
        value = h.slice(j + 1, end);
        j = end + 1;
      } else {
        const v = j;
        while (j < n && !isSpace(h.charCodeAt(j)) && h.charCodeAt(j) !== 62) j += 1;
        value = h.slice(v, j);
      }
    }
    if (!attrs.has(attr) && attrs.size < 24) attrs.set(attr, value);
  }
  return { token: null, next: n }; // never closed: nothing is made of it
}

const closeRes = new Map<string, RegExp>();
function closeRe(name: string): RegExp {
  let re = closeRes.get(name);
  if (!re) {
    re = new RegExp(`</${name}(?![a-z0-9])`, "gi");
    closeRes.set(name, re);
  }
  return re;
}

function* tokens(h: string): Generator<Token> {
  const n = h.length;
  let i = 0;
  let textStart = 0;
  while (i < n) {
    const lt = h.indexOf("<", i);
    if (lt < 0) break;
    const c = h.charCodeAt(lt + 1);
    if (c === 33 || c === 63) {
      // a comment, CDATA, doctype or processing instruction: skipped (a comment ends at `-->`, the others at the first `>`)
      if (lt > textStart) yield { k: "text", v: h.slice(textStart, lt) };
      if (h.startsWith("<!--", lt)) {
        const e = h.indexOf("-->", lt + 4);
        i = e < 0 ? n : e + 3;
      } else {
        const e = h.indexOf(">", lt + 2);
        i = e < 0 ? n : e + 1;
      }
      textStart = i;
      continue;
    }
    const tag = readTag(h, lt);
    if (tag === null) {
      i = lt + 1; // a lone `<`: text
      continue;
    }
    if (lt > textStart) yield { k: "text", v: h.slice(textStart, lt) };
    i = tag.next;
    textStart = i;
    if (tag.token === null) continue;
    yield tag.token;
    if (tag.token.k === "open" && DROP.has(tag.token.name) && !tag.token.selfClosing) {
      // Raw-text and foreign content: skip to the matching close tag (the first `</name` of any case); an unclosed one drops the rest.
      // A case-insensitive search from here on that never changes the text's length (lower-casing can), so the indexes stay true; each search moves forward only (linear overall).
      const re = closeRe(tag.token.name);
      re.lastIndex = i;
      const m = re.exec(h);
      const e = m ? m.index : -1;
      if (e < 0) {
        i = n;
        textStart = n;
      } else {
        const gt = h.indexOf(">", e);
        i = gt < 0 ? n : gt + 1;
        textStart = i;
      }
      yield { k: "close", name: tag.token.name };
    }
  }
  if (textStart < n) yield { k: "text", v: h.slice(textStart) };
}

// ---- builder
const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "aside", "main", "nav", "address", "figure", "figcaption", "center", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "dl", "dt", "dd", "details", "summary"]);
const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const KIND: Readonly<Record<string, "b" | "i" | "u" | "s" | "code">> = { b: "b", strong: "b", i: "i", em: "i", cite: "i", u: "u", ins: "u", s: "s", strike: "s", del: "s", code: "code", tt: "code", kbd: "code", samp: "code" };

type Frame = { tag: string; node: { c: MessageNode[] } | null; out: MessageNode[] };

class Budget {
  nodes = 0;
  chars = 0;
  truncated = false;
}

/** Converts Teams message HTML. Never throws; the result is bounded (see the header). */
export function htmlToNodes(html: string): ConvertedMessage {
  const budget = new Budget();
  const root: MessageNode[] = [];
  const stack: Frame[] = [{ tag: "#root", node: null, out: root }];
  const top = () => stack[stack.length - 1] as Frame;
  const room = () => !budget.truncated && budget.nodes < MAX_NODES;
  const push = (n: MessageNode) => {
    if (!room()) {
      budget.truncated = true;
      return;
    }
    budget.nodes += 1;
    top().out.push(n);
  };
  const addText = (raw: string) => {
    if (budget.truncated) return;
    let s = cleanText(decodeEntities(raw));
    if (s === "") return;
    const left = MAX_TEXT_CHARS - budget.chars;
    if (s.length > left) {
      s = cutUnits(s, left);
      budget.truncated = true;
    }
    budget.chars += s.length;
    if (s !== "") push({ t: "text", v: s });
  };
  const openNode = (tag: string, node: MessageNode & { c: MessageNode[] }) => {
    if (!room()) {
      budget.truncated = true;
      return;
    }
    if (stack.length >= MAX_DEPTH) {
      // too deep: the element is transparent (its content goes into the current level), and its close is matched to nothing
      stack.push({ tag, node: null, out: top().out });
      return;
    }
    budget.nodes += 1;
    top().out.push(node);
    stack.push({ tag, node, out: node.c });
  };
  const closeTo = (tag: string) => {
    for (let k = stack.length - 1; k > 0; k -= 1) {
      if ((stack[k] as Frame).tag === tag) {
        stack.length = k;
        return;
      }
    }
  };
  const inside = (tag: string) => stack.some((f) => f.tag === tag);
  const lineBreak = () => {
    const out = top().out;
    const last = out[out.length - 1];
    if (out.length > 0 && last?.t !== "br") push({ t: "br" });
  };

  let mention: { text: string } | null = null;

  for (const tok of tokens(html)) {
    if (budget.truncated) break;
    if (tok.k === "text") {
      if (mention) mention.text += cleanText(decodeEntities(tok.v));
      else addText(tok.v);
      continue;
    }
    const name = tok.name;
    if (tok.k === "close") {
      if (name === "at" && mention) {
        const text = mention.text.replace(/\s+/g, " ").trim();
        mention = null;
        if (text !== "") {
          const v = cutUnits(text.startsWith("@") ? text : `@${text}`, 200);
          budget.chars += v.length;
          push({ t: "mention", v });
        }
        continue;
      }
      if (name === "emoji") continue;
      if (DROP.has(name)) continue;
      if (BLOCK.has(name) || name === "li" || name === "blockquote" || name === "pre" || name === "ul" || name === "ol" || name === "td" || name === "th") {
        if (name === "td" || name === "th") {
          addText(" ");
          continue;
        }
        closeTo(name);
        if (name === "tr" || name === "table") lineBreak();
        continue;
      }
      closeTo(name);
      continue;
    }
    // an opening tag
    if (DROP.has(name)) continue; // its content was skipped by the tokenizer
    if (mention) continue; // markup inside a mention is ignored, only its text counts
    switch (name) {
      case "br":
      case "hr":
      case "wbr":
        if (name !== "wbr") push({ t: "br" });
        break;
      case "at":
        mention = { text: "" };
        break;
      case "emoji": {
        const alt = cleanText(decodeEntities(tok.attrs.get("alt") ?? "")).trim();
        if (alt !== "") {
          const v = cutUnits(alt, 16);
          budget.chars += v.length;
          push({ t: "emoji", v });
        }
        break;
      }
      case "img": {
        const alt = cleanText(decodeEntities(tok.attrs.get("alt") ?? "")).trim();
        const itemtype = (tok.attrs.get("itemtype") ?? "").toLowerCase();
        const src = safeHttpsUrl(decodeEntities(tok.attrs.get("src") ?? ""));
        if (itemtype.includes("emoji") && alt !== "" && alt.length <= 16) push({ t: "emoji", v: alt });
        // Only a picture in Microsoft's own hosted content becomes a placeholder. Any other image (a tracker, a remote picture) is dropped: it is never loaded and leaves no trace.
        else if (src && /(^|\.)graph\.microsoft\.com$/i.test(src.host) && /\/hostedcontents\//i.test(src.href)) push({ t: "image" });
        break;
      }
      case "a": {
        if (inside("a")) break; // a link inside a link: the inner one is only its text
        const link = safeHttpsUrl(decodeEntities(tok.attrs.get("href") ?? ""));
        if (link) openNode("a", { t: "link", href: link.href, host: link.host, c: [] });
        else stack.push({ tag: "a", node: null, out: top().out });
        break;
      }
      case "p":
      case "div":
        openNode(name, { t: "p", c: [] });
        break;
      case "blockquote":
        openNode(name, { t: "quote", c: [] });
        break;
      case "pre":
        openNode(name, { t: "codeblock", c: [] });
        break;
      case "ul":
      case "ol":
        openNode(name, { t: name, c: [] });
        break;
      case "li":
        if (top().tag === "li") closeTo("li");
        openNode("li", { t: "li", c: [] });
        break;
      case "td":
      case "th":
        if (top().out.length > 0) addText(" ");
        break;
      case "attachment":
        break; // Teams' marker for an attachment shown from the attachments list: nothing to draw here
      default:
        if (HEADING.has(name)) {
          // a heading is a paragraph holding bold text (two frames, both closed by the heading's own close tag)
          const before = stack.length;
          openNode(name, { t: "p", c: [] });
          if (stack.length > before && top().node) openNode(`${name}#b`, { t: "b", c: [] });
        } else if (KIND[name]) {
          openNode(name, { t: KIND[name] as "b", c: [] });
        } else if (BLOCK.has(name)) {
          openNode(name, { t: "p", c: [] });
        } else {
          // an unknown or purely presentational tag (span, font, ...): its content stays, its attributes are never read
          if (!tok.selfClosing && !VOID.has(name)) stack.push({ tag: name, node: null, out: top().out });
        }
    }
  }
  return { nodes: tidy(root), truncated: budget.truncated };
}

/** Cuts at `max` UTF-16 units without leaving half of a surrogate pair. */
export function cutUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Drops empty containers and leading or trailing breaks; merges nothing else. Pure, linear. */
function tidy(nodes: MessageNode[]): MessageNode[] {
  const out: MessageNode[] = [];
  for (const n of nodes) {
    if ("c" in n) {
      const c = tidy(n.c);
      if (c.length === 0 && n.t !== "link") continue;
      out.push({ ...n, c } as MessageNode);
    } else out.push(n);
  }
  while (out[0]?.t === "br") out.shift();
  while (out[out.length - 1]?.t === "br") out.pop();
  return out;
}

/** A plain-text body (contentType `text`): lines become breaks. Same character cleaning and the same bound. */
export function textToNodes(text: string): ConvertedMessage {
  const lines = text.split(/\r\n|\r|\n/);
  const nodes: MessageNode[] = [];
  let chars = 0;
  let truncated = false;
  for (let i = 0; i < lines.length && !truncated; i += 1) {
    let line = cleanText(lines[i] as string);
    if (i > 0) nodes.push({ t: "br" });
    if (chars + line.length > MAX_TEXT_CHARS) {
      line = cutUnits(line, MAX_TEXT_CHARS - chars);
      truncated = true;
    }
    chars += line.length;
    if (line !== "") nodes.push({ t: "text", v: line });
    if (nodes.length >= MAX_NODES) truncated = true;
  }
  return { nodes: tidy(nodes), truncated };
}

/** The body of a Teams message as safe nodes, by its content type (`html` is converted; anything else is plain text). */
export function bodyToNodes(contentType: string | null | undefined, content: string | null | undefined): ConvertedMessage {
  if (typeof content !== "string" || content === "") return { nodes: [], truncated: false };
  // The input itself is bounded before any work (a 50 MB body must not cost 50 MB of tokens): 8x the kept text is more than any real message.
  const bounded = content.length > MAX_TEXT_CHARS * 8 ? content.slice(0, MAX_TEXT_CHARS * 8) : content;
  const r = contentType?.toLowerCase() === "html" ? htmlToNodes(bounded) : textToNodes(bounded);
  return bounded.length < content.length ? { nodes: r.nodes, truncated: true } : r;
}

/** The nodes as plain text (for a one-line preview): no markup, mentions and emoji as their text, an image as "[image]", breaks as spaces. Cut at `max`. */
export function nodesToPlainText(nodes: readonly MessageNode[], max: number): string {
  const parts: string[] = [];
  let len = 0;
  const walk = (list: readonly MessageNode[]) => {
    for (const n of list) {
      if (len > max) return;
      let s = "";
      switch (n.t) {
        case "text":
        case "mention":
        case "emoji":
          s = n.v;
          break;
        case "br":
          s = " ";
          break;
        case "image":
          s = "[image]";
          break;
        default: {
          walk(n.c);
          if (n.t === "p" || n.t === "li" || n.t === "quote" || n.t === "codeblock") parts.push(" ");
          continue;
        }
      }
      parts.push(s);
      len += s.length;
    }
  };
  walk(nodes);
  const text = parts.join("").replace(/\s+/g, " ").trim();
  return cutUnits(text, max);
}
