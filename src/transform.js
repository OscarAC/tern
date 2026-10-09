// SPDX-License-Identifier: MIT
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
'use strict';

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
