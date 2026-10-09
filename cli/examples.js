// SPDX-License-Identifier: MIT
// A documentation page's live examples (docs/README.md "Live examples"): the
// `tern` fences with the class `live`, which docs/docs.js renders on the
// page. Shared by `tern corpus` (cli/commands.js), test/docs.js and the docs
// smoke tests, so all three read the same examples the same way. Node only.
//
// An example's attributes, as written on the fence and emitted on its
// element (`pre`, or a titled fence's `figure`):
//   expect="a.b c.d"   the diagnostic codes it must produce, a multiset;
//                      none by default
//   schema=none|demo   none (the default) is a plain note's empty registry;
//                      demo is window.ternDocs.demo from the page's add-ons
//                      (docs.js), which equals test/fixtures/schema.js
//   head="…"           the preserved head, as a string
//   spec="PAGE#ID …"   the documentation anchors `tern corpus` cites on the
//                      case's spec: line, as `syntax-blocks#fence`; when
//                      absent, the example's own section (citation below)
// The example's note is the fence's text plus a final line break, as a
// note file ends with one (and as the corpus harness reads a `tern` block).
'use strict';

const path = require('path');
const { analyse, addons, tern } = require('./note');

const NONE = Object.freeze({ block: Object.freeze({}), leaf: Object.freeze({}), inline: Object.freeze({}) });

// Corpus ids are kebab case in ASCII (test/lib/corpus.js ID).
const kebab = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// A page's part of its examples' slugs: the file name; a page in examples/
// gets `examples-` before it, so examples/x.html and docs/x.html differ.
function pageSlug(file) {
  const base = kebab(path.basename(file).replace(/\.html?$/i, '')) || 'page';
  return path.basename(path.dirname(path.resolve(file))) === 'examples' ? `examples-${base}` : base;
}

// The PAGE of a documentation anchor PAGE#ID: a page in docs/ is cited by its
// file name without .html (docs/syntax-blocks.html is `syntax-blocks`), and
// the home page as `index`. An example note is not a documentation page, so
// its examples cite the guide as a whole: null here, `guide#top` below.
function citedPage(file) {
  const dir = path.basename(path.dirname(path.resolve(file)));
  const name = path.basename(file).replace(/\.html?$/i, '');
  if (dir === 'docs') return name || null;
  return name === 'index' && dir !== 'examples' ? 'index' : null;
}

const words = (s) => String(s || '').split(/\s+/).filter(Boolean);
const classes = (node) => words(node.attributes && node.attributes.class);

// The page's examples, in document order. Returns null when the file is not
// a note; else {a, demo, examples, problems}:
//   a         cli/note.js analyse(): the page's diagnostics, AST, toFile …
//   demo      the demo schema the page's add-ons expose, or null
//   examples  [{n, slug, line, column, value, source, expect, schemaName,
//             schema, head, spec, cite}], `line` and `column` being the
//             fence's file position; `schema` is null when schemaName is
//             unknown; `spec` the words of spec=, or null
//   problems  [{line, message}], file lines: an unknown schema name, or
//             schema=demo on a page whose add-ons expose none
// A slug is stable: the fence's own #id when it has one, else the id of the
// heading the example follows and its number under that heading
// (`fence-2`), or its number on the page before any heading.
// `cite` is the anchor of the example's section, the nearest heading before
// it with an id: `syntax-blocks#fence`, `PAGE#top` before any heading, and
// `guide#top` on an example note (citedPage).
function extract(text, file, opts = {}) {
  let globals = null;
  const load = (tag, dir, head) => {
    const r = (opts.addons || addons)(tag, dir, head);
    globals = r.window || null;
    return r;
  };
  const a = analyse(text, file, { addons: load });
  if (!a) return null;
  let demo = null;
  try {
    const d = globals && globals.ternDocs && globals.ternDocs.demo;
    if (d && typeof d === 'object') demo = d;
  } catch {}

  const page = pageSlug(file || 'page.html');
  const cited = citedPage(file || 'page.html');
  const examples = [];
  const problems = [];
  const used = new Set();
  let section = null;
  let anchor = 'top';
  let k = 0;
  tern.visit(a.ast, (node) => {
    if (node.type === 'heading') {
      section = (node.attributes && node.attributes.id) || null;
      if (section) anchor = String(section);
      k = 0;
      return;
    }
    if (node.type !== 'code' || node.lang !== 'tern' || !classes(node).includes('live')) return;
    k++;
    const at = a.toFile(node.position).start;
    const attrs = node.attributes || {};
    const own = attrs.id && kebab(attrs.id);
    const base = `${page}-${own || (section && kebab(section) ? `${kebab(section)}-${k}` : String(k))}`;
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    used.add(slug);
    const schemaName = attrs.schema === undefined ? 'none' : String(attrs.schema);
    let schema = null;
    if (schemaName === 'none') schema = NONE;
    else if (schemaName === 'demo') {
      schema = demo;
      if (!demo) problems.push({ line: at.line, message: 'schema=demo, but the page\'s add-ons expose no demo schema (window.ternDocs.demo from docs.js)' });
    } else problems.push({ line: at.line, message: `schema="${schemaName}" is not a schema the docs know (none, demo)` });
    examples.push({
      n: examples.length + 1,
      slug,
      line: at.line,
      column: at.column,
      value: node.value,
      source: `${node.value}\n`,
      expect: words(attrs.expect),
      schemaName,
      schema,
      head: attrs.head === undefined ? undefined : String(attrs.head),
      spec: attrs.spec === undefined ? null : words(attrs.spec),
      cite: cited ? `${cited}#${anchor}` : 'guide#top',
    });
  });
  return { a, demo, examples, problems };
}

// The engine's options for an example, as docs.js passes them.
const options = (ex) => (ex.head === undefined ? { schema: ex.schema } : { schema: ex.schema, head: ex.head });

// Runs an example: its diagnostics, and how they differ from `expect` as
// multisets ({missing, unexpected}, codes; both empty when they agree).
function check(ex) {
  const diagnostics = tern.check(ex.source, options(ex));
  const left = diagnostics.map((d) => d.code);
  const missing = [];
  for (const code of ex.expect) {
    const i = left.indexOf(code);
    if (i < 0) missing.push(code);
    else left.splice(i, 1);
  }
  return { diagnostics, missing, unexpected: left };
}

// The examples as conformance-corpus cases (test/corpus/README.md):
//   ## docs/<slug>, then spec: (the fence's spec=, else the example's
//   section, `cite`), options:
//   (schema=none unless schema=demo, which is the corpus's own fixture
//   schema; escaped when the source has tabs, CR, NUL, a BOM or trailing
//   spaces), a prose line naming the page, the `tern` block, an `html head`
//   block for head=, and a `diagnostics` block: each expected code with the
//   position and severity the engine gives it.
// An example whose diagnostics differ from its expect, or that has no
// usable schema, is left out and reported. `shown` is the file as named.
// Returns {text, cases, problems}; text is '' when there are no cases.
function toCorpus(x, shown) {
  const problems = x.problems.slice();
  const out = [];
  let cases = 0;
  for (const ex of x.examples) {
    if (!ex.schema) continue;
    const r = check(ex);
    if (r.missing.length || r.unexpected.length) {
      const say = (l) => (l.length ? l.join(' ') : 'nothing');
      problems.push({ line: ex.line, message: `example ${ex.slug}: expect="${ex.expect.join(' ')}" but the engine reports ${say(r.diagnostics.map((d) => d.code))} (missing ${say(r.missing)}, unexpected ${say(r.unexpected)})` });
      continue;
    }
    const opts = [];
    if (ex.schemaName === 'none') opts.push('schema=none');
    let body = ex.value;
    if (/[\t\r\0﻿]| +$/m.test(body)) {
      opts.push('escaped');
      body = body
        .replace(/\\/g, '\\\\')
        .replace(/\t/g, '\\t')
        .replace(/\r/g, '\\r')
        .replace(/\0/g, '\\0')
        .replace(/﻿/g, '\\uFEFF')
        .replace(/ +$/gm, (s) => '\\u0020'.repeat(s.length));
    }
    const fence = (s) => '`'.repeat(Math.max(4, ...[...String(s).matchAll(/^\s*(`+)/gm)].map((m) => m[1].length + 1)));
    const block = (info, s) => {
      const f = fence(s);
      return `${f}${info}\n${s === '' ? '' : `${s}\n`}${f}`;
    };
    const diags = r.diagnostics.map((d) => `${d.position.start.line}:${d.position.start.column} ${d.severity} ${d.code}`).join('\n');
    cases++;
    out.push(
      [
        `## docs/${ex.slug}`,
        '',
        `spec: ${ex.spec && ex.spec.length ? ex.spec.join(' ') : ex.cite}`,
        ...(opts.length ? [`options: ${opts.join(' ')}`] : []),
        '',
        `The live example on line ${ex.line} of ${shown}.`,
        '',
        block('tern', body),
        ...(ex.head === undefined ? [] : ['', block('html head', ex.head)]),
        '',
        block('diagnostics', diags),
      ].join('\n'),
    );
  }
  const text = cases ? `# ${shown}: live examples (tern corpus)\n\n${out.join('\n\n')}\n` : '';
  return { text, cases, problems };
}

module.exports = { extract, check, options, toCorpus, pageSlug, kebab, NONE };
