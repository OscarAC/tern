// SPDX-License-Identifier: MIT
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
'use strict';

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
