// SPDX-License-Identifier: MIT
// The documentation's pages as the engine reads them, and the ids they
// define. Shared by test/docs.js (link fragments) and the corpus lint
// (`spec:` anchors, test/lib/spec.js); each page is analysed once per process.
//   load(file)          null when the file is not a note, {file, error} when
//                       analysing it throws, else {file, text, x, ids, html}:
//                       x is cli/examples.js extract(), ids every id a link
//                       fragment may name (the registry's and the HTML's)
//   page(name)          load() of docs/NAME.html (index.html for `index`),
//                       or {error} when it is not a note or cannot be analysed
//   resolve(anchor)     PAGE#ID, PAGE one of PAGES: {page, id}, or {error}
//   headings(name)      the page's headings with ids, in document order:
//                       [{id, depth, line}], or null
//   section(name, id)   the anchors NAME#… from heading ID up to the next
//                       heading of the same or a higher level (a Set), or null
//   decode(s)           s with HTML's five basic character references decoded
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// The pages an anchor may name: docs/NAME.html, and `index` for index.html.
const PAGES = ['index', 'guide', 'syntax-blocks', 'syntax-inline', 'elements', 'schema', 'diagnostics', 'tools', 'publishing', 'api'];

// Required on first use, so that an engine that does not load (cli/note.js
// requires tern.js) is reported for the page instead of thrown on require.
let cli = null;
const engine = () => cli || (cli = { examples: require('../../cli/examples'), tern: require('../../cli/note').tern });

const decode = (s) => s.replace(/&(amp|quot|lt|gt|#39);/g, (m, k) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[k]);

const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  let entry = null;
  try {
    const { examples, tern } = engine();
    const text = fs.readFileSync(file, 'utf8');
    const x = examples.extract(text, file);
    if (x) {
      const ids = new Set(Object.keys(x.a.ast.data.tern.ids));
      const html = tern.emit(x.a.ast, { ...x.a.opts, positions: false });
      for (const m of html.matchAll(/<[a-zA-Z][^<>]*?\sid="([^"]*)"/g)) ids.add(decode(m[1]));
      entry = { file, text, x, ids, html };
    }
  } catch (e) {
    entry = { file, error: e };
  }
  cache.set(file, entry);
  return entry;
}

const shown = (name) => (name === 'index' ? 'index.html' : `docs/${name}.html`);
function page(name) {
  const p = load(path.join(ROOT, shown(name)));
  if (!p) return { error: `${shown(name)} is not a note` };
  if (p.error) return { error: `${shown(name)} cannot be analysed: ${String((p.error && p.error.message) || p.error).split('\n')[0]}` };
  return p;
}

function resolve(anchor) {
  const m = /^([a-z][a-z-]*)#(.+)$/.exec(anchor);
  if (!m) return { error: 'is not PAGE#ID' };
  const [, name, id] = m;
  if (!PAGES.includes(name)) return { error: `names no documentation page (${PAGES.join(', ')})` };
  const p = page(name);
  if (p.error) return p;
  if (!p.ids.has(id)) return { error: `${shown(name)} has no id ${JSON.stringify(id)}` };
  return { page: name, id };
}

const outline = new Map();
function headings(name) {
  if (outline.has(name)) return outline.get(name);
  const p = PAGES.includes(name) ? page(name) : { error: true };
  let list = null;
  if (!p.error) {
    list = [];
    engine().tern.visit(p.x.a.ast, (node) => {
      if (node.type === 'heading' && node.attributes && node.attributes.id) list.push({ id: String(node.attributes.id), depth: node.depth, line: node.position.start.line });
    });
  }
  outline.set(name, list);
  return list;
}

// By note line: the registry records where each id is defined.
function section(name, id) {
  const list = headings(name);
  const i = list ? list.findIndex((h) => h.id === id) : -1;
  if (i < 0) return null;
  const { depth, line } = list[i];
  const next = list.slice(i + 1).find((h) => h.depth <= depth);
  const end = next ? next.line : Infinity;
  const ids = page(name).x.a.ast.data.tern.ids;
  const out = new Set([`${name}#${id}`]);
  for (const [k, v] of Object.entries(ids)) if (v.line >= line && v.line < end) out.add(`${name}#${k}`);
  return out;
}

module.exports = { PAGES, load, page, resolve, headings, section, decode };
