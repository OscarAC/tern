// SPDX-License-Identifier: MIT
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
'use strict';

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
