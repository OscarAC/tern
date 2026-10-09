// SPDX-License-Identifier: MIT
// tern.js 0.2.0-dev: built from src/ by tools/concat.js. Edit the sources, not this file.
(function (global) {
  'use strict';
  var defs = {};
  var cache = {};
  function require(name) {
    var id = name.replace(/^\.\//, '').replace(/\.js$/, '');
    if (!cache[id]) {
      cache[id] = { exports: {} };
      defs[id](cache[id], cache[id].exports, require);
    }
    return cache[id].exports;
  }
  // ---- src/diag.js
  defs['diag'] = function (module, exports, require) {
// The diagnostic codes with their severities, and report(), behind the
// parser's ctx.report. Severity follows the consequence: an error means
// content lost or meaning changed, a warning probably not what the author
// meant, an info a hint.

const E = 'error';
const W = 'warning';
const I = 'info';

// Every code the parser and the transforms report (transform.js reads this
// table too). The runtime and the command line have codes of their own.
const SEVERITY = {
  'block.unclosed': E,
  'block.closer-mismatch': E,
  'block.stray-closer': W,
  'block.closer-count': I,
  'block.opener-junk': E,
  'block.bad-opener': W,
  'block.spaced-name': W,
  'block.unclosed-fence': E,
  'fence.info-junk': W,
  'html.unclosed': E,
  'html.stray-closer': I,
  'html.wrapper': W,
  'html.inline-unclosed': W,
  'html.inline-escaped': I,
  'math.unclosed': E,
  'math.opener-tail': E,
  'math.closer-tail': W,
  'math.inline-display': I,
  'math.unclosed-inline': I,
  'math.bracket': I,
  'math.suspect-price': W,
  'attr.malformed': W,
  'attributes.orphan': W,
  'attributes.raw': W,
  'table.stray-delimiter': W,
  'table.row-unterminated': W,
  'table.misplaced-separator': W,
  'table.extra-cell': W,
  'cell.orphan': W,
  'leaf.demoted': I,
  'leaf.void-content': W,
  'inline.unclosed': W,
  'inline.glued': I,
  'footnote.undefined': W,
  'footnote.duplicate': W,
  'footnote.nested': W,
  'footnote.unused': I,
  'latex.delimiters': I,
  'latex.linebreak': I,
  'nesting.limit': E,
  'doc.frontmatter': I,
  'meta.conflict': W,
  'meta.duplicate': W,
  'meta.malformed': W,
  'meta.nested': W,
  'name.reserved': W,
  'tag.not-allowed': W,
  'table.body': W,
  'id.invalid': W,
  'id.duplicate': W,
  'ref.dangling': W,
  'ref.unreferenceable': W,
  'name.unknown': I,
};

// Appends one diagnostic. `start` and `end` are offsets into the normalised
// source (end exclusive; defaults to start). An unknown code is a bug in the
// engine, so it throws rather than reporting something unlisted.
function report(ctx, code, start, end, message, hint) {
  const severity = SEVERITY[code];
  if (!severity) throw new Error(`tern: unknown diagnostic code ${code}`);
  const d = { code, severity, message, position: ctx.position(start, end == null ? start : end) };
  if (hint) d.hint = hint;
  ctx.diagnostics.push(d);
  return d;
}

// Document order, then code, so output is stable whatever order phases report in.
function sortDiagnostics(list) {
  return list.sort(
    (a, b) =>
      a.position.start.offset - b.position.start.offset ||
      a.position.end.offset - b.position.end.offset ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
}

module.exports = { SEVERITY, report, sortDiagnostics };
  };
  // ---- src/scan.js
  defs['scan'] = function (module, exports, require) {
// The lexical pieces the block and inline parsers share: source
// normalisation, the character classes, the `{…}` attribute-group parser,
// and the reserved-name and custom-element tests.

// CRLF and CR become LF, a leading BOM goes, NUL becomes U+FFFD. Every
// offset in the AST and the diagnostics refers to the string this returns.
function normalise(source) {
  let s = String(source == null ? '' : source);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n?/g, '\n').replace(/\0/g, '�');
}

// The character classes, as sticky regexes for matchAt: IDENT for ids,
// classes and references (no `:` and no `.`), NAME for element names, KEY
// for attribute names, LABEL for footnote labels (a digit may lead), VALUE
// for an unquoted attribute value.
const IDENT = /[\p{L}_][\p{L}\p{M}\p{N}_-]*/uy;
const NAME = /\p{L}[\p{L}\p{M}\p{N}_-]*/uy;
const KEY = /[\p{L}_][\p{L}\p{M}\p{N}_:.-]*/uy;
const LABEL = /[\p{L}\p{M}\p{N}_-]+/uy;
const VALUE = /[^\s"'=<>`{}]+/y;

// The index just after a match of the sticky `re` at text[i], or -1.
function matchAt(re, text, i) {
  re.lastIndex = i;
  return re.test(text) ? re.lastIndex : -1;
}

function isAsciiAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// ASCII punctuation: what a backslash escapes.
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// Space, tab or newline: the `ws` of the attribute grammar.
function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n';
}

function skipWs(text, i, end) {
  while (i < end && isWs(text[i])) i++;
  return i;
}

const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

// o[k] = v as an own data property. `__proto__` is an attribute name like any
// other, and a plain assignment would set the prototype instead.
function put(o, k, v) {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  else o[k] = v;
  return o;
}

// Elements tern never produces, whatever the schema says; the names `tern`,
// `t-*` and `end` are reserved too. `:::meta` is a core block, and
// `:::script`, `:::style`, `:::html` get their own report, so block.js
// handles those names before asking.
const RESERVED_TAGS = new Set('base body head html link main meta noscript script style template title'.split(' '));

function isReservedName(name) {
  return RESERVED_TAGS.has(name) || name === 'tern' || name === 'end' || name.startsWith('t-');
}

// A class authors may not write, as tern uses it on its own elements: `tern`
// and `t-*`, case-sensitively (`.Tern` is an ordinary class).
function isReservedClass(name) {
  return name === 'tern' || name.startsWith('t-');
}

// HTML's valid custom-element name, as written: lower-case start, a hyphen,
// and none of the names HTML reserves.
const PCEN =
  /^[a-z][-.0-9_a-z\u00b7\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u037d\u037f-\u1fff\u200c\u200d\u203f\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}]*$/u;
const NOT_CUSTOM = new Set('annotation-xml color-profile font-face font-face-src font-face-uri font-face-format font-face-name missing-glyph'.split(' '));
const isCustomName = (n) => n.includes('-') && PCEN.test(n) && !NOT_CUSTOM.has(n);

// ---------------------------------------------------------------- attributes

// Parses the attribute group whose `{` is text[i], looking no further than
// `limit`:
//
//   "{" ws* ITEM (ws+ ITEM)* ws* "}"    ITEM = #IDENT | .IDENT | KEY=VALUE | KEY
//
// A quote opens only right after `=`, and inside quotes nothing is special
// (no escapes). Returns
//
//   null                          no candidate: no unquoted `}` follows, or
//                                 an unquoted `{` comes first (abort, which
//                                 keeps `{{{{…` linear);
//   {end, empty: true}            `{}`, or only whitespace inside: not a group;
//   {end, ok: false, bad}         a candidate that does not parse; `bad` is
//                                 the index of the first rejected character;
//   {end, ok: true, strong, attrs, idAt, classAt, keyAt, reserved}
//
// `end` is the index just after the `}`. `strong`: the group holds an `#id`,
// a `.class` or a `key=value`; one of bare keys only (`{open}`) is weak, and
// several positions take strong groups only. `attrs` is flat and in emission
// order: `id` (the last wins), then `class` (space-separated, accumulated),
// then the other keys, ASCII-lower-cased as the browser does, in the order
// first written (the last value wins); a bare key's value is ''. `idAt` is
// the index of the winning id (its `#`, or the first letter of `id=`), or -1;
// `classAt` that of the first class kept (its `.`, or the first letter of
// `class=`), or -1; `keyAt` maps each other key to the index of its last
// occurrence. Callers point diagnostics at them. `reserved` lists what was
// dropped for `name.reserved` (the key `data-t`, the classes `tern` and
// `t-*`), as {at, length, text, kind}.
function parseAttrs(text, i, limit) {
  let j = i + 1;
  let q = '';
  for (; j < limit; j++) {
    const c = text[j];
    if (q) {
      if (c === q) q = '';
      continue;
    }
    if (c === '}') break;
    if (c === '{') return null;
    if ((c === '"' || c === "'") && text[j - 1] === '=') q = c;
  }
  if (j >= limit) return null;
  const end = j + 1;
  let k = skipWs(text, i + 1, j);
  if (k === j) return { end, empty: true };

  let id;
  let idAt = -1;
  let classAt = -1;
  const classes = [];
  const rest = Object.create(null);
  const keyAt = Object.create(null);
  const reserved = [];
  let strong = false;
  const fail = (at) => ({ end, ok: false, bad: at });
  const addClasses = (list, at, length) => {
    for (const c of list) {
      if (isReservedClass(c)) reserved.push({ at, length, text: c, kind: 'class' });
      else if (classes.push(c) === 1) classAt = at;
    }
  };

  while (k < j) {
    const c = text[k];
    if (c === '#' || c === '.') {
      const e = matchAt(IDENT, text, k + 1);
      if (e < 0) return fail(k + 1);
      const name = text.slice(k + 1, e);
      strong = true;
      if (c === '#') {
        id = name;
        idAt = k;
      } else addClasses([name], k, e - k);
      k = e;
    } else {
      const e = matchAt(KEY, text, k);
      if (e < 0) return fail(k);
      const at = k;
      const key = asciiLower(text.slice(k, e));
      k = e;
      let value = '';
      if (text[k] === '=') {
        strong = true;
        k++;
        const quote = text[k];
        if (quote === '"' || quote === "'") {
          const close = text.indexOf(quote, k + 1);
          value = text.slice(k + 1, close);
          k = close + 1;
        } else {
          const v = matchAt(VALUE, text, k);
          if (v < 0) return fail(k);
          value = text.slice(k, v);
          k = v;
        }
      }
      if (key === 'id') {
        id = value;
        idAt = at;
      } else if (key === 'class') addClasses(value.split(/[ \t\n]+/).filter(Boolean), at, e - at);
      else if (key === 'data-t') reserved.push({ at, length: e - at, text: text.slice(at, e), kind: 'key' });
      else {
        rest[key] = value;
        keyAt[key] = at;
      }
    }
    if (k < j && !isWs(text[k])) return fail(k);
    k = skipWs(text, k, j);
  }

  const attrs = {};
  if (id !== undefined) attrs.id = id;
  if (classes.length) attrs.class = classes.join(' ');
  for (const key in rest) put(attrs, key, rest[key]);
  return { end, ok: true, strong, attrs, idAt, classAt, keyAt, reserved };
}

// Reports `name.reserved` for what parseAttrs dropped from a group that was
// used. `toOffset(index)` maps a text index to a source offset.
function reportReserved(ctx, res, toOffset) {
  for (const r of res.reserved) {
    const at = toOffset(r.at);
    if (r.kind === 'key')
      ctx.report('name.reserved', at, at + r.length, `the attribute "${r.text}" is reserved for tern's own use and is dropped`, 'remove it; tern sets data-t itself');
    else
      ctx.report('name.reserved', at, at + r.length, `the class "${r.text}" is reserved for tern's own use and is dropped`, 'choose a class that is not "tern" and does not start with "t-"');
  }
}

module.exports = {
  normalise,
  IDENT,
  NAME,
  LABEL,
  matchAt,
  isAsciiAlnum,
  isAsciiPunct,
  skipWs,
  put,
  isReservedName,
  isCustomName,
  parseAttrs,
  reportReserved,
};
  };
  // ---- src/ast.js
  defs['ast'] = function (module, exports, require) {
// The parse context, positions, inline source spans and visit(). Positions
// are unist's: 1-based line and column, 0-based offset into the normalised
// source, end exclusive; a column counts UTF-16 code units, a tab being one.

const diag = require('./diag');

function lineStarts(src) {
  const starts = [0];
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

// Everything one parse shares: the normalised source, its line table, the
// options and schema, the diagnostics, and once-per-note flags.
function createContext(src, opts) {
  const starts = lineStarts(src);
  let last = 0; // the line found last time: lookups mostly move forward
  const ctx = {
    src,
    starts,
    opts,
    schema: (opts && opts.schema) || { block: {}, leaf: {}, inline: {} },
    diagnostics: [],
    flags: Object.create(null),
    point(offset) {
      let lo;
      const n = starts.length;
      if (offset >= starts[last] && (last + 1 >= n || offset < starts[last + 1])) lo = last;
      else if (last + 1 < n && offset >= starts[last + 1] && (last + 2 >= n || offset < starts[last + 2])) lo = ++last;
      else {
        lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= offset) lo = mid;
          else hi = mid - 1;
        }
        last = lo;
      }
      return { line: lo + 1, column: offset - starts[lo] + 1, offset };
    },
    position(start, end) {
      return { start: ctx.point(start), end: ctx.point(end == null ? start : end) };
    },
    report(code, start, end, message, hint) {
      return diag.report(ctx, code, start, end, message, hint);
    },
  };
  return ctx;
}

// ---------------------------------------------------------------- spans

// A span is inline source handed from the block parser to the inline parser:
// `text`, the characters after prefixes and stripping, and `segs`, a flat
// array of pairs [at, offset, at, offset, …]: text[at] and the characters
// after it, up to the next pair, were copied from the source starting at
// `offset`. A joining '\n' is its own pair, at the offset of the line's
// newline. `empty` is the offset to use when the text is empty. So every
// inline node and diagnostic gets exact source columns, across quote
// prefixes, list indentation and joined lines.
function createSpan(empty) {
  return { text: '', segs: [], empty: empty || 0 };
}

function spanAdd(span, str, offset) {
  if (!str) return span;
  span.segs.push(span.text.length, offset);
  span.text += str;
  return span;
}

// The source offset of text[i]. For i = text.length, the offset just after
// the last character.
function spanStart(span, i) {
  const n = span.text.length;
  if (!n) return span.empty;
  if (i >= n) return spanStart(span, n - 1) + 1;
  const s = span.segs;
  let lo = 0;
  let hi = s.length / 2 - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid * 2] <= i) lo = mid;
    else hi = mid - 1;
  }
  return s[lo * 2 + 1] + (i - s[lo * 2]);
}

// The source offset just after text[i - 1]: the end of a node whose text
// ends before index i.
function spanEnd(span, i) {
  return i > 0 ? spanStart(span, i - 1) + 1 : spanStart(span, 0);
}

// The position of text[a…b). An empty range is a point at a.
function spanPosition(ctx, span, a, b) {
  const start = spanStart(span, a);
  return ctx.position(start, b > a ? spanEnd(span, b) : start);
}

// ---------------------------------------------------------------- trees

// unist-util-visit, the subset tern needs: visit(tree, [type,] fn), with
// fn(node, index, parent). Returning false skips the node's children.
function visit(tree, type, fn) {
  if (typeof type === 'function') {
    fn = type;
    type = null;
  }
  const walk = (node, index, parent) => {
    const r = !type || node.type === type ? fn(node, index, parent) : undefined;
    if (r === false || !node.children) return;
    for (let i = 0; i < node.children.length; i++) walk(node.children[i], i, node);
  };
  walk(tree, null, null);
}

module.exports = { createContext, createSpan, spanAdd, spanStart, spanEnd, spanPosition, visit };
  };
  // ---- src/entities.js
  defs['entities'] = function (module, exports, require) {
// Generated by tools/entities.py from Python's html.entities.html5; do not
// edit. The 2125 named character references HTML defines, compressed
// as the generator describes, and decode() for the body of a reference,
// between `&` and `;`.

const P = '!"#$%&()*+,-./:;<=>?@[]^_`{|}~';
const T = ['rrow', 'ar', 'Equal', 'ight', 'Vector', 'dot', 'acute', 'le', 'ilde', 'on', 'er', 'nt', 'irc', 'cy', 'im', 'edil', 'ac', 'set'];
const BASES = { fr: 0x1D504, opf: 0x1D538, scr: 0x1D49C };
const D =
  '!ÆAElig"&MP"Á>"Ăbreve"Âc_#Аy"Àgrave"Αlpha"Ām}r"⩓nd"Ąog["ҿpplyFuncti["Åring"ڲssign"Ãt@"Äuml!ٴB}kslash#⫧rv$ݤwed"Б`"ړecause#֊rnoullis#Βta"˘reve"֊scr"ڬumpeq!ЧCH`"©OPY"Ć>#ܰp$֣italDiff]e^ialD#֋y?ys"Čc/[#Ç|#Ĉ_#ڎ[i^"Ċ="¸|la#·^]Dot"֋fr"Χhi"۷_?Dot(۴Minus(۳Plus(۵T{es"ڐlockwiseC[tourI^egral$ѻseCurlyDoub?Quote,ѷQuote"ڕol[&⩴e#ڿngrue^$ڍi^$ڌtourI^egral#ՠpf$ٮroduct#ڑu^]ClockwiseC[tourI^egral"⨯ross"ܱup$ګCap!֣DD#⤑otrahd"ЂJ`"ЅS`"ЏZ`"ѿagg]#׿rr#⫤shv"Ďc/[#Дy"٥el$Δta"´i}riticalAcute-˙Dot-˝Doub?Acute-`Grave-˜T@$ܢm[d#֤ff]e^ialD"¨ot$ԺDot$ڮ:#ڍub?C[tourI^egral(¨Dot*رwnA.(خLeftA.,زR;A.,⫤Tee)⟸[gLeftA.-⟺eftR;A.,⟹R;A.(ذR;A.-܆Tee(دUpA.*سDownA.(ڃV]ticalB/#ױwnA.+⤓B/+ٓUpA.%̑Breve%⥐LeftR;<*⥞Tee<*؛<-⥖torB/%⥟R;Tee<+؟<-⥗ctorB/%܂Tee)؅A.%رa."Đstrok!ŊENG"ÐTH"É>"Ěc/[#Ê_#Эy"Ė="Ègrave"٦?me^"Ēm}r#◻ptySmallSqu/e&▫V]ySmallSqu/e"Ęog["Εpsil["⩵qual&ڠT@$تilibrium"֎scr#⩳{"Ηta"Ëuml"١xists#֥p[e^ialE!ФF`"◼il?dSmallSqu/e(▪V]ySmallSqu/e"ٞorAll#֏uri]trf"֏scr!ЃGJ`">T"Γamma&Ϝd"Ğbreve"Ģc|#Ĝ_#Гy"Ġ="ܷg"ۃreat]:-ܹlLess)ۅFull:)⪢Great])ەLess)⩾Sla^:)ۑT@"ۉt!ЪHARD`"ˇ}ek#^t"Ĥc_"ժfr"թilb]tSp}e"իopf#─riz[talLine"թscr#Ħtrok"ڬumpDownHump%ڭ:!ЕIE`"ĲJlig"ЁO`"Í>"Îc_#Иy"İ="կfr"Ìgrave"կm#Ī}r$֦gin/yI#ذplies"ڊ^$ډegral%ܠrsecti[#Ӂvisib?Comma+ӀT{es"Įog[#Ιta"ծscr"Ĩt@"Іuk`#Ïml!ĴJc_#Йy"Јs]`"Єuk`!ХKH`"ЌJ`"Κappa"Ķc|#Кy!ЉLJ`"<T"Ĺ>#Λmbda#⟪ng#հpl}etrf#׼rr"Ľc/[#Ļ|#Лy"⟨eftAng?Br}ket&׮.+قB/+ؤR;A.%ݦCeiling%⟦Doub?Br}ket(⥡wnTee<*ء<-⥙torB/%ݨFloor%ײR;A.+⥎<%܁Tee)؂A.)⥚<&ܐriang?-⧏eB/-ܒe:%⥑UpDown<(⥠Tee<(؝<-⥘rB/%ؚ<,⥒B/%خa.%زr;a.#ܸss:Great]%ۄFull:%۔Great]%⪡Less%⩽Sla^:%ېT@"ܶl#ظefta."Ŀmi="⟵[gLeftA.*⟷R;A.%⟶R;A.%⟸?fta.*⟺r;a.%⟹r;a.#׷w]LeftA.&׶R;A."հscr#؎h#Łtrok"ۈt!⤅Map"М`"ҽediumSp}e#֑lli^rf"ٱinusPlus"֑scr"Μu!ЊNJ`"Ń>"Ňc/[#Ņ|#Нy"ѩegativeMediumSp}e*ѩThickSp}e-ѩnSp}e*ѩV]yThinSp}e#ۉstedGreat]Great](ۈLessLess#\nwLine"ҾoBreak# nBreakingSp}e#ճpf#⫬t$ۀC[grue^%ۋupCap$ڄDoub?V]ticalB/$٧E?me^%ھqual*ڠ̸T@%٢xists$ۍGreat],ۏ:,ۅ̸Full:,ۉ̸Great],ۗLess,⩾̸Sla^:,ۓT@$ڬ̸HumpDownHump)ڭ̸:$݈LeftTriang?-⧏̸ng?B/-݊ng?:&یss)ێ:)ۖGreat])ۈ̸Less)⩽̸Sla^:)ےT@$⪢̸NestedGreat]Great]+⪡̸LessLess$۞Precedes-⪯̸:-ܾSla^:$٪Rev]seE?me^%݉;Triang?-⧐̸ang?B/-݋ang?:$̸ۭSqu/eSub~-݀b~:-ۮ̸p]~-݁p]~:%⃒۠ub~+ۦ:&۟cceeds-⪰̸:-ܿSla^:-۝̸T@&⃒ۡp]~-ۧ:$ڟT@*ڢ:*ڥFull:*ڧT@$ڂV]ticalB/"Ñt@"Νu!ŒOElig"Ó>"Ôc_#Оy"Ődbl}"Ògrave"Ōm}r#Ωega#Οicr["ѺpenCurlyDoub?Quote+ѶQuote"⩔r"Øslash"Õt@$⨷mes"Öuml"Ҝv]B/&⏞r}e*⎴ket%⏜P/e^hesis!٠P/tialD"П`"Φhi"Πi"±lusMinus"ժoinc/eplane#շpf"⪻r#ۘecedes*⪯:*ۚSla^:*ۜT@#ґ{e#٭oduct$ڕporti[,ٻal"Ψsi!"QUOT"ոopf!⤐RB/r"®EG"Ŕ>#⟫ng#׾rr%⤖tl"Řc/[#Ŗ|#Рy"պe#٩v]seE?me^*ةquilibrium)⥯UpEquilibrium"պfr"Ρho"⟩;Ang?Br}ket(װ.,كB/,آLeftA.&ݧCeiling&⟧Doub?Br}ket)⥝wnTee<+ؠ<-⥕ctorB/&ݩFloor&܀Tee*؄A.*⥛<(ܑriang?-⧐?B/-ܓ?:&⥏UpDown<)⥜Tee<)؜<-⥔orB/&؞<-⥓B/&ذa."ջopf#⥰undImplies"عr;a."չscr#؏h"⧴u?Delayed!ЩSHCH`#Ш`"ЬOFT`"Ś>"⪼c#Š/[#Ş|#Ŝ_#Сy"ױhortDownA.&׮LeftA.&װR;A.&ׯUpA."Σigma"ٶmallC_?"ٸqrt#□u/e(۱I^]secti[(ۭSub~-ۯt:*ۮp]~-۰~:(۲Uni["ܤt/"ܮub$ܮ~(ۤ:#ۙcceeds*⪰:*ۛSla^:*۝T@$٩hThat#ٯm#ܯp$ۡ]~*ۥ:$ܯ~!ÞTHORN"րRADE"ЋSH`#Ц`"\tab#Τu"Ťc/[#Ţ|#Тy"ڒh]efore$Θta#ҽ ickSp}e$ѧnSp}e"ښ@&ڡ:&ڣFull:&ڦT@"Թrip?Dot"Ŧstrok!ÚU>#׽rr%⥉ocir"Ўbr`$Ŭeve"Ûc_#Уy"Űdbl}"Ùgrave"Ūm}r"_nd]B/(⏟r}e+⎵ket&⏝P/e^hesis#ܡi[&۬Plus"Ųog["ׯpA.)⤒B/)أDownA.#׳DownA.#⥮Equilibrium#܃Tee&؃A.#دa.#سdowna.#״p]LeftA.&׵R;A.#ϒsi%Υl["Ůring"Ũt@"Üuml!܉VDash"⫫b/"В`"܇dash&⫦l"ܟee#Ѵrb/$Ѵt%ځicalB/*|Line*❘Sep/ator*ڞT@$ѨyThinSp}e"܈vdash!ŴWc_"ܞedge!ΞXi!ЯYA`"ЇI`"ЮU`"Ý>"Ŷc_#Ыy"Ÿuml!ЖZH`"Ź>"Žc/[#Зy"Ż="ѩ]oWidthSp}e#Ζta"ֆfr"ւopf!áa>"ăbreve"ڜc#ڜ̳E#ڝd#â_#´ute#аy"æelig"ҿf"àgrave"֓?fsym$֓ph#αpha"ām}r$⨿lg#&p"څnd$⩕and$⩜d$⩘slope$⩚v#پg$⦤e$پ?$ٿmsd(⦨aa)⦩b)⦪c)⦫d)⦬e)⦭f)⦮g)⦯h$ٽrt&ܜvb)⦝d$ڀsph%Åt$ߚz/r"ąog["ڦp#⩰E#⩯}ir#ڨe#کid#\'os#ڦprox(ڨeq"åring"*st#ڦymp&ګeq"ãt@"äuml"ڑwc[i^#⨑i^!⫭bNot"ڪ}kc[g%϶epsil[%ғpr{e%ڛs{)ܫeq#ܛrvee$ݣwed(ݣge"⎵brk%⎶tbrk"ڪc[g#бy"Ѽdquo"ړecaus(ړe#⦰mptyv#϶psi#֊rnou#βta$֔h$ۊween"ܠigcap%◯_%ܡup$⨀o=%⨁plus%⨂t{es$⨆sqcup%★t/$▽triang?down-△up$⨄uplus$ܟvee$ܞwedge"⤍k/ow"⧫l}klozenge&▪squ/e&▴triang?-▾?down-◂??ft-▸?r;$␣nk#▒k12%░4$▓34#█ock"=⃥ne$ڿ⃥quiv#ݮot"܃ot$܃tom#ܦwtie#╗xDL%╔R%╖l%╓r$═H%╦D%╩U%╤d%╧u$╝UL%╚R%╜l%╙r$║V%╬H%╣L%╠R%╫h%╢l%╟r$⧉box$╕dL%╒R%┐l%┌r$─h%╥D%╨U%┬d%┴u$۽minus$ۼplus$۾t{es$╛uL%╘R%┘l%└r$│v%╪H%╡L%╞R%┼h%┤l%├r"ғpr{e"˘reve#¦vb/"ҭsemi#ڛ{%ܫe#\\ol%⧅b%⟈hsub"Ҁull%Ҁet#ڬmp%⪮E%ڭe&ڭq!ćc>#ڇp$⩄and$⩉brcup$⩋cap%⩇up$⩀=$ڇ︀s#ҟret$ˇ["⩍caps$čr[#ç|#ĉ_#⩌ups&⩐sm"ċ="¸|#⦲mptyv#¢^%·]="чh`#✓eck&✓m/k#χi"○ir$⧃E$ˆc%ڵeq%ؘ?a.?ft-ؙr;(®dR)ⓈS)۹ast)۸c_)ۻdash$ڵe$⨐fni^$⫯mid$⧂scir"♣lubs&♣uit":ol[&ڲe(ڲq#,mma&@t$ٟp%ٶfn%ٟ?me^(ՠxes#ڣng%⩭=$ڌi^#ٮprod$©y%յsr"ؓr/r#✗oss"⫏sub%⫑e$⫐p%⫒e"ݍt="⤸ud/rl(⤵r#ܼepr$ܽsc#ؔl/r(⤽p#ڈp$⩈brcap$⩆cap%⩊up$۫=$⩅or$ڈ︀s#ؕr/r(⤼m$ܼlyeqprec)ܽsucc&ܬvee&ܭwedge$¤ren$ؔvea.?ft,ؕr;#ܬvee#ܭwed"ڐwc[i^#ڏi^"ދylcty!رdArr"⥥H/"Ѿagg]#֖?th#ױrr#Ѯsh%܁v"⤏bk/ow#˝l}"ďc/[#дy"֤d#ѿagg]$بrr#⩷otseq"°eg#δlta#⦱mptyv"⥿fisht"ءh/l%ؠr"ܢiam%ܢ[d)♦suit%♦s#¨e#ϝgamma#ݐsin#÷v$÷ide(ܥ[t{es$ܥ[x"ђj`"ݼlcorn$ݫrop"$oll/#˙t$ڮeq&گ=$ږminus$ٲplus$ۿsqu/e#ݤub?b/wedge#ױwna.%بdowna.s%ءh/po[?ft-ؠr;"⤐rbk/ow#ݽcorn$ݪrop"ѕs`#⧶ol#đtrok"ݏt=#▿ri%▾f"ٓu/r#⥯h/"⦦wang?"џz`#⟿igr/r!⩷eDDot#گot"é>#⩮st]"ěc/[#ڴir%êc#ڳol[#эy"ė="֥e"ڰfDot"⪚g#èrave#⪖s$⪘="⪙l#⏧i^]s#ձl#⪕s$⪗="ēm}r#٣pty&٣~&٣v#ѡsp%Ѣ13&ѣ4"ŋng#Ѡsp"ęog["ܳp/%⧣sl#⩱lus#εsi%εl[%ϵv"ڴqc_$ڳol[#ڠs{$⪖la^gtr)⪕?ss#=uals$ڽest$ڿiv&⩸DD#⧥vp/sl"ڱrDot#⥱/r"֍scr#ڮ=#ڠ{"ηta#ðh"ëuml#Ԋro"!xcl#١ist#֎pectati[$֥[e^ia?!ڰfalling=seq"ф`"♀ema?"ﬃfilig#ﬀlig$ﬄlig"ﬁilig"♭lat#ﬂlig#▱tns"ƒnof"ٞorall$ܲk%⫙v"⨍p/ti^"½r}12&ֱ3&¼4&ֳ5&ַ6&ֹ8%ֲ23&ִ5%¾34&ֵ5&ֺ8%ֶ45%ָ56&ֻ8%ּ78$Ңsl#ހown!ۅgE#⪌l"ǵ>#γmma&ϝd#⪆p"ğbreve"ĝc_#гy"ġ="ۃe#ܹl#ۃq$ۅq$⩾sla^#⩾s$⪩cc$⪀=(⪂o)⪄l$ܹ︀l%⪔es"ۉg#ܷg"֕{el"ѓj`"ەl#⪒E#⪥a#⪤j"ۇnE#⪊ap%⪊prox#⪈e$⪈q%ۇq#݅s{"`rave"ըscr#ۑ{%⪎e%⪐l">t#⪧cc$⩺ir#ܵ=#⦕lP/#⩼quest#⪆rapprox%⥸rr$ܵ=$ܹeq?ss&⪌q?ss$ە?ss$ۑs{"ۇ︀v]tneqq#ۇ︀nE!زhArr"Ѩairsp#½lf#թmilt#ъrd`$ײr%⥈cir%؋w"խb/"ĥc_"♥e/ts(♥uit#҄llip#ܗrc["⤥kse/ow$⤦w/ow"ٝo/r#ڙmtht#؇ok?fta.%؈r;a.#ѳrb/"խslash#ħtrok"ҡybull#Ѯphen!íi>"Ӂc#î_#иy"еe`#¡xcl"زff"ìgrave"֦i#⨌ii^$ڋ^#⧜nfin#ևota"ĳjlig"īm}r$կge%ծline%կp/t$ıth#ܕof#Ƶped"٦n#գc/e#ټfin&⧝tie#ıo=#ډt$ܘcal$ւeg]s%ܘrcal$⨗l/hk$⨼prod"ёo`#įg[#ιta"⨼prod"¿quest"٦sin%ݗE%ݓ=%ݒs&ݑv%٦v"Ӏt#ĩ@"іuk`#ïml!ĵjc_#йy"ȷmath"јs]`"єuk`!κkappa&ϰv"ķc|#кy"ĸgreen"хh`"ќj`!ظlA/r#خrr#⤛tail"⤎B/r"ۄE#⪋g"⥢H/"ĺ>#⦴emptyv#հgran#λmbda#⟨ng%⦑d%⟨?#⪅p#«quo#׮rr%قb&⤟fs%⤝fs%؇hk%؉lp%⤹pl%⥳s{%؀tl#⪫t$⤙ail$⪭e%⪭︀s"⤌b/r#❲brk#{r}e&[k$⦋ke%⦏sld(⦍u"ľc/[#ļ|$ݦil#{ub#лy"⤶dca#Ѻquo&Ѽr#⥧rdh/$⥋ush/#ؐsh"ۂe#׮fta.+؀tail%؛h/po[down-ؚup%إ?fta.s%ײr;a.-ؤrows+ةh/po[s+؋squiga.%ܩthreet{es#ܸg#ۂq$ۄq$⩽sla^#⩽s$⪨cc$⩿=(⪁o)⪃r$ܸ︀g%⪓es$⪅sapprox%ܴ=%ܸeqgtr(⪋qgtr%۔gtr%ېs{"⥼fisht#ݨloor"۔g#⪑E"؛h/d%ؚu&⥪l#▄blk"љj`"ۈl#إ/r#ݼcorn]#⥫h/d#◺tri"ŀmi=#⎰oust(⎰}he"ۆnE#⪉ap%⪉prox#⪇e$⪇q%ۆq#݄s{"⟬oang$ٛrr#⟦brk#⟵ng?fta.*⟷r;a.%⟼mapsto%⟶r;a.#؉opa.?ft+؊r;#⦅p/$⨭lus#⨴t{es#ٵwast$_b/#◊z$◊enge$⧫f"(p/%⦓lt"ؤr/r#ݽcorn]#ةh/&⥭d#Ѭm#ܝtri"җsaquo#؎h#ې{%⪍e%⪏g#[qb$Ѷuo&Ѹr#łtrok"<t#⪦cc$⩹ir#ܴ=#ܩhree#ܧ{es#⥶l/r#⩻quest#⦖rP/$◃i%ܒe%◂f"⥊urdsh/$⥦uh/"ۆ︀v]tneqq#ۆ︀nE!ژmDDot"¯}r#♂?$✠t%✠ese#؄p$؄sto(؅down(؂?ft(؃up#▮rk]"⨩comma#мy"Ѳdash"ٿeasuredang?"օho"µicro#ځd$*ast$⫰cir$·=#ٰnus&۽b&ږd(⨪u"⫛lcp#҄dr"ٱnplus"܅odels"ٱp"ڜstpos"μu#ܖlt{ap#ܖmap!̸ܷnGg#ۉ⃒t$ۉ̸v"ثLefta.&جr;a.#̸ܶl#ۈ⃒t$ۈ̸v"حR;a."܍VDash#܌dash"٥abla#ńcute#پ⃒ng#ڧp$⩰̸E$ک̸id$ŉos$ڧprox#♮tur&♮al)ճs" bsp#ڬ̸ump&ڭ̸e"⩃cap$ňr[#ņ|#ڥ[g&⩭̸=#⩂up#нy"ѱdash"ھe#صArr#⤤/hk%׵r&׵ow#ڮ̸=#ۀquiv#⤨se/$ڠ̸{#٢xist(٢s"ۅ̸gE#ۏe$ۏq%ۅ̸q%⩾̸sla^$⩾̸s#ۓs{#ۍt$ۍr"جhArr#،/r#⫲p/"٩i#ݚs$ݘd#٩v"њj`"ثlArr#ۄ̸E#׸/r#҃dr#ێe$׸fta.&،r;a.$ێq%ۄ̸q%⩽̸sla^$⩽̸s%یs#ےs{#یt$݈ri&݊e"ڂmid"¬ot$٧in&ݗ̸E&ݓ̸=&٧va(ݕb(ݔc$٪ni&٪va(ݜb(ݛc"ڄp/%ڄal?l%⫽⃥sl%٠̸t#⨔oli^#۞r$ܾcue$⪯̸e%۞c&⪯̸eq"حrArr#׹/r&⤳̸c&׻̸w#׹;a.#݉tri&݋e"۟sc$ܿcue$⪰̸e#ڂhortmid(ڄp/al?l#ڟ{%ڢe&ڢq#ڂmid#ڄp/#݀qsube&݁pe#ۢub%⫅̸E%ۦe%⃒۠~)ۦeq+⫅̸q$۟cc&⪰̸eq$ۣp%⫆̸E%ۧe%⃒ۡ~)ۧeq+⫆̸q"ۗtgl#ñ@#ۖlg#݈riang??ft-݊fteq+݉r;-݋ghteq"νu##m$մ]o$ѥsp"܋vDash#⤄H/r#ګ⃒ap#܊dash#ۃ⃒ge$>⃒t#⧞infin#⤂lArr$ۂ⃒e$<⃒t%ܒ⃒rie#⤃rArr$ܓ⃒trie#ښ⃒s{"شwArr#⤣/hk%״r&״ow#⤧ne/!ⓈoS"ó>#۹st"۸cir%ôc#оy"ۻdash#őbl}#⨸iv#۷ot#⦼sold"œelig"⦿fcir"˛g[#òrave#⧁t"⦵hb/#Ωm"ڌi^"ؘl/r#⦾cir$⦻ross#Ҝine#⧀t"ōm}r#ωega#οicr[$⦶d$۴nus"⦷p/#⦹]p#۳lus"چr#ؙ/r#⩝d$֒]&֒of$ªf$ºm#ܔigof#⩖or#⩗slope#⩛v"֒scr#ølash#۶ol"õt@$۵mes(⨶as"öuml"ޛvb/!ڃp/$¶a%ڃl?l$⫳s{%⫽l$٠t"п`"%]c^$.iod$Ҏmil$܃p$ҏtenk"φhi$ϕv#֑mmat#☎[e"πi#ܲtchfork#ϖv"խlanck(լh%խkv#+us%⨣}ir%ۼb%⨢cir%ٲdo&⨥u%⩲e%±mn%⨦s{%⨧two"±m"⨕oi^i^#£und"ۘr#⪳E#⪷ap#ۚcue#⪯e$ۘc%⪷approx%ۚcurlyeq%⪯eq%⪹napprox&⪵eqq&݆s{%ۜs{#Ґ{e&շs#⪵nE$⪹ap$݆s{#٭od$ތfal/%ݰline%ݱsurf$ٻp%ٻto#ۜs{#܎urel"ψsi"Ѧuncsp!⨌qi^"ҵpr{e"իuat]ni[s%⨖i^#?est&ڽeq#"ot!عrA/r#ذrr#⤜tail"⤏B/r"⥤H/"ڛ̱}e$ŕute#ٸdic#⦳emptyv#⟩ng%⦒d%⦥e%⟩?#»quo#װrr%⥵ap%كb&⤠fs%⤳c%⤞fs%؈hk%؊lp%⥅pl%⥴s{%؁tl%׻w#⤚tail$ڔio&ոnals"⤍b/r#❳brk#}r}e&]k$⦌ke%⦎sld(⦐u"řc/[#ŗ|$ݧil#}ub#рy"⤷dca#⥩ldh/#ѻquo&ѻr#ؑsh"պeal%չine%պp/t%ջs#▭ct#®g"⥽fisht#ݩloor"؟h/d%؞u&⥬l#ρo$ϱv"װ;a.,؁tail&؟h/po[down-؞nup&آ?fta.s+تh/po[s&اr;a.s&׻squiga.&ܪthreet{es#˚ng#ڱsing=seq"آl/r#تh/#ѭm"⎱moust(⎱}he"⫮nmid"⟭oang$ٜrr#⟧brk#⦆p/$⨮lus#⨵t{es")p/%⦔gt#⨒poli^"اr/r"Ҙsaquo#؏h#]qb$ѷuo&ѷr"ܪthree#ܨ{es#▹ri%ܓe%▸f%⧎ltri"⥨uluh/"ռx!śs>"Ѹbquo"ۙc#⪴E#⪸ap$šr[#ۛcue#⪰e$şdil#ŝ_#⪶nE$⪺ap$݇s{#⨓poli^#۝s{#сy"ܣ=%ۿb%⩦e"ضeArr#⤥/hk%׶r&׶ow#§ct#;mi#⤩sw/#ٴtminus%ٴn#✶xt"ހfrown"♯h/p#щch`$шy#ځortmid&ڃp/al?l#­y"σigma&ςf&ςv#ښm$⩪=$ڡe%ڡq$⪞g%⪠E$⪝l%⪟E$ڤne$⨤plus$⥲r/r"׮l/r"ٴmall~minus$⨳shp#⧤ep/sl#ځid$ށ?#⪪t$⪬e%⪬︀s"ьoft`#/l$⧄b%ޝ/"♠pades(♠uit$ڃr"۱qcap&۱︀s$۲up&۲︀s#ۭsub&ۯe&ۭ~*ۯeq%ۮp&۰e&ۮ~*۰eq#□u$□/e&▪f$▪f"װr/r"ٴ~mn#ށmi?#ܤt/f"☆t/%★f#ϵra;epsil[*ϕphi$¯ns"۠ub$⫅E$⪽=$ۤe%⫃=$⫁mult$⫋nE%ۨe$⪿plus$⥹r/r$۠~(ۤeq*⫅q(ۨneq+⫋q%⫇{%⫕ub&⫓p#ۙcc%⪸approx%ۛcurlyeq%⪰eq%⪺napprox&⪶eqq&݇s{%۝s{#ٯm#♪ng#ۡp$¹1$²2$³3$⫆E$⪾=%⫘sub$ۥe%⫄=$⟉hsol&⫗ub$⥻l/r$⫂mult$⫌nE%۩e$⫀plus$ۡ~(ۥeq*⫆q(۩neq+⫌q%⫈{%⫔ub&⫖p"طwArr#⤦/hk%׷r&׷ow#⤪nw/"ßzlig!ݴt/get#τu"⎴brk"ťc/[#ţ|#тy"Թ="ݳelrec"ڒh]e4&ڒfore$θta&ϑsym&ϑv#ڦickapprox&ښs{$ѧnsp#ڦkap$ښs{#þorn"˜@#×mes&۾b(⨱/&⨰d#ڋ^"⤨oea#܂p$ޔbot$⫱cir$⫚fork#⤩sa"Ғpr{e"րrade#▵iang?*▿down*◃?ft-ܒteq*ںq*▹r;-ܓhteq$◬=$ںe$⨺minus$⨹plus$⧍sb$⨻t{e#⏢pezium"цs`#ћh`#ŧtrok"ۊwixt#׼ohead?fta.)׾r;a.!دuArr"⥣H/"ú>#ׯrr"ўbr`$ŭeve"ûc_#уy"أd/r#űbl}#⥮h/"⥾fisht"ùgrave"؝h/l%؜r#▀blk"ݺlcorn(ݺ]$ݭrop#◸tri"ūm}r#¨l"ųog["ׯpa.#׳downa.#؝h/po[?ft+؜r;#۬lus#υsi%ϒh%υl[#ئupa.s"ݻrcorn(ݻ]$ݬrop#ůing#◹tri"ݎt=#ũ@#▵ri%▴f"ئu/r#üml"⦧wang?!سvArr"⫨B/%⫩v"܆Dash"⦜angrt#ϵrepsil[$ϰkappa$٣nothing$ϕphi%ϖi%ٻropto$׳r%ϱho$ςsigma%ۨ︀ub~neq-⫋︀qq&۩︀p~neq-⫌︀qq$ϑtheta%ܐriang??ft-ܑr;"в`"܀dash"چee$ܙb/$ڸeq#݌llip#|rb/$|t"ܐltri"⃒۠nsub%⃒ۡp"ٻprop"ܑrtri"⫋︀subnE&ۨ︀e$⫌︀pnE&۩︀e"⦚zigzag!ŵwc_"⩟edb/$څge&ڷq#նi]p"նp"ڞr#ڞeath!ܠxcap#◯_#ܡup"▽dtri"⟺hArr#⟷/r"ξi"⟸lArr#⟵/r"⟼map"ݙnis"⨀o=#⨁plus#⨂t{e"⟹rArr#⟶/r"⨆sqcup"⨄uplus#△tri"ܟvee"ܞwedge!ýy>$яy"ŷc_#ыy"¥en"їi`"юu`#ÿml!źz>"žc/[#зy"ż="ֆeetrf#ζta"жh`"ػigr/r"ѫwj#Ѫnj';

let map = null;

function build() {
  map = Object.create(null);
  const code = new Int8Array(128).fill(-1);
  for (let k = 0; k < P.length; k++) code[P.charCodeAt(k)] = k;
  let name = '';
  for (let i = 0; i < D.length; ) {
    name = name.slice(0, code[D.charCodeAt(i++)]);
    let c = D.codePointAt(i);
    i += c > 0xffff ? 2 : 1;
    if (c >= 0x460 && c < 0x800) c += 0x1ba2;
    let v = String.fromCodePoint(c);
    if (D.charCodeAt(i) >= 0x80) v += D[i++];
    for (let k; i < D.length && !((k = code[D.charCodeAt(i)]) >= 0 && k < 12); i++) name += k >= 12 ? T[k - 12] : D[i];
    map[name] = v;
  }
  map.fjlig = 'fj';
}

// '#35', '#x23' or a name -> the characters it stands for, or null when it is
// not a reference HTML defines. A numeric reference to 0, a surrogate or past
// U+10FFFF is U+FFFD, as in CommonMark.
function decode(body) {
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X';
    const digits = body.slice(hex ? 2 : 1);
    if (!(hex ? /^[0-9a-fA-F]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) return null;
    const c = parseInt(digits, hex ? 16 : 10);
    return c === 0 || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff) ? '\ufffd' : String.fromCodePoint(c);
  }
  if (!map) build();
  const v = map[body];
  if (v !== undefined) return v;
  const m = /^([A-Za-z])(fr|opf|scr)$/.exec(body);
  if (!m) return null;
  const c = m[1].charCodeAt(0);
  return String.fromCodePoint(BASES[m[2]] + (c < 97 ? c - 65 : c - 71));
}

module.exports = { decode };
  };
  // ---- src/inline.js
  defs['inline'] = function (module, exports, require) {
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
  };
  // ---- src/block.js
  defs['block'] = function (module, exports, require) {
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
  };
  // ---- src/outline.js
  defs['outline'] = function (module, exports, require) {
// outline(ast) -> {headings, blocks, refs, math, tables, raw, inline}: the
// editor digest, one walk over the AST, sent by the LSP as `tern/outline` so
// the editor never re-parses. It reads whatever the tree holds: on a parse
// AST, explicit ids only; after the transforms, slugs, labels, numbers and
// resolved references too.

const { visit } = require('./ast');

// The plain text of inline content: text, code and math values, with tags
// dropped. Entities give their decoded value.
function plainText(nodes) {
  let out = '';
  const walk = (list) => {
    for (const n of list || []) {
      if (n.type === 'text' || n.type === 'inlineCode' || n.type === 'inlineMath') out += n.value;
      else if (n.type === 'image') out += n.alt || '';
      else if (n.type === 'break') out += '\n';
      else if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

const tern = (n) => (n.data && n.data.tern) || {};
const line = (n) => n.position.start.line;
const endLine = (n) => n.position.end.line;
const id = (n) => (n.attributes && n.attributes.id) || undefined;

function outline(ast) {
  const out = { headings: [], blocks: [], refs: [], math: [], tables: [], raw: [], inline: [] };
  visit(ast, (n) => {
    if (!n.position) return false; // text the transforms copied (a reference's, a toc entry's): not in the source
    const t = tern(n);
    switch (n.type) {
      case 'heading':
        out.headings.push({ line: line(n), depth: n.depth, id: id(n), text: plainText(n.children) });
        break;
      case 'containerDirective':
      case 'leafDirective': {
        const label = n.type === 'containerDirective' && n.children && n.children[0] && n.children[0].data && n.children[0].data.directiveLabel ? n.children[0] : null;
        out.blocks.push({
          line: line(n),
          endLine: endLine(n),
          kind: n.type === 'containerDirective' ? 'container' : 'leaf',
          name: n.name,
          id: id(n),
          title: label ? plainText(label.children) : n.type === 'leafDirective' && n.children.length ? plainText(n.children) : undefined,
          label: t.text,
          colons: t.colons,
        });
        break;
      }
      case 'ref':
        out.refs.push({ line: line(n), col: n.position.start.column, end: n.position.end.column, id: n.id, text: n.children ? plainText(n.children) : undefined, resolved: t.resolved });
        break;
      case 'math':
      case 'inlineMath':
        out.math.push({ line: line(n), col: n.position.start.column, endLine: endLine(n), end: n.position.end.column, display: n.type === 'math', number: t.text, tex: n.value });
        break;
      case 'table':
        out.tables.push({ line: line(n), endLine: endLine(n) });
        break;
      case 'html':
        if (t.kind !== 'inline') out.raw.push({ line: line(n), endLine: endLine(n), kind: t.kind });
        break;
      case 'textDirective':
        out.inline.push({ line: line(n), col: n.position.start.column, end: n.position.end.column, name: n.name });
        break;
    }
  });
  return JSON.parse(JSON.stringify(out)); // drop undefined fields
}

module.exports = { outline };
  };
  // ---- src/schema.js
  defs['schema'] = function (module, exports, require) {
// The schema registry and element resolution. `tern.block`, `tern.leaf` and
// `tern.inline(name, spec)` write the plain-data registry
// `tern.schema = {block, leaf, inline}`. The transforms read it through the
// helpers below; the emitter never does: it reads what they wrote under
// `data.tern`.
//
// Spec fields, all optional (docs/schema.html#fields):
//   tag           the element, through the level's allowlist
//   class         classes put before the author's
//   attrs         default attributes, under the author's
//   counter       a counter name; names that share it share one sequence
//   within        'h2' would restart the counter per section. Accepted and
//                 kept in the registry, but not applied: numbering is
//                 document-wide
//   label         'Theorem', {en: 'Lemma', fr: 'Lemme'} picked by language, or
//                 (n, node) => text, which returns the whole label ("Satz 4.1")
//   ref           a reference template over {label} {n} {title} {id}
//   title         the title slot: 'block' (div), 'inline' (span), 'summary',
//                 'figcaption', 'caption' or 'legend'; by default it follows the tag
//   titleDefault  the title when none is written ('Details')
//   body          'blocks' (the default) or 'raw', a verbatim body as `{raw}`
//                 gives (read by the parser); 'inline' is accepted, parsed as blocks
//   end           a trailing mark in real text ('∎'), containers only
//   transform     a built-in filler: 'toc', with `depth` ('2-3' by default)
//   css, dom      for the runtime: queued CSS and the DOM behaviour

const { isReservedName, isCustomName } = require('./scan');

const schema = { block: {}, leaf: {}, inline: {} };

const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const FULL_NAME = /^\p{L}[\p{L}\p{M}\p{N}_-]*$/u; // a whole element name

// tern.block/leaf/inline(name, spec): registers a name (case-sensitive) and
// returns its entry. A reserved name can never apply, so it is refused.
function define(level) {
  return (name, spec) => {
    if (typeof name !== 'string' || !FULL_NAME.test(name)) throw new TypeError(`tern.${level}: "${name}" is not an element name`);
    if (isReservedName(name) || (level === 'block' && CORE.has(name))) throw new TypeError(`tern.${level}: "${name}" is reserved`);
    if (spec == null || typeof spec !== 'object') throw new TypeError(`tern.${level}("${name}", spec): spec must be an object`);
    return (schema[level][name] = Object.assign({}, spec));
  };
}

// ---------------------------------------------------------------- resolution

// The schema level and the allowlist of each named node type.
const LEVEL = { containerDirective: 'block', leafDirective: 'leaf', textDirective: 'inline' };
const words = (s) => new Set(s.split(' '));
const CONTAINER = 'address article aside blockquote details dialog div dl dd dt fieldset figure footer form header hgroup li menu nav ol search section ul';
const ALLOW = {
  block: words(`${CONTAINER} table`), // `table` only through the table merge (transform.js tables)
  leaf: words(`${CONTAINER} figcaption legend p summary audio canvas embed hr iframe img object picture video`),
  inline: words('abbr b bdi bdo button cite code data del dfn em i ins kbd mark q rp rt ruby s samp small span strong sub sup time u var wbr'),
};
// Core containers: each has its own output, so it is never resolved, and a
// schema cannot define one.
const CORE = words('meta macros script style html');
// HTML's void elements: content given to one follows it.
const VOID = words('area base br col embed hr img input link meta source track wbr');

// The schema entry for a name at a level, or null.
const entry = (s, level, name) => (s && own(s[level], name) && s[level][name] && typeof s[level][name] === 'object' ? s[level][name] : null);

// The element a named node resolves to; the first rule that applies wins:
// its `{tag=x}`, the schema's `tag`, a custom-element name, the name itself,
// then div (span inline). A tag outside the level's allowlist is skipped.
// `node` is a named element, `want` its `{tag=x}` (already taken out of its
// attributes), `s` the schema. Returns {tag, spec, reserved, unknown}.
// `report(code, at, message, hint)` gets tag.not-allowed, and name.reserved
// for a schema `tag` that names a reserved element (at the element's name);
// without it the resolution is silent. A reserved `x` was reported by the
// parser (name.reserved) and only falls through here. `unknown`: the
// fallback for a name with no schema entry, the one case name.unknown is for.
function resolve(node, want, s, report) {
  const level = LEVEL[node.type];
  const name = node.name;
  const fallback = level === 'inline' ? 'span' : 'div';
  if (isReservedName(name)) return { tag: fallback, spec: null, reserved: true, unknown: false };
  const spec = entry(s, level, name);
  const allow = ALLOW[level];
  const t = (node.data && node.data.tern) || {};
  const refuse = (tag, at, how) =>
    report &&
    report('tag.not-allowed', at, `${how} \`${tag}\`, which ${level === 'inline' ? 'an inline element' : `a ${level === 'block' ? 'container' : 'leaf'}`} cannot be; the next rule decides`, HINT[level]);
  if (want !== undefined && !isReservedName(want)) {
    if (allow.has(want)) return { tag: want, spec, reserved: false, unknown: false };
    refuse(want, t.tagPosition || node, '`tag=` asks for');
  }
  if (spec && typeof spec.tag === 'string') {
    if (isReservedName(spec.tag)) {
      if (report) report('name.reserved', namePosition(node), `the schema gives \`${name}\` the element \`${spec.tag}\`, which is reserved and never produced; the next rule decides`, HINT[level]);
    } else if (allow.has(spec.tag)) return { tag: spec.tag, spec, reserved: false, unknown: false };
    else refuse(spec.tag, namePosition(node), `the schema gives \`${name}\` the element`);
  }
  if (isCustomName(name)) return { tag: name, spec, reserved: false, unknown: false };
  if (allow.has(name)) return { tag: name, spec, reserved: false, unknown: false };
  return { tag: fallback, spec, reserved: false, unknown: !spec };
}
const HINT = {
  block: 'choose a flow element such as section, aside or div',
  leaf: 'choose a flow or media element such as div, figure or video',
  inline: 'choose a phrasing element such as kbd, abbr or span',
};

// Where a named element's name is written: recorded by the parser for
// containers and leaves; an inline element's follows its `:`.
function namePosition(node) {
  const t = (node.data && node.data.tern) || {};
  if (t.namePosition) return t.namePosition;
  const p = node.position;
  if (!p || node.type !== 'textDirective') return p;
  const at = (q, k) => ({ line: q.line, column: q.column + k, offset: q.offset + k });
  return { start: at(p.start, 1), end: at(p.start, 1 + String(node.name).length) };
}

// The title slot: the schema's `title`, when it can stand in the element
// (a `summary` only in a `details` …), else the tag's own slot, else div.
const SLOT_OF_TAG = { details: 'summary', figure: 'figcaption', table: 'caption', fieldset: 'legend' };
const TITLE = { block: 'div', inline: 'span', summary: 'summary', figcaption: 'figcaption', caption: 'caption', legend: 'legend' };
const PARENT_OF = { summary: 'details', figcaption: 'figure', caption: 'table', legend: 'fieldset' };
function slotFor(title, tag) {
  const s = own(TITLE, title) ? TITLE[title] : null;
  if (s && (!PARENT_OF[s] || PARENT_OF[s] === tag)) return s;
  return SLOT_OF_TAG[tag] || 'div';
}

// ---------------------------------------------------------------- labels

// The label of an element of `spec` numbered n (undefined when it is not
// counted), in `lang`: {word, text}. `text` is data.tern.text ("Theorem 2",
// "Proof", or "2" when counted without a label); `word` is what {label}
// stands for in a ref template. A label function's result is both.
function label(spec, n, node, lang) {
  const l = spec ? spec.label : null;
  if (typeof l === 'function') {
    const s = l(n, node);
    const text = s == null ? '' : String(s);
    return { word: text, text };
  }
  const word = typeof l === 'string' ? l : l && typeof l === 'object' ? pick(l, lang) : '';
  return { word, text: n == null ? word : word ? `${word} ${n}` : String(n) };
}

// A language map's entry: the exact tag, then its primary subtag, then any
// entry with that primary subtag, then `en`, then the first entry.
function pick(map, lang) {
  const keys = Object.keys(map).filter((k) => typeof map[k] === 'string');
  if (!keys.length) return '';
  const want = String(lang || '').toLowerCase();
  const primary = want.split('-')[0];
  const lower = keys.map((k) => k.toLowerCase());
  let i = lower.indexOf(want);
  if (i < 0) i = lower.indexOf(primary);
  if (i < 0 && primary) i = lower.findIndex((k) => k.split('-')[0] === primary);
  if (i < 0) i = lower.indexOf('en');
  return map[keys[i < 0 ? 0 : i]];
}

module.exports = {
  schema,
  block: define('block'),
  leaf: define('leaf'),
  inline: define('inline'),
  own,
  LEVEL,
  ALLOW,
  CORE,
  VOID,
  entry,
  resolve,
  namePosition,
  slotFor,
  label,
};
  };
  // ---- src/transform.js
  defs['transform'] = function (module, exports, require) {
// The transforms: the semantics of a note, computed in place on its parse
// AST. They are pure (no DOM) and identical under node and in browsers.
// Nothing recurses, so a deep tree cannot overflow the stack: `figures` and
// `tables` walk the blocks, and one walk (index) collects what the others
// read, so the pipeline stays linear in the note. Their diagnostics go to
// root.data.tern.diagnostics.
//
//   run(ast, opts) -> ast         opts: {schema, head, lang}
//   register(name, fn, {before | after}) -> unregister
//     fn(ast, ctx), ctx = {schema, opts, lang, report(code, at, message, hint, severity)},
//     `at` being a node or a position
//   names() -> the order
//
// The contract with src/emit.js, which reads nothing else from the schema or
// the source (in full: docs/api.html#transformed-ast). Under data.tern:
//   named elements  tag; slot (the title element); text (the label); end; cols
//   toc leaves      toc: [{depth, id, children}]
//   fences          lines, start, hl (displayed line numbers), hlText;
//                   slot and text when titled (a listing)
//   display math    text, the equation number "(1)"
//   refs            resolved; a resolved ref's children are its text
//   footnote refs   resolved, number, id, target
//   footnote defs   id, backref; dropped when a duplicate
//   root            footnotes: definition identifiers in output order
// `attributes` ends as exactly what the element gets besides tern's own
// classes and data-t. The tree changes too: an image paragraph may become a
// `figure` container, and a schema's titleDefault a label paragraph.
// Written for other readers (the runtime, the command line, the language
// server): root ids, meta and transformed; counter and number; raw, depth
// and implicit; a fragment link's resolved.

const { SEVERITY, sortDiagnostics } = require('./diag');
const { isReservedName, put } = require('./scan'); // put: `__proto__` is an ordinary attribute name
const S = require('./schema');

const IDENT_FULL = /^[\p{L}_][\p{L}\p{M}\p{N}_-]*$/u; // a whole id that @ can reach
const ORIGIN = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
const EMPTY = Object.freeze({});
const SEV = Object.assign(Object.create(null), SEVERITY); // a lookup that needs no own-property check
// Nodes that hold blocks: the only places a block-level node can be.
const BLOCKS = new Set(['root', 'containerDirective', 'cell', 'blockquote', 'list', 'listItem', 'footnoteDefinition']);

const tern = (n) => {
  const d = n.data || (n.data = {});
  return d.tern || (d.tern = {});
};
const peek = (n) => (n.data && n.data.tern) || EMPTY;
// Gives a node the fields of `o`: as its data.tern when it has none, which
// builds it in one go, else copied in.
const set = (n, o) => {
  if (!n.data) n.data = { tern: o };
  else if (!n.data.tern) n.data.tern = o;
  else Object.assign(n.data.tern, o);
};
const isNamed = (n) => n.type === 'containerDirective' || n.type === 'leafDirective' || n.type === 'textDirective';
const isCore = (n) => n.type === 'containerDirective' && S.CORE.has(n.name); // meta, macros, script …: own output
const dropped = (n) => n.type === 'footnoteDefinition' && peek(n).dropped === true;
const titled = (n) => Array.isArray(peek(n).title) && peek(n).title.length > 0; // a titled fence, a listing; `[]` is no title
const isLabel = (n) => !!n && n.type === 'paragraph' && !!n.data && n.data.directiveLabel === true;
const specOf = (n, ctx) => (isNamed(n) && !isCore(n) && !isReservedName(n.name) ? S.entry(ctx.schema, S.LEVEL[n.type], n.name) : null);
// The k characters at the start of position p, on its line.
const prefix = (p, k) => ({ start: p.start, end: { line: p.start.line, column: p.start.column + k, offset: p.start.offset + k } });
// A footnote definition's `[^label]:`.
const marker = (d) => prefix(d.position || ORIGIN, String(d.label).length + 4);

// A node's children; a titled fence's title is inline content like any other.
const kidsOf = (n) => n.children || (n.type === 'code' ? peek(n).title : undefined);

// Pre-order, in document order, without recursion. enter(node, parent)
// returns false to skip the children; leave(node) runs after them.
function walk(root, enter, leave) {
  if (enter(root, null) === false) return;
  const ns = [root];
  const is = [0];
  while (ns.length) {
    const k = ns.length - 1;
    const n = ns[k];
    const kids = kidsOf(n);
    const i = is[k]++;
    if (!kids || i >= kids.length) {
      ns.pop();
      is.pop();
      if (leave) leave(n);
      continue;
    }
    const c = kids[i];
    if (c && typeof c === 'object' && enter(c, n) !== false) ns.push(c), is.push(0);
  }
}

// What the model transforms read, collected by one walk into one list per
// reader, each in document order (pre-order, so an element comes before what
// it holds): `attrs` (attributes, named elements, fences), `ids` (attributes,
// headings, footnote nodes), `nums` (named elements, fences, display math),
// `refs` (references, fragment links), `fns` (footnote nodes) and `heads`
// (headings, leaves). `inDef` maps a node inside a footnote definition to it,
// as a dropped definition's content counts for nothing. Rebuilt after a
// custom transform, which may have changed the tree.
function index(ast, ctx) {
  if (ctx.idx) return ctx.idx;
  const x = { attrs: [], ids: [], nums: [], refs: [], fns: [], heads: [], inDef: new Map() };
  const ks = [];
  const is = [];
  const ds = [];
  let kids = ast.children || [];
  let i = 0;
  let def = null;
  for (;;) {
    if (i >= kids.length) {
      if (!ks.length) break;
      (kids = ks.pop()), (i = is.pop()), (def = ds.pop());
      continue;
    }
    const n = kids[i++];
    if (!n || typeof n !== 'object') continue;
    const type = n.type;
    if (type === 'text') continue; // the most common node: no attributes, no children
    const named = type === 'containerDirective' || type === 'leafDirective' || type === 'textDirective';
    const has = n.attributes !== undefined;
    const fn = type === 'footnoteDefinition' || type === 'footnoteReference';
    let k = 0;
    if (has || named || type === 'code') k = x.attrs.push(n);
    if (has || type === 'heading') k = x.ids.push(n); // footnote ids come from `fns`, merged by offset
    if (named || type === 'code' || type === 'math') k = x.nums.push(n);
    if (type === 'ref' || (type === 'link' && typeof n.url === 'string' && n.url[0] === '#')) k = x.refs.push(n);
    if (fn) k = x.fns.push(n);
    if (type === 'heading' || type === 'leafDirective') k = x.heads.push(n);
    if (k && def) x.inDef.set(n, def);
    const c = n.children || (type === 'code' ? peek(n).title : undefined);
    if (c && c.length) {
      ks.push(kids), is.push(i), ds.push(def);
      (kids = c), (i = 0);
      if (type === 'footnoteDefinition') def = n;
    }
  }
  return (ctx.idx = x);
}
// A dropped definition, or a node inside one.
const dead = (n, inDef) => dropped(n) || (inDef.size > 0 && inDef.has(n) && dropped(inDef.get(n)));
const empty = (o) => {
  for (const _ in o) return false;
  return true;
};

// ---------------------------------------------------------------- context

// What the preserved head sets: its <title> and <html lang>.
function headInfo(h) {
  const s = String(h || '');
  const out = {};
  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(s);
  if (t) out.title = t[1].trim();
  const html = /<html\b[^>]*>/i.exec(s);
  const m = html && /\slang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html[0]);
  if (m) out.lang = [m[1], m[2], m[3]].find((x) => x !== undefined);
  return out;
}

function context(ast, opts) {
  const list = ast.data.tern.diagnostics;
  const head = headInfo(opts.head);
  const meta = ast.data.tern.meta;
  return {
    schema: opts.schema || S.schema,
    opts,
    head,
    // The label language: the caller's, then `:::meta`, then <html lang>.
    lang: String(opts.lang || (meta && meta.lang) || head.lang || ''),
    reg: null, // the id registry, once the ids transform has run
    report(code, at, message, hint, severity) {
      const position = !at ? ORIGIN : at.position || (at.start && at.start.line !== undefined ? at : ORIGIN);
      const sev = SEV[code] || severity || 'warning';
      const d = hint ? { code, severity: sev, message, position, hint } : { code, severity: sev, message, position }; // one shape each, no growth
      list.push(d);
      return d;
    },
  };
}

// ---------------------------------------------------------------- figures

// The element a named node resolves to, silently: what `figures` and
// `tables` need before `attributes` resolves it with its diagnostics.
const tagOf = (n, ctx) => S.resolve(n, n.attributes ? n.attributes.tag : undefined, ctx.schema, null).tag;

// An implicit figure: a paragraph whose only content is one image, with an id
// on the image or on its attribute line, and with no ancestor whose tag is
// `figure`, becomes the node `:::figure[bracket text]{#id}` would be.
function figures(ast, ctx) {
  let inside = 0;
  const marks = [];
  walk(
    ast,
    (n) => {
      if (!BLOCKS.has(n.type)) return false;
      const fig = n.type === 'containerDirective' && tagOf(n, ctx) === 'figure';
      marks.push(fig);
      if (fig) inside++;
      const kids = n.children;
      if (!inside && kids) for (let i = 0; i < kids.length; i++) if (implicit(kids[i])) kids[i] = toFigure(kids[i]);
    },
    () => {
      if (marks.pop()) inside--;
    },
  );
}

function implicit(p) {
  if (p.type !== 'paragraph' || isLabel(p) || peek(p).junk) return false;
  const k = p.children;
  if (!k || k.length !== 1 || k[0].type !== 'image') return false;
  return (!!k[0].attributes && k[0].attributes.id !== undefined) || (!!p.attributes && p.attributes.id !== undefined);
}

// The figure takes the image's #id (which wins, as an opener's id wins over
// its attribute line's) and the paragraph's attributes; the image keeps the
// rest, and its alt is `alt=` or empty, so the caption is read once.
function toFigure(p) {
  const img = p.children[0];
  const ia = img.attributes || {};
  const pa = p.attributes || {};
  const it = peek(img);
  const pt = peek(p);
  const byImage = ia.id !== undefined;
  const attrs = {};
  const id = byImage ? ia.id : pa.id;
  if (id !== undefined) attrs.id = id;
  if (pa.class) attrs.class = pa.class;
  for (const k in pa) if (k !== 'id' && k !== 'class') put(attrs, k, pa[k]);
  const t = { implicit: true, namePosition: img.position };
  const idPosition = byImage ? it.idPosition : pt.idPosition;
  if (idPosition) t.idPosition = idPosition;
  if (pt.tagPosition) t.tagPosition = pt.tagPosition;
  for (const k of ['refPosition', 'rawPosition', 'colsPosition']) if (pt[k]) t[k] = pt[k]; // the attribute line's keys go with it
  const caption = it.caption || [];
  delete ia.id;
  if (img.attributes && !Object.keys(ia).length) delete img.attributes;
  img.alt = '';
  if (img.data && img.data.tern) {
    delete img.data.tern.idPosition;
    delete img.data.tern.caption;
    if (!Object.keys(img.data.tern).length) delete img.data;
  }
  delete p.attributes;
  delete p.data;
  const figure = { type: 'containerDirective', name: 'figure' };
  if (Object.keys(attrs).length) figure.attributes = attrs;
  figure.children = [{ type: 'paragraph', data: { directiveLabel: true }, children: caption, position: img.position }, p];
  figure.position = p.position;
  figure.data = { tern: t };
  p.position = img.position;
  return figure;
}

// ---------------------------------------------------------------- tables

// The table merge: a container whose element is `table` merges with
// its body when the body is exactly one pipe table. Otherwise it gets
// table.body here, and `attributes` makes it a `div` that keeps its label and
// counter.
function tables(ast, ctx) {
  walk(ast, (n) => {
    if (!BLOCKS.has(n.type)) return false;
    if (n.type !== 'containerDirective' || tagOf(n, ctx) !== 'table') return;
    const t = soleTable(n);
    if (t) merge(n, t, ctx);
    else
      ctx.report(
        'table.body',
        S.namePosition(n),
        `\`:::${n.name}\` becomes a <table> only when its body is exactly one pipe table; this one is a div`,
        'put one `| … |` table in the block, or use another name',
      );
  });
}

function soleTable(n) {
  let one = null;
  for (const c of n.children || []) {
    if (isLabel(c)) continue;
    if (one || c.type !== 'table') return null;
    one = c;
  }
  return one;
}

// The attributes combine and the container's win: its id beats the table's,
// and classes accumulate with the container's last. The table's own `tag=`,
// `raw` and `ref=` are not the container's, so they apply to nothing
// (tag.not-allowed, attr.malformed); its `cols=` sets the container's grid.
function merge(n, tbl, ctx) {
  const T = tbl.attributes;
  if (!T) return;
  if ('tag' in T) tagElsewhere(tbl, ctx);
  if ('raw' in T) misplaced(tbl, 'raw', ctx);
  if ('ref' in T) misplaced(tbl, 'ref', ctx);
  const C = n.attributes || {};
  const tt = peek(tbl);
  const m = {};
  const id = C.id !== undefined ? C.id : T.id;
  if (id !== undefined) m.id = id;
  const cls = [T.class, C.class].filter(Boolean).join(' ');
  if (cls) m.class = cls;
  for (const k in T) if (k !== 'id' && k !== 'class' && k !== 'tag' && k !== 'raw' && k !== 'ref') put(m, k, T[k]);
  for (const k in C) if (k !== 'id' && k !== 'class') put(m, k, C[k]);
  n.attributes = m;
  if (C.id === undefined && T.id !== undefined && tt.idPosition) tern(n).idPosition = tt.idPosition;
  delete tbl.attributes;
  if (tt !== EMPTY) delete tt.idPosition, delete tt.tagPosition, delete tt.refPosition, delete tt.rawPosition, delete tt.colsPosition;
}

// ---------------------------------------------------------------- attributes

// Takes the reserved keys (tag, raw, cols, ref, and a fence's lines, start,
// hl) out of `attributes` into data.tern, reporting those that do not apply;
// resolves each named element (tag, schema defaults, title slot, void
// content); and turns `cols` into a grid.
function attributes(ast, ctx) {
  const code = S.entry(ctx.schema, 'block', 'code');
  for (const n of index(ast, ctx).attrs) {
    const a = n.attributes;
    let want, cols;
    if (a) {
      if ('tag' in a) {
        want = a.tag;
        delete a.tag;
        if (!isNamed(n)) tagElsewhere(n, ctx);
        else if ((isCore(n) || isReservedName(n.name)) && !isReservedName(String(want))) misplaced(n, 'tag', ctx); // a reserved value: name.reserved at parse
      }
      if ('raw' in a) {
        tern(n).raw = true;
        delete a.raw;
        if (n.type !== 'containerDirective' || peek(n).implicit) misplaced(n, 'raw', ctx); // an implicit figure's body was parsed already
      }
      if ('cols' in a) {
        cols = a.cols;
        delete a.cols;
        if (!isNamed(n) || isCore(n)) misplaced(n, 'cols', ctx);
      }
      if ('ref' in a) {
        if (n.type === 'ref') tern(n).ref = a.ref; // checked at parse (attr.malformed)
        else misplaced(n, 'ref', ctx);
        delete a.ref;
      }
      if (n.type === 'code') fenceKeys(n, a);
    }
    if (isNamed(n) && !isCore(n)) element(n, want, ctx);
    else if (n.type === 'code' && titled(n)) tern(n).slot = S.slotFor(code && code.title, 'figure');
    const g = n.type === 'containerDirective' || cols !== undefined ? grid(cols, n) : null;
    if (g) tern(n).cols = g;
    if (a && n.attributes === a && empty(a)) delete n.attributes;
  }
}

// `{tag=…}` on what is not a named element (a span, link, image, heading, a
// paragraph through its attribute line …) chooses nothing: tag.not-allowed
// at the key, and the key is dropped.
function tagElsewhere(n, ctx) {
  ctx.report(
    'tag.not-allowed',
    peek(n).tagPosition || n,
    '`tag=` applies only to `:::name`, `::name` and `:name[…]`; it is dropped here',
    'remove it; to choose the element, name it: `:kbd[…]`, `::video[…]`, `:::aside`',
  );
}

// A reserved key where it does not apply:
// attr.malformed at the key, naming where it applies; the key is dropped.
// `tag=` off named elements is tag.not-allowed instead (tagElsewhere).
// `lines`, `hl` and `start` are reserved on fences only, and ordinary
// attributes elsewhere, so they are never misplaced.
const KEY_USE = {
  ref: ['`ref=` applies only to a reference (`@id{ref=…}`)', 'remove it; on a reference it chooses the text: `@id{ref=title}`'],
  raw: ['`raw` applies only to a container (`:::name{raw}`), whose body it keeps verbatim', 'remove it, or write the block as `:::name{raw}` … `:::`'],
  cols: ['`cols=` applies only to a container, leaf or inline element (`:::name{cols=2}`), whose grid it sets', 'remove it, or put the content in a container: `:::row{cols=2}` … `:::`'],
  tag: ['`tag=` applies only to `:::name`, `::name` and `:name[…]`', 'remove it'],
};
function misplaced(n, key, ctx) {
  let [use, hint] = KEY_USE[key];
  if (isCore(n)) use += `, not to \`:::${n.name}\`, which has its own output`;
  else if (key === 'tag') (use += ` with a name that is not reserved, and \`${n.name}\` is`), (hint = 'choose a name that is not reserved, and keep `tag=`');
  ctx.report('attr.malformed', peek(n)[`${key}Position`] || n, `${use}; it is dropped here`, hint);
}

// A fence's `lines`, `start=N` and `hl=4,6-7`; hl names displayed line
// numbers, so they count from `start`.
function fenceKeys(n, a) {
  const t = tern(n);
  if ('lines' in a) (t.lines = true), delete a.lines;
  if ('start' in a) {
    const v = String(a.start).trim();
    delete a.start;
    if (/^-?\d{1,9}$/.test(v)) t.start = Number(v);
  }
  if ('hl' in a) {
    t.hlText = String(a.hl);
    delete a.hl;
    t.hl = hlLines(t.hlText, t.start === undefined ? 1 : t.start, String(n.value || '').split('\n').length);
  }
}

// The displayed line numbers `hl` names, ascending and within the fence:
// one pass over the value and one over the lines, whatever the ranges.
function hlLines(v, first, count) {
  const mark = new Int32Array(count + 1);
  for (const part of v.split(',')) {
    const m = /^\s*(\d{1,9})\s*(?:-\s*(\d{1,9})\s*)?$/.exec(part);
    if (!m) continue;
    let a = Number(m[1]);
    let b = m[2] === undefined ? a : Number(m[2]);
    if (a > b) [a, b] = [b, a];
    a = Math.max(a, first) - first;
    b = Math.min(b, first + count - 1) - first;
    if (a <= b) mark[a]++, mark[b + 1]--;
  }
  const out = [];
  for (let i = 0, on = 0; i < count; i++) if ((on += mark[i]) > 0) out.push(first + i);
  return out;
}

// A `cols` value as a grid template: an integer N, or one entry per column,
// a bare number W being minmax(0,Wfr); zero or a negative number is ignored
// (the parser reports it on a container). A body of cells without `cols` has
// one column per cell.
function grid(raw, n) {
  const v = raw === undefined ? '' : String(raw).trim();
  if (v && !(/^-?\d+(?:\.\d+)?$/.test(v) && Number(v) <= 0)) {
    if (/^\d+$/.test(v)) return `repeat(${Number(v)},minmax(0,1fr))`;
    return v
      .split(/\s+/)
      .map((w) => (/^\d+(?:\.\d+)?$/.test(w) ? `minmax(0,${w}fr)` : w))
      .join(' ');
  }
  let cells = 0;
  if (n.type === 'containerDirective') for (const c of n.children || []) if (c.type === 'cell') cells++;
  return cells ? `repeat(${cells},minmax(0,1fr))` : null;
}

// A named element: its tag, schema defaults, end mark and title slot.
function element(n, want, ctx) {
  const t = tern(n);
  const r = S.resolve(n, want, ctx.schema, ctx.report);
  t.tag = r.tag === 'table' && n.type === 'containerDirective' && !soleTable(n) ? 'div' : r.tag; // table.body (tables)
  if (r.unknown && ctx.schema.strict) // only a name with no schema entry
    ctx.report('name.unknown', S.namePosition(n), `\`${n.name}\` has no schema entry and names no element, so it is a ${t.tag}`, 'check the spelling, or declare the name with tern.block, tern.leaf or tern.inline');
  const spec = r.spec;
  if (spec) defaults(n, spec);
  if (n.type === 'containerDirective') {
    if (spec && spec.end != null && spec.end !== '') t.end = String(spec.end);
    titleSlot(n, t, spec);
  } else if (S.VOID.has(t.tag) && n.children && n.children.length)
    ctx.report('leaf.void-content', n, `<${t.tag}> holds no content; what the brackets hold follows it`, 'remove the brackets, or choose an element that holds content');
  if (spec && spec.transform === 'toc' && n.attributes && 'depth' in n.attributes) (t.depth = n.attributes.depth), delete n.attributes.depth;
}

// The schema's `class` before the author's classes, and its `attrs` under the
// author's. Never an id: every instance would share it.
function defaults(n, spec) {
  const def = spec.attrs && typeof spec.attrs === 'object' ? spec.attrs : null;
  const cls = [spec.class, def && def.class].filter((c) => typeof c === 'string' && c);
  if (!cls.length && !def) return;
  const a = n.attributes || {};
  const out = {};
  if (a.id !== undefined) out.id = a.id;
  const c = cls.concat(a.class ? [a.class] : []).join(' ');
  if (c) out.class = c;
  if (def)
    for (const k in def) {
      const v = def[k];
      if (k === 'id' || k === 'class' || S.own(a, k) || v == null || v === false || /^(?:tag|raw|cols|ref|data-t)$/.test(k)) continue;
      put(out, k, v === true ? '' : String(v));
    }
  for (const k in a) if (k !== 'id' && k !== 'class') put(out, k, a[k]);
  n.attributes = out;
}

// The title slot, set when a title or a label is emitted. With no written
// title the schema's `titleDefault` is the title.
function titleSlot(n, t, spec) {
  const kids = n.children || (n.children = []);
  const label = isLabel(kids[0]) ? kids[0] : null;
  let has = !!label && label.children.length > 0;
  if (!has && spec && spec.titleDefault != null && spec.titleDefault !== '') {
    const text = [{ type: 'text', value: String(spec.titleDefault) }];
    if (label) label.children = text;
    else kids.unshift({ type: 'paragraph', data: { directiveLabel: true }, children: text, position: n.position && { start: n.position.start, end: n.position.start } });
    has = true;
  }
  const labelled = !!spec && ((spec.label != null && spec.label !== '') || (spec.counter != null && spec.counter !== ''));
  if (has || labelled) t.slot = S.slotFor(spec && spec.title, t.tag);
}

// ---------------------------------------------------------------- footnotes

// Definitions match by folded label and the first wins; numbers follow the
// first references; ids use the definition's label as written.
function footnotes(ast, ctx) {
  const defs = new Map(); // identifier -> {node, uses, number, backref, target}
  const kept = [];
  const { fns } = index(ast, ctx);
  // A definition holds no references: the parser leaves them text (footnote.nested).
  for (const n of fns) {
    if (n.type !== 'footnoteDefinition') continue;
    const first = defs.get(n.identifier);
    if (first) {
      tern(n).dropped = true;
      ctx.report('footnote.duplicate', marker(n), `[^${n.label}] is already defined on line ${first.node.position.start.line}; this definition is dropped`, 'merge the two definitions, or give one another label');
    } else defs.set(n.identifier, { node: n, uses: 0, number: 0, backref: '', target: '' }), kept.push(n);
  }
  const order = [];
  let count = 0;
  for (const r of fns) {
    if (r.type !== 'footnoteReference') continue;
    const d = defs.get(r.identifier);
    if (!d) {
      set(r, { resolved: false });
      ctx.report('footnote.undefined', r, `[^${r.label}] has no definition, so it stays text`, `add a definition: \`[^${r.label}]: …\``);
      continue;
    }
    if (!d.uses) {
      const label = d.node.label;
      Object.assign(tern(d.node), { number: (d.number = ++count), backref: (d.backref = `fnref-${label}`), id: (d.target = `fn-${label}`) });
      order.push(d.node.identifier);
    }
    const k = ++d.uses;
    set(r, { resolved: true, number: d.number, id: k > 1 ? `${d.backref}-${k}` : d.backref, target: d.target });
  }
  for (const d of kept) {
    const dt = tern(d);
    if (dt.number !== undefined) continue;
    dt.id = `fn-${d.label}`;
    order.push(d.identifier);
    ctx.report('footnote.unused', marker(d), `[^${d.label}] is never referenced; it is listed after the referenced footnotes`, `reference it with [^${d.label}], or remove it`);
  }
  ast.data.tern.footnotes = order;
}

// ---------------------------------------------------------------- ids

const DUP = 'give each element its own id';

// The ids tern gives elements of its own, in the page around the note: the
// base stylesheet, the colour-scheme meta, the holder of the source and a
// built page's diagnostics (src/runtime.js, cli/build.js). Exported for the
// runtime, the command line and the tests.
const TERN_IDS = Object.freeze(['tern-style', 'tern-color-scheme', 'tern-source', 'tern-diagnostics']);
const TERN = Object.freeze({ type: '#tern' }); // their holder in the registry

// One registry for every id. Tern's own ids first, then the fixed ids, in
// document order: the ids authors wrote and the generated fn-/fnref- ids.
// Then heading slugs, which yield silently with -2, -3 … A heading whose own
// id was dropped gets a slug.
function ids(ast, ctx) {
  const reg = (ctx.reg = new Registry());
  const heads = [];
  const told = new Set(); // first holders already reported
  const add = (id, node, at) => {
    const prev = reg.node(id);
    if (!prev) return reg.add(id, node, false), true;
    if (prev === TERN) {
      ctx.report('id.duplicate', at, `the id "${id}" belongs to tern itself, which gives it to an element of its own in the page; this element drops it`, 'choose another id');
      return false;
    }
    const first = idAt(prev, id);
    if (!told.has(id)) told.add(id), ctx.report('id.duplicate', first, `the id "${id}" is used again on line ${at.start.line}; this element keeps it`, DUP);
    ctx.report('id.duplicate', at, `the id "${id}" is already used on line ${first.start.line}; this element drops it`, DUP);
    return false;
  };
  const { ids: list, fns, inDef } = index(ast, ctx);
  // A generated footnote id (fns) is registered where its node starts, before
  // an author id on the same node.
  const generated = (n) => {
    const t = peek(n);
    if (t.id !== undefined && !dead(n, inDef) && !add(t.id, n, n.type === 'footnoteReference' ? n.position : marker(n))) delete t.id;
  };
  let j = 0;
  for (const n of list) {
    const at = n.position ? n.position.start.offset : 0;
    while (j < fns.length && (fns[j].position ? fns[j].position.start.offset : 0) <= at) generated(fns[j++]);
    if (dead(n, inDef)) continue;
    const a = n.attributes;
    if (a && a.id !== undefined && n.type === 'containerDirective' && n.name === 'meta') {
      delete a.id; // `:::meta` emits nothing, so its id names nothing (attr.malformed at parse)
      if (empty(a)) delete n.attributes;
    } else if (a && a.id !== undefined) authorId(n, a, peek(n), ctx, add);
    if (n.type === 'heading') heads.push(n);
  }
  while (j < fns.length) generated(fns[j++]);
  const next = new Map(); // a slug -> the first suffix that may be free
  for (const h of heads) {
    if (h.attributes && h.attributes.id !== undefined) continue;
    const base = slug(plain(h.children, false));
    let id = base;
    if (reg.node(id)) {
      let k = next.get(base) || 2;
      while (reg.node(`${base}-${k}`)) k++;
      id = `${base}-${k}`;
      next.set(base, k + 1);
    }
    reg.add(id, h, true);
    const a = { id }; // the slug first, as `id` is always emitted first
    for (const k in h.attributes) if (k !== 'id') put(a, k, h.attributes[k]);
    h.attributes = a;
  }
  reg.publish(ast.data.tern);
}

// The registry: a Map from each id to its element, so an id costs no object
// of its own. Its JSON form, root.data.tern.ids = {id: {kind, explicit, line,
// column}}, is built when first read: an enumerable accessor that replaces
// itself with the plain object. Building it up front would put every id (20k
// fnref ids for a footnote cited 20k times) through the string table, for an
// emitter that never reads it.
class Registry {
  constructor() {
    this.nodes = new Map();
    this.slugs = new Set();
    for (const id of TERN_IDS) this.nodes.set(id, TERN); // taken before the note's own
  }
  node(id) {
    const n = this.nodes.get(id);
    return n === undefined ? null : n;
  }
  add(id, node, slug) {
    this.nodes.set(id, node);
    if (slug) this.slugs.add(id);
  }
  json() {
    const out = Object.create(null);
    for (const [id, n] of this.nodes) {
      if (n === TERN) continue; // the note's ids only
      const generated = this.slugs.has(id) || ((n.type === 'footnoteDefinition' || n.type === 'footnoteReference') && peek(n).id === id);
      const p = (this.slugs.has(id) ? n.position || ORIGIN : idAt(n, id)).start;
      out[id] = { kind: isNamed(n) ? n.name : n.type, explicit: !generated, line: p.line, column: p.column };
    }
    return out;
  }
  publish(rt) {
    const plain = (value) => Object.defineProperty(rt, 'ids', { value, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(rt, 'ids', { get: () => (plain(this.json()), rt.ids), set: plain, enumerable: true, configurable: true });
  }
}
// The element an id names in the note; tern's own ids name none of its elements.
const target = (ctx, id) => {
  const n = ctx.reg ? ctx.reg.node(id) : null;
  return n === TERN ? null : n;
};

// Where a node's id is written, for diagnostics: the `#` or `id=` item, a
// footnote definition's `[^label]:`, a footnote reference; else the node.
function idAt(n, id) {
  const t = peek(n);
  if (t.id === id && n.type === 'footnoteDefinition') return marker(n);
  if (t.id === id && n.type === 'footnoteReference') return n.position || ORIGIN;
  return t.idPosition || n.position || ORIGIN;
}

// An id an author wrote: invalid HTML ids are dropped, valid ones that @
// cannot reach are kept with a warning, and a later duplicate is dropped.
function authorId(n, a, t, ctx, add) {
  const id = String(a.id);
  const at = t.idPosition || n.position || ORIGIN;
  if (!id || /[\t\n\f\r ]/.test(id)) {
    ctx.report('id.invalid', at, `"${id}" is not a valid HTML id: it is empty or holds whitespace, so it is dropped`, 'write an id without spaces: {#my-id}');
  } else {
    if (!IDENT_FULL.test(id))
      ctx.report('ref.unreferenceable', at, `the id "${id}" is kept, but @ cannot reach it: a referenceable id starts with a letter or _ and holds no ":" or "."`, 'write it like {#plan-2024}');
    if (add(id, n, at)) return;
  }
  delete a.id;
  if (empty(a)) delete n.attributes;
}

// A heading slug: NFKC, lower case, from the first letter or `_`, runs
// outside [\p{L}\p{M}\p{N}_-] as `-`, trimmed of `-`; `section` when nothing
// is left.
function slug(text) {
  const s = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[^\p{L}_]+/u, '')
    .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '-');
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === '-') a++;
  while (b > a && s[b - 1] === '-') b--;
  return s.slice(a, b) || 'section';
}

// The plain text of inline content: text with entities decoded, code
// and math as written; tags, images and footnote references dropped. A
// reference is its id; with `useText`, its text, or `@id` when unresolved.
function plain(nodes, useText) {
  let s = '';
  const lists = [nodes];
  const at = [0];
  while (lists.length) {
    const k = lists.length - 1;
    const list = lists[k];
    const i = at[k]++;
    if (!list || i >= list.length) {
      lists.pop(), at.pop();
      continue;
    }
    const n = list[i];
    if (n.type === 'text' || n.type === 'inlineCode' || n.type === 'inlineMath') s += n.value;
    else if (n.type === 'break') s += ' ';
    else if (n.type === 'ref' && !(useText && n.children)) s += useText ? `@${n.id}` : n.id;
    else if (n.children && n.type !== 'footnoteReference') lists.push(n.children), at.push(0);
  }
  return s;
}

// ---------------------------------------------------------------- numbering

// In document order, an element numbered at its opener before what it holds.
// Counters come from the schema and are shared by name; equations are on
// `equation`, and only with an id. `within` is not applied (schema.js).
function numbering(ast, ctx) {
  const counters = new Map();
  const code = S.entry(ctx.schema, 'block', 'code');
  const next = (c) => {
    const k = (counters.get(c) || 0) + 1;
    counters.set(c, k);
    return k;
  };
  const { nums, inDef } = index(ast, ctx);
  for (const n of nums) {
    if (dead(n, inDef)) continue;
    if (n.type === 'math') {
      if (n.attributes && n.attributes.id !== undefined && !peek(n).unclosed) {
        const k = next('equation');
        Object.assign(tern(n), { counter: 'equation', number: k, text: `(${k})` });
      }
      continue;
    }
    const spec = n.type === 'code' ? (titled(n) ? code : null) : specOf(n, ctx);
    if (!spec) continue;
    const t = tern(n);
    let k;
    if (spec.counter != null && spec.counter !== '') (t.counter = String(spec.counter)), (k = t.number = next(t.counter));
    const { text } = S.label(spec, k, n, ctx.lang);
    if (text) t.text = text;
  }
}

// ---------------------------------------------------------------- refs

const DANGLING = 'no id in this note has this name, so the reference stays text';

// `@id` gets its target's text; a fragment link is checked.
function refs(ast, ctx) {
  const { refs: list, inDef } = index(ast, ctx);
  for (const n of list) {
    if (dead(n, inDef)) continue;
    if (n.type === 'ref') reference(n, ctx);
    else if (n.type === 'link' && typeof n.url === 'string' && n.url.length > 1 && n.url[0] === '#') fragment(n, ctx);
  }
}

// A resolved reference gets its text as children; an unresolved one gets
// none, and is written as its literal `@id`.
function reference(n, ctx) {
  const e = target(ctx, n.id);
  if (e) {
    set(n, { resolved: true }); // data first, so the JSON keeps its key order
    n.children = refText(e, peek(n).ref, n.id, ctx);
    return;
  }
  set(n, { resolved: false });
  ctx.report('ref.dangling', n, DANGLING, `if it is not a reference, write \\@${n.id}`);
}

// A fragment link: a missing target gives ref.dangling at the `[`; the link
// stays a link.
function fragment(n, ctx) {
  let id = n.url.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch (e) {
    // not percent-encoded UTF-8: compared as written
  }
  const ok = !!target(ctx, id);
  tern(n).resolved = ok;
  if (!ok) ctx.report('ref.dangling', prefix(n.position || ORIGIN, 1), `the link points to #${id}, which names no id in this note`, 'check the id, or give the target that id');
}

// What a target offers a reference: its number and label text, the word a
// template's {label} stands for, its title (a heading's is its content).
function info(T, ctx) {
  const t = peek(T);
  const I = { number: t.number, text: t.text, word: '', title: null, spec: null, equation: T.type === 'math', heading: T.type === 'heading' };
  if (I.heading) I.title = T.children;
  else if (T.type === 'code') {
    if (titled(T)) (I.spec = S.entry(ctx.schema, 'block', 'code')), (I.title = t.title);
  } else if ((I.spec = specOf(T, ctx)) || T.type === 'containerDirective') {
    const k = T.type === 'containerDirective' && T.children && T.children[0];
    if (isLabel(k) && k.children.length) I.title = k.children;
  }
  if (I.spec) I.word = S.label(I.spec, I.number, T, ctx.lang).word;
  if (I.title && !I.title.length) I.title = null;
  return I;
}

// A reference's text. `ref=` chooses a part, and a part the target lacks
// gives the default text; the default is the schema's template when the
// target has every part it names, else by kind: label and number, `(n)`, the
// heading's content, the title, the label, the id.
function refText(T, sel, id, ctx) {
  const I = info(T, ctx);
  const counted = I.number != null;
  const label = !I.equation && I.text ? I.text : '';
  if (sel === 'label' && label) return [{ type: 'text', value: label }];
  if (sel === 'number' && counted) return [{ type: 'text', value: String(I.number) }];
  if (sel === 'title' && I.title) return copy(I.title, ctx);
  if (sel === 'full' && label && I.title) {
    const out = [{ type: 'text', value: `${label} (` }];
    for (const c of copy(I.title, ctx)) add(out, c);
    return add(out, { type: 'text', value: ')' }), out;
  }
  const r = I.spec && typeof I.spec.ref === 'string' ? template(I.spec.ref, I, id, ctx) : null;
  if (r) return r;
  if (counted) return [{ type: 'text', value: I.text || String(I.number) }];
  if (I.title) return copy(I.title, ctx);
  return [{ type: 'text', value: I.text || id }];
}

// A template over {label} {n} {title} {id}; null when the target lacks a part.
function template(str, I, id, ctx) {
  const out = [];
  const re = /\{(label|n|title|id)\}/g;
  let last = 0;
  for (let m; (m = re.exec(str)); last = re.lastIndex) {
    add(out, { type: 'text', value: str.slice(last, m.index) });
    if (m[1] === 'label') {
      if (!I.word) return null;
      add(out, { type: 'text', value: I.word });
    } else if (m[1] === 'n') {
      if (I.number == null) return null;
      add(out, { type: 'text', value: String(I.number) });
    } else if (m[1] === 'title') {
      if (!I.title) return null;
      for (const c of copy(I.title, ctx)) add(out, c);
    } else add(out, { type: 'text', value: id });
  }
  add(out, { type: 'text', value: str.slice(last) });
  return out;
}

// Appends a node, merging plain text into plain text.
function add(out, n) {
  const last = out[out.length - 1];
  if (n.type === 'text' && !n.data) {
    if (!n.value) return out;
    if (last && last.type === 'text' && !last.data) return (last.value += n.value), out;
  }
  out.push(n);
  return out;
}

// A copy of inline content to put inside a link (a reference's text, a toc
// entry): positions and ids dropped, links unwrapped, footnote references
// left out. A reference inside becomes its target's plain text, never a link
// in a link, so copies never nest; ref text and toc entries flatten alike.
function copy(nodes, ctx) {
  const one = nodes.length === 1 && nodes[0].type === 'text' && !nodes[0].data ? nodes[0] : null;
  if (one) return [{ type: 'text', value: one.value }]; // the usual title
  const root = [];
  const src = [nodes];
  const at = [0];
  const dst = [root];
  while (src.length) {
    const k = src.length - 1;
    const list = src[k];
    const i = at[k]++;
    if (!list || i >= list.length) {
      src.pop(), at.pop(), dst.pop();
      continue;
    }
    const n = list[i];
    const out = dst[k];
    if (n.type === 'footnoteReference') continue;
    if (n.type === 'link') {
      src.push(n.children || []), at.push(0), dst.push(out);
      continue;
    }
    if (n.type === 'ref') add(out, { type: 'text', value: shortText(n, ctx) });
    else if (n.type === 'text' && !(n.data && n.data.tern && n.data.tern.entity)) add(out, { type: 'text', value: n.value });
    else {
      const c = clone(n);
      out.push(c);
      if (n.children) (c.children = []), src.push(n.children), at.push(0), dst.push(c.children);
    }
  }
  return root;
}

function clone(n) {
  const c = {};
  for (const k in n) if (k !== 'position' && k !== 'children' && k !== 'attributes' && k !== 'data') c[k] = n[k];
  if (n.attributes) {
    const a = {};
    for (const k in n.attributes) if (k !== 'id') put(a, k, n.attributes[k]);
    if (Object.keys(a).length) c.attributes = a;
  }
  if (n.data) {
    c.data = Object.assign({}, n.data);
    if (n.data.tern) {
      const t = (c.data.tern = Object.assign({}, n.data.tern));
      delete t.idPosition, delete t.tagPosition, delete t.namePosition, delete t.caption;
      delete t.refPosition, delete t.rawPosition, delete t.colsPosition;
    }
  }
  return c;
}

// A reference inside copied content: its target's default text, as plain text.
function shortText(n, ctx) {
  const e = target(ctx, n.id);
  if (!e) return `@${n.id}`;
  const I = info(e, ctx);
  if (I.number != null) return I.text || String(I.number);
  return (I.title && plain(I.title, false)) || I.text || n.id;
}

// ---------------------------------------------------------------- toc

// A leaf whose schema `transform` is 'toc' lists the headings in its depth
// range in document order: data.tern.toc = [{depth, id, children}], the
// children a copy of the heading's inline content, flattened as ref text is
// (copy: a reference is its target's plain text). Its range is `{depth=…}`
// on the leaf, else the schema's `depth`, else '2-3'; a single N is the range
// from the lower bound to N.
function toc(ast, ctx) {
  const tocs = [];
  const heads = [];
  const { heads: list, inDef } = index(ast, ctx);
  for (const n of list) {
    if (n.type === 'heading') {
      if (!dead(n, inDef)) heads.push(n);
    } else if (n.type === 'leafDirective' && !dead(n, inDef)) {
      const spec = specOf(n, ctx);
      if (spec && spec.transform === 'toc') tocs.push([n, spec]);
    }
  }
  for (const [n, spec] of tocs) {
    const [lo, hi] = depthRange(peek(n).depth, depthRange(spec.depth, [2, 3]));
    const entries = [];
    for (const h of heads)
      if (h.depth >= lo && h.depth <= hi && h.attributes && h.attributes.id !== undefined) entries.push({ depth: h.depth, id: h.attributes.id, children: copy(h.children, ctx) });
    tern(n).toc = entries;
  }
}

function depthRange(v, fallback) {
  const m = v == null ? null : /^\s*([1-6])\s*(?:-\s*([1-6])\s*)?$/.exec(String(v));
  if (!m) return fallback;
  const a = Number(m[1]);
  if (m[2] === undefined) return [Math.min(fallback[0], a), a];
  const b = Number(m[2]);
  return a <= b ? [a, b] : [b, a];
}

// ---------------------------------------------------------------- meta

// The title fallback: with no title in the head or in `:::meta`, the plain
// text of the first level-1 heading is meta.title.
function meta(ast, ctx) {
  const rt = ast.data.tern;
  if ((rt.meta && rt.meta.title !== undefined) || ctx.head.title !== undefined) return;
  const { heads, inDef } = index(ast, ctx);
  const h1 = heads.find((n) => n.type === 'heading' && n.depth === 1 && !dead(n, inDef));
  const title = h1 ? plain(h1.children, true).trim() : '';
  if (title) (rt.meta || (rt.meta = Object.create(null))).title = title;
}

// ---------------------------------------------------------------- the pipeline

// The order: figures and the table merge before `attributes`, which resolves
// the nodes they make; footnote ids before the other ids.
const BUILTIN = { figures, tables, attributes, footnotes, ids, numbering, refs, toc, meta };
const order = Object.keys(BUILTIN);
const custom = new Map();
const KEEPS = new Set(['attributes', 'footnotes', 'ids', 'numbering', 'refs', 'toc', 'meta']); // leave the index valid

function run(ast, opts) {
  const d = ast.data || (ast.data = {});
  const rt = d.tern || (d.tern = {});
  if (!Array.isArray(rt.diagnostics)) rt.diagnostics = [];
  if (rt.transformed) return ast; // once per tree: a second run would take slugs for authors' ids
  rt.transformed = true;
  const ctx = context(ast, opts || {});
  for (const name of order.slice()) {
    if (S.own(BUILTIN, name)) BUILTIN[name](ast, ctx);
    else if (custom.has(name)) guarded(name, custom.get(name), ast, ctx);
    if (!KEEPS.has(name)) ctx.idx = null; // it may have changed the tree
  }
  if (!ordered(rt.diagnostics)) sortDiagnostics(rt.diagnostics);
  return ast;
}

// A registered transform that throws is skipped, and the rest run: one
// add-on's bug must not cost the reader the note. It is addon.failed at
// line 0, the tern.js line, as the runtime reports add-on problems, since no
// note line is at fault.
function guarded(name, fn, ast, ctx) {
  try {
    fn(ast, ctx);
  } catch (e) {
    let why;
    try {
      why = String(e && typeof e === 'object' && e.message !== undefined ? e.message : e);
    } catch (e2) {
      why = 'a value that cannot be shown';
    }
    const at = () => ({ line: 0, column: 0, offset: 0 });
    ctx.report('addon.failed', { start: at(), end: at() }, `the transform "${name}" threw: ${why}; the note renders without it`, `fix the function given to tern.transform("${name}", …)`, 'error');
  }
}

// Whether diagnostics are already in sortDiagnostics' order, as each
// transform reports in document order: one cheap pass instead of a sort.
function ordered(list) {
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1].position;
    const b = list[i].position;
    const d = a.start.offset - b.start.offset || a.end.offset - b.end.offset;
    if (d > 0 || (d === 0 && list[i - 1].code > list[i].code)) return false;
  }
  return true;
}

// tern.transform(name, fn, {before | after}): adds a transform, at the end by
// default; registering a name again moves and replaces it. Returns a function
// that removes it.
function register(name, fn, where) {
  if (typeof name !== 'string' || !name) throw new TypeError('tern.transform(name, fn): name must be a non-empty string');
  if (typeof fn !== 'function') throw new TypeError(`tern.transform("${name}", fn): fn must be a function`);
  if (S.own(BUILTIN, name)) throw new Error(`tern.transform: "${name}" is a built-in transform`);
  const w = where || {};
  const anchor = w.before !== undefined ? w.before : w.after;
  if (anchor !== undefined && (anchor === name || !order.includes(anchor))) throw new Error(`tern.transform("${name}"): there is no transform "${anchor}"`);
  if (custom.has(name)) order.splice(order.indexOf(name), 1), custom.delete(name);
  let i = order.length;
  if (anchor !== undefined) i = order.indexOf(anchor) + (w.before !== undefined ? 0 : 1);
  order.splice(i, 0, name);
  custom.set(name, fn);
  return () => {
    if (custom.get(name) !== fn) return;
    custom.delete(name);
    order.splice(order.indexOf(name), 1);
  };
}

module.exports = { run, register, names: () => order.slice(), TERN_IDS };
  };
  // ---- src/emit.js
  defs['emit'] = function (module, exports, require) {
// The one HTML emitter. It reads the transformed AST and nothing else, so
// every host emits the same string from the same tree; the data.tern fields
// it reads from the transforms are listed at the top of src/transform.js.
//
//   emit(ast, {positions = true, safe = false, cssom = false}) -> HTML string
//     positions: `data-pos="line:col"` on math, directive, cell and code
//                elements, from which the runtime positions its diagnostics;
//     safe:      html nodes escaped, risky attributes and URLs dropped;
//     cssom:     for the browser runtime only: tern's own presentational
//                styles, a column's alignment and a grid's --t-cols, are
//                written as data-t-align and data-t-cols instead of `style`,
//                for the runtime to apply through the CSSOM, which a strict
//                CSP allows (presentation() in src/runtime.js). An author's
//                own `style` stays an attribute.
//
// The walk is iterative, so a deep tree cannot overflow the call stack: a
// work stack holds strings, nodes and cursors over child lists. A node's
// opening tag is written when it is reached, and its closing tag and a cursor
// over its children are pushed. An atom (text, code and math spans, images,
// footnote references, raw HTML) is written in place, and an element whose
// children are all atoms is written as one string. Output is gathered in
// flat chunks of about 16 KB (see write()).

const { decode } = require('./entities');
const { isReservedName } = require('./scan');

const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));
const SLOT = { details: 'summary', figure: 'figcaption', table: 'caption', fieldset: 'legend' }; // each tag's own title slot
const RESERVED_KEYS = new Set(['tag', 'raw', 'cols', 'ref']); // consumed by the transforms, never emitted
const FENCE_KEYS = new Set(['lines', 'hl', 'start']);
const VERBATIM_ERROR = new Set(['script', 'style', 'html']); // core containers shown as source in `pre.t-error`
// Under `safe`: attributes that hold a URL, and the schemes kept.
const URL_KEYS = new Set('href src action poster cite data background longdesc manifest ping icon codebase usemap xlink:href srcset archive profile lowsrc dynsrc classid'.split(' '));
const SAFE_SCHEME = /^(?:https?|mailto)$/i;
const FLAT = /^/; // a regexp's subject is flattened first: see write()
const ATTR_NAME = /^[^\s"'<>\/=]+$/; // a key from a schema's `attrs` is not checked by the parser
const FOOTNOTES = { type: '#footnotes' }; // the work item that starts the footnote section
const TOC_IN = { type: '#toc-in' }; // around a toc's entries: their links and ids are left out
const TOC_OUT = { type: '#toc-out' };

// ---------------------------------------------------------------- escaping

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escChar = (c) => ESC[c];
// Text: `<`, `>`, `&` and `"` escaped.
const TEXT = /[&<>"]/;
const TEXT_ALL = /[&<>"]/g;
const VALUE = /[&<"]/;
const VALUE_ALL = /[&<"]/g;
const esc = (s) => (TEXT.test(s) ? s.replace(TEXT_ALL, escChar) : s);
// A decoded value in an attribute (a URL, a title): every `&` escaped.
const escValue = (s) => (VALUE.test(s) ? s.replace(VALUE_ALL, escChar) : s);
// An author's attribute value: `"`, `<` and `&` escaped, a
// well-formed entity kept as written.
const ATTR = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,47});|[&<"]/g;
const escAttr = (s) => (VALUE.test(s) ? s.replace(ATTR, (m, body) => (body !== undefined && decode(body) !== null ? m : escChar(m[0]) + m.slice(1))) : s);

// Whether a URL may be emitted under `safe`: http(s), mailto or relative.
// The browser decodes entities and drops tabs, newlines and leading
// controls before it reads the scheme, so the check does too.
function safeUrl(v, entities) {
  let s = entities ? v.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,47});/g, (m, b) => decode(b) || m) : v;
  s = s.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+/, '');
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s);
  return !m || SAFE_SCHEME.test(m[1]);
}

// ---------------------------------------------------------------- state

// One emit at a time, as one parse at a time: the state lives here.
let out = null; // the output: flat chunks …
let buf = ''; // … and the one being built
let work = null; // the stack of pending nodes and strings
let positions = true;
let safe = false;
let cssom = false;
let section = false; // true once the footnote section is being written
let inToc = 0; // inside a toc entry: no nested links, no ids
let fnDefs = null; // identifier -> footnoteDefinition
let names = null; // see named(): containers' …
let inlineNames = null; // … and leaves' and inline elements'
let classes = null; // ` class="…"` for tern's own tokens, by token list
let fnPara = null; // the paragraph that ends with the back link …
let fnBack = '';
let taskPara = null; // … and the one that starts with a task checkbox
let taskBox = '';

// Appends to the current chunk. A full chunk is flattened (a regexp test
// flattens its subject) and set aside, so the output under construction is a
// few flat strings, not a graph of small ones that every young-generation
// collection would copy.
const write = (s) => {
  if ((buf += s).length > 16384) FLAT.test(buf), out.push(buf), (buf = '');
};
const tern = (node) => (node.data && node.data.tern) || {};
// A list of nodes still to write, from index i. Children go on the stack as
// one cursor, not one item each: next() writes them in place and stops only
// at a child that pushed work of its own.
function Cursor(list, i) {
  this.list = list;
  this.i = i;
}
const kids = (list) => {
  if (list && list.length) work.push(new Cursor(list, 0));
};
// The children as one string when every one is an atom, else null; for
// short lists (titles, toc entries) that are kept as strings.
function flat(list) {
  if (!list) return '';
  let s = '';
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const h = c && typeof c === 'object' ? atom(c) : '';
    if (h === null) return null;
    s += h;
  }
  return s;
}

// The HTML of a node written whole, with no children to walk, or null.
function atom(n) {
  const a = n.attributes;
  switch (n.type) {
    case 'text': {
      const e = n.data && n.data.tern && n.data.tern.entity;
      return e || esc(n.value || ''); // an entity as written
    }
    case 'break':
      return '<br>\n';
    case 'inlineCode':
      return `<code${attrs(a)}>${esc(n.value || '')}</code>`;
    case 'inlineMath':
      return (a ? `<span${attrs(a, 't-math', '', pos(n))}>` : `<span class="t-math"${pos(n)}>`) + esc(n.value || '') + '</span>';
    case 'image':
      return image(n, a);
    case 'footnoteReference':
      return footnoteReference(n, a);
    case 'html':
      return html(n);
    case 'ref': // unresolved, or in a toc: its literal text, when that is plain text
      if (tern(n).resolved && !inToc) return null;
      if (!n.children || !n.children.length) return esc(`@${n.id}`);
      return n.children.length === 1 && n.children[0].type === 'text' ? atom(n.children[0]) : null;
    default:
      return null;
  }
}
// Writes open, then the children: atoms in place, and from the first child
// that is not one, a cursor, with close pushed after it. Most elements hold
// only atoms (text, code, math), so most are written here whole.
function wrapped(open, list, close) {
  let s = open; // gathered here, written every 16 KB
  const n = list ? list.length : 0;
  for (let i = 0; i < n; i++) {
    const c = list[i];
    const h = c && typeof c === 'object' ? atom(c) : '';
    if (h === null) {
      write(s);
      work.push(close, new Cursor(list, i));
      return;
    }
    if ((s += h).length > 16384) write(s), (s = '');
  }
  write(s + close);
}
const pos = (node) => (positions && node.position ? ` data-pos="${node.position.start.line}:${node.position.start.column}"` : '');

// ` id="…" class="…"`, tern's own attributes (`extra`, already escaped),
// then the author's in order. `pre` and `post` are tern's
// class tokens before and after the author's; `skip` is a key emitted by the
// caller instead.
function attrs(a, pre, post, extra, skip, fence) {
  if (!a) {
    // Tern's own tokens only: names are NAME characters, nothing to escape.
    const cls = post ? (pre ? `${pre} ${post}` : post) : pre;
    if (!cls) return extra || '';
    let c = classes.get(cls);
    if (c === undefined) classes.set(cls, (c = ` class="${cls}"`));
    return extra ? c + extra : c;
  }
  let s = '';
  if (a.id != null && a.id !== '' && !inToc) s += ` id="${escAttr(String(a.id))}"`;
  let cls = pre || '';
  if (a.class) cls = cls ? `${cls} ${a.class}` : String(a.class);
  if (post) cls = cls ? `${cls} ${post}` : post;
  if (cls) s += ` class="${escAttr(cls)}"`;
  if (extra) s += extra;
  for (const k in a) {
    if (k === 'id' || k === 'class' || k === skip || RESERVED_KEYS.has(k) || (fence && FENCE_KEYS.has(k)) || !ATTR_NAME.test(k)) continue;
    const v = a[k] == null ? '' : String(a[k]);
    if (safe && (/^on/i.test(k) || k === 'srcdoc' || k === 'formaction' || k === 'style' || (URL_KEYS.has(k) && !safeSet(k, v)))) continue;
    s += v === '' ? ` ${k}` : ` ${k}="${escAttr(v)}"`;
  }
  return s;
}
const safeSet = (k, v) => (k === 'srcset' ? v.split(',').every((c) => safeUrl(c.trim().split(/\s+/)[0] || '', true)) : safeUrl(v, true));

// ---------------------------------------------------------------- the walk

function emit(ast, opts) {
  out = [];
  buf = '';
  work = [FOOTNOTES, ast];
  positions = !opts || opts.positions !== false;
  safe = !!(opts && opts.safe);
  cssom = !!(opts && opts.cssom);
  section = false;
  inToc = 0;
  fnDefs = new Map();
  names = new Map();
  inlineNames = new Map();
  classes = new Map();
  fnPara = taskPara = null;
  try {
    while (work.length) {
      const it = work.pop();
      if (typeof it === 'string') write(it);
      else if (it instanceof Cursor) next(it);
      else if (it === FOOTNOTES) footnotes(ast);
      else if (it === TOC_IN) inToc++;
      else if (it === TOC_OUT) inToc--;
      else if (it && typeof it === 'object') node(it);
    }
    // The flat chunks as one string. Concatenated, not joined: whoever uses
    // the HTML (the mount's `<main>` wrapper and innerHTML, a file write)
    // flattens it once anyway, so a join would copy everything twice.
    let html = '';
    for (let i = 0; i < out.length; i++) html += out[i];
    return html + buf;
  } finally {
    out = work = fnDefs = names = inlineNames = classes = fnPara = taskPara = null; // keep nothing of this note alive
    buf = '';
  }
}

// Writes a cursor's nodes until one pushes work; the cursor, when it has
// more, waits under that work.
function next(c) {
  const list = c.list;
  let s = ''; // atoms, gathered and written every 16 KB
  while (c.i < list.length) {
    const n = list[c.i++];
    if (!n || typeof n !== 'object') continue;
    const h = atom(n);
    if (h !== null) {
      if ((s += h).length > 16384) write(s), (s = '');
      continue;
    }
    if (s) write(s), (s = '');
    const more = c.i < list.length;
    if (more) work.push(c);
    const top = work.length;
    node(n);
    if (work.length !== top) return;
    if (more) work.pop();
  }
  if (s) write(s);
}

function node(n) {
  const a = n.attributes;
  switch (n.type) {
    case 'root':
      return kids(n.children);
    case 'paragraph':
      return paragraph(n, a);
    case 'heading': {
      const d = n.depth >= 1 && n.depth <= 6 ? n.depth : 6;
      return wrapped(`<h${d}${attrs(a)}>`, n.children, `</h${d}>\n`);
    }
    case 'thematicBreak':
      return void write(`<hr${attrs(a)}>\n`);
    case 'blockquote':
      write(`<blockquote${attrs(a)}>\n`);
      work.push('</blockquote>\n');
      return kids(n.children);
    case 'list': {
      const tag = n.ordered ? 'ol' : 'ul';
      const start = n.ordered && n.start != null && n.start !== 1 ? ` start="${n.start}"` : '';
      write(`<${tag}${attrs(a, '', '', start)}>\n`);
      work.push(`</${tag}>\n`);
      return kids(n.children);
    }
    case 'listItem':
      return listItem(n, a);
    case '#row':
      return row(n);
    case '#toc':
      return tocNext(n);
    case 'code':
      return code(n, a);
    case 'math':
      return math(n, a);
    case 'table':
      write(`<table${attrs(a)}>\n`);
      return table(n, null, null);
    case 'containerDirective':
      return container(n, a);
    case 'leafDirective':
      return leaf(n, a);
    case 'textDirective':
      return inlineElement(n, a);
    case 'cell':
      write(`<div${attrs(a, 't-cell', '', pos(n))}>\n`);
      work.push('</div>\n');
      return kids(n.children);
    case 'attributes': // an attribute line that binds to nothing, shown as text
      return void write(`<p>${esc(n.value || '')}</p>\n`);
    case 'footnoteDefinition':
      return footnoteDefinition(n);
    case 'emphasis':
      return wrap(n, 'em', a);
    case 'strong':
      return wrap(n, 'strong', a);
    case 'delete':
      return wrap(n, 'del', a);
    case 'mark':
      return wrap(n, 'mark', a);
    case 'span': // a bare `[…]{…}` span: no data-t
      return wrap(n, 'span', a, attrs(a, '', '', pos(n)));
    case 'link':
      return link(n, a);
    case 'ref':
      return ref(n, a);
    default: {
      const h = atom(n);
      if (h !== null) return void write(h);
      // An unknown node (an add-on's): its children, or its value as text.
      if (n.children) return kids(n.children);
      if (typeof n.value === 'string') write(esc(n.value));
    }
  }
}

function wrap(n, tag, a, at) {
  wrapped(`<${tag}${at === undefined ? attrs(a) : at}>`, n.children, `</${tag}>`);
}

// ---------------------------------------------------------------- blocks

function paragraph(n, a) {
  const open = `<p${attrs(a, tern(n).junk ? 't-error' : '')}>`; // junk after a container's opener, shown as text
  wrapped(n === taskPara ? open + taskBox : open, n.children, n === fnPara ? `${fnBack}</p>\n` : '</p>\n');
}

// Tight items hold their paragraphs' inline content directly; a task
// item starts with a disabled checkbox, inside the first paragraph when loose.
function listItem(n, a) {
  const task = n.checked === true || n.checked === false;
  const box = task ? `<input type="checkbox"${n.checked ? ' checked' : ''} disabled>` : '';
  const list = n.children || [];
  const first = list[0];
  const bare = !n.spread && first && first.type === 'paragraph' && !first.attributes;
  let open = `<li${attrs(a, task ? 't-task' : '')}>`;
  if (task && bare) open += box + ' ';
  else if (task && first && first.type === 'paragraph') (taskPara = first), (taskBox = box + ' ');
  else if (task) open += box;
  if (bare && list.length === 1) return wrapped(open, first.children, '</li>\n'); // the common item
  write(open);
  work.push('</li>\n');
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (!n.spread && c.type === 'paragraph' && !c.attributes) kids(c.children);
    else work.push(c);
  }
}

// An untitled fence is `pre[data-t=code]` with the author's attributes;
// a titled one is a listing, `figure.t-block.code` with them, its `pre`
// keeping the line-number data.
function code(n, a) {
  const t = tern(n);
  const lang = n.lang ? `<code class="language-${escValue(n.lang)}">` : '<code>';
  const hl = t.hl == null ? null : Array.isArray(t.hl) ? t.hl : [];
  const start = typeof t.start === 'number' && isFinite(t.start) ? t.start : null;
  const wrapLines = !!t.lines || hl !== null || start !== null;
  let data = t.lines ? ' data-lines' : '';
  if (start !== null) data += ` data-start="${start}"`;
  if (t.hl != null) data += ` data-hl="${escValue(String(t.hlText != null ? t.hlText : Array.isArray(t.hl) ? t.hl.join(',') : t.hl))}"`;
  const meta = n.meta != null ? ` data-meta="${escValue(n.meta)}"` : ''; // the rest of the info string, verbatim
  let body = n.value || '';
  if (wrapLines) {
    const marked = new Set(hl || []);
    const lines = body.split('\n');
    const first = start === null ? 1 : start;
    for (let i = 0; i < lines.length; i++) lines[i] = `<span class="t-line${marked.has(first + i) ? ' t-hl' : ''}">${esc(lines[i])}</span>`;
    body = lines.join('\n');
  } else body = esc(body);
  const pre = `${lang}${body}</code></pre>`;
  const titled = Array.isArray(t.title) && (t.title.length > 0 || !!t.text);
  if (!titled) return void write(`<pre${attrs(a, '', '', ` data-t="code"${data}${meta}${pos(n)}`, null, true)}>${pre}\n`);
  write(`<figure${attrs(a, 't-block code', '', ` data-t="code"${meta}${pos(n)}`, null, true)}><pre${data}>${pre}`);
  work.push('</figure>\n');
  title(t.slot || 'figcaption', t.text, t.title);
}

// Raw HTML byte for byte; an unclosed comment or raw-text block as escaped
// source in `pre.t-error`.
function html(n) {
  const t = tern(n);
  const v = n.value || '';
  const inline = t.kind === 'inline';
  if (t.unclosed) return `<pre class="t-error"${pos(n)}>${esc(v)}</pre>\n`;
  if (safe) return inline ? esc(v) : `<pre>${esc(v)}</pre>\n`;
  return inline ? v : `${v}\n`;
}

// Display math: `div.t-eq` holding `span.t-math[data-display]` and the
// number; an unclosed one as escaped source in `div.t-eq.t-error`.
function math(n, a) {
  const t = tern(n);
  if (t.unclosed) return void write(`<div${attrs(a, 't-eq t-error', '', pos(n))}>${esc(t.source != null ? t.source : n.value || '')}</div>\n`);
  const no = t.text ? `<span class="t-eqno">${esc(String(t.text))}</span>` : '';
  write(`<div${attrs(a, 't-eq')}><span class="t-math" data-display${pos(n)}>${esc(n.value || '')}</span>${no}</div>\n`);
}

// A pipe table: `thead` from the first row unless headerless, `tbody` unless
// header-only; missing cells emitted empty; alignment on every cell of its
// column. Writes after the caller's opening `<table…>`.
function table(n, caption, label) {
  const rows = n.children || [];
  const align = n.align || [];
  const head = tern(n).headerless ? 0 : Math.min(1, rows.length);
  work.push('</table>\n');
  if (rows.length > head) {
    const td = align.map((al) => cellOpen('td', al)); // each column's opening tag
    work.push('</tbody>\n');
    for (let r = rows.length - 1; r >= head; r--) work.push(new Row(rows[r], td, 'td'));
    work.push('<tbody>\n');
  }
  if (head) {
    work.push('</thead>\n');
    work.push(new Row(rows[0], align.map((al) => cellOpen('th', al)), 'th'));
    work.push('<thead>\n');
  }
  if (caption) title('caption', label, caption.children);
}

// A row still to write, from cell i: a work item, so that a cell holding
// more than atoms suspends the row and resumes it. `opens` holds each
// column's opening tag.
function Row(row, opens, tag) {
  this.type = '#row';
  this.row = row;
  this.opens = opens;
  this.tag = tag;
  this.i = 0;
}
const cellOpen = (tag, al) => (al ? `<${tag} ${cssom ? 'data-t-align="' : 'style="text-align:'}${escValue(String(al))}">` : `<${tag}>`);

function row(it) {
  const list = (it.row && it.row.children) || [];
  const opens = it.opens;
  const plain = it.tag === 'th' ? '<th>' : '<td>'; // an extra cell's
  const close = it.tag === 'th' ? '</th>' : '</td>';
  let s = it.i === 0 ? '<tr>' : ''; // gathered here, written every 16 KB
  while (it.i < list.length) {
    const k = it.i++;
    const cell = list[k];
    s += k < opens.length ? opens[k] : plain;
    const inl = (cell && cell.children) || [];
    for (let j = 0; j < inl.length; j++) {
      const c = inl[j];
      const h = c && typeof c === 'object' ? atom(c) : '';
      if (h === null) {
        write(s);
        work.push(it, close, new Cursor(inl, j));
        return;
      }
      s += h;
    }
    if ((s += close).length > 16384) write(s), (s = '');
  }
  for (let i = list.length; i < opens.length; i++) s += opens[i] + close;
  write(s + '</tr>\n');
}

// A title slot: the label first, then a space and the title. Pushed, so
// it is written next.
function title(slot, label, inlines) {
  const has = inlines && inlines.length > 0;
  if (!label && !has) return;
  const open = `<${slot} class="t-title">${label ? `<span class="t-label">${esc(String(label))}</span>${has ? ' ' : ''}` : ''}`;
  const f = flat(inlines);
  if (f !== null) return void work.push(open + f + `</${slot}>`);
  work.push(`</${slot}>`);
  kids(inlines);
  work.push(open);
}

// ---------------------------------------------------------------- named elements

// Tern's class tokens and data-t for a named element: its name as a class
// unless reserved, `t-cols` after the author's classes, and the grid as the
// first declaration of `style`, or data-t-cols under `cssom`.
function named(n, a, block) {
  const t = tern(n);
  const name = String(n.name);
  const cache = block ? names : inlineNames;
  let parts = cache.get(name); // [class tokens, data-t], the same for every element of a name
  if (!parts) cache.set(name, (parts = [block + (isReservedName(name) ? '' : (block ? ' ' : '') + name), ` data-t="${escValue(name)}"`]));
  const pre = parts[0];
  let extra = parts[1];
  let skip = null;
  if (t.cols != null && t.cols !== '') {
    const own = a && typeof a.style === 'string' && a.style.startsWith('--t-cols:');
    const cols = String(t.cols);
    if (!own && (!safe || /^[-\w\s.,%()/+*]*$/.test(cols)) && !(safe && /url|expression|\\/i.test(cols))) {
      if (cssom) extra += ` data-t-cols="${escAttr(cols)}"`;
      else {
        extra += ` style="${escAttr(`--t-cols:${cols}${a && a.style != null && a.style !== '' && !safe ? `;${a.style}` : ''}`)}"`;
        skip = 'style';
      }
    }
  }
  return attrs(a, pre, t.cols != null && t.cols !== '' ? 't-cols' : '', extra + pos(n), skip);
}

// A container, its title slot, body and end mark.
function container(n, a) {
  const t = tern(n);
  const name = n.name;
  if (name === 'meta') return; // nothing: the runtime writes it into the head
  // The author's id, classes and keys are carried, as on any element; the
  // runtime finds macros by `.t-macros`, and `hidden` is tern's.
  if (name === 'macros') return void write(`<div${attrs(a, 't-macros', '', ` hidden${pos(n)}`, 'hidden')}>${esc(n.value || '')}</div>\n`);
  if (VERBATIM_ERROR.has(name)) return void write(`<pre${attrs(a, 't-error', '', pos(n))}>${esc(n.value || '')}</pre>\n`);
  const tag = t.tag || 'div';
  const list = n.children || [];
  const label = list[0] && list[0].data && list[0].data.directiveLabel ? list[0] : null;
  const b = label ? 1 : 0; // the body is list[b…]
  const one = list.length === b + 1 ? list[b] : null; // a body of one block
  const open = `<${tag}${named(n, a, 't-block')}>`;
  // A merged table: the container is the <table>, its title the caption.
  if (tag === 'table' && one && one.type === 'table') {
    write(`${open}\n`);
    return table(one, label || { children: [] }, t.text);
  }
  write(open);
  work.push(`</${tag}>\n`);
  const slot = t.slot !== undefined ? t.slot : label && label.children && label.children.length ? SLOT[tag] || 'div' : t.text ? SLOT[tag] || 'div' : null;
  const last = slot === 'figcaption';
  if (slot && last) title(slot, t.text, label && label.children);
  if (t.end != null && t.end !== '') work.push(`<span class="t-end" aria-hidden="true">${esc(String(t.end))}</span>`);
  if (typeof n.value === 'string') work.push(esc(n.value)); // a `{raw}` body: one escaped text
  else if (tag === 'figure' && one && imageOnly(one)) kids(one.children); // a figure's lone image: no `<p>`
  else if (list.length > b) work.push(new Cursor(list, b));
  if (slot && !last) title(slot, t.text, label && label.children);
}

const imageOnly = (p) => p.type === 'paragraph' && !p.attributes && p.children && p.children.length === 1 && p.children[0].type === 'image';

// The label of a leaf or inline element counted or labelled by its schema
// (data.tern.text), as its first child: `span.t-label`, then a space when
// content follows, as in a container's title. A void
// element has nowhere to put it.
function label(t, more) {
  return t.text ? `<span class="t-label">${esc(String(t.text))}</span>${more ? ' ' : ''}` : '';
}

// A leaf; a void element gets no content, which follows it in a
// paragraph; a toc leaf holds its list.
function leaf(n, a) {
  const t = tern(n);
  const tag = t.tag || 'div';
  if (Array.isArray(t.toc)) return toc(n, a, tag, t.toc, t);
  const open = `<${tag}${named(n, a, '')}>`;
  if (VOID.has(tag)) {
    write(`${open}\n`);
    if (n.children && n.children.length) {
      work.push('</p>\n');
      kids(n.children);
      work.push('<p>');
    }
    return;
  }
  wrapped(open + label(t, n.children && n.children.length > 0), n.children, `</${tag}>\n`);
}

// A toc: its element holding `ol > li > a`, a nested `ol` for each deeper
// level, after the label when the schema gives one; an empty toc emits nothing.
function toc(n, a, tag, entries, t) {
  if (entries.length) tocNext(new Toc(`<${tag}${named(n, a, '')}>${label(t, true)}`, `</${tag}>\n`, entries));
}

// A toc still to write, from entry i: a work item, so that an entry whose
// title is more than atoms suspends it, as a row does.
function Toc(open, close, entries) {
  this.type = '#toc';
  this.open = open;
  this.close = close;
  this.entries = entries;
  this.levels = []; // the depth of each open <ol>
  this.i = 0;
}

function tocNext(t) {
  const { entries, levels } = t;
  let s = t.i === 0 ? t.open : ''; // gathered here, written every 16 KB
  while (t.i < entries.length) {
    const e = entries[t.i++];
    const d = e.depth;
    if (!levels.length || d > levels[levels.length - 1]) (s += '<ol><li><a href="#'), levels.push(d);
    else {
      while (levels.length > 1 && d < levels[levels.length - 1]) (s += '</li></ol>'), levels.pop();
      if (d > levels[levels.length - 1]) (s += '<ol><li><a href="#'), levels.push(d);
      else s += '</li><li><a href="#';
    }
    s += escAttr(String(e.id));
    s += '">';
    const list = e.children || [];
    for (let j = 0; j < list.length; j++) {
      const c = list[j];
      const h = c && typeof c === 'object' ? atom(c) : '';
      if (h === null) {
        write(s);
        work.push(t, '</a>', TOC_OUT, new Cursor(list, j), TOC_IN);
        return;
      }
      s += h;
    }
    if ((s += '</a>').length > 16384) write(s), (s = '');
  }
  while (levels.length) (s += '</li></ol>'), levels.pop();
  write(s + t.close);
}

// An inline element, its label first; a void one is followed by its content.
function inlineElement(n, a) {
  const t = tern(n);
  const tag = t.tag || 'span';
  if (VOID.has(tag)) return void (write(`<${tag}${named(n, a, '')}>`), kids(n.children));
  wrapped(`<${tag}${named(n, a, '')}>${label(t, n.children && n.children.length > 0)}`, n.children, `</${tag}>`);
}

// ---------------------------------------------------------------- inline

function link(n, a) {
  if (inToc) return kids(n.children);
  const url = n.url == null ? '' : String(n.url);
  const href = safe && !safeUrl(url, false) ? '' : ` href="${escValue(url)}"`;
  const title = n.title != null && !(a && 'title' in a) ? ` title="${escValue(String(n.title))}"` : '';
  wrapped(`<a${href}${title}${attrs(a, '', '', '', 'href')}>`, n.children, '</a>');
}

function image(n, a) {
  const url = n.url == null ? '' : String(n.url);
  const src = safe && !safeUrl(url, false) ? '' : ` src="${escValue(url)}"`;
  const alt = a && 'alt' in a ? '' : ` alt="${escValue(n.alt == null ? '' : String(n.alt))}"`; // an alt= attribute wins
  const title = n.title != null && !(a && 'title' in a) ? ` title="${escValue(String(n.title))}"` : '';
  return `<img${attrs(a, '', '', `${src}${alt}${title}`, 'src')}>`;
}

// A resolved reference is `a.t-ref` holding its text; an unresolved
// one is its literal text.
function ref(n, a) {
  if (!tern(n).resolved || inToc) {
    const h = atom(n); // its literal text
    return h !== null ? void write(h) : kids(n.children);
  }
  wrapped(`<a${attrs(a, 't-ref', '', ` href="#${escAttr(String(n.id))}"`, 'href')}>`, n.children, '</a>');
}

// A footnote reference: `sup.t-fnref > a`, or the literal text when it did
// not resolve.
function footnoteReference(n, a) {
  const t = tern(n);
  if (inToc) return '';
  if (t.resolved === false || t.target == null || t.number == null) return esc(`[^${n.label}]`);
  const open = a ? `<sup${attrs(a, 't-fnref')}><a` : '<sup class="t-fnref"><a';
  const id = t.id != null ? ` id="${escAttr(String(t.id))}"` : '';
  const num = typeof t.number === 'number' ? t.number : esc(String(t.number));
  return `${open}${id} href="#${escAttr(String(t.target))}">${num}</a></sup>`;
}

// ---------------------------------------------------------------- footnotes

// In the body a definition emits nothing; it is collected, unless dropped.
// In the section it is an `li` whose last paragraph ends with the back link,
// or which gets a paragraph for it.
function footnoteDefinition(n) {
  const t = tern(n);
  if (!section) {
    if (!t.dropped && !fnDefs.has(n.identifier)) fnDefs.set(n.identifier, n);
    return;
  }
  const list = n.children || [];
  const back = t.backref != null ? `<a class="t-fnback" href="#${escAttr(String(t.backref))}">↩</a>` : '';
  write(`<li${t.id != null ? ` id="${escAttr(String(t.id))}"` : ''}>`);
  work.push('</li>\n');
  const last = list[list.length - 1];
  if (back && last && last.type === 'paragraph') (fnPara = last), (fnBack = ` ${back}`);
  else if (back) work.push(`<p>${back}</p>`);
  kids(list);
}

// The section after all content, in the transforms' order.
function footnotes(ast) {
  const order = ast && ast.data && ast.data.tern && ast.data.tern.footnotes;
  section = true;
  if (!Array.isArray(order)) return;
  const defs = order.map((id) => fnDefs.get(id)).filter(Boolean);
  if (!defs.length) return;
  write('<section class="t-footnotes"><ol>\n');
  work.push('</ol></section>\n');
  kids(defs);
}

module.exports = { emit };
  };
  // ---- src/css.js
  defs['css'] = function (module, exports, require) {
// The base stylesheet, injected by the runtime as <style id="tern-style"> and
// published as tern.css. It styles the emitter's output: blocks have no look
// of their own; add-ons and the note's own CSS style them by class and data-t.
// It uses logical properties throughout and isolates math and code as LTR, so
// RTL notes work.

const css = `:root {
  color-scheme: light dark;
  --t-bg: #fdfdfb; --t-fg: #1f2328; --t-muted: #636c76; --t-line: #d9dde3; --t-soft: #f3f4f1;
  --t-link: #0b62c4; --t-mark: #fff2a8; --t-error: #b3261e; --t-error-bg: #fdecea; --t-warn: #8a5300;
  --t-font: Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif;
  --t-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --t-mono: ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --t-width: 40rem; --t-size: 18px; --t-leading: 1.6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --t-bg: #16181c; --t-fg: #dcdfe4; --t-muted: #8b949e; --t-line: #30363d; --t-soft: #1f2329;
    --t-link: #6cb0ff; --t-mark: #5c4d00; --t-error: #ffb4ab; --t-error-bg: #3b1714; --t-warn: #e3b341;
  }
}
html { background: var(--t-bg); color: var(--t-fg); font: var(--t-size)/var(--t-leading) var(--t-font); -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 2.5rem 1rem 6rem; }
.tern { max-width: var(--t-width); margin-inline: auto; overflow-wrap: break-word; }
.tern > :first-child { margin-block-start: 0; }
.tern :is(h1, h2, h3, h4, h5, h6) { font-family: var(--t-sans); line-height: 1.25; margin-block: 2em .6em; text-wrap: balance; }
.tern h1 { font-size: 1.9rem; }
.tern h2 { font-size: 1.4rem; padding-block-end: .25em; border-block-end: 1px solid var(--t-line); }
.tern h3 { font-size: 1.15rem; }
.tern :is(h4, h5, h6) { font-size: 1rem; }
.tern :is(p, ul, ol, dl, pre, table, blockquote, figure, details), .t-block, .t-eq { margin-block: 0 1rem; margin-inline: 0; }
.tern a { color: var(--t-link); text-decoration-thickness: .06em; text-underline-offset: .15em; }
.tern :is(ul, ol) { padding-inline-start: 1.6rem; }
.tern li > :is(ul, ol) { margin-block-end: 0; }
.tern li > p { margin-block-end: .5rem; }
.tern hr { border: 0; border-block-start: 1px solid var(--t-line); margin-block: 2rem; }
.tern blockquote { padding-inline-start: 1rem; border-inline-start: 3px solid var(--t-line); color: var(--t-muted); }
.tern mark { background: var(--t-mark); color: inherit; padding-inline: .15em; border-radius: 2px; }

/* Media keep their aspect ratio when max-width shrinks them. */
.tern :is(img, video, canvas, picture) { max-inline-size: 100%; height: auto; }
.tern :is(iframe, embed, object) { max-inline-size: 100%; }

/* Code. Math and code read left to right in a right-to-left note. */
.tern :is(code, kbd, samp, pre) { font-family: var(--t-mono); font-size: .85em; }
.tern pre code { font-size: 1em; }
.tern :not(pre) > code { background: var(--t-soft); padding: .12em .35em; border-radius: 4px; }
.tern kbd { border: 1px solid var(--t-line); border-block-end-width: 2px; border-radius: 4px; padding: .05em .4em; }
.t-math, .tern :is(pre, code, kbd, samp) { direction: ltr; unicode-bidi: isolate; }
.tern pre { text-align: start; background: var(--t-soft); padding: .8rem 1rem; border-radius: 6px; overflow-x: auto; line-height: 1.45; }
.tern pre[data-lines] code { counter-reset: t-line; }
.tern pre[data-lines][data-start] code { counter-reset: t-line calc(attr(data-start type(<integer>), 1) - 1); }
.tern pre[data-lines] .t-line::before {
  counter-increment: t-line; content: counter(t-line); display: inline-block; min-inline-size: 2.5ch;
  margin-inline-end: 1.5ch; text-align: end; color: var(--t-muted); user-select: none;
}
.tern .t-hl { display: inline-block; min-inline-size: 100%; background: var(--t-mark); }

/* Tables scroll when wider than the column. */
.tern table { border-collapse: collapse; display: block; inline-size: max-content; max-inline-size: 100%; overflow-x: auto; font-size: .95em; }
.tern :is(th, td) { border: 1px solid var(--t-line); padding: .35em .7em; }
.tern th { background: var(--t-soft); font-family: var(--t-sans); font-size: .9em; }
.tern caption { caption-side: top; text-align: start; padding-block-end: .4em; }

/* Named blocks, titles, labels and end marks. */
.t-title { font-weight: 600; margin-block-end: .4rem; }
.tern :is(figcaption, caption).t-title { font-weight: normal; color: var(--t-muted); font-size: .95em; }
.tern figcaption.t-title { margin-block: .4rem 0; }
.t-label { font-weight: 700; }
.t-end { display: block; text-align: end; }
.t-block > :last-child, .t-cell > :last-child, .tern blockquote > :last-child { margin-block-end: 0; }
.tern figure > img { display: block; margin-inline: auto; }

/* Grids: --t-cols from cols= or the cell count; one column on narrow screens. */
.t-cols { display: grid; grid-template-columns: var(--t-cols, repeat(auto-fit, minmax(12rem, 1fr))); gap: 1rem 1.5rem; }
.t-cols > * { margin: 0; min-inline-size: 0; }
.t-cols > .t-title { grid-column: 1 / -1; }
.t-cell { min-inline-size: 0; }
@media (max-width: 36rem) { .t-cols { grid-template-columns: minmax(0, 1fr); } }

/* Math: display equations scroll rather than overflow; the number sits at the end. */
.t-eq { display: flex; align-items: center; gap: 1rem; overflow-x: auto; overflow-y: hidden; }
.t-eq > .t-math { flex: 1; text-align: center; min-inline-size: 0; }
.t-eqno { color: var(--t-muted); font-family: var(--t-font); white-space: nowrap; }
.t-math[data-display] { display: block; }
.t-macros[hidden] { display: none !important; }

/* Footnotes and task lists. */
.t-fnref { line-height: 0; font-size: .75em; }
.t-fnref a, .t-fnback { text-decoration: none; }
.t-footnotes { border-block-start: 1px solid var(--t-line); margin-block-start: 3rem; padding-block-start: 1rem; font-size: .9em; }
.tern li.t-task { list-style: none; }
.tern li.t-task > input, .tern li.t-task > p:first-child > input { margin-inline: -1.4rem .3rem; vertical-align: middle; }

/* Problems stay visible where they are. */
.tern .t-error { color: var(--t-error); background: var(--t-error-bg); border-inline-start: 3px solid var(--t-error); padding: .3em .6em; white-space: pre-wrap; font-family: var(--t-mono); font-size: .85em; }
.tern .t-eq.t-error { display: block; }

/* The diagnostics panel: fixed at the end corner, outside main, never printed. */
.t-diagnostics {
  position: fixed; inset-block-end: .75rem; inset-inline-end: .75rem; z-index: 2147483647;
  max-inline-size: min(40rem, calc(100vw - 1.5rem)); max-block-size: 60vh; overflow: auto;
  background: var(--t-bg); color: var(--t-fg); border: 1px solid var(--t-line); border-inline-start: 4px solid var(--t-error);
  border-radius: 6px; box-shadow: 0 4px 18px rgb(0 0 0 / .18); font: 13px/1.45 var(--t-sans);
}
.t-diagnostics summary { cursor: pointer; padding: .45rem .75rem; font-weight: 600; }
.t-diagnostics ol { margin: 0; padding-block: 0 .6rem; padding-inline: 2.2rem .75rem; }
.t-diagnostics li { margin-block: .35rem; }
.t-diag-sev { font-weight: 700; text-transform: uppercase; font-size: .78em; letter-spacing: .03em; }
.t-diag-error .t-diag-sev { color: var(--t-error); }
.t-diag-warning .t-diag-sev { color: var(--t-warn); }
.t-diag-info .t-diag-sev, .t-diag-at, .t-diag-hint { color: var(--t-muted); }
.t-diag-code { font-family: var(--t-mono); font-size: .95em; }
.t-diag-hint { display: block; }

@media print {
  .t-diagnostics { display: none; }
  .tern > * { content-visibility: visible !important; } /* the runtime's held blocks (src/runtime.js) */
  :root { color-scheme: light; --t-size: 11pt; --t-bg: #fff; --t-fg: #000; --t-soft: #f3f4f1; --t-line: #d9dde3; --t-mark: #fff2a8; --t-muted: #555; }
  body { padding: 0; }
  .tern { max-width: none; }
  .tern pre { white-space: pre-wrap; }
  .tern pre, .tern table, .t-eq { overflow: visible; }
  .tern table { display: table; inline-size: auto; }
  /* KaTeX positions .katex (0.19) and its bases (.base, 0.19 .katex-base) relatively, so Chromium
     paints formulas after the text around them and the PDF text layer moves them out of their sentences. */
  .katex, .katex :is(.base, .katex-base) { position: static; }
}
`;

module.exports = { css };
  };
  // ---- src/runtime.js
  defs['runtime'] = function (module, exports, require) {
// The browser runtime. Run from a plain <script src> in a loading document,
// tern.js captures the rest of the file as the note and renders it in place,
// in this order (docs/api.html#lifecycle):
//
//   config → capture (one document.write) → add-ons, base CSS and KaTeX
//   requested → wait for DOMContentLoaded and every add-on →
//   window.TERN.schema → parse → transform → emit → mount → note scripts in
//   order → data-tex, line numbers, behaviours → 'render' → math in time
//   slices → 'math' → fragment scroll → console group → 'ready'
//
// Behaviours run before math, so they see the TeX, never typeset math; one
// that needs the typeset math listens for 'math'.
//
// A page written by `tern build` (its tern.js tag has data-built) starts at
// the behaviours instead: its main.tern is in the HTML, and its scripts and
// add-ons are real scripts the browser runs.
//
// The API sits on the engine's object:
//   tern.define(name, fn) -> undo   fn(el) once per [data-t=name] element
//   tern.undefine(name)
//   tern.on('render'|'math'|'ready'|'diagnostic', fn) -> undo
//   tern.render(root = main.tern, source?) -> Promise of source's diagnostics
//   tern.ready        a Promise, settled after 'ready'
//   tern.diagnostics  parse, transform and runtime diagnostics (a live array)
//   tern.config       window.TERN merged with the tag's data-* (data-* wins)
//   tern.style(css)   a stylesheet, at its add-on's place in the cascade
// Under node nothing touches a DOM: the API is present and inert.

const { css: BASE_CSS } = require('./css');
const { sortDiagnostics } = require('./diag');

// KaTeX, pinned with SRI; a custom data-katex base gets none.
const KATEX = {
  base: 'https://cdn.jsdelivr.net/npm/katex@0.19.0/dist',
  js: 'sha384-QFFtAGzvvj+bfgCGxXJlNZZR1nXEZgvG8tDLCCY1F19xl20WlfTYgguB4VcNdxYk',
  css: 'sha384-3rdsX6e5mueWyoweR9NIVmtEsUkokpBT/0ALqKKIBMr9j4qhHkaIkAcGgsE6uVlp',
};
// The runtime's own diagnostic codes, all errors: each loses or changes what
// the reader sees.
const SEVERITY = {
  'math.error': 'error',
  'addon.failed': 'error',
  'script.document-write': 'error',
  'script.domcontentloaded': 'error',
  'katex.unavailable': 'error',
  'doc.quirks': 'error',
};
// A problem with the tern.js line or the head, not with a note line: line 0,
// the line before the note's first; the panel shows its file line.
const HEAD = { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } };
// Math is typeset in time slices, one per frame, so that no task of math
// runs over 50 ms whatever the formulas cost. The first slice shares the
// mount's task when KaTeX is ready, within that task's budget, so the first
// paint is typeset.
const SLICE_MS = 10;
const TASK_MS = 40;
// Note scripts that run: JavaScript MIME types, modules, import maps,
// speculation rules. Other types are data blocks and stay inert.
const RUNS = /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:jscript|livescript|javascript1\.[0-5])|module|importmap|speculationrules)?$/i;
const EVENTS = ['render', 'math', 'ready', 'diagnostic'];
const BROWSER = typeof window === 'object' && !!window && typeof document === 'object' && !!document && window.document === document;

let T = null; // the API object
const diagnostics = [];
const config = { use: Object.create(null), katex: {} };
const listeners = { render: [], math: [], ready: [], diagnostic: [] };
const defined = new Map(); // name -> [{fn, done}]
let settle = null;
const ready = new Promise((resolve) => (settle = resolve));

let page = null; // what capture found: {head, lines, source, quirks}
let main = null;
let built = false; // a page written by `tern build`
let addonList = []; // the data-use entries
let mounted = false;
let logged = false;
const roots = new Set();
let behavioursRan = false;

const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const now = () => performance.now();
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = (s) => String(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const append = (to, list) => {
  for (const x of list) to.push(x);
};

// ---------------------------------------------------------------- the API

function attach(api) {
  T = api;
  api.diagnostics = diagnostics;
  api.config = config;
  api.ready = ready;
  api.define = define;
  api.undefine = undefine;
  api.on = on;
  api.render = render;
  api.style = style;
  // A schema entry's `css` is queued like tern.style.
  for (const level of ['block', 'leaf', 'inline']) {
    const add = api[level];
    api[level] = (name, spec) => {
      const entry = add(name, spec);
      if (entry && typeof entry.css === 'string' && entry.css) style(entry.css);
      return entry;
    };
  }
  if (!BROWSER) return api;
  // A second tern.js (from a note script, say) leaves the first in charge.
  const first = window.tern;
  if (first && first.version) {
    console.warn('tern: tern.js is already loaded; this second copy does nothing');
    return api;
  }
  document.addEventListener('toggle', onToggle, true);
  document.addEventListener('copy', onCopy);
  window.addEventListener('beforeprint', onBeforePrint);
  window.addEventListener('afterprint', onAfterPrint);
  start();
  return api;
}

function on(event, fn) {
  if (!EVENTS.includes(event)) throw new TypeError(`tern.on: "${event}" is not one of ${EVENTS.join(', ')}`);
  if (typeof fn !== 'function') throw new TypeError(`tern.on("${event}", fn): fn must be a function`);
  listeners[event].push(fn);
  return () => {
    const i = listeners[event].indexOf(fn);
    if (i >= 0) listeners[event].splice(i, 1);
  };
}

function fire(event, arg) {
  for (const fn of listeners[event].slice()) {
    try {
      fn(arg);
    } catch (e) {
      console.error(`tern: a "${event}" listener failed`, e);
    }
  }
}

// tern.define(name, fn): additive, in registration order. Defined after the
// behaviours ran, it runs at once on the elements already there.
function define(name, fn) {
  if (typeof name !== 'string' || !name) throw new TypeError('tern.define(name, fn): name must be a non-empty string');
  if (typeof fn !== 'function') throw new TypeError(`tern.define("${name}", fn): fn must be a function`);
  const rec = { fn, done: new WeakSet() };
  if (!defined.has(name)) defined.set(name, []);
  defined.get(name).push(rec);
  if (behavioursRan) {
    for (const root of roots) {
      if (root.isConnected) for (const el of root.querySelectorAll(`[data-t="${CSS.escape(name)}"]`)) apply(rec, el, name);
    }
  }
  return () => {
    const list = defined.get(name);
    const i = list ? list.indexOf(rec) : -1;
    if (i >= 0) list.splice(i, 1);
  };
}

function undefine(name) {
  defined.delete(name);
}

// tern.render(root, source): with a source, root's content is replaced by
// the note's HTML and its scripts run. Then behaviours run on elements that
// have not had them and formulas not yet typeset are typeset, so a second
// call with no source changes nothing. Resolves to the source's
// diagnostics, which replace tern.diagnostics when root is the page's main.
function render(root, source) {
  if (!BROWSER) return Promise.resolve([]);
  return renderRoot(root, source);
}

async function renderRoot(root, source) {
  root = root || main || document.querySelector('main.tern');
  if (!root || root.nodeType !== 1) throw new TypeError('tern.render(root, source): root must be an element');
  let list = [];
  if (source !== undefined) {
    const r = compile(String(source));
    list = r.list;
    const tpl = document.createElement('template');
    tpl.innerHTML = r.html;
    root.replaceChildren(tpl.content);
    presentation(root);
    if (root === main) {
      const kept = diagnostics.filter((d) => d.position === HEAD);
      diagnostics.length = 0;
      append(diagnostics, kept);
      append(diagnostics, list);
      rebuildPanel();
    }
    await runScripts(root, r.ast);
  }
  await process(root);
  return list;
}

// tern.style(css): a stylesheet in the head. One added while an add-on runs
// sits at that add-on's place in data-use, so the cascade follows the
// listing; any other comes after all add-ons.
function style(text) {
  const css = text == null ? '' : String(text);
  if (!BROWSER || !document.head) return;
  const el = document.createElement('style');
  el.textContent = css;
  return insert(nonce(el), currentSlot());
}

// ---------------------------------------------------------------- diagnostics

function report(code, position, message, hint) {
  const d = { code, severity: SEVERITY[code], message, position: position || HEAD };
  if (hint) d.hint = hint;
  diagnostics.push(d);
  fire('diagnostic', d);
  if (mounted) panelAdd(d);
  if (logged) console.warn(`tern: ${describe(d)}`);
  return d;
}

// "line 12:3 (file line 13)": positions are note lines; the file line is
// what the author edits, the note starting after the tern.js line.
function where(d) {
  const p = d.position && d.position.start;
  const before = page ? page.lines : 0;
  if (!p || !p.line) return before ? `the tern.js line (file line ${before})` : 'the tern.js line';
  return `line ${p.line}:${p.column}${before ? ` (file line ${p.line + before})` : ''}`;
}
const describe = (d) => `${d.severity} ${d.code} at ${where(d)}: ${d.message}${d.hint ? ` (${d.hint})` : ''}`;

// A note position from data-pos="line:col" on the element or an ancestor
// (the emitter puts it on math, directive, cell and code elements).
function positionOf(el) {
  const at = el && el.closest('[data-pos]');
  const m = at && /^(\d+):(\d+)$/.exec(at.getAttribute('data-pos'));
  if (!m) return null;
  const line = Number(m[1]);
  const column = Number(m[2]);
  let offset = 0;
  if (page && page.source != null) {
    if (!page.starts) {
      page.starts = [0];
      for (let i = page.source.indexOf('\n'); i >= 0; i = page.source.indexOf('\n', i + 1)) page.starts.push(i + 1);
    }
    offset = (page.starts[line - 1] || 0) + column - 1;
  }
  const p = { line, column, offset };
  return { start: p, end: p };
}

// The console group, always printed once; later problems get a line each.
function logGroup(times) {
  logged = true;
  console.groupCollapsed(`tern: ${plural(diagnostics.length, 'problem')}`);
  if (times) console.log(`tern ${T.version}: ${times}`);
  for (const d of diagnostics) (d.severity === 'info' ? console.info : console.warn)(describe(d));
  console.groupEnd();
}

// The panel, <aside class="t-diagnostics" role="status"> after main, on
// file:, localhost and with data-diagnostics; data-quiet silences it.
let panel = null;
function panelOn() {
  if (config.quiet) return false;
  if (config.diagnostics) return true;
  return location.protocol === 'file:' || /^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
}
function panelAdd(d) {
  if (!panelOn() || !document.body) return;
  if (!panel) {
    const aside = document.createElement('aside');
    aside.className = 't-diagnostics';
    aside.setAttribute('role', 'status');
    const box = document.createElement('details');
    const sum = document.createElement('summary');
    const list = document.createElement('ol');
    box.append(sum, list);
    aside.append(box);
    document.body.append(aside);
    panel = { aside, box, sum, list, n: { error: 0, warning: 0, info: 0 } };
  }
  const span = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  const li = document.createElement('li');
  li.className = `t-diag t-diag-${d.severity}`;
  li.append(span('t-diag-sev', d.severity), ' ', span('t-diag-code', d.code), ' ', span('t-diag-at', where(d)), ' ', span('t-diag-msg', d.message));
  if (d.hint) li.append(span('t-diag-hint', d.hint));
  panel.list.append(li);
  const n = panel.n;
  n[d.severity] = (n[d.severity] || 0) + 1;
  const parts = [n.error && plural(n.error, 'error'), n.warning && plural(n.warning, 'warning'), n.info && plural(n.info, 'info')].filter(Boolean);
  panel.sum.textContent = `tern: ${plural(n.error + n.warning + n.info, 'problem')} (${parts.join(', ')})`;
  if (n.error) panel.box.open = true;
}
function rebuildPanel() {
  if (panel) panel.aside.remove();
  panel = null;
  for (const d of diagnostics) panelAdd(d);
}

// ---------------------------------------------------------------- capture

function start() {
  const script = document.currentScript;
  if (script && script.hasAttribute('data-built')) return startBuilt(script);
  if (!script || document.readyState !== 'loading' || script.async || script.defer || script.type === 'module') {
    if (script && (script.hasAttribute('async') || script.hasAttribute('defer'))) console.warn('tern: load tern.js with a plain <script src>, without async or defer; the note was not rendered');
    return; // loaded by a page or an app: tern.render works, nothing starts
  }
  if (document.querySelector('main.tern')) return void console.warn('tern: the page already has a main.tern; tern.js does nothing');

  const addons = readConfig(script);
  page = { head: headString(), lines: linesBefore(), source: null, starts: null, quirks: document.compatMode === 'BackCompat' };
  locateSheets();
  if (page.quirks) {
    const use = script.getAttribute('data-use');
    const tag = `<script src="${script.getAttribute('src')}"${use ? ` data-use="${use}"` : ''}></script>`;
    report('doc.quirks', HEAD, 'the file has no <!doctype html>, so the browser renders it in quirks mode and math is shown as TeX source', `make the first line <!doctype html><meta charset="utf-8">${tag}`);
  }

  // One document.write: the colour scheme (no white flash), preloads that
  // start with the HTML download, and the holder. <plaintext> makes the HTML
  // parser read the rest of the file into it as text, so the note arrives
  // untouched by HTML parsing; `hidden`, not a style attribute, for CSP.
  // Firefox warns of "an unbalanced tree" for this; that is harmless. By now
  // Chromium's preload scanner has read ahead in the raw file, so a `src=`
  // in the note's text (a code example) may be fetched: at worst a 404.
  const plan = katexPlan();
  const n = config.nonce ? ` nonce="${escAttr(config.nonce)}"` : '';
  let w = '';
  if (!document.querySelector('meta[name="color-scheme" i]')) w += '<meta name="color-scheme" content="light dark" id="tern-color-scheme">';
  for (const a of addons) if (!a.css) w += `<link rel="preload" as="script" href="${escAttr(a.url)}"${n}>`;
  if (plan && !window.katex) {
    const sri = (h) => (plan.sri ? ` integrity="${h}" crossorigin="anonymous"` : '');
    w += `<link rel="preload" as="script" href="${escAttr(plan.base)}/katex.min.js" fetchpriority="low"${sri(KATEX.js)}${n}>`;
    w += `<link rel="preload" as="style" href="${escAttr(plan.base)}/katex.min.css" fetchpriority="low"${sri(KATEX.css)}${n}>`;
  }
  try {
    document.write(`${w}<plaintext id="tern-source" hidden>`);
  } catch {
    return;
  }
  const holder = document.getElementById('tern-source');
  if (!holder) return; // the write was ignored: not a parser-inserted script

  // Add-ons: every script at once with async=false, so they are fetched in
  // parallel but run in order (an inserted script is async by default); CSS
  // as links in data-use order. A failure is addon.failed; mount waits for
  // each to load or fail, with no timeout.
  const waits = [];
  const failed = (a) => (ok) => ok || report('addon.failed', HEAD, `the add-on ${a.url} did not load; the note renders without it`, 'check the path in data-use');
  const unwatch = watchAddons(addons); // one that loads but throws while it runs
  for (const a of addons) {
    if (a.css) {
      waits.push(loaded(insert(sheet(a.url), a.slot)).then(failed(a)));
      continue;
    }
    const s = nonce(document.createElement('script'));
    s.src = a.url;
    s.async = false;
    scriptSlot.set(s, a.slot);
    waits.push(loaded(s).then(failed(a)));
    document.head.append(s);
  }
  if (config.css && !BASE_SLOT.els.length) waits.push(loaded(insert(sheet(config.css), BASE_SLOT)));
  baseStyle();
  // KaTeX loads beside the add-ons, so that it is usually there at mount
  // and the first paint is typeset; it runs only after the behaviours.
  if (plan) loadKatex();

  const parsed = new Promise((resolve) =>
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        // The note is everything after the line holding the tern.js tag.
        const text = holder.textContent;
        const nl = text.indexOf('\n');
        page.source = nl < 0 ? '' : text.slice(nl + 1);
        resolve();
      },
      { once: true },
    ),
  );
  Promise.all([parsed, ...waits]).then(() => {
    unwatch();
    return mount();
  });
}

// An add-on script that throws while it runs, at its top level or in what
// it parses badly, still fires `load`: the browser reports the error on
// window instead. Until mount (on a built page, until DOMContentLoaded),
// such an error is addon.failed, once per add-on, with its message. The
// add-on is the current script when the error is reported (so an error
// thrown inside tern.js by the add-on's call counts), else the error's file.
// A cross-origin add-on served without CORS has its error muted: the message
// is then only "Script error.". Returns the function that stops watching.
function watchAddons(addons) {
  const scripts = addons.filter((a) => !a.css);
  if (!scripts.length) return () => {};
  const seen = new Set();
  const bare = (u) => String(u || '').replace(/#.*$/, '');
  const onError = (e) => {
    const cur = document.currentScript;
    const a = scripts.find((x) => (cur ? x.abs === cur.src : bare(x.abs) === bare(e.filename)));
    if (!a || seen.has(a)) return;
    seen.add(a);
    let msg = '';
    try {
      const err = e.error;
      msg = String((err && typeof err === 'object' && err.message) || e.message || err);
    } catch {}
    report('addon.failed', HEAD, `the add-on ${a.url} threw while it ran: ${msg}; the note renders with what it registered before the error`, 'fix the add-on; the browser console shows where it threw');
  };
  window.addEventListener('error', onError);
  return () => window.removeEventListener('error', onError);
}

// window.TERN merged with data-* on the tag. data-use's query strings go to
// config.use[name]: "my-addon.js?lang=de" gives use['my-addon'].lang.
function readConfig(script) {
  const given = window.TERN && typeof window.TERN === 'object' ? window.TERN : {};
  const attr = (k) => (script.hasAttribute(k) ? script.getAttribute(k).trim() : null);
  const flag = (k, v) => (attr(k) === null ? !!v : !/^(?:false|0|off|no)$/i.test(attr(k)));
  Object.assign(config, given);
  ownSchema = given.schema;
  config.use = Object.assign(Object.create(null), given.use && typeof given.use === 'object' ? given.use : null);
  config.katex = typeof given.katex === 'string' ? { base: given.katex } : Object.assign({}, given.katex);
  if (attr('data-katex') !== null) config.katex.base = attr('data-katex');
  if (attr('data-css') !== null) config.css = attr('data-css');
  if (attr('data-nonce') !== null) config.nonce = attr('data-nonce');
  if (attr('data-lang') !== null) config.lang = attr('data-lang');
  config.diagnostics = flag('data-diagnostics', config.diagnostics);
  config.quiet = flag('data-quiet', config.quiet);
  const addons = [];
  for (const url of (attr('data-use') || '').split(/\s+/)) {
    let u;
    try {
      if (url) u = new URL(url, document.baseURI);
    } catch {}
    if (!u) continue;
    let file = u.pathname.slice(u.pathname.lastIndexOf('/') + 1);
    try {
      file = decodeURIComponent(file);
    } catch {}
    const name = file.replace(/(?:\.min)?\.(?:m?js|css)$/i, '');
    const params = Object.create(null);
    u.searchParams.forEach((v, k) => (params[k] = v));
    config.use[name] = Object.assign(Object.create(null), config.use[name], params);
    addons.push({ url, abs: u.href, name, css: /\.css$/i.test(u.pathname), slot: { els: [] } });
  }
  slots = [KATEX_SLOT, BASE_SLOT, ...addons.map((a) => a.slot), STYLE_SLOT];
  return (addonList = addons);
}

// A single-file note declares its vocabulary in window.TERN.schema, in
// the registry's shape {block, leaf, inline}, from a head script. It is
// applied once the add-ons have registered theirs, so the note's own entry
// wins for a name both declare; function fields (label, dom) work as in an
// add-on. A bad entry is a console warning. Its `strict` sets the
// registry's (name.unknown), over an add-on's.
let ownSchema = null;
function applyOwnSchema() {
  const s = ownSchema;
  ownSchema = null;
  if (!s || typeof s !== 'object') return;
  if (s.strict !== undefined) T.schema.strict = !!s.strict;
  for (const level of ['block', 'leaf', 'inline']) {
    const entries = s[level];
    if (!entries || typeof entries !== 'object') continue;
    for (const name of Object.keys(entries)) {
      try {
        T[level](name, entries[name]);
      } catch (e) {
        console.warn(`tern: window.TERN.schema.${level}: ${e.message}`);
      }
    }
  }
}

// The preserved head as a string, for `:::meta` conflicts.
function headString() {
  let s = '<html';
  for (const a of document.documentElement.attributes) s += ` ${a.name}="${escAttr(a.value)}"`;
  return `${s}>${document.head ? document.head.innerHTML : ''}`;
}

// The tern.js line's number in the file: the line breaks in what the parser
// kept of the file so far, the tag being its last node. Exact for the
// canonical first line and for breaks between head elements; the parser
// drops breaks before <html> and <head>, which are then not counted.
function linesBefore() {
  let n = 0;
  const count = (s) => {
    for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  };
  for (const c of document.childNodes) {
    if (c.nodeType === 8) count(c.data);
    else if (c.nodeType === 1) count(c.outerHTML);
  }
  return n + 1;
}

// ---------------------------------------------------------------- the head

// Tern's sheets go in the head in this order: KaTeX, the base, each add-on
// (its link, or the tern.style sheets it adds) in data-use order, then other
// tern.style sheets. The group sits before the head's first author
// stylesheet, so the author's head CSS wins; a head link to tern.css is the
// base itself (the CSP route).
const KATEX_SLOT = { els: [] };
const BASE_SLOT = { els: [] };
const STYLE_SLOT = { els: [] };
let slots = [KATEX_SLOT, BASE_SLOT, STYLE_SLOT];
let anchor = null;
let located = false;
const scriptSlot = new Map(); // add-on script -> its slot

function locateSheets() {
  if (located || !document.head) return;
  located = true;
  const sheets = document.head.querySelectorAll('link[rel~="stylesheet" i], style');
  let named = null;
  try {
    if (config.css) named = new URL(config.css, document.baseURI).href;
  } catch {}
  for (const el of sheets) {
    // A built page inlines the base as <style id="tern-style"> (cli/build.js).
    const base = el.localName === 'link' ? el.href === named || /(?:^|\/)tern(?:\.min)?\.css$/.test(el.href.replace(/[?#].*$/, '')) : built && el.id === 'tern-style';
    if (base) {
      BASE_SLOT.els.push(el);
      return;
    }
  }
  anchor = sheets[0] || null;
}

function insert(el, slot) {
  locateSheets();
  const i = Math.max(0, slots.indexOf(slot));
  let next = null;
  let prev = null;
  for (let j = i + 1; j < slots.length && !next; j++) next = slots[j].els[0] || null;
  for (let j = i; j >= 0 && !next && !prev; j--) prev = slots[j].els[slots[j].els.length - 1] || null;
  if (next) next.before(el);
  else if (prev) prev.after(el);
  else if (anchor && anchor.isConnected) anchor.before(el);
  else document.head.append(el);
  slot.els.push(el);
  return el;
}

// The slot of the add-on running now: the script capture appended, or on a
// built page the static tag with the add-on's URL.
function currentSlot() {
  const s = document.currentScript;
  if (!s) return STYLE_SLOT;
  const a = built && s.src ? addonList.find((x) => !x.css && x.abs === s.src) : null;
  return scriptSlot.get(s) || (a && a.slot) || STYLE_SLOT;
}

const nonce = (el) => {
  if (config.nonce) el.nonce = config.nonce;
  return el;
};
function sheet(href) {
  const l = nonce(document.createElement('link'));
  l.rel = 'stylesheet';
  l.href = href;
  return l;
}
function meta(name, content) {
  const m = document.createElement('meta');
  m.name = name;
  m.content = content;
  return m;
}
const loaded = (el) =>
  new Promise((resolve) => {
    el.addEventListener('load', () => resolve(true), { once: true });
    el.addEventListener('error', () => resolve(false), { once: true });
  });

// The base stylesheet (src/css.js), unless data-css names one or the head
// links tern.css. Added at capture: the empty page already has its colours.
function baseStyle() {
  if (BASE_SLOT.els.length || !document.head) return;
  if (config.css) return void insert(sheet(config.css), BASE_SLOT);
  const s = nonce(document.createElement('style'));
  s.id = 'tern-style';
  s.textContent = BASE_CSS;
  insert(s, BASE_SLOT);
}

// `:::meta` into the existing head, before mount. The head wins a conflict,
// so a key the head already sets is left alone.
function writeMeta(m) {
  if (!m || !document.head) return;
  const html = document.documentElement;
  for (const k of Object.keys(m)) {
    const v = String(m[k]);
    if (k === 'title') {
      if (!document.head.querySelector('title')) document.title = v;
    } else if (k === 'lang' || k === 'dir') {
      if (!html.hasAttribute(k)) html.setAttribute(k, v);
    } else {
      const el = document.head.querySelector(`meta[name="${CSS.escape(k)}" i]`);
      if (!el) document.head.append(meta(k, v));
      else if (el.id === 'tern-color-scheme') el.content = v; // tern's, not the head's
    }
  }
}

// ---------------------------------------------------------------- mount

// parse → transform → emit, with every diagnostic in document order.
function compile(source) {
  const opts = { head: page ? page.head : '', lang: config.lang || undefined };
  const { ast, diagnostics: parsed } = T.parse(source, opts);
  T.transform(ast, opts);
  return { ast, html: T.emit(ast, Object.assign({ cssom: true }, opts)), list: sortDiagnostics(parsed.concat(ast.data.tern.diagnostics)) };
}

// Tern's own presentational styles, a column's alignment and a grid's
// --t-cols, arrive as data-t-align and data-t-cols (emit's `cssom` option) and
// are set through the CSSOM: a strict CSP blocks style attributes, Chromium
// already while parsing (so stripping them after a <template> parse is too
// late), but not the CSSOM. The DOM then matches toHTML's. An author's own
// `style=` stays an attribute, under the page's CSP: raw HTML's could never be
// moved, and moving only `{style=…}` would make a declaration work or not
// depending on how it is written.
function presentation(root) {
  for (const el of root.querySelectorAll('[data-t-align]')) {
    el.style.textAlign = el.getAttribute('data-t-align');
    el.removeAttribute('data-t-align');
  }
  for (const el of root.querySelectorAll('[data-t-cols]')) {
    if (!el.style.getPropertyValue('--t-cols')) el.style.setProperty('--t-cols', el.getAttribute('data-t-cols'));
    el.removeAttribute('data-t-cols');
  }
  posters(root);
}

// A <video> parsed in a <template> and moved into the page keeps its poster
// unloaded in Chromium (Firefox loads it). Setting the attribute again, once
// per element, starts the load; where it is loaded already, the cache answers.
// presentation() runs after every insertion and in process(), so this
// covers a mount, tern.render and a built page.
const posterDone = new WeakSet();
function posters(root) {
  for (const v of root.querySelectorAll('video[poster]')) {
    if (posterDone.has(v)) continue;
    posterDone.add(v);
    v.setAttribute('poster', v.getAttribute('poster'));
  }
}

let taskStart = 0; // when the task running the mount began (0: not mounting)

async function mount() {
  const t0 = (taskStart = now());
  let times = '';
  try {
    applyOwnSchema();
    let r;
    try {
      r = compile(page.source);
    } catch (e) {
      // An engine bug: the note stays readable.
      console.error('tern: rendering failed; the note is shown as source', e);
      r = { ast: null, list: [], html: `<pre class="t-error">${escText(page.source)}</pre>` };
    }
    const t1 = now();
    append(diagnostics, r.list);
    sortDiagnostics(diagnostics);
    writeMeta(r.ast && r.ast.data && r.ast.data.tern && r.ast.data.tern.meta);
    if (!config.lang) config.lang = document.documentElement.lang || undefined;
    if (!document.querySelector('meta[name="viewport" i]')) document.head.append(meta('viewport', 'width=device-width, initial-scale=1'));
    baseStyle();
    // The one emitter's string, through <template>: never a second renderer.
    const tpl = document.createElement('template');
    tpl.innerHTML = `<main class="tern">${r.html}</main>`;
    main = tpl.content.firstElementChild;
    document.body.replaceChildren(tpl.content);
    presentation(main);
    mounted = true;
    rebuildPanel();
    const t2 = now();
    await runScripts(main, r.ast);
    await process(main);
    const t3 = now();
    taskStart = 0;
    reveal();
    times = `${plural(page.source.split('\n').length, 'line')}; parse, transform and emit ${Math.round(t1 - t0)} ms, mount ${Math.round(t2 - t1)} ms, then scripts, behaviours and math ${Math.round(t3 - t2)} ms (${plural(typesetCount, 'formula')})`;
  } catch (e) {
    console.error('tern: the runtime failed', e);
  } finally {
    taskStart = 0;
    logGroup(times);
    fire('ready', main);
    settle();
  }
}

// After 'math': scroll to the URL's fragment, opening the <details> around it.
function reveal() {
  let id = location.hash.slice(1);
  if (!id) return;
  try {
    id = decodeURIComponent(id);
  } catch {}
  const target = document.getElementById(id);
  if (!target) return;
  for (let d = target.parentElement && target.parentElement.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) {
    if (!d.open) d.open = true;
  }
  for (const b of held.keys()) if (b.contains(target)) release(b);
  typesetNow();
  target.scrollIntoView();
}

// ---------------------------------------------------------------- a built page

// `tern build` writes main.tern into the page, the note into
// <script type="text/tern" id="tern-source" data-line="N">, its diagnostics
// into <script type="application/json" id="tern-diagnostics">, and the
// add-ons as static tags after tern.js (cli/build.js). The browser has run
// the note's scripts by DOMContentLoaded, so there is no capture, mount or
// script re-creation: config now, then at DOMContentLoaded the diagnostics
// and the panel, behaviours, the math the build left, the fragment and
// 'ready'. data-built="math" says formulas were left, so KaTeX is requested
// at once, as capture does.
function startBuilt(script) {
  built = true;
  const addons = readConfig(script);
  page = { head: headString(), lines: 0, source: null, starts: null, quirks: document.compatMode === 'BackCompat' };
  locateSheets();
  for (const l of document.head.querySelectorAll('link[rel~="stylesheet" i]')) {
    if (/\/katex(?:\.min)?\.css$/i.test(l.href.replace(/[?#].*$/, ''))) KATEX_SLOT.els.push(l);
    for (const a of addons) if (a.css && a.abs === l.href) a.slot.els.push(l);
  }
  // A static add-on script comes after this one; when it fails to load, its
  // error event reaches window in the capture phase.
  const failed = new Set();
  const onError = (e) => e.target && e.target.localName === 'script' && failed.add(e.target.src);
  window.addEventListener('error', onError, true);
  const unwatch = watchAddons(addons); // one that throws while it runs
  if (script.getAttribute('data-built') === 'math') loadKatex();
  const go = () => {
    window.removeEventListener('error', onError, true);
    unwatch();
    startBuiltPage(addons, failed);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
  else go();
}

async function startBuiltPage(addons, failed) {
  const t0 = (taskStart = now());
  let times = '';
  try {
    applyOwnSchema(); // for behaviours and tern.render: the build applied it already
    main = document.querySelector('main.tern');
    const src = document.getElementById('tern-source');
    if (src && src.localName === 'script') {
      page.source = src.textContent.replace(/<\\(\\*)(\/script|!--)/gi, '<$1$2'); // cli/build.js decodeSource
      page.lines = Number(src.getAttribute('data-line')) || 0;
    }
    const data = document.getElementById('tern-diagnostics');
    try {
      if (data) append(diagnostics, JSON.parse(data.textContent));
    } catch (e) {
      console.warn('tern: the built page has unreadable diagnostics', e);
    }
    // A script add-on that failed. A CSS add-on's link comes before tern.js,
    // so its error event is past, and a failed link still has a sheet: the
    // browser's own console reports it.
    for (const a of addons) if (!a.css && failed.has(a.abs)) report('addon.failed', HEAD, `the add-on ${a.url} did not load; the note renders without it`, 'check the path in data-use');
    sortDiagnostics(diagnostics);
    if (!config.lang) config.lang = document.documentElement.lang || undefined;
    if (!main) return void console.warn('tern: this page has data-built but no main.tern; tern.js does nothing');
    mounted = true;
    rebuildPanel();
    await process(main);
    taskStart = 0;
    reveal();
    const pre = main.querySelectorAll('.t-math .katex').length - typesetCount;
    times = `a built page; behaviours and math ${Math.round(now() - t0)} ms (${plural(typesetCount, 'formula')} typeset, ${pre} pre-rendered)`;
  } catch (e) {
    console.error('tern: the runtime failed', e);
  } finally {
    taskStart = 0;
    logGroup(times);
    fire('ready', main);
    settle();
  }
}

// ---------------------------------------------------------------- note scripts

// Scripts parsed through <template> never run, so each is re-created, in
// document order: inline ones run on insertion, an external one without
// `async` is awaited before the next. Awaiting keeps the order; async=false
// is set too because without it Firefox could hang on a large script.
// Meanwhile document.write and DOMContentLoaded listeners are reported; no
// DOMContentLoaded is ever dispatched again.
const scriptAt = new WeakMap(); // a re-created script -> where it is written
async function runScripts(root, ast) {
  const all = [...root.querySelectorAll('script')].filter((s) => s instanceof HTMLScriptElement);
  if (!all.length) return;
  const at = scriptPositions(ast);
  intercept(true);
  try {
    for (let i = 0; i < all.length; i++) {
      const old = all[i];
      const type = (old.getAttribute('type') || '').trim();
      if (!RUNS.test(type) || !old.isConnected) continue;
      const s = document.createElement('script');
      for (const a of old.attributes) if (a.name !== 'nonce') s.setAttribute(a.name, a.value);
      const n = config.nonce || old.nonce;
      if (n) s.nonce = n;
      const external = old.hasAttribute('src');
      const ordered = external && !old.hasAttribute('async');
      if (ordered) s.async = false;
      if (!external) s.text = old.text;
      if (at.length === all.length) scriptAt.set(s, at[i]);
      const done = ordered || type.toLowerCase() === 'module' ? loaded(s) : null;
      old.replaceWith(s);
      if (done) {
        await done;
        if (taskStart) taskStart = now(); // a load event starts a new task
      }
    }
  } finally {
    intercept(false);
  }
}

// Where each <script> tag is written: only raw HTML blocks hold them.
function scriptPositions(ast) {
  const out = [];
  if (!ast) return out;
  T.visit(ast, 'html', (n) => {
    const v = n.value || '';
    const p = n.position && n.position.start;
    if (!p) return;
    const re = /<!--[\s\S]*?(?:-->|$)|<script\b/gi;
    for (let m = re.exec(v); m; m = re.exec(v)) {
      if (m[0][1] === '!') continue;
      const before = v.slice(0, m.index);
      const nl = before.lastIndexOf('\n');
      const pt = { line: p.line + (before.match(/\n/g) || []).length, column: nl < 0 ? p.column + m.index : m.index - nl, offset: p.offset + m.index };
      out.push({ start: pt, end: pt });
    }
  });
  return out;
}

function intercept(on) {
  if (!on) {
    for (const k of ['write', 'writeln', 'addEventListener']) delete document[k];
    delete window.addEventListener;
    return;
  }
  const at = () => scriptAt.get(document.currentScript) || null;
  document.write = document.writeln = function (...args) {
    const text = args.join('').replace(/\s+/g, ' ').trim();
    report('script.document-write', at(), `a note script called document.write("${text.length > 60 ? `${text.slice(0, 60)}…` : text}"); the page is already parsed, so its output is dropped`, 'build elements with the DOM instead, for example document.currentScript.after(element)');
  };
  const add = EventTarget.prototype.addEventListener;
  // A DOMContentLoaded listener is reported and not registered: the mount
  // may run inside the event's dispatch (tern's own listener on document),
  // where one added to window would still run, so "never runs" holds only if
  // it is never added.
  const wrapped = function (type, fn, opts) {
    if (type !== 'DOMContentLoaded') return add.call(this, type, fn, opts);
    report('script.domcontentloaded', at(), 'a note script listens for DOMContentLoaded, which fired before note scripts run, so the listener never runs', "use tern.on('ready', fn), or run the code directly");
  };
  document.addEventListener = wrapped;
  window.addEventListener = wrapped;
}

// ---------------------------------------------------------------- behaviours

async function process(root) {
  roots.add(root);
  presentation(root);
  texAttributes(root);
  lineNumbers(root);
  behaviours(root);
  fire('render', root);
  await typeset(root);
  fire('math', root);
}

// schema `dom` and tern.define, once per element and function, in document
// order, keyed on data-t. A `t-block` element is a container, so its block
// entry comes first; otherwise the leaf, then the inline one.
const domRecs = new WeakMap(); // a schema dom function -> {fn, done}
function behaviours(root) {
  behavioursRan = true;
  const schema = T.schema;
  const list = root.querySelectorAll('[data-t]');
  for (let i = root.hasAttribute('data-t') ? -1 : 0; i < list.length; i++) {
    const el = i < 0 ? root : list[i];
    const name = el.getAttribute('data-t');
    const levels = el.classList.contains('t-block') ? ['block', 'leaf', 'inline'] : ['leaf', 'inline', 'block'];
    for (const level of levels) {
      const spec = own(schema[level], name) ? schema[level][name] : null;
      if (!spec || typeof spec.dom !== 'function') continue;
      let rec = domRecs.get(spec.dom);
      if (!rec) domRecs.set(spec.dom, (rec = { fn: spec.dom, done: new WeakSet() }));
      apply(rec, el, name);
      break;
    }
    const recs = defined.get(name);
    if (recs) for (const rec of recs.slice()) apply(rec, el, name);
  }
}

function apply(rec, el, name) {
  if (rec.done.has(el)) return;
  rec.done.add(el);
  try {
    rec.fn.call(el, el);
  } catch (e) {
    console.error(`tern: the "${name}" behaviour failed`, e);
  }
}

// Line numbers from data-start: the base CSS needs typed attr() (Chromium
// 133+), so the counter is also set through the CSSOM, which a CSP allows.
function lineNumbers(root) {
  for (const code of root.querySelectorAll('pre[data-lines][data-start] > code')) {
    const n = parseInt(code.parentElement.getAttribute('data-start'), 10);
    if (Number.isFinite(n)) code.style.counterReset = `t-line ${n - 1}`;
  }
}

// ---------------------------------------------------------------- math

let katexP = null;
let katexFailed = null; // the base KaTeX did not load from
let K = null; // KaTeX, once loaded
let inlineOpts = null;
let displayOpts = null;
let macroOpts = null;
const done = new WeakSet(); // formulas typeset, or failed
const deferred = new Set(); // formulas in a closed <details>
const macrosDone = new WeakSet();
let queue = [];
let qi = 0;
let pumping = false;
let waiters = [];
let typesetCount = 0;

// Where KaTeX comes from: nowhere in quirks mode, which KaTeX refuses, or
// with data-katex="none"; a custom base has no SRI.
function katexPlan() {
  if (document.compatMode === 'BackCompat') return null;
  const b = config.katex && typeof config.katex.base === 'string' ? config.katex.base : '';
  if (b === 'none') return null;
  return b ? { base: b.replace(/\/+$/, ''), sri: false } : { base: KATEX.base, sri: true };
}

function loadKatex() {
  if (katexP) return katexP;
  const plan = katexPlan();
  if (!plan) return (katexP = Promise.resolve(null));
  if (window.katex) return (katexP = Promise.resolve(useKatex(window.katex)));
  const css = sheet(`${plan.base}/katex.min.css`);
  const js = nonce(document.createElement('script'));
  js.src = `${plan.base}/katex.min.js`;
  for (const [el, hash] of [[css, KATEX.css], [js, KATEX.js]]) {
    el.fetchPriority = 'low';
    if (plan.sri) (el.integrity = hash), (el.crossOrigin = 'anonymous');
  }
  const both = Promise.all([loaded(js), loaded(insert(css, KATEX_SLOT))]);
  document.head.append(js);
  return (katexP = both.then(([a, b]) => {
    if (a && b && window.katex) return useKatex(window.katex);
    katexFailed = plan.base;
    return null;
  }));
}

// Options from tern.config.katex: trust, strict, output, leqno, macros, and
// any other KaTeX option but displayMode and throwOnError. One macro table is
// shared by every formula, the `:::macros` bodies filling it first.
function useKatex(k) {
  K = k;
  const c = config.katex || {};
  const base = { throwOnError: true, macros: Object.assign({}, c.macros) };
  for (const key of Object.keys(c)) if (!['base', 'macros', 'displayMode', 'throwOnError'].includes(key)) base[key] = c[key];
  inlineOpts = Object.assign({}, base, { displayMode: false });
  displayOpts = Object.assign({}, base, { displayMode: true });
  macroOpts = Object.assign({}, base, { displayMode: false, globalGroup: true });
  return k;
}

// data-tex on every formula before the behaviours see it (find in page, copy).
function texAttributes(root) {
  for (const el of root.querySelectorAll('.t-math')) if (!el.hasAttribute('data-tex')) el.setAttribute('data-tex', el.textContent);
}

// Typesets the formulas in view; one in a closed <details> waits for it to open.
async function typeset(root) {
  texAttributes(root);
  const visible = [];
  for (const el of root.querySelectorAll('.t-math')) {
    if (done.has(el) || deferred.has(el)) continue;
    if (el.querySelector('.katex')) done.add(el); // typeset already (tern build)
    else if (closedDetails(el)) deferred.add(el);
    else visible.push(el);
  }
  // A built page whose formulas are all pre-rendered needs no KaTeX for its
  // :::macros: they matter only to a formula typeset here.
  const macros = built && !visible.length && !deferred.size ? [] : root.querySelectorAll('.t-macros');
  if (!visible.length && !deferred.size && !macros.length) return;
  const sameTask = !!K && taskStart > 0; // no task boundary before the first slice
  if (visible.length > HOLD_OVER && katexPlan()) hold(root);
  if (!(await loadKatex())) {
    if (katexFailed && (visible.length || deferred.size)) {
      report('katex.unavailable', HEAD, `KaTeX did not load from ${katexFailed}; math is shown as TeX source`, 'check the connection or data-katex; data-katex="none" turns math rendering off');
      katexFailed = null;
    }
    return;
  }
  for (const m of macros) {
    if (macrosDone.has(m)) continue;
    macrosDone.add(m);
    try {
      K.renderToString(m.textContent, macroOpts);
    } catch (e) {
      report('math.error', positionOf(m), `the :::macros block does not parse: ${e.message}`, 'fix the TeX of the definitions');
    }
  }
  if (!visible.length) return;
  append(queue, visible);
  if (!pumping) {
    pumping = true;
    const left = sameTask ? TASK_MS - (now() - taskStart) : SLICE_MS;
    if (left > 2) pump(Math.min(left, SLICE_MS));
    else later();
  }
  if (pumping) await new Promise((resolve) => waiters.push(resolve));
}

function pump(budget) {
  const end = now() + budget;
  do typesetOne(queue[qi++]);
  while (qi < queue.length && now() < end);
  if (qi < queue.length) return void later();
  queue = [];
  qi = 0;
  pumping = false;
  const w = waiters;
  waiters = [];
  for (const resolve of w) resolve();
}

// Typeset into a detached box, moved in only on success: a failure keeps the
// TeX visible. katex.render builds the DOM with CSSOM styles, which a CSP
// allows; renderToString's style attributes would be blocked by one.
let box = null;
function typesetOne(el) {
  if (!el || done.has(el)) return;
  done.add(el);
  if (!el.isConnected) return;
  box = box || document.createElement('span');
  try {
    K.render(el.getAttribute('data-tex') || '', box, el.hasAttribute('data-display') ? displayOpts : inlineOpts);
  } catch (e) {
    box.textContent = '';
    el.classList.add('t-error');
    el.title = e.message;
    report('math.error', positionOf(el), `KaTeX cannot typeset this formula: ${e.message}`, 'the formula is shown as written; fix its TeX');
    return;
  }
  el.replaceChildren(...box.childNodes);
  typesetCount++;
}

// Held blocks, for long notes. A typeset formula costs the browser several
// times its KaTeX time in style, layout and paint, plus moving everything
// after it: on a 4,000-formula note each 10 ms slice made a 50-60 ms frame.
// So when more than HOLD_OVER formulas wait, root's top-level blocks get
// content-visibility:auto, which skips that work for those out of view. Each
// is released (made plain again, for good) before it comes into view,
// because containment changes layout (margins stop collapsing through the
// block, it avoids floats, it clips its overflow): the ones near the
// viewport at once, in this task, so no frame shows a held block; the others
// when an IntersectionObserver sees them within 1.5 viewports, and before
// printing, a fragment scroll or a copy. A full-page screenshot tool shows
// held blocks blank; printing does not (see the print rule in src/css.js).
const HOLD_OVER = 100;
const held = new Map(); // block -> the author's inline [content-visibility, contain-intrinsic-block-size]
let watcher = null;
function hold(root) {
  if (typeof IntersectionObserver !== 'function' || !('contentVisibility' in document.documentElement.style)) return;
  const blocks = [];
  for (const b of root.children) {
    if (held.has(b) || /^(?:script|style|template)$/.test(b.localName)) continue;
    held.set(b, [b.style.contentVisibility, b.style.containIntrinsicBlockSize]);
    b.style.containIntrinsicBlockSize = 'auto 6em';
    b.style.contentVisibility = 'auto';
    blocks.push(b);
  }
  // Release what is near the viewport; that changes heights, so look again.
  for (let again = true, n = 0; again && n < 8; n++) {
    again = false;
    const margin = 1.5 * (window.innerHeight || 800);
    for (const b of blocks) {
      if (!held.has(b)) continue;
      const r = b.getBoundingClientRect();
      if (r.bottom > -margin && r.top < (window.innerHeight || 800) + margin) release(b), (again = true);
    }
  }
  watcher = watcher || new IntersectionObserver((list) => list.forEach((e) => e.isIntersecting && release(e.target)), { rootMargin: '150% 0px' });
  for (const b of blocks) if (held.has(b)) watcher.observe(b);
}
function release(b) {
  const h = held.get(b);
  if (!h) return;
  held.delete(b);
  if (watcher) watcher.unobserve(b);
  b.style.contentVisibility = h[0];
  b.style.containIntrinsicBlockSize = h[1];
}

// Everything pending, now: before printing and before a fragment scroll.
function typesetNow() {
  if (!K) return;
  for (const el of deferred) if (!closedDetails(el)) deferred.delete(el), typesetOne(el);
  while (qi < queue.length) typesetOne(queue[qi++]);
}

// The closed <details> that hides el, if any (its own <summary> shows).
function closedDetails(el) {
  for (let d = el.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) {
    const s = d.querySelector(':scope > summary');
    if (!(s && s.contains(el))) return d;
  }
  return null;
}

// The next slice: after the next frame while the page is visible (the frame
// callback posts a MessageChannel task, so the slice runs after the paint,
// not before it), at once while it is hidden, where frames stop.
let port = null;
let frame = 0;
function later() {
  if (!port) {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => pump(SLICE_MS);
    port = ch.port2;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && frame) cancelAnimationFrame(frame), (frame = 0), port.postMessage(0);
    });
  }
  if (document.hidden) port.postMessage(0);
  else frame = requestAnimationFrame(() => ((frame = 0), port.postMessage(0)));
}

// ---------------------------------------------------------------- page handlers

// Formulas in a <details> are typeset when it opens; then 'math' fires on it.
function onToggle(e) {
  const d = e.target;
  if (!d.open || !deferred.size || !K) return;
  const list = [];
  for (const el of deferred) if (d.contains(el) && !closedDetails(el)) list.push(el);
  if (!list.length) return;
  for (const el of list) deferred.delete(el), queue.push(el);
  if (!pumping) (pumping = true), pump(SLICE_MS);
  (pumping ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()).then(() => fire('math', d));
}

// Copy: a typeset formula is copied as its TeX, $tex$ or $$tex$$, in
// text/plain and text/html.
function onCopy(e) {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
  for (const b of held.keys()) if (sel.containsNode(b, true)) release(b); // held blocks are skipped by innerText
  const tex = (m) => {
    const t = m.getAttribute('data-tex') || '';
    return m.hasAttribute('data-display') ? `$$${t}$$` : `$${t}$`;
  };
  const anc = sel.getRangeAt(0).commonAncestorContainer;
  const inside = (anc.nodeType === 1 ? anc : anc.parentElement).closest('.t-math[data-tex]');
  if (inside) {
    if (!inside.querySelector('.katex')) return;
    e.clipboardData.setData('text/plain', tex(inside));
    e.clipboardData.setData('text/html', escText(tex(inside)));
    return void e.preventDefault();
  }
  const host = document.createElement('div');
  for (let i = 0; i < sel.rangeCount; i++) host.append(sel.getRangeAt(i).cloneContents());
  if (!host.querySelector('.katex')) return;
  for (const m of host.querySelectorAll('.t-math[data-tex]')) if (m.querySelector('.katex')) m.replaceChildren(tex(m));
  for (const k of host.querySelectorAll('.katex')) k.remove(); // cut away from its .t-math
  // innerText needs layout: measured off screen inside main, then taken out.
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:40rem';
  (main && main.isConnected ? main : document.body).append(host);
  const text = host.innerText;
  host.remove();
  host.removeAttribute('style');
  host.removeAttribute('aria-hidden');
  e.clipboardData.setData('text/plain', text);
  e.clipboardData.setData('text/html', host.innerHTML);
  e.preventDefault();
}

// Print: every details.t-block opens (and closes again afterwards), and
// pending math is typeset now, as the print layout is taken right after.
let printOpened = [];
function onBeforePrint() {
  for (const d of document.querySelectorAll('details.t-block:not([open])')) (d.open = true), printOpened.push(d);
  for (const b of held.keys()) release(b);
  typesetNow();
}
function onAfterPrint() {
  for (const d of printOpened) d.open = false;
  printOpened = [];
}

module.exports = { attach, KATEX };
  };
  // ---- src/index.js
  defs['index'] = function (module, exports, require) {
// The engine's public API (docs/api.html). Everything returned is
// JSON-serialisable.

const { normalise } = require('./scan');
const { createContext, visit } = require('./ast');
const { sortDiagnostics } = require('./diag');
const { parseBlocks } = require('./block');
const { outline } = require('./outline');
const registry = require('./schema');
const pipeline = require('./transform');
const { emit } = require('./emit');
const { css } = require('./css');
const runtime = require('./runtime');

const version = '0.2.0-dev';

// The schema a call uses: opts.schema when given (the corpus passes one),
// else the registry that tern.block/leaf/inline write.
const withSchema = (opts) => (opts && opts.schema ? opts : { ...opts, schema: registry.schema });

// parse(source, {schema, head, maxDepth}) -> {ast, diagnostics}
// `source` is the note (everything after the tern.js line); `head` is the
// preserved head as a string, for `:::meta` conflicts; `schema` is the
// registry {block, leaf, inline}, with `strict: true` for name.unknown.
function parse(source, opts) {
  const ctx = createContext(normalise(source), withSchema(opts));
  const ast = parseBlocks(ctx);
  return { ast, diagnostics: sortDiagnostics(ctx.diagnostics) };
}

// transform(ast, opts) -> ast: runs the transforms in place and appends
// their diagnostics to ast.data.tern.diagnostics.
// transform(name, fn, {before | after}) registers a transform.
function transform(ast, opts, order) {
  if (typeof ast === 'string') return pipeline.register(ast, opts, order);
  return pipeline.run(ast, withSchema(opts));
}

// Every diagnostic for a note: the parser's and the transforms', in order.
function check(source, opts) {
  const o = withSchema(opts);
  const { ast, diagnostics } = parse(source, o);
  pipeline.run(ast, o);
  return sortDiagnostics(diagnostics.concat(ast.data.tern.diagnostics));
}

// toHTML(source, {schema, head, positions, safe}) -> the body HTML, synchronously.
function toHTML(source, opts) {
  const o = withSchema(opts);
  const { ast } = parse(source, o);
  return emit(pipeline.run(ast, o), o);
}

module.exports = {
  version,
  parse,
  transform,
  emit: (ast, opts) => emit(ast, withSchema(opts)),
  toHTML,
  check,
  visit,
  outline,
  schema: registry.schema,
  block: registry.block,
  leaf: registry.leaf,
  inline: registry.inline,
  get transforms() {
    return pipeline.names();
  },
  css,
};

// The runtime's API (define, undefine, on, render, ready, diagnostics,
// config, style) on the same object; in a browser it also starts the
// runtime. Under node it is inert.
runtime.attach(module.exports);
  };
  var tern = require('index');
  if (typeof module === 'object' && module && module.exports) module.exports = tern;
  else if (!(global.tern && global.tern.version)) global.tern = tern;
})(typeof globalThis !== 'undefined' ? globalThis : this);
