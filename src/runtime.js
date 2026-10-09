// SPDX-License-Identifier: MIT
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
'use strict';

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
