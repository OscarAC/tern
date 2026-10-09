// SPDX-License-Identifier: MIT
// The lexical pieces the block and inline parsers share: source
// normalisation, the character classes, the `{…}` attribute-group parser,
// and the reserved-name and custom-element tests.
'use strict';

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
