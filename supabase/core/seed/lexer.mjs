// Single-pass SQL lexer for the seed guard and the generator's section checks. It is not a parser: it only splits
// text into code, string literals, quoted identifiers and comments, the way Postgres does, so nothing can hide a
// literal inside something the guard treats as a comment (or the other way round).
// Token types:
//   code            anything else (keywords, identifiers, operators, numbers, whitespace)
//   string          '...'   ('' escapes a quote; standard_conforming_strings = on)
//   estring         E'...'  (backslash escapes)          — rejected in section output
//   ustring         U&'...' (unicode escapes)            — rejected in section output
//   dollar          $tag$...$tag$                        — rejected in section output
//   ident           "..."   ("" escapes a quote)
//   line-comment    -- up to \n or \r
//   block-comment   /* ... */ (nested, like Postgres)
// `value` is the decoded content for string/ident (raw content for estring/ustring/dollar/comments).
// Throws on an unterminated string, identifier, dollar quote or block comment.

const IDENT_CHAR = /[\p{L}\p{N}_$]/u;
const DOLLAR_TAG = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u;

/** @returns {{type: string, value: string, raw: string}[]} */
export function tokenize(sql) {
  const tokens = [];
  let code = "";
  let i = 0;
  const n = sql.length;

  const flush = () => {
    if (code) tokens.push({ type: "code", value: code, raw: code });
    code = "";
  };
  const push = (type, value, start) => {
    flush();
    tokens.push({ type, value, raw: sql.slice(start, i) });
  };
  const prevIsIdentChar = (pos) => pos > 0 && IDENT_CHAR.test(sql[pos - 1]);

  // Reads a quoted run starting at the opening quote `i`; returns decoded content and moves `i` past the close.
  const readQuoted = (quote, backslashEscapes) => {
    const open = i;
    i += 1;
    let out = "";
    while (i < n) {
      const c = sql[i];
      if (backslashEscapes && c === "\\") {
        out += sql.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) {
        if (sql[i + 1] === quote) {
          out += quote;
          i += 2;
          continue;
        }
        i += 1;
        return out;
      }
      out += c;
      i += 1;
    }
    throw new SyntaxError(`unterminated ${quote === "'" ? "string" : "quoted identifier"} at offset ${open}`);
  };

  while (i < n) {
    const c = sql[i];
    const start = i;

    if (c === "-" && sql[i + 1] === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n" && sql[j] !== "\r") j += 1;
      const value = sql.slice(i + 2, j);
      i = j;
      push("line-comment", value, start);
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      if (depth > 0) throw new SyntaxError(`unterminated block comment at offset ${start}`);
      const value = sql.slice(i + 2, j - 2);
      i = j;
      push("block-comment", value, start);
      continue;
    }

    if ((c === "E" || c === "e") && sql[i + 1] === "'" && !prevIsIdentChar(i)) {
      i += 1;
      const value = readQuoted("'", true);
      push("estring", value, start);
      continue;
    }

    if ((c === "U" || c === "u") && sql[i + 1] === "&" && sql[i + 2] === "'" && !prevIsIdentChar(i)) {
      i += 2;
      const value = readQuoted("'", false);
      push("ustring", value, start);
      continue;
    }

    if (c === "'") {
      const value = readQuoted("'", false);
      push("string", value, start);
      continue;
    }

    if (c === '"') {
      const value = readQuoted('"', false);
      push("ident", value, start);
      continue;
    }

    if (c === "$" && !prevIsIdentChar(i)) {
      const m = DOLLAR_TAG.exec(sql.slice(i, i + 256));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close < 0) throw new SyntaxError(`unterminated dollar quote ${tag} at offset ${start}`);
        const value = sql.slice(i + tag.length, close);
        i = close + tag.length;
        push("dollar", value, start);
        continue;
      }
    }

    code += c;
    i += 1;
  }
  flush();
  return tokens;
}

export const LITERAL_TYPES = new Set(["string", "estring", "ustring", "dollar"]);
export const COMMENT_TYPES = new Set(["line-comment", "block-comment"]);
