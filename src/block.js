// SPDX-License-Identifier: MIT
// The block parser: parseBlocks(ctx) -> root, positioned from 0 to the end
// of the source. One pass over the lines (see line()), with a stack of open
// frames (quotes, list items, footnote definitions, `:::` containers, cells)
// and at most one open leaf.
//
// AST conventions beyond mdast, for the emitter and transforms (every
// data.tern field is listed in docs/api.html#data-tern):
//   - an attribute line is merged into its block's `attributes` and the
//     block's position starts at it; one that binds to nothing is an
//     `attributes` node whose `value` is its lines, rendered as text;
//   - an author id has `data.tern.idPosition`, its `#id` or `id=value` item;
//   - reserved keys (`raw`, `cols`, `tag`, `lines` …) stay in `attributes`;
//     `code.meta` is a fence's info junk (`data-meta`), else null;
//   - a container has `data.tern.colons`; opener junk is a paragraph with
//     `data.tern.junk` holding one text node, after the label; a container
//     with a verbatim body (`:::meta`, `{raw}`, `:::script` …) has it as
//     `value`;
//   - `root.data.tern.meta` exists when a top-level `:::meta` does;
//   - an unclosed `$$` has `data.tern.unclosed` and `data.tern.source`;
//   - a row holds the cells it has (missing ones are not in the tree, so the
//     column count is `align.length`); a continuation is a `break` in a cell.
'use strict';

const { createSpan, spanAdd } = require('./ast');
const { IDENT, NAME, LABEL, matchAt, isAsciiPunct, parseAttrs, reportReserved, isReservedName, isCustomName, put } = require('./scan');
const { parseInline, atomRanges } = require('./inline');

// Tags that start a raw HTML block, as custom elements do. A raw-text tag's
// block ends at its end tag; a one-line tag (void, or with an end tag HTML
// lets you omit) is a block of one line; any other is generic, ending where
// its openings and closings balance.
const BLOCK_TAGS = new Set(
  ('address article aside audio blockquote canvas details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 ' +
    'header hgroup hr iframe link math menu nav noscript object ol picture search section summary svg table template ul video ' +
    'script style pre textarea p li dd dt tr td th thead tbody tfoot').split(' '),
);
const RAW_TEXT = new Set(['script', 'style', 'pre', 'textarea']);
// A raw-text block's end tag: `</NAME`, optional spaces or tabs, `>`, any case, as a generic closing is.
const RAW_END = {};
for (const n of RAW_TEXT) RAW_END[n] = new RegExp(`</${n}[ \\t]*>`, 'i');
const ONE_LINE = new Set('hr link p li dd dt tr td th thead tbody tfoot'.split(' '));
const isCustom = isCustomName; // HTML's valid custom-element name
const TAG = /[A-Za-z][-.\w\u00b7-\uffff]*/y;
const LANG = /[^\s[\]{}`]+/y;
const DELIM = /\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?/y;
const VALUE = /[^\s"'=<>`{}]*/y;
const META = /^([A-Za-z][-\w.:]*?): (.*)$/; // a `:::meta` line; the separator is the first `: `
// Containers whose body is verbatim, kept as `value`: the core `:::macros`
// and `:::meta`, and the reserved `:::script`, `:::style`, `:::html`, whose
// body is shown as text.
const RAW_BODY = new Set(['macros', 'meta', 'script', 'style', 'html']);
const RESERVED_HINT = { script: 'write `<script>` … `</script>`', style: 'write `<style>` … `</style>`', html: 'use a ```=html fence' };
const isPrefix = (k) => k === 'quote' || k === 'item' || k === 'fn'; // the frames with a line prefix
// parseInline's options, shared, as inline.js only reads them: IO[context][footnote ? 1 : 0]
const IO = {};
for (const c of ['paragraph', 'heading', 'title', 'leaf', 'cell']) IO[c] = [false, true].map((footnote) => Object.freeze({ context: c, footnote }));
// The paragraph row. OWN starts a paragraph of its own: a closer or `+++`
// line that falls back to text still interrupts the open paragraph.
const PARA = Object.freeze({ k: 'para' });
const OWN = Object.freeze({ k: 'para', own: true });
const GROUP = 'write `{#id .class key=value}`';

const isSp = (c) => c === ' ' || c === '\t';
const metaLine = (s) => {
  const m = META.exec(s);
  return m && !m[1].endsWith(':') ? m : null;
};

// The parse in progress. Parses never nest, so its state lives here and the
// functions below are made once; made per parse, as closures, they would lose
// their optimised code from one parse to the next.
let ctx = null, src = '', N = 0, MAX = 64, root = null, stack = null; // N: src.length; MAX: the nesting limit; stack[0]: the root's frame
let leaf = null; // the open leaf, a child of the top frame
let depth = 0; // open quotes, items, footnotes and containers, against MAX; cells and lists do not count
// The line [ls, le); the cursor's offset and column, and the columns of a
// tab at pos not yet consumed. A tab advances to the next multiple of 4;
// columns matter only for list items, footnotes and dedenting fence and
// math content.
let ls = 0, le = 0, pos = 0, col = 0, partial = 0, lineNo = 0;
let prevBlank = false;
let unclosedWhat = null; // a verbatim leaf that just ran out unclosed, named in the hint of the block.unclosed that follows
let meta = null, head = null, front = null; // `:::meta`'s keys; what the preserved head sets; a `---` that may open front matter
const cuts = [], cells = [], one = [0, 0, 0]; // a table row's cells, as text ranges and as nodes; a one-line row
let rl = null, rq = 0, rf = 0; // off()'s forward cursor in the row being cut

const top = () => stack[stack.length - 1];
const lineOf = (o) => ctx.point(o).line;
const same = (i) => i; // index to offset, where the text is src itself
const report = (code, a, b, message, hint) => ctx.report(code, a, b, message, hint);
const tern = (node) => (node.data = node.data || {}).tern || (node.data.tern = {});
const skipSp = (i, e) => {
  while (i < e && isSp(src[i])) i++;
  return i;
};
const trimEnd = (a, e) => {
  while (e > a && isSp(src[e - 1])) e--;
  return e;
};
const atoms = (a, b) => atomRanges(src.slice(a, b)).map((x) => x + a); // the inline parser's atoms in [a, b), as offsets
// A span (ast.js) of one piece of the source, with an exact-size segment list (an array grown by push from empty reserves ~17 slots)
const lineSpan = (a, b) => ({ text: src.slice(a, b), segs: b > a ? [0, a] : [], empty: a });
const inline = (a, b, context) => parseInline(ctx, lineSpan(a, b), IO[context][+(top().fn > 0)]);

// ------------------------------------------------------------ the cursor

// The whitespace run at the cursor, [runAt, runEnd), and the column where it
// ends; cached, since nested list items measure the same run.
let runAt = -1, runEnd = 0, runCol = 0;
function run() {
  if (runAt >= 0 && runAt <= pos && pos <= runEnd) return;
  let c = col + partial, i = partial ? pos + 1 : pos;
  for (; i < le && isSp(src[i]); i++) c = src[i] === ' ' ? c + 1 : c + 4 - (c % 4);
  runAt = pos;
  runEnd = i;
  runCol = c;
}
const indentAt = () => (run(), runCol - col);
const firstNB = () => (run(), runEnd);

// Consumes up to n columns of indentation; a tab partly consumed leaves its other columns pending in `partial`.
function advance(n) {
  while (n > 0 && (partial || isSp(src[pos]))) {
    const w = partial || (src[pos] === '\t' ? 4 - (col % 4) : 1); // the columns left in this character
    const k = Math.min(n, w);
    col += k;
    n -= k;
    partial = w - k;
    if (!partial) pos++;
  }
}

function moveTo(i) {
  if (partial && i > pos) col += partial, (partial = 0), pos++;
  for (; pos < i; pos++) col = src[pos] === '\t' ? col + 4 - (col % 4) : col + 1;
}

// The remainder as written; a partly consumed tab becomes spaces.
const rest = () => (partial ? ' '.repeat(partial) + src.slice(pos + 1, le) : src.slice(pos, le));

// Matches and consumes frame f's prefix: a quote's `>` (after any indent)
// and one space or tab; a list item's indent to its content column; a
// footnote's 2 columns. A blank line matches an item or a footnote.
// Containers and cells have no prefix.
function matchPrefix(f) {
  if (f.kind === 'quote') {
    const i = firstNB();
    if (src[i] !== '>') return false;
    return moveTo(i + 1 + isSp(src[i + 1])), true; // a tab after `>` is consumed whole, unlike CommonMark
  }
  if (f.kind !== 'item' && f.kind !== 'fn') return true;
  const need = f.kind === 'fn' ? 2 : f.indent;
  const w = indentAt();
  if (firstNB() < le) return w >= need && (advance(need), true);
  return !!f.node.children.length && (advance(Math.min(w, need)), true); // an item still empty takes no blank line: it begins with at most one
}

// ------------------------------------------------------------ the tree

function addChild(node) {
  const f = top();
  const kids = f.node.children;
  if (f.kind === 'item' && prevBlank && kids.length) loose(f.list);
  if (kids.length) kids.push(node);
  else f.node.children = [node]; // exact-size, as lineSpan
}

// A blank line between items, or between blocks directly in an item, makes
// the list loose: its items' paragraphs get <p>.
function loose(li) {
  if (li.node.spread) return;
  li.node.spread = true;
  for (const it of li.node.children) it.spread = true;
}

function push(f) {
  f.fn = top().fn + (f.kind === 'fn' ? 1 : 0);
  if (f.kind !== 'cell') depth++;
  stack.push(f);
}

// A node's attributes: an attribute line's, then its own group, which wins
// for the id and the other keys; classes accumulate. Records under data.tern
// where the id is written (idPosition) and where reserved keys that may not
// apply are (tagPosition, refPosition, rawPosition, colsPosition), for the
// transforms' diagnostics. Returns them with where each key was written.
function attach(node, pa, res) {
  const groups = pa ? pa.groups.concat(res || []) : res ? [res] : [];
  if (!groups.length) return null;
  let id, idAt = -1, classAt = -1;
  const cls = [], other = Object.create(null), keyAt = Object.create(null); // no prototype: `__proto__` is a key
  for (const g of groups) {
    reportReserved(ctx, g, same);
    if (g.attrs.id !== undefined) (id = g.attrs.id), (idAt = g.idAt);
    if (g.attrs.class && classAt < 0) classAt = g.classAt;
    if (g.attrs.class) cls.push(g.attrs.class);
    for (const k in g.attrs) if (k !== 'id' && k !== 'class') (other[k] = g.attrs[k]), (keyAt[k] = g.keyAt[k]);
  }
  const attrs = {};
  if (id !== undefined) attrs.id = id;
  if (cls.length) attrs.class = cls.join(' ');
  for (const k in other) put(attrs, k, other[k]);
  if (Object.keys(attrs).length) node.attributes = attrs;
  if (idAt >= 0) {
    const q = src[idAt + 3];
    const e = src[idAt] === '#' ? matchAt(IDENT, src, idAt + 1) : q === '"' || q === "'" ? src.indexOf(q, idAt + 4) + 1 : matchAt(VALUE, src, idAt + 3);
    tern(node).idPosition = ctx.position(idAt, Math.max(e, idAt + 1));
  }
  if (keyAt.tag !== undefined) tern(node).tagPosition = ctx.position(keyAt.tag, keyAt.tag + 3); // for tag.not-allowed
  // Reserved keys where they may not apply, for attr.malformed: `ref` off
  // references, `raw` off containers, `cols` off containers and leaves (and
  // on raw-body containers).
  if (keyAt.ref !== undefined) tern(node).refPosition = ctx.position(keyAt.ref, keyAt.ref + 3);
  if (keyAt.raw !== undefined && node.type !== 'containerDirective') tern(node).rawPosition = ctx.position(keyAt.raw, keyAt.raw + 3);
  if (keyAt.cols !== undefined && node.type !== 'leafDirective' && (node.type !== 'containerDirective' || RAW_BODY.has(node.name))) tern(node).colsPosition = ctx.position(keyAt.cols, keyAt.cols + 4);
  return { attrs, keyAt, classAt };
}

// A block starts: the open leaf closes, and an attribute line before it is returned.
function begin() {
  const pa = leaf && leaf.kind === 'attrs' ? leaf : null;
  if (pa) leaf = null;
  else closeLeaf(-1);
  return pa;
}

// An attribute line that binds to nothing stays visible as text.
function orphan(pa, raw) {
  const value = [];
  for (let k = 0; k < pa.parts.length; k += 2) value.push(src.slice(pa.parts[k], pa.parts[k + 1]));
  addChild({ type: 'attributes', value: value.join('\n'), position: ctx.position(pa.start, pa.end) });
  if (raw) report('attributes.raw', pa.at, pa.parts[1], 'attributes do not apply to raw HTML; this line is shown as text', 'put them in the tag');
  else report('attributes.orphan', pa.at, pa.parts[1], 'no block follows this attribute line; it is shown as text', 'put it right above its block');
}

// ------------------------------------------------------------ lines

// One line, [ls, le):
//   1. the frames' prefixes are matched, outermost first; what is left is
//      the remainder;
//   2. an open verbatim leaf (fence, raw HTML, display math, raw-body
//      container) takes the remainder when every prefix matched, and closes
//      unclosed when one failed, so `:::` inside a fence is never structure;
//   3. when a prefix failed after a paragraph line, a remainder that would
//      be a paragraph line continues that paragraph (lazy continuation); the
//      limits on interrupting a paragraph do not apply here, so `1. one` ⏎
//      `2. two` is two items;
//   4. otherwise the frames whose prefix failed close, and the remainder is
//      classified into a row (classify) and acted on (blocks).
// What is still open closes at the end of the note, each with its
// diagnostic. The rows are listed in docs/syntax-blocks.html#rows.
function line() {
  unclosedWhat = null;
  let m = 1;
  while (m < stack.length && matchPrefix(stack[m])) m++;
  const all = m === stack.length;
  const end = trimEnd(ls, le);
  for (let k = 1; k < m; k++) if (stack[k].kind === 'quote') stack[k].end = end;
  const fi = firstNB();
  const te = trimEnd(fi, le);
  const blank = fi >= te;
  if (leaf && leaf.verbatim) {
    if (!all) closeLeaf(ls, 'the end of its container');
    else if (feed(fi, te)) return void (prevBlank = blank);
  }
  let r = null;
  if (!all && !blank && leaf && leaf.kind === 'para') {
    r = classify(fi, te, false, true, m);
    if (r.k === 'para') return paraLine(fi, te, r, true), void (prevBlank = false);
  }
  if (!all) {
    const c = stack[m].kind === 'item' && src[fi] === ':' ? colonRow(fi, te) : null;
    closeFrames(m, c && c.k === 'closer' ? 'indent the closer to the item’s content column' : null);
  }
  blocks(r); // once the failed frames close, the lazy test's row is the line's row
  prevBlank = blank;
}

// Classifies the remainder and acts on it, again after each quote, item or
// footnote it opens (`> - item`); `r` is the row if already known. An open
// table sees the line first.
function blocks(r) {
  for (;; r = null) {
    const fi = firstNB();
    const te = trimEnd(fi, le);
    if (fi >= te) return leaf && closeLeaf(-1);
    if (leaf && leaf.kind === 'table' && tableLine(fi, te)) return;
    r = r || classify(fi, te, !!leaf && leaf.kind === 'para', false, stack.length);
    if (!isPrefix(r.k)) return ACT[r.k](r, fi, te);
    if (!container(r, fi, te)) return;
  }
}

// The row that the remainder [fi, te) matches, chosen by its first
// character; where rows share one, the earlier row wins: a thematic break
// before a list item (`- - -`), a cell before a `+` item. The row's `k`
// names its handler in ACT. `inPara`: it would continue a paragraph, which
// only a non-empty bullet or an item numbered 1 may interrupt (`2019. was`
// stays prose); `lazy`: it follows a failed prefix, after a paragraph line.
// In both, a delimiter row starts no table. `nf`: the frames it lies in.
function classify(fi, te, inPara, lazy, nf) {
  const c = src[fi];
  let r = null;
  if (c === ':') r = colonRow(fi, te);
  else if (c === '`' || c === '~') r = fenceRow(fi, te);
  else if (c === '<') r = htmlRow(fi, te);
  else if (c === '#') r = headingRow(fi, te);
  else if (c === '-' || c === '*' || c === '_') r = hrRow(fi, te) || (c !== '_' && itemRow(fi, te));
  else if (c === '+') r = cellRow(fi, te) || itemRow(fi, te);
  else if (c === '|') r = tableRow(fi, te, inPara || lazy, nf);
  else if (c === '>') r = fi + 1 >= te || isSp(src[fi + 1]) ? { k: 'quote' } : null;
  else if (c === '$') r = mathRow(fi, te);
  else if (c === '[') r = fnRow(fi, te, nf);
  else if (c === '{') r = attrRow(fi, te);
  else if (c >= '0' && c <= '9') r = itemRow(fi, te);
  return !r || (inPara && r.k === 'item' && !r.int) ? PARA : r;
}

// ------------------------------------------------------------ rows

// A construct-shaped line that falls back to paragraph text; `d` reports why,
// wherever the line lands, continuation lines included.
const textRow = (code, a, b, message, hint) => ({ k: 'para', d: () => report(code, a, b, message, hint) });

// `[title]` then `{attrs}`, each optional, spaces allowed; the first thing
// that does not parse starts the junk, `bad` being a group that failed.
function tail(i, te) {
  const o = { tb: -1, tc: -1, res: null, junk: -1, bad: null };
  i = skipSp(i, te);
  if (src[i] === '[') {
    o.tc = closeBracket(i, te);
    if (o.tc < 0) return (o.junk = i), o;
    o.tb = i;
    i = skipSp(o.tc + 1, te);
  }
  if (src[i] === '{') {
    const g = parseAttrs(src, i, te);
    if (!g || !g.ok) return (o.junk = i), (o.bad = g), o;
    o.res = g;
    i = skipSp(g.end, te);
  }
  if (i < te) o.junk = i;
  return o;
}

// `:::` closers and openers, and `::` leaves. A `:::` line that is neither is
// text, with a hint: the name must be glued to the colons.
function colonRow(fi, te) {
  let k = fi;
  while (k < te && src[k] === ':') k++;
  const n = k - fi;
  if (n === 2) return leafRow(fi, te);
  if (n < 3) return null;
  if (k === te) return { k: 'closer', n, name: '' };
  const e = matchAt(NAME, src, src[k] === '/' ? k + 1 : k);
  if (src[k] === '/' && e === te) return { k: 'closer', n, name: src.slice(k + 1, e) };
  if (src[k] !== '/' && e > 0) return { k: 'opener', n, ne: e, name: src.slice(k, e) };
  const j = skipSp(k, te);
  const e2 = j > k ? matchAt(NAME, src, j) : -1;
  if (e2 > 0) return textRow('block.spaced-name', pos, te, 'a space after the colons makes this text, not a block', `write \`${src.slice(fi, k)}${src.slice(j, e2)}\``);
  const t = src.slice(k, te);
  return textRow('block.bad-opener', pos, te, 'this opens no block: a name must follow the colons', t[0] === '{' ? `write \`:::div${t}\`` : 'a name starts with a letter: `:::name`');
}

// A leaf: the whole line is `::NAME[content]{attrs}`; else the line is text
// (leaf.demoted, or attr.malformed alone when only a trailing group fails).
function leafRow(fi, te) {
  const k = fi + 2;
  const e = matchAt(NAME, src, k);
  if (e < 0) {
    const j = skipSp(k, te);
    const e2 = j > k ? matchAt(NAME, src, j) : -1;
    return e2 > 0 ? textRow('block.spaced-name', pos, te, 'a space after `::` makes this text, not a leaf', `write \`::${src.slice(j, e2)}\``) : PARA;
  }
  const name = src.slice(k, e);
  const o = tail(e, te);
  if (o.junk < 0) return { k: 'leaf', name, ns: k, o };
  const g = o.bad;
  if (g && g.ok === false && skipSp(g.end, te) === te) {
    const r = textRow('attr.malformed', g.bad, g.bad + 1, 'the attribute group does not parse; the line is text', GROUP);
    r.once = g.bad; // `[content]{bad}` is a failed bare span to the inline parser too, which would report it again
    return r;
  }
  return textRow('leaf.demoted', fi, e, `\`::${name}\` is a leaf only when it fills the line; this is text`, `write \`::${name}[…]\` for a one-line element, or \`:::${name}\` … \`:::\``);
}

// A fence: 3 or more backticks or tildes. A backtick fence's info may not
// hold a backtick (the line is then a paragraph with a code span).
function fenceRow(fi, te) {
  let k = fi;
  while (k < te && src[k] === src[fi]) k++;
  if (k - fi < 3 || (src[fi] === '`' && src.slice(k, te).includes('`'))) return null;
  return { k: 'fence', c: src[fi], len: k - fi, ie: k };
}

// A raw HTML block. Its kind, fixed on this line, is a comment, raw text, a
// one-line tag (an end tag, which is stray, a void or end-tag-optional tag,
// or a self-closed one) or generic. Tag names are case-insensitive; phrasing
// tags start no block.
function htmlRow(fi, te) {
  if (src.startsWith('<!--', fi)) return { k: 'html', hk: 'comment' };
  const close = src[fi + 1] === '/';
  const ns = fi + (close ? 2 : 1);
  const ne = matchAt(TAG, src, ns);
  const name = ne > 0 ? src.slice(ns, ne) : '';
  const lower = name.toLowerCase();
  if (!name || (!BLOCK_TAGS.has(lower) && !isCustom(name))) return null;
  if (close) return src[skipSp(ne, te)] === '>' ? { k: 'html', hk: 'oneline', stray: lower } : null;
  const b = ne < te ? src[ne] : '';
  if (b && !isSp(b) && b !== '>' && b !== '/') return null;
  if (RAW_TEXT.has(lower) && b !== '/') return { k: 'html', hk: 'rawtext', name: lower };
  if (ONE_LINE.has(lower) || selfClosed(src, ne, te)) return { k: 'html', hk: 'oneline' };
  return b === '/' ? null : { k: 'html', hk: 'generic', name: lower };
}

// A heading: 1 to 6 `#`, then a space, a tab or the end (`#tag` is text).
function headingRow(fi, te) {
  let k = fi;
  while (k < te && src[k] === '#') k++;
  return k - fi > 6 || (k < te && !isSp(src[k])) ? null : { k: 'heading', depth: k - fi, cs: skipSp(k, te) };
}

// A thematic break: three or more of one mark, spaces and tabs allowed, nothing else.
function hrRow(fi, te) {
  let n = 0;
  for (let i = fi; i < te; i++) {
    if (src[i] === src[fi]) n++;
    else if (!isSp(src[i])) return null;
  }
  return n >= 3 ? { k: 'hr' } : null;
}

// A list item: a bullet, or 1–9 digits and `.` or `)`; then a space, a tab
// or the end. `int`: it may interrupt a paragraph.
function itemRow(fi, te) {
  let k = fi;
  const ordered = src[fi] >= '0' && src[fi] <= '9';
  while (ordered && k < te && k - fi < 10 && src[k] >= '0' && src[k] <= '9') k++;
  if (ordered && (k - fi > 9 || (src[k] !== '.' && src[k] !== ')'))) return null;
  const num = ordered ? Number(src.slice(fi, k)) : 0;
  if (++k < te && !isSp(src[k])) return null;
  const empty = k >= te;
  return { k: 'item', ordered, num, ch: src[k - 1], me: k, empty, int: !empty && (!ordered || num === 1) };
}

// A cell separator: `+{3,}` alone, or with one group (any).
function cellRow(fi, te) {
  let k = fi;
  while (k < te && src[k] === '+') k++;
  const i = skipSp(k, te);
  if (k - fi < 3 || (i < te && src[i] !== '{')) return null;
  const res = i < te ? parseAttrs(src, i, te) : null;
  return i === te || (res && res.ok && skipSp(res.end, te) === te) ? { k: 'cell', res } : null;
}

// A table: (a) a header, not continued, with a delimiter row next in the
// same frames, the grammar's one lookahead, which moves the line state to
// the next line and back; (b) a delimiter row at a block start, headerless.
function tableRow(fi, te, inPara, nf) {
  if (delimAt(fi, te)) return inPara ? null : { k: 'delim' };
  if (continues(fi, te) || le >= N) return null;
  const save = [ls, le, pos, col, partial];
  ls = pos = le + 1;
  le = src.indexOf('\n', ls);
  if (le < 0) le = N;
  col = partial = 0;
  runAt = -1;
  let ok = true;
  for (let m = 1; m < nf && ok; m++) ok = matchPrefix(stack[m]);
  const i = firstNB();
  ok = ok && src[i] === '|' && delimAt(i, trimEnd(i, le));
  [ls, le, pos, col, partial] = save;
  runAt = -1;
  return ok ? { k: 'table' } : null;
}

// Whether [fi, te) is shaped like a delimiter row: the start is checked before the regex.
function delimAt(fi, te) {
  let k = src[fi] === '|' ? fi + 1 : fi;
  while (isSp(src[k])) k++;
  return src[k + (src[k] === ':')] === '-' && matchAt(DELIM, src, fi) === te;
}

// A row continues onto the next line when it ends with an unescaped single `\` outside atoms.
function continues(a, te) {
  let k = te;
  while (k > a && src[k - 1] === '\\') k--;
  if ((te - k) % 2 === 0) return false;
  const at = atomRanges(src.slice(a, te));
  for (let i = 0; i < at.length; i += 2) if (at[i] < te - a && te - a - 1 < at[i + 1]) return false;
  return true;
}

// Display math: complete on the line when an unescaped `$$` follows with
// nothing after it but an optional group (math1); not math when other text
// follows (a paragraph, where the inline parser reports the `$$`); else
// multi-line.
function mathRow(fi, te) {
  if (src[fi + 1] !== '$') return null;
  const k = dollars(fi + 2, te);
  if (k < 0) return { k: 'math' };
  const j = skipSp(k + 2, te);
  const res = src[j] === '{' ? parseAttrs(src, j, te) : null;
  return j === te || (res && res.ok && skipSp(res.end, te) === te) ? { k: 'math1', close: k, res } : null;
}

// The first unescaped `$$` in [i, e); `\x` pairs are skipped.
function dollars(i, e) {
  for (; i < e - 1; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '$' && src[i + 1] === '$') return i;
  }
  return -1;
}

// A footnote definition: `[^LABEL]:` and a space or the end, except inside a definition.
function fnRow(fi, te, nf) {
  if (src[fi + 1] !== '^' || stack[nf - 1].fn) return null;
  const e = matchAt(LABEL, src, fi + 2);
  if (e < 0 || src[e] !== ']' || src[e + 1] !== ':' || (e + 2 < te && !isSp(src[e + 2]))) return null;
  return { k: 'fn', label: src.slice(fi + 2, e), me: e + 2 };
}

// An attribute line: strong groups only (`{x}` is text); a line starting `{#` or `{.` that does not parse is attr.malformed.
function attrRow(fi, te) {
  const groups = [];
  let i = fi, res = null;
  while (src[i] === '{' && (res = parseAttrs(src, i, te)) && res.ok && res.strong) groups.push(res), (i = skipSp(res.end, te)), (res = null);
  if (i === te) return { k: 'attrs', groups };
  if (src[fi + 1] !== '#' && src[fi + 1] !== '.') return null;
  const bad = res && res.ok === false ? res.bad : i;
  return textRow('attr.malformed', bad, bad + 1, 'this attribute line does not parse; it is text', GROUP);
}

// The `]` closing the `[` at i, for titles: brackets nest; escapes and atoms are skipped (`[See $f[x]$]`).
function closeBracket(i, e) {
  const at = atoms(i + 1, e);
  for (let j = i, k = 0, d = 0; j < e; j++) {
    while (k < at.length && at[k + 1] <= j) k += 2;
    if (k < at.length && j >= at[k]) j = at[k + 1] - 1;
    else if (src[j] === '\\' && isAsciiPunct(src.charCodeAt(j + 1))) j++;
    else if (src[j] === '[') d++;
    else if (src[j] === ']' && --d === 0) return j;
  }
  return -1;
}

// The `{` of a group candidate closing at e, or -1: an unquoted `{`
// restarts the candidate; escapes and atoms do not count.
function lastGroup(a, e) {
  if (src[e - 1] !== '}') return -1;
  const at = atoms(a, e);
  let open = -1, q = '';
  for (let i = a, k = 0; i < e; i++) {
    const c = src[i];
    while (k < at.length && at[k + 1] <= i) k += 2;
    if (q) q = c === q ? '' : q;
    else if (k < at.length && i >= at[k]) i = at[k + 1] - 1;
    else if (c === '\\' && isAsciiPunct(src.charCodeAt(i + 1))) i++;
    else if (c === '{') open = i;
    else if (open >= 0 && (c === '"' || c === "'") && src[i - 1] === '=') q = c;
    else if (c === '}' && open >= 0) {
      if (i === e - 1) return open;
      open = -1;
    }
  }
  return -1;
}

// ------------------------------------------------------------ leaves

// A paragraph line, lazy or not: `r.d` reports the line's own diagnostic,
// `r.own` starts a paragraph of its own. Lines are stripped and joined by a
// '\n' that maps to the previous line's newline (p.nl); p.kv tracks whether
// every line is `key: value`, for front matter.
function paraLine(fi, te, r, lazy) {
  if (r.d) r.d();
  const p = leaf && leaf.kind === 'para' && !r.own ? leaf : null;
  if (delimAt(fi, te) && src.slice(fi, te).includes('|')) {
    const cont = p && !lazy && src[p.end - 1] === '\\';
    report('table.stray-delimiter', pos, te, 'this line is shaped like a delimiter row, but no table starts here', cont ? 'the header row cannot continue onto the next line' : 'table rows start with `|`: write `| Keys | Action |`');
  }
  const kv = !!front && !!metaLine(src.slice(fi, te));
  if (p) {
    spanAdd(p.span, '\n', p.nl);
    spanAdd(p.span, src.slice(fi, te), fi);
    p.end = te;
    p.nl = le;
    p.kv = p.kv && kv;
    if (r.once !== undefined) (p.once || (p.once = [])).push(r.once);
    return;
  }
  const pa = begin();
  const node = { type: 'paragraph', children: [] };
  attach(node, pa, null);
  addChild(node);
  leaf = { kind: 'para', node, span: lineSpan(fi, te), start: pa ? pa.start : fi, end: te, nl: le, fn: top().fn, kv, once: r.once === undefined ? null : [r.once] };
}

// Parses the paragraph's inline content. `front.ok`: the note so far is a
// `---` and this all-`key: value` paragraph, so a `---` next is front matter.
function finishPara(p) {
  const k = ctx.diagnostics.length;
  p.node.children = parseInline(ctx, p.span, IO.paragraph[+(p.fn > 0)]);
  if (p.once) once(p.once, k);
  p.node.position = ctx.position(p.start, p.end);
  if (front) front.ok = root.children.length === 2 && root.children[1] === p.node && p.kv;
}

// Drops the inline parser's attr.malformed at an offset the line already
// reported it at (leafRow, heading), from the diagnostics after the k-th.
function once(at, k) {
  const list = ctx.diagnostics;
  for (let i = list.length - 1; i >= k; i--) if (list[i].code === 'attr.malformed' && at.includes(list[i].position.start.offset)) list.splice(i, 1);
}

// A heading: a trailing strong group is the heading's; a `{#…` or `{.…` one that does not parse is text.
function heading(r, fi, te) {
  const pa = begin();
  const g = lastGroup(r.cs, te);
  const t = g >= 0 ? parseAttrs(src, g, te) : null;
  const res = t && t.ok && t.strong ? t : null;
  const bad = t && t.ok === false && (src[g + 1] === '#' || src[g + 1] === '.');
  if (bad) report('attr.malformed', t.bad, t.bad + 1, 'the attribute group does not parse; it stays heading text', GROUP);
  const node = { type: 'heading', depth: r.depth, children: [] };
  attach(node, pa, res);
  const k = ctx.diagnostics.length;
  node.children = inline(r.cs, res ? Math.max(r.cs, trimEnd(r.cs, g)) : te, 'heading');
  if (bad) once([t.bad], k); // the group glued to `]` or a closer is also the inline parser's to report
  node.position = ctx.position(pa ? pa.start : fi, te);
  addChild(node);
}

// A thematic break. At the top level it also catches front matter, which is
// not supported: `---`, `key: value` lines and `---` as the note's first
// blocks stay a rule, a paragraph and a rule, with doc.frontmatter.
function hr(_r, fi, te) {
  const pa = begin();
  const node = { type: 'thematicBreak' };
  attach(node, pa, null);
  node.position = ctx.position(pa ? pa.start : fi, te);
  if (stack.length === 1) {
    const dashes = te - fi === 3 && src.startsWith('---', fi);
    if (dashes && !root.children.length && !pa) front = { at: fi, end: te };
    else if (dashes && front && front.ok && root.children.length === 2)
      report('doc.frontmatter', front.at, front.end, 'front matter is not supported: this is a rule, a paragraph and a rule', 'write metadata in a `:::meta` block'), (front = null);
    else front = null;
  }
  addChild(node);
}

// A fence's info: LANG, `[Title]`, `{attrs}`, in that order; anything else is
// junk, kept as `code.meta`. An `=html` fence is raw HTML and takes neither
// title nor attributes; any other `=FORMAT` is code in language FORMAT.
function fence(r, fi, te) {
  const ind = indentAt();
  let i = skipSp(r.ie, te);
  const e = matchAt(LANG, src, i);
  const lang = e > i ? src.slice(i, e) : '';
  if (lang) i = skipSp(e, te);
  const o = lang === '=html' ? { tb: -1, res: null, junk: i < te ? i : -1 } : tail(i, te);
  const kept = lang === '=html' ? 'it is dropped, as an `=html` fence has no `<pre>` to keep it on' : 'it is kept in data-meta';
  if (o.junk >= 0) report('fence.info-junk', o.junk, te, `this is not part of the fence info; ${kept}`, 'the info is a language, a `[Title]` and a `{…}` group, in that order');
  let pa = begin();
  let node;
  if (lang === '=html') {
    if (pa) orphan(pa, true);
    pa = null;
    node = { type: 'html', value: '', data: { tern: { kind: 'fence' } } };
  } else {
    node = { type: 'code', lang: (lang[0] === '=' ? lang.slice(1) : lang) || null, meta: o.junk >= 0 ? src.slice(o.junk, te) : null, value: '' };
    attach(node, pa, o.res);
    if (o.tb >= 0) tern(node).title = inline(o.tb + 1, o.tc, 'title');
  }
  addChild(node);
  leaf = { kind: 'fence', verbatim: true, node, c: r.c, len: r.len, indent: ind, lines: [], start: pa ? pa.start : fi, end: te, open: fi };
}

// A raw HTML block: the kind, and with it the end condition, is fixed on the first line, which counts too.
function html(r, fi) {
  const pa = begin();
  if (pa) orphan(pa, true);
  const a = pos;
  const node = { type: 'html', value: rest(), data: { tern: { kind: r.hk } } };
  addChild(node);
  if (r.hk === 'oneline') {
    node.position = ctx.position(a, le);
    const hint = r.stray === 'table' ? 'write a pipe table or a whole raw `<table>` block' : `to wrap Tern content write \`:::${r.stray}{…}\` … \`:::\``;
    if (r.stray) report('html.stray-closer', a, trimEnd(a, le), `\`</${r.stray}>\` closes nothing that is open; it is passed through`, hint);
    return;
  }
  const v = (leaf = { kind: 'html', verbatim: true, node, hk: r.hk, name: r.name, lines: [node.value], start: a, end: le, first: le, open: a, d: 0 });
  const s = src.slice(fi, le);
  if (r.hk === 'comment' ? s.includes('-->', 2) : r.hk === 'rawtext' ? RAW_END[r.name].test(s.slice(1)) : (v.d = balance(r.name, fi, le)) <= 0) finish(v);
}

// Openings minus closings of NAME in [a, e), any case: a generic block ends
// on the line where the count from its opener returns to 0. An opening is
// `<NAME` then whitespace, `/`, `>` or the end, not self-closed (so
// `<divider>` is no `div`); a closing is `</NAME`, spaces, `>`.
function balance(name, a, e) {
  const s = src.slice(a, e).toLowerCase();
  let d = 0;
  for (let i = s.indexOf('<'); i !== -1; i = s.indexOf('<', i + 1)) {
    if (s[i + 1] === '/') {
      if (!s.startsWith(name, i + 2)) continue;
      let k = i + 2 + name.length;
      while (isSp(s[k])) k++;
      if (s[k] === '>') d--;
    } else if (s.startsWith(name, i + 1)) {
      const k = i + 1 + name.length;
      if ((k >= s.length || /[\s/>]/.test(s[k])) && !selfClosed(s, k, s.length)) d++;
    }
  }
  return d;
}

// Whether the tag whose name ends at i ends with `/>` on this line; quoted values are skipped.
function selfClosed(s, i, e) {
  for (let q = ''; i < e; i++) {
    const c = s[i];
    if (q) q = c === q ? '' : q;
    else if (c === '"' || c === "'") q = c;
    else if (c === '>') return s[i - 1] === '/';
    else if (c === '<') return false;
  }
  return false;
}

// `html.wrapper`: the first non-tag line of a generic block after a blank
// line or holding Tern syntax, a sign the author expects Tern inside an
// HTML wrapper. Once per block.
function wrapper(v, fi, te) {
  if (v.warned || fi >= te) return void (v.blank = v.blank || fi >= te);
  const s = src.slice(fi, te);
  if (s[0] === '<' || (!v.blank && !/[*`$[]|:::/.test(s) && !/^(?:#{1,6}(?:[ \t]|$)|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|\|)/.test(s))) return;
  v.warned = true;
  report('html.wrapper', fi, te, `This line is inside the raw \`<${v.name}>\` opened on line ${lineOf(v.open)} and is shown as HTML, not parsed as Tern.`, `To put Tern inside an element write \`:::${v.name}{…}\` … \`:::\`.`);
}

// Multi-line display math: the rest of the opener line is the first TeX line,
// a strong `{#…`/`{.…` group included (attributes go after the closing `$$`).
function math(_r, fi, te) {
  const pa = begin();
  const node = { type: 'math', value: '' };
  addChild(node);
  leaf = { kind: 'math', verbatim: true, node, pa, indent: indentAt(), tex: [], lines: [src.slice(fi, te)], start: pa ? pa.start : fi, end: te, open: fi };
  const f = skipSp(fi + 2, te);
  if (f < te) leaf.tex.push(src.slice(f, te));
  const g = src[f] === '{' && (src[f + 1] === '#' || src[f + 1] === '.') ? parseAttrs(src, f, te) : null;
  if (g && g.ok && g.strong && g.end === te) report('math.opener-tail', f, te, 'a group on the opening `$$` line is TeX, not attributes', 'attributes go after the closing `$$`: `$$ {#eq}`');
}

// One-line display math: `$$ TeX $$ {attrs}`.
function math1(r, fi, te) {
  const pa = begin();
  const node = { type: 'math', value: src.slice(skipSp(fi + 2, r.close), trimEnd(fi + 2, r.close)) };
  attach(node, pa, r.res);
  node.position = ctx.position(pa ? pa.start : fi, te);
  addChild(node);
}

// What ends display math early, named for the message. TeX forbids blank
// lines in display math, so no valid equation is cut, and an unclosed `$$`
// swallows at most one paragraph.
function mathStop(fi, te) {
  const c = src[fi];
  if (fi >= te) return 'the blank line';
  if (c === '#' && headingRow(fi, te)) return 'the heading';
  if ((c === '`' || c === '~') && fenceRow(fi, te)) return 'the fence';
  if (c === ':' && colonLine(fi, te)) return 'the `:::` line';
  if (c === '+' && cellRow(fi, te)) return 'the `+++` line';
  return null;
}

// A `:::` opener or closer line, which ends display math and generic raw HTML.
const colonLine = (fi, te) => src[fi] === ':' && ['closer', 'opener'].includes((colonRow(fi, te) || PARA).k);

// A leaf `::NAME[content]{attrs}`.
function leafLine(r, fi, te) {
  const pa = begin();
  const node = { type: 'leafDirective', name: r.name, children: [] };
  reserved(r.name, r.ns, attach(node, pa, r.o.res));
  tern(node).namePosition = ctx.position(r.ns, r.ns + r.name.length);
  if (r.o.tb >= 0) node.children = inline(r.o.tb + 1, r.o.tc, 'leaf');
  node.position = ctx.position(pa ? pa.start : fi, te);
  addChild(node);
}

// Reports a reserved name, or `{tag=…}` naming a reserved element.
function reserved(name, at, m) {
  if (isReservedName(name)) report('name.reserved', at, at + name.length, `\`${name}\` is reserved; the element falls back to a \`div\``, 'choose another name');
  const t = m && m.attrs.tag;
  if (t && isReservedName(t)) report('name.reserved', m.keyAt.tag, m.keyAt.tag + 3, `\`tag=${t}\` names a reserved element and is ignored`, 'choose another element');
}

// An attribute line is held as the open leaf until the next block takes it
// (begin()) or anything else makes it an orphan. Consecutive lines merge.
function attrLine(r, fi, te) {
  if (leaf && leaf.kind === 'attrs') return leaf.groups.push(...r.groups), leaf.parts.push(fi, te), void (leaf.end = te);
  closeLeaf(-1);
  leaf = { kind: 'attrs', groups: r.groups, parts: [fi, te], start: fi, end: te, at: pos };
}

// ------------------------------------------------------------ tables

// A table, opened by its header (the delimiter row comes next: t.delim) or by
// a delimiter row alone (headerless), which sets the column count.
function table(r, fi, te) {
  const pa = begin();
  const node = { type: 'table', align: [], children: [] };
  attach(node, pa, null);
  addChild(node);
  const t = (leaf = { kind: 'table', node, start: pa ? pa.start : fi, end: te, cols: 0, delim: r.k === 'table', row: null, at: 0, io: IO.cell[+(top().fn > 0)] });
  if (t.delim) t.cols = row(t, [fi, te, le]).children.length;
  else (tern(node).headerless = true), (node.align = aligns(fi, te, -1)), (t.cols = node.align.length);
}

// A line while a table is open: its delimiter row, a continuation, or a row.
// A continuation joins whatever the next line holds, unless it is a closer or
// a `+++` line.
function tableLine(fi, te) {
  const t = leaf;
  if (t.delim) return (t.node.align = aligns(fi, te, t.cols)), (t.delim = false), (t.end = te), true;
  if (t.row) {
    const r = src[fi] === ':' ? colonRow(fi, te) : src[fi] === '+' ? cellRow(fi, te) : null;
    if (r && (r.k === 'closer' || r.k === 'cell')) return closeLeaf(-1), false;
  } else if (src[fi] !== '|') return closeLeaf(-1), false;
  else if (delimAt(fi, te)) report('table.misplaced-separator', pos, te, 'a delimiter row in the table body is shown as a text row', 'a table has one delimiter row, under its header');
  t.at = pos;
  t.end = te;
  const more = continues(fi, te);
  if (t.row || more) (t.row = t.row || []).push(fi, te, le);
  if (!more) row(t, t.row || ((one[0] = fi), (one[1] = te), (one[2] = le), one)), (t.row = null);
  return true;
}

// A delimiter row's alignments, one per column; extra ones are dropped,
// missing ones are null.
function aligns(fi, te, cols) {
  const out = src.slice(fi + 1, src[te - 1] === '|' && te - 1 > fi ? te - 1 : te).split('|').map((c) => {
    const l = c.trim()[0] === ':', r = c.trim().endsWith(':');
    return l && r ? 'center' : l ? 'left' : r ? 'right' : null;
  });
  if (cols < 0) return out;
  while (out.length < cols) out.push(null);
  return out.slice(0, cols);
}

// A logical row, `lines` being [start, end, newline, …] per line: the lines
// joined with each continuation's `\` and newline, so the inline parser makes
// the hard break, and cut into cells at `|` outside atoms and escapes; a
// trailing `|` adds no cell.
function row(t, lines) {
  let text = src.slice(lines[0], lines[1]);
  for (let q = 3; q < lines.length; q += 3) text += '\n' + src.slice(lines[q], lines[q + 1]);
  const at = atomRanges(text);
  let s = 1, j, nc = 0;
  for (let i = 1, k = 0; i < text.length; i++) {
    while (k < at.length && at[k + 1] <= i) k += 2;
    const c = text.charCodeAt(i);
    if (k < at.length && i >= at[k]) i = at[k + 1] - 1;
    else if (c === 92 && isAsciiPunct(text.charCodeAt(i + 1))) i++; // `\`
    else if (c === 124) (cuts[nc++] = s), (cuts[nc++] = i), (s = i + 1); // `|`
  }
  for (j = s; j < text.length && isSp(text[j]); ) j++;
  if (j < text.length) (cuts[nc++] = s), (cuts[nc++] = text.length);
  (rl = lines), (rq = rf = 0);
  for (let k = 0; k < nc; k += 2) {
    let a = cuts[k], b = cuts[k + 1];
    const sep = k === t.cols * 2 && t.cols ? off(a - 1) : -1;
    if (sep >= 0) report('table.extra-cell', sep, sep + 1, `this row has more cells than the header's ${t.cols}; the extra ones are kept`, 'add a header cell, or remove this one');
    while (a < b && isSp(text[a])) a++;
    while (b > a && isSp(text[b - 1])) b--;
    const x = off(a);
    let kids = [];
    if (b > a && b <= rf + lines[rq + 1] - lines[rq]) kids = parseInline(ctx, lineSpan(x, x + b - a), t.io);
    else if (b > a) {
      const span = createSpan(x); // the cell crosses joints: a segment per line and the joints between
      for (let q = rq, f = rf, i = a; i < b; q += 3) {
        const e = Math.min(b, f + lines[q + 1] - lines[q]);
        spanAdd(span, text.slice(i, e), lines[q] + i - f);
        if (e < b) spanAdd(span, '\n', lines[q + 2]);
        i = f += lines[q + 1] - lines[q] + 1;
      }
      kids = parseInline(ctx, span, t.io);
    }
    cells[k >> 1] = { type: 'tableCell', children: kids, position: ctx.position(x, b > a ? off(b - 1) + 1 : x) };
  }
  const node = { type: 'tableRow', children: cells.slice(0, nc >> 1), position: ctx.position(lines[0], lines[lines.length - 2]) };
  t.node.children.push(node);
  return node;
}

// A row's text index as a source offset, moving forward only: line rq of `rl`
// starts at text index rf, and a joint is its line's newline.
function off(i) {
  while (rq + 3 < rl.length && i > rf + rl[rq + 1] - rl[rq]) (rf += rl[rq + 1] - rl[rq] + 1), (rq += 3);
  return i === rf + rl[rq + 1] - rl[rq] && rq + 3 < rl.length ? rl[rq + 2] : rl[rq] + i - rf;
}

function finishTable(t) {
  if (t.row) report('table.row-unterminated', t.at, t.row[t.row.length - 2], 'this row ends with `\\` but nothing can continue it; the `\\` is literal', 'continue the row on the next line, in the same block'), row(t, t.row);
  t.node.position = ctx.position(t.start, t.end);
}

// ------------------------------------------------------------ verbatim leaves

// The remainder goes to the open verbatim leaf; fence and math lines lose up
// to the opener's indentation. Returns false when a terminator closed it and
// the line is to be classified.
function feed(fi, te) {
  const v = leaf;
  if (v.kind === 'math') return feedMath(v, fi, te);
  if (v.kind === 'html' && v.hk === 'generic' && colonLine(fi, te)) return closeLeaf(ls, ''), false;
  if (fi < te) v.mark = null;
  else if (!v.mark) v.mark = [v.lines.length, v.end]; // blank lines are held: if the parent ends next, the leaf ends before them
  if (v.kind === 'fence') {
    let k = fi;
    while (k < te && src[k] === v.c) k++;
    if (k === te && k - fi >= v.len) return (v.end = te), finish(v), true;
    advance(Math.min(v.indent, indentAt()));
  } else if (v.kind === 'raw') {
    const r = src[fi] === ':' ? colonRow(fi, te) : null;
    if (r && r.k === 'closer' && (!r.name || r.name === v.name)) return (v.end = te), finish(v), true;
    v.at.push(pos);
  }
  const a = pos;
  v.lines.push(rest());
  v.end = le;
  if (v.kind !== 'html') return true;
  const s = src.slice(a, le);
  if (v.hk === 'comment' ? s.includes('-->') : v.hk === 'rawtext' ? RAW_END[v.name].test(s) : (wrapper(v, fi, te), (v.d += balance(v.name, a, le)) <= 0)) finish(v);
  return true;
}

// Display math: terminators, then the closer; after it nothing, a group, or junk that starts a paragraph.
function feedMath(v, fi, te) {
  const why = mathStop(fi, te);
  if (why) return closeLeaf(ls, why), false;
  const k = dollars(fi, te);
  if (k < 0) {
    advance(Math.min(v.indent, indentAt()));
    const t = rest();
    return v.tex.push(t), v.lines.push(t), (v.end = le), true;
  }
  if (trimEnd(fi, k) > fi) v.tex.push(src.slice(fi, trimEnd(fi, k)));
  const j = skipSp(k + 2, te);
  const g = src[j] === '{' ? parseAttrs(src, j, te) : null;
  const ok = j === te || (g && g.ok && skipSp(g.end, te) === te);
  v.res = ok ? g : null;
  v.end = ok ? te : k + 2;
  finish(v);
  if (!ok) report('math.closer-tail', j, te, 'text after the closing `$$` is not part of the equation; it starts a paragraph', 'only an attribute group may follow the closing `$$`'), paraLine(j, te, PARA, false);
  return true;
}

// Closes the open leaf. A verbatim leaf closed here did not reach its end
// condition: `at` is where the line that ended it starts (-1 at the end of
// the note), `why` names that line.
function closeLeaf(at, why) {
  const v = leaf;
  if (!v) return;
  leaf = null;
  if (v.kind === 'para') return finishPara(v);
  if (v.kind === 'table') return finishTable(v);
  if (v.kind === 'attrs') return orphan(v);
  if (v.mark && at >= 0) {
    v.lines.length = v.mark[0];
    if (v.at) v.at.length = v.mark[0];
    v.end = v.mark[1];
  }
  Object.assign(v, { unclosed: true, why, stop: at });
  finish(v);
}

// Completes a verbatim leaf, closed or not: its value, attributes and
// unclosed diagnostics. An unclosed fence or raw block sets unclosedWhat for
// the block.unclosed hint of the containers that close with it.
function finish(v) {
  if (leaf === v) leaf = null;
  const node = v.node;
  const opened = lineOf(v.open);
  node.value = (v.tex || v.lines).join('\n');
  if (v.kind === 'math') attach(node, v.pa, v.res);
  if (v.kind === 'raw' && v.unclosed) unclosedDir(v, '');
  if (v.kind === 'raw' && v.name === 'meta') readMeta(v);
  if (v.kind === 'math' && v.unclosed) {
    Object.assign(tern(node), { unclosed: true, source: v.lines.join('\n') });
    const where = v.stop >= 0 ? `ends at ${v.why} on line ${lineOf(v.stop)} without a closing \`$$\`` : 'is never closed';
    const tex = v.why === 'the blank line' ? '; TeX forbids blank lines in display math' : '';
    report('math.unclosed', v.open, v.stop >= 0 ? v.stop : v.end, `\`$$\` opened on line ${opened} ${where}${tex}`, 'add a line holding only `$$`');
  } else if (v.kind === 'fence' && v.unclosed) {
    report('block.unclosed-fence', v.open, v.open + v.len, `the fence opened on line ${opened} is never closed`, `add a closing \`${v.c.repeat(v.len)}\``);
    unclosedWhat = `the fence opened on line ${opened} is unclosed`;
  } else if (v.kind === 'html' && v.unclosed) {
    const what = v.hk === 'comment' ? '`<!--`' : `\`<${v.name}>\``;
    if (v.hk !== 'generic') (tern(node).unclosed = true), (unclosedWhat = `the ${what} opened on line ${opened} is unclosed`);
    report('html.unclosed', v.start, v.first, `the raw ${what} opened on line ${opened} is never closed`, v.hk === 'comment' ? 'end it with `-->`' : `end it with \`</${v.name}>\``);
  }
  node.position = ctx.position(v.start, v.end);
}

// ------------------------------------------------------------ containers

// A quote, list item or footnote definition opens a frame; returns whether
// the rest of the line is to be classified inside it.
function container(r, fi, te) {
  if (depth >= MAX) return nesting(fi, r.k === 'quote' ? fi + 1 : r.me, te), false;
  const pa = begin();
  if (r.k === 'item') return item(r, fi, te, pa);
  if (pa && r.k === 'fn') orphan(pa);
  const quote = r.k === 'quote';
  const node = quote ? { type: 'blockquote', children: [] } : { type: 'footnoteDefinition', identifier: r.label.toLowerCase().toUpperCase().toLowerCase(), label: r.label, children: [] };
  if (quote) attach(node, pa, null);
  addChild(node);
  push({ kind: r.k, node, start: pa && quote ? pa.start : fi, end: quote ? trimEnd(ls, le) : r.me });
  if (!quote) return moveTo(skipSp(r.me, le)), pos < te;
  return moveTo(fi + 1 + isSp(src[fi + 1])), true; // `>` and a space or a whole tab
}

// Past MAX open frames, an opener becomes paragraph text.
function nesting(fi, e, te) {
  report('nesting.limit', fi, e, `blocks nest at most ${MAX} deep; this opener is shown as text`, 'flatten the structure');
  paraLine(fi, te, PARA, false);
}

// A list item. It joins the list before it when that is the last block and
// has the same bullet or delimiter; an attribute line starts a new list. The
// content column is the marker's end plus the spaces after it, or plus one
// when the item starts blank or more than four follow. `[ ]`, `[x]` make a
// task item.
function item(r, fi, te, pa) {
  const parent = top();
  const kids = parent.node.children;
  let li = parent.lastList;
  if (!li || li.node !== kids[kids.length - 1] || li.ch !== r.ch || pa) {
    li = parent.lastList = { node: { type: 'list', ordered: r.ordered, start: r.ordered ? r.num : null, spread: false, children: [] }, ch: r.ch, start: pa ? pa.start : fi };
    attach(li.node, pa, null);
    addChild(li.node);
  } else if (prevBlank) loose(li);
  const base = col; // the content column counts from where this remainder starts
  moveTo(r.me);
  const w = indentAt();
  const pad = r.empty || w > 4 ? 1 : w;
  const node = { type: 'listItem', spread: li.node.spread, checked: null, children: [] };
  const f = { kind: 'item', node, start: fi, end: r.me, indent: col - base + pad, list: li };
  advance(pad);
  li.node.children.push(node);
  push(f);
  if (r.empty) return false;
  const t = firstNB();
  const x = src[t + 1];
  if (src[t] === '[' && (x === ' ' || x === 'x' || x === 'X') && src[t + 2] === ']' && (t + 3 >= te || isSp(src[t + 3]))) {
    node.checked = x !== ' ';
    f.end = t + 3;
    moveTo(t + 3 + isSp(src[t + 3]));
  }
  return firstNB() < te;
}

// A container opener `:::NAME[title]{attrs}`. Anything after that is junk,
// shown as an error paragraph; `:::end` acts as a bare closer. The body is
// verbatim for `:::macros`, `:::meta`, `:::script`, `:::style`, `:::html`,
// `{raw}` and a schema entry with `body: 'raw'`.
function opener(r, fi, te) {
  if (r.name === 'end') {
    report('name.reserved', r.ne - 3, r.ne, '`:::end` is reserved; it is read as `:::`', 'write `:::` or `:::/name`');
    return closer({ k: 'closer', n: r.n, name: '' }, fi, te);
  }
  if (depth >= MAX) return nesting(fi, r.ne, te);
  const o = tail(r.ne, te);
  const pa = begin();
  const name = r.name;
  const ns = r.ne - name.length;
  const node = { type: 'containerDirective', name, children: [], data: { tern: { colons: r.n, namePosition: ctx.position(ns, r.ne) } } };
  const m = attach(node, pa, o.res);
  if (RESERVED_HINT[name]) report('name.reserved', ns, r.ne, `\`:::${name}\` is reserved: its body is shown as text, not run`, RESERVED_HINT[name]);
  reserved(RESERVED_HINT[name] || name === 'meta' ? '' : name, ns, m);
  if (name === 'meta' && m) metaAttrs(node, m);
  const cols = m && m.attrs.cols;
  if (/^\s*-?\d+(?:\.\d+)?\s*$/.test(cols) && Number(cols) <= 0) {
    let v = m.keyAt.cols + 4;
    while (src[v] === '=' || src[v] === '"' || src[v] === "'") v++;
    report('attr.malformed', v, v + cols.length, '`cols` must be a positive number or a list of widths; it is ignored', 'write `cols=2` or `cols="2 1"`');
  }
  if (o.tb >= 0) node.children.push({ type: 'paragraph', data: { directiveLabel: true }, children: inline(o.tb + 1, o.tc, 'title'), position: ctx.position(o.tb, o.tc + 1) });
  if (o.junk >= 0) {
    const text = src.slice(o.junk, te);
    const position = ctx.position(o.junk, te);
    node.children.push({ type: 'paragraph', data: { tern: { junk: true } }, children: [{ type: 'text', value: text, position }], position });
    const title = o.tb >= 0 ? src.slice(o.tb, o.tc + 1) : '';
    const c = text[0];
    const hint =
      c === '#' || c === '.' ? `attributes go in braces: \`:::${name}${title}{${text}}\``
      : c === '{' ? GROUP
      : title ? 'this text is not part of the opener: remove it, or put it in the title or the body' // the title is already there
      : c === '[' ? 'close the title with `]` on this line'
      : `a title goes in brackets: \`:::${name}[${text}]\``;
    report('block.opener-junk', o.junk, te, 'this is not part of the opener; it is shown as an error paragraph', hint);
  }
  addChild(node);
  const start = pa ? pa.start : fi;
  if (RAW_BODY.has(name) || (node.attributes && 'raw' in node.attributes) || rawBody(name)) leaf ={ kind: 'raw', verbatim: true, node, name, lines: [], at: [], start, end: te, open: fi, ne: r.ne };
  else push({ kind: 'dir', node, start, end: te, name, n: r.n, open: fi, ne: r.ne, body: node.children.length });
}

// `:::meta` emits nothing, so its id, classes and ordinary keys apply to no
// element: attr.malformed at each item (the ids transform does not register
// the id). The reserved keys have their own reports (transform.js
// misplaced: `tag`, `cols`, `ref`); `raw` changes nothing on a body that is
// verbatim already.
function metaAttrs(node, m) {
  const dropped = (at, e, what, many) =>
    report('attr.malformed', at, e, `${what} ${many ? 'apply' : 'applies'} to no element here, as \`:::meta\` emits nothing; ${many ? 'they are' : 'it is'} dropped`, 'remove it; metadata goes in the body, as `key: value` lines');
  const idp = tern(node).idPosition;
  if (idp) dropped(idp.start.offset, idp.end.offset, `the id "${m.attrs.id}"`, false);
  const cls = m.attrs.class;
  const many = m.classAt >= 0 && cls.includes(' ');
  if (m.classAt >= 0) dropped(m.classAt, src[m.classAt] === '.' ? matchAt(IDENT, src, m.classAt + 1) : m.classAt + 5, `the class${many ? 'es' : ''} "${cls}"`, many);
  for (const k in m.keyAt) if (k !== 'tag' && k !== 'cols' && k !== 'ref' && k !== 'raw') dropped(m.keyAt[k], m.keyAt[k] + k.length, `\`${k}\``);
}

// A schema entry with `body: 'raw'` makes the body verbatim, as `{raw}` does.
function rawBody(name) {
  const b = ctx.schema.block;
  return !!b && Object.prototype.hasOwnProperty.call(b, name) && !!b[name] && b[name].body === 'raw' && !isReservedName(name);
}

// A closer: bare `:::` closes the innermost container, `:::/NAME` the
// nearest of that name, and those inside it close as unclosed; colon counts
// do not choose. It sees only the containers above the innermost quote,
// list item or footnote. A closer that closes nothing is text.
function closer(r, fi, te) {
  let lo = stack.length - 1;
  while (lo > 0 && !isPrefix(stack[lo].kind)) lo--;
  const open = stack.slice(lo + 1).filter((f) => f.kind === 'dir').reverse();
  const f = open.find((x) => !r.name || x.name === r.name);
  if (!f && !r.name) report('block.stray-closer', pos, te, 'this `:::` closes nothing: no container is open here', 'remove it, or open a container above it');
  else if (!f) {
    const names = open.map((x) => `\`:::${x.name}\``).join(', ') || 'none';
    report('block.closer-mismatch', fi, te, `no \`:::${r.name}\` is open to close (open: ${names}); the line is text`, open.length ? `write \`:::/${open[0].name}\` or \`:::\`` : 'remove it');
  }
  if (!f) return paraLine(fi, te, OWN, false);
  const alt = open.find((x) => x !== f && x.n === r.n);
  if (!r.name && r.n !== f.n) report('block.closer-count', fi, te, `this \`${':'.repeat(r.n)}\` closes \`:::${f.name}\` (line ${lineOf(f.open)}); colon counts do not choose the block`, `write \`:::/${(alt || f).name}\``);
  closeFrames(stack.indexOf(f) + 1, null);
  f.end = te;
  if (leaf) closeLeaf(-1);
  popFrame(false);
}

// A `+++` at a container's own level starts a cell; the first one wraps what came before.
function cell(r, fi, te) {
  let k = stack.length - 1;
  while (stack[k].kind === 'cell') k--;
  const d = stack[k];
  if (d.kind !== 'dir') return report('cell.orphan', pos, te, '`+++` separates cells only directly inside a container; this is text', 'move it to the container’s own level'), paraLine(fi, te, OWN, false);
  const pa = begin();
  if (pa) orphan(pa);
  closeFrames(k + 1, null);
  const kids = d.node.children;
  const body = d.cells ? [] : kids.splice(d.body);
  d.cells = true;
  if (body.length) kids.push({ type: 'cell', children: body, position: ctx.position(body[0].position.start.offset, body[body.length - 1].position.end.offset) });
  const node = { type: 'cell', children: [] };
  attach(node, null, r.res);
  kids.push(node);
  push({ kind: 'cell', node, start: fi, end: te });
}

function closeFrames(m, hint) {
  if (stack.length > m && leaf) closeLeaf(-1);
  while (stack.length > m) popFrame(true, hint);
  unclosedWhat = null;
}

// A frame's position runs at least to its last child's end; a list's to its last item's.
function popFrame(unclosed, hint) {
  const f = stack.pop();
  if (f.kind !== 'cell') depth--;
  const kids = f.node.children;
  const end = Math.max(f.end, kids.length ? kids[kids.length - 1].position.end.offset : 0);
  f.node.position = ctx.position(f.start, end);
  if (f.kind === 'item') f.list.node.position = { start: f.list.p0 || (f.list.p0 = ctx.point(f.list.start)), end: f.node.position.end };
  if (f.kind === 'dir' && unclosed) unclosedDir(f, [unclosedWhat, hint].filter(Boolean).join('; '));
}

function unclosedDir(f, extra) {
  report('block.unclosed', f.open, f.ne, `\`:::${f.name}\` opened on line ${lineOf(f.open)} is still open at line ${lineNo}`, `add \`:::\` or \`:::/${f.name}\`${extra ? `; ${extra}` : ''}`);
}

// ------------------------------------------------------------ metadata

// A top-level `:::meta` body: `key: value` lines into root.data.tern.meta.
// The first value of a key wins, and a value the preserved head sets wins
// over it (meta.conflict).
function readMeta(v) {
  if (stack.length > 1) return report('meta.nested', v.open, v.ne, '`:::meta` counts only at the top level; this one is ignored', 'move it to the top of the note');
  meta = meta || Object.create(null);
  v.lines.forEach((s, k) => {
    const at = v.at[k];
    const m = metaLine(s);
    const value = m && m[2].replace(/[ \t]+$/, '');
    if (!/[^ \t]/.test(s)) return;
    if (!m) return report('meta.malformed', at, at + s.replace(/[ \t]+$/, '').length, 'a `:::meta` line is `key: value`', 'write `key: value`, unindented, the key starting with a letter');
    if (m[1] in meta) return report('meta.duplicate', at, at + m[1].length, `\`${m[1]}\` is already set; the first value wins`, 'remove one of them');
    const h = headValue(m[1]);
    const differs = h !== undefined && (m[1] === 'lang' ? h.toLowerCase() !== value.toLowerCase() : h !== value);
    if (differs) report('meta.conflict', at, at + m[1].length, `the head sets \`${m[1]}\` to "${h}"; the head wins`, 'set each key in one place');
    meta[m[1]] = differs ? h : value;
  });
}

// What the preserved head (opts.head) sets: <title>, <html lang dir>, <meta name content>.
function headValue(key) {
  if (!head) {
    head = Object.create(null);
    const h = String(ctx.opts.head || '');
    const attr = (tag, name) => (new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag) || []).slice(1).find((x) => x !== undefined);
    const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(h);
    if (t) head.title = t[1].trim();
    const html = /<html\b[^>]*>/i.exec(h);
    for (const k of html ? ['lang', 'dir'] : []) if (attr(html[0], k) !== undefined) head[k] = attr(html[0], k);
    for (const tag of h.match(/<meta\b[^>]*>/gi) || []) {
      const n = attr(tag, 'name'), c = attr(tag, 'content');
      if (n !== undefined && c !== undefined && !(n in head)) head[n] = c;
    }
  }
  return head[key];
}

// ------------------------------------------------------------ the pass

// Each row kind's handler, (r, fi, te).
const ACT = { para: (r, fi, te) => paraLine(fi, te, r, false), closer, opener, fence, html, heading, hr, table, delim: table, cell, leaf: leafLine, math, math1, attrs: attrLine };

function parseBlocks(c) {
  (ctx = c), (src = c.src), (N = src.length), (MAX = c.opts.maxDepth || 64);
  root = { type: 'root', children: [] };
  stack = [{ kind: 'root', node: root, start: 0, end: 0, fn: 0 }];
  leaf = unclosedWhat = meta = head = front = null;
  (depth = lineNo = 0), (prevBlank = false);
  for (ls = 0; ls < N; ls = le + 1) {
    le = src.indexOf('\n', ls);
    if (le < 0) le = N;
    lineNo++;
    pos = ls;
    col = partial = 0;
    runAt = -1;
    line();
  }
  if (leaf) closeLeaf(-1);
  closeFrames(1, null);
  root.position = ctx.position(0, N);
  if (meta) root.data = { tern: { meta } };
  const out = root;
  (ctx = root = stack = rl = meta = head = front = null), (src = ''), (cells.length = 0); // keep nothing of this note alive
  return out;
}

module.exports = { parseBlocks };
