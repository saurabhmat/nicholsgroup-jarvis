// Teams message HTML -> safe nodes (T-281, spec 8.4, rule 9): the hostile corpus. The output is data, never HTML; this test walks every node and asserts only the allow-list can appear.
import { describe, expect, it } from "vitest";
import { bodyToNodes, cleanText, htmlToNodes, MAX_DEPTH, MAX_INPUT_CHARS, MAX_NODES, MAX_TEXT_CHARS, nodesToPlainText, safeHttpsUrl, textToNodes, type MessageNode } from "./message-html";

const KINDS = new Set(["text", "br", "mention", "emoji", "image", "link", "b", "i", "u", "s", "code", "p", "quote", "codeblock", "ul", "ol", "li"]);
function walk(nodes: readonly MessageNode[], visit: (n: MessageNode, depth: number) => void, depth = 0): void {
  for (const n of nodes) {
    visit(n, depth);
    if ("c" in n) walk(n.c, visit, depth + 1);
  }
}
function allText(nodes: readonly MessageNode[]): string {
  let s = "";
  walk(nodes, (n) => {
    if (n.t === "text" || n.t === "mention" || n.t === "emoji") s += n.v;
  });
  return s;
}
/** Every node is one of the allowed kinds, carries only its own keys, and the only address anywhere is an https link. */
function assertSafe(nodes: readonly MessageNode[]): void {
  walk(nodes, (n) => {
    expect(KINDS.has(n.t)).toBe(true);
    const keys = Object.keys(n).sort().join(",");
    if (n.t === "text" || n.t === "mention" || n.t === "emoji") expect(keys).toBe("t,v");
    else if (n.t === "br") expect(keys).toBe("t");
    else if (n.t === "image") {
      // T-285: the only extra key is a hosted-content ID (validated string, never an address)
      expect(["t", "hosted,t"]).toContain(keys);
      if (n.hosted !== undefined) expect(n.hosted).toMatch(/^[A-Za-z0-9._:=@-]{1,256}$/);
    }
    else if (n.t === "link") {
      expect(keys).toBe("c,host,href,t");
      expect(n.href.startsWith("https://")).toBe(true);
      expect(new URL(n.href).username).toBe("");
    } else expect(keys).toBe("c,t");
  });
}

describe("what survives", () => {
  it("formatting, lists, quotes, code and links become typed nodes", () => {
    const r = htmlToNodes('<p>Hello <b>bold</b> <i>it</i> <u>un</u> <s>st</s> <code>c</code></p><blockquote>quoted</blockquote><ul><li>one</li><li>two</li></ul><ol><li>a</li></ol><pre>x = 1</pre><a href="https://docs.example.test/a?b=1">the doc</a>');
    assertSafe(r.nodes);
    const kinds: string[] = [];
    walk(r.nodes, (n) => kinds.push(n.t));
    for (const k of ["p", "b", "i", "u", "s", "code", "quote", "ul", "ol", "li", "codeblock", "link"]) expect(kinds).toContain(k);
    let link: MessageNode | undefined;
    walk(r.nodes, (n) => n.t === "link" && (link = n));
    expect(link).toMatchObject({ t: "link", href: "https://docs.example.test/a?b=1", host: "docs.example.test" });
    expect(r.truncated).toBe(false);
  });

  it("a mention is '@Name' text and never a link or a lookup; a mention that looks like markup stays text", () => {
    const r = htmlToNodes('<p>hi <at id="0">Pat Example</at> and <at id="1">&lt;script&gt;alert(1)&lt;/script&gt;</at> <at id="2"><a href="https://evil.example.test">@Chris</a></at></p>');
    assertSafe(r.nodes);
    const mentions: string[] = [];
    walk(r.nodes, (n) => n.t === "mention" && mentions.push(n.v));
    expect(mentions).toEqual(["@Pat Example", "@<script>alert(1)</script>", "@Chris"]);
    let links = 0;
    walk(r.nodes, (n) => n.t === "link" && (links += 1));
    expect(links).toBe(0);
  });

  it("emoji: an <emoji> tag and an emoji <img> become their alt text; an alt that is long or a URL is not an emoji", () => {
    const r = htmlToNodes('<emoji id="smile" alt="😀" title="Smile"></emoji> <img itemtype="http://schema.skype.com/Emoji" alt="👍" src="https://tracker.example.test/e.png"> <img itemtype="http://schema.skype.com/Emoji" alt="this is not an emoji at all">');
    assertSafe(r.nodes);
    expect(allText(r.nodes).replace(/\s+/g, "")).toBe("😀👍");
  });

  it("images: every picture is a neutral placeholder (an image-only message is not empty), a tracking pixel is nothing, and no address is kept anywhere", () => {
    const r = htmlToNodes('<img src="https://graph.microsoft.com/v1.0/chats/19:x@thread.v2/messages/1/hostedContents/aGVsbG8/$value"><img src="https://tracker.example.test/pixel.gif" width="1" height="1"><img src="http://graph.microsoft.com/x/hostedContents/1"><img src="data:image/png;base64,AAAA"><img src="https://evil.example.test/?u=graph.microsoft.com/hostedContents/">');
    assertSafe(r.nodes);
    expect(r.nodes).toEqual([{ t: "image" }, { t: "image" }, { t: "image" }, { t: "image" }]); // hosted, http hosted, data:, look-alike; the 1x1 tracker is nothing
    expect(JSON.stringify(r.nodes)).not.toMatch(/tracker|evil|data:/);
  });

  it("images of the SAME message carry a hosted-content id only (T-285): another message, host, scheme, query, port, user name or path shape leaves a plain placeholder, and no address is kept", () => {
    const CHAT = "19:x@thread.v2";
    const ctx = { scope: { kind: "chat" as const, chatId: CHAT }, messageId: "1700000000000" };
    const base = `https://graph.microsoft.com/v1.0/chats/${CHAT}/messages/1700000000000/hostedContents`;
    const img = (src: string) => `<img src="${src}">`;
    const html = [
      img(`${base}/aGVsbG8=/$value`), // ok
      img(`https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(CHAT)}/messages/1700000000000/hostedContents/b2s/$value`), // encoded chat id: same chat
      img(`https://graph.microsoft.com/v1.0/chats/${CHAT}/messages/999/hostedContents/x/$value`), // another message
      img(`https://graph.microsoft.com/v1.0/chats/19:other@thread.v2/messages/1700000000000/hostedContents/x/$value`), // another chat
      img(`http://graph.microsoft.com/v1.0/chats/${CHAT}/messages/1700000000000/hostedContents/x/$value`), // http
      img(`https://graph.microsoft.com.evil.example.test/v1.0/chats/${CHAT}/messages/1700000000000/hostedContents/x/$value`),
      img(`https://evil.example.test/v1.0/chats/${CHAT}/messages/1700000000000/hostedContents/x/$value`),
      img(`https://user:pw@graph.microsoft.com/v1.0/chats/${CHAT}/messages/1700000000000/hostedContents/x/$value`),
      img(`https://graph.microsoft.com:444/v1.0/chats/${CHAT}/messages/1700000000000/hostedContents/x/$value`),
      img(`${base}/x/$value?redirect=https://evil.example.test`),
      img(`${base}/x/$value#frag`),
      img(`https://graph.microsoft.com/beta/chats/${CHAT}/messages/1700000000000/hostedContents/x/$value`),
      img(`${base}/../../x/$value`),
      img(`${base}/%2e%2e/$value`),
      img(`${base}/a%2Fb/$value`),
      img(`${base}/x/%24value`.replace("%24value", "content")),
      img(`${base}/${"a".repeat(300)}/$value`),
    ].join("");
    const r = htmlToNodes(html, ctx);
    assertSafe(r.nodes);
    expect(r.nodes.map((n) => (n.t === "image" ? (n.hosted ?? null) : "?"))).toEqual(["aGVsbG8=", "b2s", ...Array.from({ length: 15 }, () => null)]);
    expect(JSON.stringify(r.nodes)).not.toMatch(/graph\.microsoft|evil|https?:/);
    // without a message to compare with, nothing carries an id (the chat list's previews, a message with no known id)
    expect(htmlToNodes(img(`${base}/aGVsbG8=/$value`)).nodes).toEqual([{ t: "image" }]);
  });

  it("images in a channel post: the team, channel and post must all match", () => {
    const T = "11111111-1111-4111-8111-111111111111";
    const C = "19:chan1@thread.tacv2";
    const ctx = { scope: { kind: "channel" as const, teamId: T, channelId: C }, messageId: "1700000000001" };
    const url = (t: string, c: string, m: string) => `<img src="https://graph.microsoft.com/v1.0/teams/${t}/channels/${c}/messages/${m}/hostedContents/aWQ9/$value">`;
    const r = bodyToNodes("html", [url(T, C, "1700000000001"), url(T.toUpperCase(), C, "1700000000001"), url("33333333-3333-4333-8333-333333333333", C, "1700000000001"), url(T, "19:chan2@thread.tacv2", "1700000000001"), url(T, C, "1700000000002")].join(""), ctx);
    expect(r.nodes.map((n) => (n.t === "image" ? (n.hosted ?? null) : "?"))).toEqual(["aWQ9", "aWQ9", null, null, null]);
    // a chat address in a channel post, and the reverse, are not accepted
    const chat = bodyToNodes("html", `<img src="https://graph.microsoft.com/v1.0/chats/${C}/messages/1700000000001/hostedContents/aWQ9/$value">`, ctx);
    expect(chat.nodes).toEqual([{ t: "image" }]);
  });

  it("a table is flattened to text, cells separated, rows on their own line", () => {
    const r = htmlToNodes("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>");
    assertSafe(r.nodes);
    expect(nodesToPlainText(r.nodes, 100)).toBe("a b c d");
    let breaks = 0;
    walk(r.nodes, (n) => n.t === "br" && (breaks += 1));
    expect(breaks).toBeGreaterThan(0);
  });

  it("a heading is bold text in a paragraph; a span, font and unknown tags keep their text and nothing else", () => {
    const r = htmlToNodes('<h2>Title</h2><span style="color:red" onclick="x()">plain</span><font color=red>f</font><weird-tag data-x=1>w</weird-tag>');
    assertSafe(r.nodes);
    expect(allText(r.nodes)).toBe("Titleplainfw");
    const first = r.nodes[0] as { t: string; c: { t: string }[] };
    expect(first.t).toBe("p");
    expect(first.c[0]?.t).toBe("b");
  });

  it("entities decode once and never twice; invalid numeric references become the replacement character", () => {
    const r = htmlToNodes("a &amp;lt; b &lt;i&gt; &#x41;&#66; &#0; &#xD800; &#1114112; &unknown; &nbsp;x");
    expect(allText(r.nodes)).toBe("a &lt; b <i> AB � � � &unknown;  x");
  });
});

describe("hostile input", () => {
  const CORPUS: [string, string][] = [
    ["script", "<script>alert(document.cookie)</script>after"],
    ["script with uppercase close and attributes", "<SCRIPT src=x>evil()</SCRIPT >after"],
    ["unclosed script drops the rest", "before<script>evil() and everything after"],
    ["style", "<style>body{display:none}</style>after"],
    ["iframe, object, embed, form, svg, math", '<iframe src="https://evil.example.test"></iframe><object data=x></object><embed src=x><form action=https://evil.example.test><input name=p></form><svg onload=alert(1)><script>x</script></svg><math><mi>x</mi></math>after'],
    ["event handlers", '<p onclick="alert(1)" onmouseover=alert(2)>after</p><b onfocus=x>b</b>'],
    ["javascript link", '<a href="javascript:alert(1)">after</a>'],
    ["javascript link, entity encoded", '<a href="&#106;avascript:alert(1)">after</a>'],
    ["javascript link, tab and newline inside", '<a href="java\nscript:alert(1)">after</a>'],
    ["javascript link, leading control characters", '<a href="\u0001javascript:alert(1)">after</a>'],
    ["data link", '<a href="data:text/html,<script>alert(1)</script>">after</a>'],
    ["vbscript, file, ftp, blob, mailto, tel", '<a href="vbscript:x">after</a><a href="file:///etc/passwd">a</a><a href="ftp://x.example.test">a</a><a href="blob:https://x.example.test/1">a</a><a href="mailto:a@example.test">a</a><a href="tel:+15551234">a</a>'],
    ["http link (not https)", '<a href="http://example.test/">after</a>'],
    ["protocol-relative and relative links", '<a href="//evil.example.test/x">after</a><a href="/path">a</a><a href="x.html">a</a>'],
    ["credentials in a link", '<a href="https://user:pass@example.test/">after</a><a href="https://user@example.test/">a</a>'],
    ["comment tricks", "<!-- <script>alert(1)</script> -->after<!--unclosed"],
    ["cdata and doctype and pi", "<![CDATA[<script>x</script>]]><!DOCTYPE html><?php echo 1 ?>after"],
    ["nested mismatched tags", "<b><i><u>after</b></i></u><p><div></p></div><li><li>x"],
    ["tag split by attribute with > inside quotes", '<a title=">" href="javascript:alert(1)">after</a><img alt=">" src=x>'],
    ["null bytes and control characters", "<scr\u0000ipt>alert(1)</scr\u0000ipt>after"],
    ["meta refresh, base, link", '<meta http-equiv="refresh" content="0;url=https://evil.example.test"><base href="https://evil.example.test/"><link rel=stylesheet href=https://evil.example.test/x.css>after'],
    ["button and textarea with markup in them", "<button onclick=x()>click</button><textarea><script>x</script></textarea>after"],
    ["srcdoc and style attributes", '<p style="background:url(https://evil.example.test/x)" srcdoc="<script>x</script>">after</p>'],
  ];

  it.each(CORPUS)("%s: only the allow-list can appear, no script, no handler, no unsafe address", (_name, html) => {
    const r = htmlToNodes(html);
    assertSafe(r.nodes);
    const json = JSON.stringify(r.nodes);
    expect(json).not.toMatch(/javascript:|vbscript:|data:|file:|onclick|onerror|onload|evil\.example\.test\/x\.css|<script|alert\(document/i);
    walk(r.nodes, (n) => {
      if (n.t === "link") expect(n.href.startsWith("https://")).toBe(true);
    });
  });

  it("dropped elements take their content with them; the text around them stays", () => {
    expect(allText(htmlToNodes("<script>alert(document.cookie)</script>after").nodes)).toBe("after");
    expect(allText(htmlToNodes("before<style>x{}</style>after").nodes)).toBe("beforeafter");
    expect(allText(htmlToNodes("before<script>evil() and everything after").nodes)).toBe("before");
    expect(allText(htmlToNodes("<!-- <script>alert(1)</script> -->after").nodes)).toBe("after");
  });

  it("a link that is not https keeps only its text; the https one is normalised by the URL parser", () => {
    expect(htmlToNodes('<a href="javascript:alert(1)">after</a>').nodes).toEqual([{ t: "text", v: "after" }]);
    expect(htmlToNodes('<a href="http://example.test/">after</a>').nodes).toEqual([{ t: "text", v: "after" }]);
    const r = htmlToNodes(String.raw`<a href="HTTPS://Example.TEST:443/a b">x</a><a href="https://example.test\p">y</a><a href="https:\\example.test\p">z</a>`);
    const links = r.nodes.filter((n) => n.t === "link") as { href: string }[];
    // a space inside the written address is refused outright; a backslash after `https://` is normalised by the parser to a slash and the NORMALISED address is what is kept; `https:\\host` is not a written https link at all
    expect(links.map((l) => l.href)).toEqual(["https://example.test/p"]);
  });

  it("safeHttpsUrl: https only, no credentials, bounded, no whitespace or invisible character inside", () => {
    expect(safeHttpsUrl("https://example.test/a")?.href).toBe("https://example.test/a");
    expect(safeHttpsUrl("  https://example.test/a \n")?.href).toBe("https://example.test/a");
    for (const bad of ["", "http://example.test", "javascript:alert(1)", "https://u:p@example.test", "https://", "https://exa mple.test", "https://example.test/‮", "https://example.test/​", `https://example.test/${"a".repeat(2100)}`, "//example.test", "https:example", "ht\ttps://example.test"]) {
      expect(safeHttpsUrl(bad), bad).toBeNull();
    }
    // a look-alike host is shown in its punycode form, so the person sees it is not the Latin name
    expect(safeHttpsUrl("https://exаmple.test/")?.host).toMatch(/^xn--/);
  });

  it("nested links: the inner link is only its text", () => {
    const r = htmlToNodes('<a href="https://a.example.test/">outer <a href="https://b.example.test/">inner</a> end</a>');
    assertSafe(r.nodes);
    const links: string[] = [];
    walk(r.nodes, (n) => n.t === "link" && links.push(n.href));
    expect(links).toEqual(["https://a.example.test/"]);
    expect(allText(r.nodes)).toContain("inner");
  });

  it("deep nesting is bounded: no node is deeper than MAX_DEPTH and the text is all kept", () => {
    const html = `${"<div>".repeat(500)}deep${"</div>".repeat(500)}`;
    const r = htmlToNodes(html);
    assertSafe(r.nodes);
    let max = 0;
    walk(r.nodes, (_n, d) => (max = Math.max(max, d)));
    expect(max).toBeLessThanOrEqual(MAX_DEPTH);
    expect(allText(r.nodes)).toBe("deep");
  });

  it("a huge body is cut at the text limit, reported as truncated, and is cheap", () => {
    const t0 = Date.now();
    const big = htmlToNodes(`<p>${"word ".repeat(200_000)}</p>`);
    expect(big.truncated).toBe(true);
    expect(allText(big.nodes).length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    const viaBody = bodyToNodes("html", `<p>${"x".repeat(5_000_000)}</p>`);
    expect(viaBody.truncated).toBe(true);
    expect(allText(viaBody.nodes).length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("many tiny elements are bounded by the node limit", () => {
    const r = htmlToNodes("<b>x</b>".repeat(50_000));
    let n = 0;
    walk(r.nodes, () => (n += 1));
    expect(n).toBeLessThanOrEqual(MAX_NODES);
    expect(r.truncated).toBe(true);
  });

  it("many dropped elements and unterminated constructs stay linear", () => {
    const t0 = Date.now();
    htmlToNodes("<script>x</script>".repeat(8_000));
    htmlToNodes("<a ".repeat(50_000));
    htmlToNodes("<a href='".repeat(20_000));
    htmlToNodes("<".repeat(100_000));
    htmlToNodes("<script>".repeat(20_000));
    htmlToNodes("<!--".repeat(30_000));
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("text direction tricks are removed: bidirectional overrides, isolates, zero-width spaces, BOM, soft hyphens and control characters", () => {
    const tricks = "a‮b‭c⁦d⁩e‏f​g﻿h­i\u0000j\u0007k⁠l";
    expect(cleanText(tricks)).toBe("abcdefghijkl");
    expect(allText(htmlToNodes(`<p>${tricks}</p>`).nodes)).toBe("abcdefghijkl");
    expect(allText(textToNodes(tricks).nodes)).toBe("abcdefghijkl");
    // joiners stay: emoji sequences and some scripts need them
    expect(cleanText("a\u3164b\u2800c\u115fd\u180ee\uffa0")).toBe("abcde");
    expect(cleanText("👨‍👩‍👧")).toBe("👨‍👩‍👧");
    // right-to-left text itself is kept
    expect(allText(htmlToNodes("<p>שלום עולם</p>").nodes)).toBe("שלום עולם");
  });

  it("a link's text cannot claim another host: the real host is carried with the link for display", () => {
    const r = htmlToNodes('<a href="https://evil.example.test/login">https://bank.example.test</a>');
    const link = r.nodes[0] as { t: string; host: string };
    expect(link.t).toBe("link");
    expect(link.host).toBe("evil.example.test");
  });

  it("never throws, whatever the input", () => {
    const inputs = ["", "<", "<>", "</>", "<a", "<a href", "<a href=", "<a href='", "&", "&#", "<a/b/c>", "<\u0000>", "<!", "<!--", "<?", "\ud800", "<a href=\"https://example.test\" href=\"javascript:1\">x</a>", "<br/><br/>", "<emoji>", "<at>", "</at>", "<at><at>x</at></at>"];
    for (const i of inputs) {
      const r = htmlToNodes(i);
      assertSafe(r.nodes);
    }
    // the first of two equal attributes wins, as in a browser
    expect(htmlToNodes('<a href="https://example.test" href="javascript:1">x</a>').nodes[0]).toMatchObject({ t: "link", href: "https://example.test/" });
  });
});

describe("plain text bodies and previews", () => {
  it("a text body keeps its lines and never reads markup", () => {
    const r = bodyToNodes("text", "line one\nline <b>two</b>\r\n<script>x</script>");
    expect(allText(r.nodes)).toBe("line oneline <b>two</b><script>x</script>");
    expect(r.nodes.filter((n) => n.t === "br")).toHaveLength(2);
  });

  it("an unknown content type is read as text, never as HTML", () => {
    expect(allText(bodyToNodes("weird", "<b>x</b>").nodes)).toBe("<b>x</b>");
    expect(bodyToNodes(null, "<b>x</b>").nodes).toEqual([{ t: "text", v: "<b>x</b>" }]);
  });

  it("an empty or missing body is no nodes", () => {
    expect(bodyToNodes("html", null)).toEqual({ nodes: [], truncated: false });
    expect(bodyToNodes("html", "")).toEqual({ nodes: [], truncated: false });
  });

  it("the preview text is one line without markup, with a placeholder for a picture, cut at the limit without splitting a pair", () => {
    const r = htmlToNodes('<p>Hello <at id="0">Pat</at> <emoji alt="😀"></emoji></p><p>second</p><img src="https://graph.microsoft.com/v1.0/x/hostedContents/1/$value">');
    expect(nodesToPlainText(r.nodes, 160)).toBe("Hello @Pat 😀 second [image]");
    const cut = nodesToPlainText(htmlToNodes("😀".repeat(100)).nodes, 5);
    expect(cut.length).toBeLessThanOrEqual(5);
    expect(cut).not.toMatch(/[\ud800-\udbff]$/);
  });
});

describe("H1: the converter is linear in its input (time bounds are generous but fail on quadratic work)", () => {
  const time = (html: string) => {
    const t0 = performance.now();
    const r = htmlToNodes(html);
    assertSafe(r.nodes);
    return performance.now() - t0;
  };
  const N = 20_000; // about 160 KB
  const cases: [string, string][] = [
    ["many spans open, many links, all closed", "<span>".repeat(N) + "<a></a>".repeat(N) + "</span>".repeat(N)],
    ["bold opened, italic closed (unmatched)", "<b>".repeat(26_000) + "</i>".repeat(20_000)],
    ["mixed unmatched closes", "<span>".repeat(N) + "</b></i></u></p></div>".repeat(8_000)],
    ["deep nesting of allowed tags", "<div><b><i><u><s>".repeat(N / 5) + "x" + "</s></u></i></b></div>".repeat(N / 5)],
    ["many links inside deep unknown tags", "<x-a>".repeat(5_000) + '<a href="https://a.example.test/">x</a>'.repeat(3_000)],
    ["links never closed", '<a href="https://a.example.test/">'.repeat(4_000) + "</span>".repeat(20_000)],
    ["lists and items", "<ul><li>".repeat(N / 2) + "</ul>".repeat(N / 2)],
  ];
  // The test machine has one busy core: the best of three runs, against a bound ~10x what a linear pass needs; the quadratic version took 1.2 - 2.9 s on the same inputs.
  it.each(cases)("%s: 100+ KB, best of three, under 400 ms", (_n, html) => {
    expect(html.length).toBeGreaterThan(100_000);
    const best = Math.min(time(html), time(html), time(html));
    expect(best).toBeLessThan(400);
  });
  it("the open-element stack is capped, and an input over the post limit is cut and reported", () => {
    const r = htmlToNodes("<span>".repeat(5_000) + "x");
    expect(allText(r.nodes)).toBe("x");
    const big = htmlToNodes(`<p>a</p>${"<br>".repeat(5)}${"x".repeat(MAX_INPUT_CHARS)}`);
    expect(big.truncated).toBe(true);
  });
});
