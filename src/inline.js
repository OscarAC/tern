// SPDX-License-Identifier: MIT
// The inline parser: one left-to-right pass, no recursion, linear time. `]`
// is resolved on the bracket stack as it is met, delimiter runs by CommonMark
// 0.31.2's process_emphasis. Atoms (escapes, code, math, autolinks, raw tags,
// entities, references, footnote references) are opaque to every other rule.
//
//   parseInline(ctx, span, opts) -> node[]
//     opts.context: 'paragraph' | 'heading' | 'title' | 'leaf' | 'cell'; a
//     `\` before a newline is a hard break in paragraphs and cells only.
//     opts.footnote: inside a footnote definition (references stay text).
//   atomRanges(text) -> [start, end, ...]
//     the atoms of text, found by the same pass with no brackets resolved,
//     so atoms inside a link destination or a glued group, which the parser
//     reads as such, are listed too. block.js splits table rows and matches
//     title brackets with it, so it sees the atoms this parser will.
//
// AST conventions beyond mdast (data.tern fields: docs/api.html#data-tern):
//   - text and soft breaks merge into one text node; a hard break includes
//     its line ending;
//   - an entity is its own text node: `value` is the decoded character(s),
//     `data.tern.entity` the source spelling (`&nbsp;`), which the emitter
//     writes back unchanged; entities never merge with neighbouring text;
//   - a bare span `[x]{.c}` is {type: 'span', attributes, children};
//   - inline elements are textDirective, references ref {id}, footnote
//     references footnoteReference {identifier, label} (identifier
//     case-folded and lower-cased, as mdast; label as written), raw tags and
//     comments html with data.tern.kind 'inline';
//   - a glued group is `attributes`, inside the node's position;
//   - a link's url is normalised and its title is present only when given;
//     an image has a plain-text alt and no children, and its bracket
//     content as inline nodes in data.tern.caption; an autolink is a
//     link whose url is as written (`mailto:` added to an e-mail address).
'use strict';

const { spanStart, spanEnd, spanPosition } = require('./ast');
const scan = require('./scan');
const { decode } = require('./entities');
const { matchAt, isAsciiAlnum, isAsciiPunct, parseAttrs, isReservedName } = scan;
const words = (s) => new Set(s.split(' '));
// Raw inline HTML: the phrasing tags that pass through (lower-case only, so
// generics such as `List<B>` stay text), those taken verbatim to their end
// tag, and the current HTML elements, for which an escaped start tag gets
// html.inline-escaped.
const PHRASING = words(
  'a abbr audio b bdi bdo br button canvas cite code data datalist del dfn em embed i iframe img input ins kbd label mark meter object optgroup option output picture progress q rp rt ruby s samp select small source span strong sub sup time track u var video wbr',
);
const VERBATIM = words('svg math textarea');
const UNTRACKED = words('br embed img input source track wbr rt rp option optgroup'); // void, or end tag optional: never unclosed or stray
const CURRENT = words(
  'address area article aside base blockquote body caption col colgroup dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html legend li link main map menu meta nav noscript ol p pre script search section slot style summary table tbody td template tfoot th thead title tr ul svg math textarea',
);
for (const t of PHRASING) CURRENT.add(t);
const NOT_CUSTOM = words('annotation-xml color-profile font-face font-face-src font-face-uri font-face-format font-face-name missing-glyph');
// The custom-element rule in ASCII: OPEN_TAG only matches ASCII names anyway.
const isCustom = (name) => /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(name) && !NOT_CUSTOM.has(name);
const passes = (name) => PHRASING.has(name) || isCustom(name);

const SPECIAL = new Uint8Array(128); // what can start an atom, a bracket or a delimiter run; the rest is copied as text
for (const c of '\\`$<&hH@[!:]*~=') SPECIAL[c.charCodeAt(0)] = 1;
const special = (k) => k < 128 && SPECIAL[k] === 1;
// Whether anything can start in t; most cells and short paragraphs are one
// text node, with no atoms.
function starts(t) {
  for (let k = 0; k < t.length; k++) {
    const c = t.charCodeAt(k);
    if (special(c) && c !== 104 && c !== 72) return true; // h, H: only in http(s)://
  }
  return t.includes('://') && /https?:\/\//i.test(t);
}
// CommonMark's grammars for angle autolinks and raw tags; a quoted attribute
// value may hold `>`.
const AUTO_URI = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20\x7f]*)>/y;
const AUTO_MAIL = /<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;
const OPEN_TAG = /<([A-Za-z][A-Za-z0-9-]*)(?:[ \t\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t\n]*\/?>/y;
const CLOSE_TAG = /<\/([A-Za-z][A-Za-z0-9-]*)[ \t\n]*>/y;
const END_TAG = new Map(); // name -> the regex for its end tag
const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,47});/y;
const BARE = /https?:\/\//iy;
const BARE_TAIL = /[^\s<>[\]{}|`"]*/y;
const ESCAPES = /\\([!-/:-@[-`{-~])|&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,47});/g;
const URL_UNSAFE = /%(?![0-9a-fA-F]{2})|[^\w;/?:@&=+$,\-.!~*'()#%]+/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const UNI_WS = /[\t\n\f\r\p{Zs}]/u;
const UNI_PUNCT = /[\p{P}\p{S}]/u;
const REF_TEXT = words('label number title full');
const ID_VALUE = /[^\s"'=<>`{}]*/y; // an unquoted id= value, as block.js measures it

// Which `{…}` a construct takes when the group is glued right after it.
const STRONG = 0; // strong groups only: code, math, autolinks, footnote references, `*` `~~` `==` closers
const ANY = 1; // any group: links, images, inline elements
const REF = 2; // like ANY, and `{}` is consumed as a terminator: `@kernel{}です`

// Item kinds. TXT is text, its source slice when v is null; OWN is source
// text a delimiter run or a held-aside group still owns, so nothing merges
// into it; ENT is an entity (v decoded, n the spelling); LEAF holds node n;
// PARENT holds node n and its children, the item list starting at v.
const TXT = 0;
const OWN = 1;
const ENT = 2;
const LEAF = 3;
const PARENT = 4;
const isWs = (c) => c === ' ' || c === '\t' || c === '\n';
const JS_SPACE = /\s/;

// Backslash escapes and entities, for link destinations and titles.
const unescape = (s) =>
  s.replace(ESCAPES, (m, p, body) => {
    const v = p ? p : decode(body);
    return v === null ? m : v;
  });

// CommonMark's normalisation: percent-encode what is unsafe or non-ASCII,
// keep an existing %XX. A lone surrogate, which encodeURIComponent rejects,
// becomes U+FFFD.
const normaliseUrl = (url) => url.replace(URL_UNSAFE, (m) => (m === '%' ? '%25' : encodeURIComponent(m.replace(LONE_SURROGATE, '\ufffd'))));

// A code span's content: newlines become spaces; one space is stripped from
// each end when both are there and the content is not all spaces.
function codeContent(s) {
  s = s.replace(/\n/g, ' ');
  return s.length > 1 && s[0] === ' ' && s[s.length - 1] === ' ' && /[^ ]/.test(s) ? s.slice(1, -1) : s;
}

// The first entry of the sorted array `a` that is >= q, or -1.
function after(a, q) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < q) lo = mid + 1;
    else hi = mid;
  }
  return lo < a.length ? a[lo] : -1;
}

// For math.suspect-price: whether the TeX holds a run of three or more ASCII
// letters after whitespace, outside control words and their arguments
// (every braced group that follows a control word, whitespace allowed
// before each: `\frac{ abc}{ def}`). After a `$` and a digit, words suggest
// the `$` is a price: `$5 then x$`.
function suspect(tex) {
  const letter = (k) => /[A-Za-z]/.test(tex[k] || '');
  for (let k = 0; k < tex.length; ) {
    if (tex[k] === '\\') {
      if (!letter(++k)) {
        k++;
        continue;
      }
      while (letter(k)) k++;
      for (;;) {
        let j = k;
        while (isWs(tex[j])) j++;
        if (tex[j] !== '{') break;
        let depth = 0;
        for (k = j; k < tex.length; k++) {
          if (tex[k] === '\\') k++;
          else if (tex[k] === '{') depth++;
          else if (tex[k] === '}' && !--depth) break;
        }
        k++;
      }
    } else if (letter(k)) {
      const s = k;
      while (letter(k)) k++;
      if (k - s >= 3 && isWs(tex[s - 1])) return true;
    } else k++;
  }
  return false;
}
const NO_OPTS = {};
function parseInline(c, sp, o) {
  const t = sp.text;
  if (!t) return [];
  if (!starts(t)) return [{ type: 'text', value: t, position: spanPosition(c, sp, 0, t.length) }];
  return run(c, sp, t, 0, o || NO_OPTS, false);
}
function atomRanges(t) {
  if (!starts(t)) return [];
  return run(null, null, t, 0, NO_OPTS, true);
}

// ---- the state of one call, at module level so the functions below are made
// once and keep their optimised code. The parser is not reentrant: run()
// sets all of it, and drops what it holds on to when it returns.
let ctx, span, opts, text, from, to, atomMode; // atomMode: atomRanges' pass, which builds no items
let ranges; // the atoms found, in atom mode
let ticks; // run length -> sorted starts of maximal backtick runs, built on first use
let dollarQ, dollarAt, commentQ, commentAt; // forward-only caches: a search from q is reused while its answer lies ahead
let endTags; // tag name -> {q, at, end} for its next end tag
let openTags; // tag name -> start and end of each open tag not yet closed
let head, tail; // the item list
let dtop; // top of the delimiter stack
// Each bracket opener gets a serial number. One numbered below linkSerial was
// pushed before the last link closed, so it encloses that link and cannot
// become a link itself (no links in links); images, spans and elements can.
let serial, linkSerial;
const brackets = []; // the bracket stack, four slots per opener: its text item, index, serial, dtop
const linkables = []; // bare URLs and references so far; those inside a link's text turn back into text
const bottoms = Array.from({ length: 18 }, () => null); // openers_bottom by character, can-open, length % 3
let bottomsSet = false; // whether bottoms needs clearing
const latexOpen = [-1, -1]; // the pending `\(` and `\[` escapes
let latexAt; // where latex.delimiters would go, or Infinity

function run(c, sp, t, f, o, atoms) {
  (ctx = c), (span = sp), (opts = o), (text = t), (from = f), (to = t.length), (atomMode = atoms), (ranges = atoms ? [] : null);
  dollarQ = dollarAt = commentQ = commentAt = latexOpen[0] = latexOpen[1] = -1;
  latexAt = Infinity;
  serial = linkSerial = 0;
  head = tail = dtop = null;
  const out = scanAll();
  ctx = span = opts = ranges = ticks = endTags = openTags = head = tail = dtop = null;
  text = '';
  if (brackets.length) brackets.length = 0; // setting length is slow, even to what it is
  if (linkables.length) linkables.length = 0;
  return out;
}

// ---- searches ahead. They go through a table built on first use or a cache
// that only moves forward, so the scan stays linear.

// The first backtick run of exactly `len` that starts at or after q, or -1.
function closingRun(len, q) {
  if (!ticks) {
    ticks = [];
    for (let i = text.indexOf('`', from), j; i !== -1; i = text.indexOf('`', j)) {
      for (j = i + 1; text[j] === '`'; ) j++;
      (ticks[j - i] || (ticks[j - i] = [])).push(i);
    }
  }
  return ticks[len] ? after(ticks[len], q) : -1;
}
// Whether text[i] is escaped: an odd number of backslashes before it.
function escaped(i) {
  let k = i - 1;
  while (k >= from && text[k] === '\\') k--;
  return (i - 1 - k) % 2 === 1;
}
// The next unescaped `$` from q, or -1.
function nextDollar(q) {
  if (dollarQ < 0 || dollarQ > q || (dollarAt >= 0 && dollarAt < q)) {
    dollarAt = text.indexOf('$', (dollarQ = q));
    while (dollarAt !== -1 && escaped(dollarAt)) dollarAt = text.indexOf('$', dollarAt + 1);
  }
  return dollarAt;
}
// The line breaks in text[a, b), up to 2. No unescaped `$` lies between an
// opener and its candidate, so the ranges counted are disjoint.
function lineBreaks(a, b) {
  let n = 0;
  for (let k = a; k < b && n < 2; k++) if (text.charCodeAt(k) === 10) n++;
  return n;
}
// The next `-->` from q, or -1; cached as nextDollar is.
function commentEnd(q) {
  if (commentQ < 0 || commentQ > q || (commentAt >= 0 && commentAt < q)) commentAt = text.indexOf('-->', (commentQ = q));
  return commentAt;
}
// The next end tag of `name` from q, as {q, at, end}; cached per name.
function endTag(name, q) {
  if (!endTags) endTags = new Map();
  let c = endTags.get(name);
  if (!c || c.q > q || (c.at >= 0 && c.at < q)) {
    let re = END_TAG.get(name);
    if (!re) END_TAG.set(name, (re = new RegExp(`</${name}[ \\t\\n]*>`, 'gi')));
    re.lastIndex = q;
    const m = re.exec(text);
    endTags.set(name, (c = { q, at: m ? m.index : -1, end: m ? re.lastIndex : -1 }));
  }
  return c;
}
const exec = (re, i) => ((re.lastIndex = i), re.exec(text));

// ---- the item list: a doubly linked list of items in source order. Brackets
// and emphasis wrap a run of items into a PARENT item; build() turns the list
// into nodes.
const item = (k, s, e) => ({ k, s, e, v: null, n: null, prev: null, next: null });
function append(it) {
  it.prev = tail;
  if (tail) tail.next = it;
  else head = it;
  return (tail = it);
}
function insertAfter(a, it) {
  it.prev = a;
  it.next = a.next;
  if (a.next) a.next.prev = it;
  else tail = it;
  a.next = it;
}
// Makes text[a, b) of the source text item X an item of its own.
function split(X, a, b) {
  if (X.e > b) {
    insertAfter(X, item(TXT, b, X.e));
    X.e = b;
  }
  if (X.s === a) return X;
  const it = item(TXT, a, b);
  insertAfter(X, it);
  X.e = a;
  return it;
}
function unlink(it) {
  if (it.prev) it.prev.next = it.next;
  else head = it.next;
  if (it.next) it.next.prev = it.prev;
  else tail = it.prev;
}
// Moves the items between a and b (b null: to the end) into C, and puts C there.
function wrap(a, b, C) {
  const first = a.next;
  if (first && first !== b) {
    C.v = first;
    first.prev = null;
    (b ? b.prev : tail).next = null;
  }
  a.next = C;
  C.prev = a;
  C.next = b;
  if (b) b.prev = C;
  else tail = C;
}
// Adds text[s, e), or v standing for it; returns e.
function lit(s, e, v) {
  if (atomMode) return e;
  if (v === undefined && tail && tail.k === TXT && tail.v === null && tail.e === s) tail.e = e;
  else append(item(TXT, s, e)).v = v === undefined ? null : v;
  return e;
}
const str = (it) => (it.v === null ? text.slice(it.s, it.e) : it.v);
const pos = (s, e) => spanPosition(ctx, span, s, e);
// JavaScript's \s, at text[k], with an ASCII fast path.
const spaceAt = (k) => {
  const c = text.charCodeAt(k);
  return c < 128 ? c === 32 || (c >= 9 && c <= 13) : JS_SPACE.test(text[k]);
};
const offset = (k) => spanStart(span, k);
function rep(code, s, e, message, hint) {
  if (atomMode) return;
  const a = spanStart(span, s);
  ctx.report(code, a, e > s ? spanEnd(span, e) : a, message, hint);
}

// ---- glued groups: a `{…}` right after a construct is its attributes

// Whether a backtick in text[a, b) would open a code span. Code spans bind
// tighter than groups and link destinations, so such a group or destination
// is not one.
function codeInside(a, b) {
  for (let k = text.indexOf('`', a); k !== -1 && k < b; ) {
    let e = k + 1;
    while (text[e] === '`') e++;
    const s = escaped(k) ? k + 1 : k;
    if (s < e && closingRun(e - s, e) >= 0) return true;
    k = text.indexOf('`', e);
  }
  return false;
}
const malformed = (res) =>
  rep('attr.malformed', res.bad, res.bad + 1, `this attribute group does not parse at "${text[res.bad]}"`, 'attributes are {#id .class key=value}; quote a value that holds spaces');
// A failed group where only strong ones bind is reported only when it starts with `#` or `.`.
const hashOrDot = (at) => /[#.]/.test(text[scan.skipWs(text, at + 1, to)]);
// Gives the item's node the group's attributes, and extends the item over it.
// Under data.tern it records where the author's id is written (idPosition)
// and where reserved keys that may not apply are (tagPosition, refPosition,
// rawPosition, colsPosition): the transforms point their diagnostics there.
function bind(it, res) {
  const n = it.n;
  n.attributes = res.attrs;
  it.e = res.end;
  scan.reportReserved(ctx, res, offset);
  const a = res.idAt; // the `#id` item, or the whole `id=value` one, as block.js records it
  if (a >= 0) {
    const q = text[a + 3];
    const e = text[a] === '#' ? matchAt(scan.IDENT, text, a + 1) : q === '"' || q === "'" ? text.indexOf(q, a + 4) + 1 : matchAt(ID_VALUE, text, a + 3);
    n.data = { tern: { idPosition: pos(a, Math.max(e, a + 1)) } };
  }
  const { ref, tag } = res.attrs;
  if (tag !== undefined) {
    const k = res.keyAt.tag; // for tag.not-allowed, on any node: off an inline element, `tag=` is refused
    ((n.data || (n.data = {})).tern || (n.data.tern = {})).tagPosition = pos(k, k + 3);
  }
  // Reserved keys where they do not apply, for attr.malformed: `ref` off
  // references, `raw` anywhere inline, `cols` off inline elements.
  const keys = res.keyAt;
  if (ref !== undefined && n.type !== 'ref') keyPosition(n, 'refPosition', keys.ref, 3);
  if (keys.raw !== undefined) keyPosition(n, 'rawPosition', keys.raw, 3);
  if (keys.cols !== undefined && n.type !== 'textDirective') keyPosition(n, 'colsPosition', keys.cols, 4);
  if (n.type === 'ref' && ref !== undefined && !REF_TEXT.has(ref)) {
    const at = res.keyAt.ref + 4 + (/["']/.test(text[res.keyAt.ref + 4]) ? 1 : 0);
    rep('attr.malformed', at, at + Math.max(ref.length, 1), `ref=${ref} is not one of label, number, title, full`, 'write {ref=label}, {ref=number}, {ref=title} or {ref=full}');
  }
  if (n.type === 'textDirective' && tag !== undefined && isReservedName(tag))
    rep('name.reserved', res.keyAt.tag, res.keyAt.tag + 3, `tag=${tag} names a reserved element and is ignored`, 'choose a phrasing element such as kbd or abbr');
}
const keyPosition = (n, field, k, length) => (((n.data || (n.data = {})).tern || (n.data.tern = {}))[field] = pos(k, k + length));
// Binds the group at `at`, if there is one that `mode` takes, to item it;
// returns where the scan goes on.
function glue(it, at, mode) {
  if (text[at] !== '{') return at;
  const res = parseAttrs(text, at, to);
  if (!res) return at;
  if (res.empty) return mode === REF ? (it.e = res.end) : at; // `{}` ends a reference
  if (res.ok) {
    if ((mode === STRONG && !res.strong) || codeInside(at, res.end)) return at;
    bind(it, res);
    return res.end;
  }
  if (mode !== STRONG || hashOrDot(at)) malformed(res);
  return at;
}
// An atom over text[s, e): a range in atom mode, else a leaf item holding
// node, which takes a glued group when `mode` is given.
function atom(s, e, node, mode) {
  if (atomMode) {
    ranges.push(s, e);
    return e;
  }
  const it = append(item(LEAF, s, e));
  it.n = node;
  return mode === undefined ? e : glue(it, e, mode);
}

// ---- delimiter runs: `*` runs of any length, `~~` and `==` runs of exactly
// two (other lengths are text); `_` is never a delimiter. A run's record
// holds its item (whose first character and length are the run's), its
// original length, whether it can open and close, its neighbours on the
// stack, and g: a group glued after it, held aside until the run closes, or
// a malformed one. Which node the group belongs to is known only then, and
// if the run never closes the group stays text.

function dremove(d) {
  if (d.prev) d.prev.next = d.next;
  if (d.next) d.next.prev = d.prev;
  else dtop = d.prev;
}
// CommonMark's character classes for flanking, with an ASCII fast path:
// 1 whitespace (and the edges), 2 punctuation, 0 anything else. A low
// surrogate is classed by the whole character it ends.
function flankClass(i) {
  if (i < from || i >= to) return 1;
  const c = text.charCodeAt(i);
  if (c < 128) return c === 32 || (c >= 9 && c <= 13) ? 1 : isAsciiPunct(c) ? 2 : 0;
  const ch = String.fromCodePoint(c >= 0xdc00 && c <= 0xdfff && i > from ? text.codePointAt(i - 1) : text.codePointAt(i));
  return UNI_WS.test(ch) ? 1 : UNI_PUNCT.test(ch) ? 2 : 0;
}
// A run can open when the next character is not whitespace, nor punctuation
// unless whitespace or punctuation comes before (left-flanking); closing is
// the mirror. `~~` and `==` also cannot open after an ASCII letter or digit,
// nor close before one, so `a==b` is text; ASCII only, so `これは==重要==です`
// works.
function delim(i) {
  const ch = text[i];
  let k = i + 1;
  while (text[k] === ch) k++;
  if (atomMode) return k;
  if (ch !== '*' && k - i !== 2) return lit(i, k);
  const b = flankClass(i - 1);
  const a = flankClass(k);
  let open = a !== 1 && (a !== 2 || b !== 0);
  let close = b !== 1 && (b !== 2 || a !== 0);
  if (ch !== '*') {
    open = open && !isAsciiAlnum(text.charCodeAt(i - 1));
    close = close && !isAsciiAlnum(text.charCodeAt(k));
  }
  if (!open && !close) return lit(i, k);
  const d = { it: append(item(OWN, i, k)), orig: k - i, open, close, prev: dtop, next: null, g: null };
  if (dtop) dtop.next = d;
  dtop = d;
  if (!close || text[k] !== '{') return k;
  const res = parseAttrs(text, k, to);
  if (res && res.ok && res.strong && !codeInside(k, res.end)) {
    d.g = { res, it: append(item(OWN, k, res.end)) };
    return res.end;
  }
  if (res && res.ok === false && hashOrDot(k)) d.g = { res, it: null };
  return k;
}
// CommonMark 0.31.2 process_emphasis over the delimiters above `bottom`.
// `bottoms` records how far down an opener search already failed, so no
// search repeats: that keeps it linear. The rule of three applies to `*`
// only.
function processEmphasis(bottom) {
  if (dtop === bottom) return;
  if (bottomsSet) for (let k = 0; k < 18; k++) bottoms[k] = null;
  bottomsSet = false;
  let closer = dtop;
  while (closer && closer.prev !== bottom) closer = closer.prev;
  while (closer) {
    if (!closer.close) {
      closer = closer.next;
      continue;
    }
    const ch = text[closer.it.s];
    const key = (ch === '*' ? 0 : ch === '~' ? 6 : 12) + (closer.open ? 3 : 0) + (closer.orig % 3);
    let op = closer.prev;
    while (op && op !== bottom && op !== bottoms[key]) {
      if (text[op.it.s] === ch && op.open && !(ch === '*' && (closer.open || op.close) && closer.orig % 3 && !((op.orig + closer.orig) % 3))) break;
      op = op.prev;
    }
    if (!op || op === bottom || op === bottoms[key]) {
      bottoms[key] = closer.prev;
      bottomsSet = true;
      const next = closer.next;
      if (!closer.open) dremove(closer);
      closer = next;
      continue;
    }
    const use = ch === '*' && (closer.it.e - closer.it.s < 2 || op.it.e - op.it.s < 2) ? 1 : 2;
    op.it.e -= use;
    closer.it.s += use;
    const C = item(PARENT, op.it.e, closer.it.s);
    C.n = { type: ch === '~' ? 'delete' : ch === '=' ? 'mark' : use === 2 ? 'strong' : 'emphasis', children: null, position: null };
    wrap(op.it, closer.it, C);
    op.next = closer;
    closer.prev = op;
    if (op.it.s === op.it.e) {
      unlink(op.it);
      dremove(op);
    }
    if (closer.it.s === closer.it.e) {
      unlink(closer.it);
      dremove(closer);
      const g = closer.g; // the group binds to the outermost node: `***x***{.c}` to the em
      if (g && g.it) {
        unlink(g.it);
        bind(C, g.res);
      } else if (g) malformed(g.res);
      closer = closer.next;
    }
  }
  dtop = bottom;
  if (bottom) bottom.next = null;
}

// ---- brackets. An opener stays plain text, so one that never closes costs
// nothing; it is split out of its text item when it closes.

function pushBracket(i, len) {
  if (atomMode) return i + len;
  lit(i, i + len);
  brackets.push(tail, i, serial++, dtop);
  return i + len;
}
// Ends a bracket construct: the items after the opener become C's children.
function finish(op, bottom, C, keepBang) {
  processEmphasis(bottom);
  wrap(op, null, C);
  if (keepBang) op.e = op.s + 1;
  else unlink(op);
}
function skipWs(j) {
  while (isWs(text[j])) j++;
  return j;
}
// A link's `(destination "title")` from the `(` at `at`, as CommonMark's:
// `<…>`, or a run with no space or control character whose parentheses
// balance, at most 32 deep. Returns {url, title, end} or null.
function destination(at) {
  let j = skipWs(at + 1);
  let raw;
  if (text[j] === '<') {
    let k = j + 1;
    for (; k < to && text[k] !== '>' && text[k] !== '<' && text[k] !== '\n'; k++) if (text[k] === '\\' && isAsciiPunct(text.charCodeAt(k + 1))) k++;
    if (text[k] !== '>') return null;
    raw = text.slice(j + 1, k);
    j = k + 1;
  } else {
    let k = j;
    let depth = 0;
    for (; k < to; k++) {
      const c = text[k];
      if (c === '\\' && isAsciiPunct(text.charCodeAt(k + 1))) k++;
      else if (c <= ' ') break;
      else if (c === '(' && ++depth > 32) return null;
      else if (c === ')') {
        if (!depth) break;
        depth--;
      }
    }
    if (depth) return null;
    raw = text.slice(j, k);
    j = k;
  }
  let title;
  const k0 = j;
  j = skipWs(j);
  const q = text[j];
  if ((q === '"' || q === "'") && j > k0) {
    let k = j + 1;
    for (; k < to && text[k] !== q; k++) if (text[k] === '\\' && isAsciiPunct(text.charCodeAt(k + 1))) k++;
    if (k >= to) return null;
    title = unescape(text.slice(j + 1, k));
    j = skipWs(k + 1);
  }
  if (text[j] !== ')' || codeInside(at, j + 1)) return null;
  return { url: normaliseUrl(unescape(raw)), title, end: j + 1 };
}
// The plain text of an item list, for an image's alt.
function plain(first) {
  let out = '';
  const stack = [first];
  while (stack.length) {
    const it = stack.pop();
    if (!it) continue;
    stack.push(it.next);
    if (it.k <= ENT) out += str(it);
    else if (it.k === PARENT) stack.push(it.v);
    else {
      const n = it.n;
      if (n.type === 'inlineCode' || n.type === 'inlineMath') out += n.value;
      else if (n.type === 'image') out += n.alt;
      else if (n.type === 'link') out += n.children[0].value;
      else if (n.type === 'break') out += '\n';
    }
  }
  return out;
}
// `]` closes the nearest opener: `:NAME[` always makes an element; otherwise
// `](…)` makes a link or image, else `]{…}` a span (`![x]{.c}` is `!` and a
// span); else the `]` and its opener stay text.
function closeBracket(i) {
  if (atomMode) return i + 1;
  if (!brackets.length) return lit(i, i + 1);
  const bottom = brackets.pop();
  const ser = brackets.pop();
  const s = brackets.pop();
  const X = brackets.pop();
  const kind = text[s]; // `[`, `!` or `:`
  const e = kind === '[' ? s + 1 : kind === '!' ? s + 2 : text.indexOf('[', s) + 1;
  if (kind === ':') {
    const name = text.slice(s + 1, e - 1);
    const C = item(PARENT, s, i + 1);
    C.n = { type: 'textDirective', name, children: null, position: null };
    finish(split(X, s, e), bottom, C);
    if (isReservedName(name)) rep('name.reserved', s + 1, e - 1, `:${name}[ uses a reserved name, so it is a plain span`, 'choose another name');
    return glue(C, i + 1, ANY);
  }
  if (text[i + 1] === '(' && (kind === '!' || ser >= linkSerial)) {
    const d = destination(i + 1);
    if (d) {
      while (linkables.length && linkables[linkables.length - 1].s > s) {
        const it = linkables.pop();
        it.k = TXT;
        it.n = null;
      }
      const C = item(PARENT, s, d.end);
      C.n = { type: kind === '!' ? 'image' : 'link', url: d.url };
      if (d.title !== undefined) C.n.title = d.title;
      finish(split(X, s, e), bottom, C);
      if (kind === '!') C.n.alt = plain(C.v); // its items become data.tern.caption (build)
      else linkSerial = serial;
      return glue(C, d.end, ANY);
    }
  }
  if (text[i + 1] === '{') {
    const res = parseAttrs(text, i + 1, to);
    if (res && res.ok && !codeInside(i + 1, res.end)) {
      const C = item(PARENT, kind === '!' ? s + 1 : s, res.end);
      C.n = { type: 'span', children: null, position: null };
      finish(split(X, s, e), bottom, C, kind === '!');
      bind(C, res);
      return res.end;
    }
    if (res && res.ok === false) malformed(res);
  }
  return lit(i, i + 1);
}

// ---- atoms and openers, one function per special character

// `\`: an escape before ASCII punctuation, a hard break before a newline
// (paragraphs and cells only), else a literal backslash. It also watches for
// LaTeX's `\(…\)`, `\[…\]` and a `\begin{` at a line start, for the
// once-per-note latex.delimiters hint.
function backslash(i) {
  const nx = text[i + 1];
  if (i + 1 < to && isAsciiPunct(text.charCodeAt(i + 1))) {
    if (atomMode) return atom(i, i + 2);
    const p = '(['.indexOf(nx);
    const q = ')]'.indexOf(nx);
    if (p >= 0 && latexOpen[p] < 0) latexOpen[p] = i;
    if (q >= 0 && latexOpen[q] >= 0) {
      if (latexOpen[q] < latexAt && texInside(latexOpen[q] + 2, i, q)) latexAt = latexOpen[q];
      latexOpen[q] = -1;
    }
    if (nx === '\\' && text[i + 2] === '\n')
      rep('latex.linebreak', i, i + 2, '`\\\\` at the end of a line is a backslash followed by a soft break, not a line break', 'a line break is a single trailing `\\`');
    return lit(i, i + 2, nx);
  }
  if (nx === '\n' && (!opts.context || opts.context === 'paragraph' || opts.context === 'cell')) return atomMode ? i + 2 : atom(i, i + 2, { type: 'break', position: null });
  if (i < latexAt && (i === from || text[i - 1] === '\n') && text.startsWith('\\begin{', i)) latexAt = i;
  return lit(i, i + 1);
}
// LaTeX's delimiters: what lies between `\(` and `\)` counts when it is not
// blank, between `\[` and `\]` when it holds one of TeX's marks: `\` before a
// letter, or `{` `}` `^` `_` `&`. `\[` is also the escape for `[`, so
// `\[not a span\]` gets no hint. Escape pairs are skipped.
function texInside(a, b, square) {
  for (let k = a; k < b; k++) {
    const c = text[k];
    if (c === '\\' && isAsciiPunct(text.charCodeAt(k + 1))) k++;
    else if (square ? '{}^_&'.includes(c) || (c === '\\' && /[A-Za-z]/.test(text[k + 1] || '')) : !isWs(c)) return true;
  }
  return false;
}
// A code span: a run of n backticks closes at the next run of exactly n;
// without one, the run is text.
function backticks(i) {
  let k = i + 1;
  while (text[k] === '`') k++;
  const j = closingRun(k - i, k);
  if (j < 0) return lit(i, k);
  return atom(i, j + k - i, { type: 'inlineCode', value: codeContent(text.slice(k, j)), position: null }, STRONG);
}
// `$`. A `$$` inside a line is text. `$` then a backtick run is verbatim math,
// closed by a run of the same length, with no other rule (without one, the
// `$` is text). Otherwise the dollar rule: an opener is a `$` not next to
// another and not followed by whitespace, and the first unescaped `$` after
// it is its only candidate, so `$5 and $10` stays text. The candidate closes
// when it is not after whitespace, not before a digit or `$`, and at most one
// line break away. The bracket clause also rejects an opener followed by one
// of `) ] } , . ; :` and a candidate after an unescaped `( [ {`, as in
// `Price ($)`. A rejected opener is text, and the candidate gets its own
// chance to open. Examples: docs/syntax-inline.html#dollar-rule.
function dollar(i) {
  let d = i + 1;
  while (text[d] === '$') d++;
  if (d - i > 1) {
    rep('math.inline-display', i, d, '`$$` inside a line is text: display math goes on its own lines', 'for an inline display style write `$\\displaystyle …$`');
    return lit(i, d);
  }
  const nx = text[i + 1];
  if (nx === '`') {
    let k = i + 2;
    while (text[k] === '`') k++;
    const j = closingRun(k - i - 1, k);
    if (j >= 0) return atom(i, j + k - i - 1, { type: 'inlineMath', value: codeContent(text.slice(k, j)), position: null }, STRONG);
    return lit(i, i + 1);
  }
  if (i + 1 >= to || spaceAt(i + 1) || (i > from && text[i - 1] === '$' && !escaped(i - 1))) return lit(i, i + 1);
  const openBad = ')]},.;:'.includes(nx) ? nx : '';
  const j = nextDollar(i + 1);
  const pre = j < 0 ? '' : text[j - 1];
  const closeBad = j > 0 && '([{'.includes(pre) && !escaped(j - 1) ? pre : '';
  const other = j < 0 || spaceAt(j - 1) || /[0-9$]/.test(text[j + 1] || '') || lineBreaks(i, j) > 1;
  if (openBad || closeBad || other) {
    if (!other && (!openBad || openBad === ']') && (!closeBad || closeBad === '['))
      rep('math.bracket', i, i + 1, 'a `]` after the opening `$` or a `[` before the closing one keeps this from being math', `for an interval write verbatim math: $\`${text.slice(i + 1, j)}\``);
    if (!openBad && nx === '\\') rep('math.unclosed-inline', i, i + 1, 'this `$` is followed by TeX, but nothing closes it', 'close the formula with `$`, or write `\\$` for a dollar sign');
    return lit(i, i + 1);
  }
  const value = text.slice(i + 1, j);
  if (!atomMode && /[0-9]/.test(nx) && suspect(value))
    rep('math.suspect-price', i, i + 1, 'this formula starts with a digit and holds words: is the `$` a price?', 'if `$` is a price, write `\\$`');
  return atom(i, j + 1, { type: 'inlineMath', value, position: null }, STRONG);
}
// `<`: a comment (`<!-->` and `<!--->` are complete), an angle autolink, or
// a raw tag; else text. A tag passes when its name is lower-case and
// phrasing or custom; `<svg>`, `<math>`, `<textarea>` are taken verbatim to
// their end tag. Open tags are tracked for html.stray-closer and
// html.inline-unclosed. A single capital (`<B>`) gets html.inline-escaped only
// when its end tag follows, so `List<B>` stays silent.
const rawHtml = (s, e) => atom(s, e, { type: 'html', value: text.slice(s, e), data: { tern: { kind: 'inline' } }, position: null });
const autolink = (s, e, url, label) => atom(s, e, { type: 'link', url, children: [{ type: 'text', value: label, position: atomMode ? null : pos(s + 1, e - 1) }], position: null }, STRONG);
function angle(i) {
  let m;
  if (text.startsWith('<!--', i)) {
    const e = text.startsWith('<!-->', i) ? i + 5 : text.startsWith('<!--->', i) ? i + 6 : commentEnd(i + 4) + 3;
    if (e > i + 2) return rawHtml(i, e);
  } else if ((m = exec(AUTO_URI, i))) return autolink(i, AUTO_URI.lastIndex, m[1], m[1]);
  else if ((m = exec(AUTO_MAIL, i))) return autolink(i, AUTO_MAIL.lastIndex, 'mailto:' + m[1], m[1]);
  else if ((m = exec(OPEN_TAG, i))) {
    const e = OPEN_TAG.lastIndex;
    const name = m[1];
    const lower = name.toLowerCase();
    if (name === lower && VERBATIM.has(name)) {
      const c = endTag(name, e);
      if (c.at >= 0) return rawHtml(i, c.end);
    } else if (name === lower && passes(name)) {
      if (!UNTRACKED.has(name) && !atomMode) {
        if (!openTags) openTags = new Map();
        if (!openTags.has(name)) openTags.set(name, []);
        openTags.get(name).push(i, e);
      }
      return rawHtml(i, e);
    }
    if (name === lower && CURRENT.has(name)) rep('html.inline-escaped', i, e, `<${name}> is not an inline tag, so it is shown as text`, 'put block HTML on its own line');
    else if (name !== lower && CURRENT.has(lower) && (name.length > 1 || endTag(lower, e).at >= 0))
      rep('html.inline-escaped', i, e, `<${name}> is shown as text: inline tags are lower-case`, `inline tags are lower-case: write <${lower}>`);
  } else if ((m = exec(CLOSE_TAG, i)) && passes(m[1])) {
    const e = CLOSE_TAG.lastIndex;
    const open = openTags && openTags.get(m[1]);
    if (open && open.length) open.splice(-2);
    else if (!UNTRACKED.has(m[1])) rep('html.stray-closer', i, e, `</${m[1]}> closes no open <${m[1]}> in this paragraph`, `open it with <${m[1]}> earlier in the paragraph, or remove it`);
    return rawHtml(i, e);
  }
  return lit(i, i + 1);
}
// `&`: a numeric reference, or a named one HTML defines, is an entity item;
// any other `&` is text.
function amp(i) {
  const m = exec(ENTITY, i);
  const v = m ? decode(m[1]) : null;
  if (v === null) return lit(i, i + 1);
  const e = ENTITY.lastIndex;
  if (atomMode) return atom(i, e);
  const it = append(item(ENT, i, e));
  it.v = v;
  it.n = m[0];
  return e;
}
// A bare `http://` or `https://` URL, in any case, at the start or after
// whitespace or one of `( [ | * ~ = " ' >`; -1 when there is none at i. It
// stops at whitespace and ``< > [ ] { } | ` "``, then gives back trailing
// punctuation and an unbalanced final `)`, so a row-final `\` stays a table
// continuation.
function bare(i) {
  if (i > from && !/[\s([|*~="'>]/.test(text[i - 1])) return -1;
  if (!exec(BARE, i)) return -1;
  const s0 = BARE.lastIndex;
  exec(BARE_TAIL, s0);
  let e = BARE_TAIL.lastIndex;
  let opens = 0;
  let closes = 0;
  for (let k = s0; k < e; k++) {
    if (text[k] === '(') opens++;
    else if (text[k] === ')') closes++;
  }
  for (;;) {
    const c = text[e - 1];
    if (e > s0 && ".,:;!?'*~=\\".includes(c)) e--;
    else if (e > s0 && c === ')' && closes > opens) {
      e--;
      closes--;
    } else break;
  }
  if (e <= s0) return -1;
  if (atomMode) return atom(i, e);
  const url = text.slice(i, e);
  const it = append(item(LEAF, i, e));
  it.n = { type: 'link', url, children: [{ type: 'text', value: url, position: pos(i, e) }], position: null };
  linkables.push(it);
  return glue(it, e, STRONG);
}
// `@IDENT`, unless the `@` follows an ASCII letter or digit or one of
// `_ - . / @` (`me@x.org`); trailing `-` go back to the text. -1 when there
// is none at i.
function reference(i) {
  if (i > from && (isAsciiAlnum(text.charCodeAt(i - 1)) || '_-./@'.includes(text[i - 1]))) return -1;
  let e = matchAt(scan.IDENT, text, i + 1);
  if (e < 0) return -1;
  while (text[e - 1] === '-') e--;
  if (atomMode) return atom(i, e);
  const it = append(item(LEAF, i, e));
  it.n = { type: 'ref', id: text.slice(i + 1, e), position: null };
  linkables.push(it);
  return glue(it, e, REF);
}
// `[^LABEL]`, a footnote reference (text inside a footnote definition),
// else a bracket opener.
function bracket(i) {
  if (text[i + 1] === '^') {
    const e = matchAt(scan.LABEL, text, i + 2);
    if (e > 0 && text[e] === ']') {
      const label = text.slice(i + 2, e);
      const identifier = /^[a-z0-9_-]*$/.test(label) ? label : label.toLowerCase().toUpperCase().toLowerCase(); // micromark's case fold, lower-cased as mdast; definitions fold the same way
      if (!opts.footnote || atomMode) return atom(i, e + 1, { type: 'footnoteReference', identifier, label, position: null }, STRONG);
      rep('footnote.nested', i, e + 1, `[^${label}] is inside a footnote definition, so it stays text`, 'footnotes cannot nest: put the text in this footnote, or move the reference into the main text');
      return lit(i, e + 1);
    }
  }
  return pushBracket(i, 1);
}
// `:NAME[` opens an inline element, unless the `:` follows an ASCII letter
// or digit (text, with inline.glued: `press:kbd[S]`) or `_`, `:` or `/`
// (silent text: `http://x[1]`).
function colon(i) {
  const e = matchAt(scan.NAME, text, i + 1);
  if (e > 0 && text[e] === '[') {
    const p = i > from ? text[i - 1] : '';
    if (p && isAsciiAlnum(p.charCodeAt(0))) {
      const name = text.slice(i + 1, e);
      rep('inline.glued', i, i + 1, `":${name}[" follows a letter or digit, so it is text`, `put a space before ":${name}["`);
    } else if (p !== '_' && p !== ':' && p !== '/') return pushBracket(i, e + 1 - i);
  }
  return lit(i, i + 1);
}

// ---- the pass
function scanAll() {
  for (let i = from; i < to; ) {
    const c = text[i];
    let j = -1;
    if (c === '\\') i = backslash(i);
    else if (c === '`') i = backticks(i);
    else if (c === '$') i = dollar(i);
    else if (c === '<') i = angle(i);
    else if (c === '&') i = amp(i);
    else if ((c === 'h' || c === 'H') && (j = bare(i)) > 0) i = j;
    else if (c === '@' && (j = reference(i)) > 0) i = j;
    else if (c === '[') i = bracket(i);
    else if (c === '!' && text[i + 1] === '[' && text[i + 2] !== '^') i = pushBracket(i, 2);
    else if (c === ':') i = colon(i);
    else if (c === ']') i = closeBracket(i);
    else if (c === '*' || c === '~' || c === '=') i = delim(i);
    else {
      for (j = i + 1; j < to; j++) if (special(text.charCodeAt(j))) break;
      i = lit(i, j);
    }
  }
  if (atomMode) return ranges;

  // Openers still on the stack never closed: they stay text, and an
  // unclosed `:NAME[` is reported.
  for (let k = 1; k < brackets.length; k += 4) {
    const s = brackets[k];
    if (text[s] !== ':') continue;
    const e = text.indexOf('[', s) + 1;
    rep('inline.unclosed', e - 1, e, `${text.slice(s, e)} is never closed`, 'close it with `]`; a literal `]` inside is written `\\]`');
  }
  processEmphasis(null);
  if (openTags)
    for (const [name, at] of openTags)
      for (let k = 0; k < at.length; k += 2) rep('html.inline-unclosed', at[k], at[k + 1], `<${name}> is never closed in this paragraph`, `close it with </${name}> before the paragraph ends`);
  if (latexAt < Infinity && !ctx.flags['latex.delimiters']) {
    ctx.flags['latex.delimiters'] = true;
    rep('latex.delimiters', latexAt, latexAt + 2, "LaTeX's delimiters are not math in tern; the backslash is an escape", 'math is `$…$` and `$$`');
  }
  return build();
}

// ---- items to nodes, walking the item tree with explicit stacks; adjacent
// text and soft breaks merge
const stackIt = [];
const stackOut = [];
const textNode = (ts, te, parts) => ({ type: 'text', value: parts ? parts.join('') : text.slice(ts, te), position: pos(ts, te) });
function build() {
  const root = [];
  let next = head; // the list being built, into out; the outer ones are on the stacks
  let out = root;
  let ts = -1; // the pending text runs from ts to te; it is that slice of
  let te = -1; // the source while parts is null
  let parts = null;
  for (;;) {
    const it = next;
    if (!it) {
      if (ts >= 0) out.push(textNode(ts, te, parts));
      ts = -1;
      if (!stackIt.length) return root;
      next = stackIt.pop();
      out = stackOut.pop();
      continue;
    }
    next = it.next;
    if (it.k <= OWN) {
      if (it.s === it.e) continue;
      if (ts < 0) {
        ts = it.s;
        parts = it.v === null ? null : [it.v];
      } else if (parts) parts.push(str(it));
      else if (it.v !== null || it.s !== te) parts = [text.slice(ts, te), str(it)];
      te = it.e;
      continue;
    }
    if (ts >= 0) out.push(textNode(ts, te, parts));
    ts = -1;
    const node = it.k === ENT ? { type: 'text', value: it.v, data: { tern: { entity: it.n } }, position: null } : it.n;
    node.position = pos(it.s, it.e);
    out.push(node);
    if (it.k === PARENT && (it.v || node.type !== 'image')) {
      stackIt.push(next);
      stackOut.push(out);
      next = it.v;
      // An image has no children: its bracket content, as inline nodes, is
      // data.tern.caption, which becomes an implicit figure's caption.
      out = node.type === 'image' ? (((node.data || (node.data = {})).tern || (node.data.tern = {})).caption = []) : (node.children = []);
    }
  }
}

module.exports = { parseInline, atomRanges };
