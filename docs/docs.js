// SPDX-License-Identifier: MIT
// docs.js: the documentation's add-on (docs/README.md), loaded with
// data-use="docs.js docs.css" (index.html: docs/docs.js docs/docs.css).
//
// It declares the pages' vocabulary, exposes the demo schema that live
// examples use with schema=demo, and adds two behaviours:
//   - site-nav: draws the site navigation;
//   - code: turns each live example (a `tern` fence with the class `live`)
//     into source, result, diagnostics and generated HTML, computed here by
//     the engine, and highlights every `tern` fence. A result is isolated
//     from the page: its ids are prefixed, its scripts do not run, its styles
//     are scoped, and its math is typeset here with its own macros, its
//     KaTeX errors listed in the example rather than the page.
//
// Under node (tern check, the LSP, test/docs.js) only the vocabulary and
// window.ternDocs matter: the behaviours are registered with the inert shim
// and never run.
(function () {
  'use strict';
  const T = window.tern;
  if (!T) return;

  // ---------------------------------------------------------------- vocabulary

  const callout = (label) => ({ label, attrs: { role: 'note' } });
  T.leaf('toc', { tag: 'nav', transform: 'toc', depth: '2-3', attrs: { 'aria-label': 'Contents' } });
  T.leaf('site-nav', { tag: 'nav', attrs: { 'aria-label': 'Site' } });
  T.block('note', callout('Note'));
  T.block('tip', callout('Tip'));
  T.block('warning', callout('Warning'));
  T.block('important', callout('Important'));
  T.block('syntax', { label: 'Syntax' });
  T.block('figure', { tag: 'figure', counter: 'figure', label: 'Figure' });
  T.block('table', { tag: 'table', counter: 'table', label: 'Table' });
  T.block('code', { counter: 'code', label: 'Listing' });
  T.inline('kbd', { tag: 'kbd' });

  // ---------------------------------------------------------------- the demo schema

  // What `{.live schema=demo}` renders with: exactly test/fixtures/schema.js,
  // the vocabulary the conformance corpus assumes (test/docs.js checks that
  // the two are equal). Plain data, as tern.block/leaf/inline write it.
  const theoremLike = (label) => ({ tag: 'section', counter: 'theorem', label, ref: '{label} {n}' });
  const demoCallout = (label) => ({ label });
  const demo = {
    block: {
      theorem: theoremLike('Theorem'),
      lemma: theoremLike('Lemma'),
      proposition: theoremLike('Proposition'),
      corollary: theoremLike('Corollary'),
      definition: { tag: 'section', counter: 'definition', label: 'Definition' },
      example: { tag: 'section', counter: 'example', label: 'Example' },
      exercise: { tag: 'section', counter: 'exercise', label: 'Exercise' },
      proof: { tag: 'section', label: 'Proof', end: '∎' },
      note: demoCallout('Note'),
      tip: demoCallout('Tip'),
      important: demoCallout('Important'),
      warning: demoCallout('Warning'),
      caution: demoCallout('Caution'),
      recall: { tag: 'details' },
      figure: { tag: 'figure', counter: 'figure', label: 'Figure' },
      table: { tag: 'table', counter: 'table', label: 'Table' },
      code: { counter: 'code', label: 'Listing' },
    },
    leaf: {
      toc: { tag: 'nav', transform: 'toc', depth: '2-3' },
    },
    inline: {},
  };
  // schema=none, the default: what a plain note gets.
  const none = { block: {}, leaf: {}, inline: {} };

  // The site, in navigation order (docs/README.md "The pages"); paths from
  // the site root. The examples follow, under one heading.
  const PAGES = [
    ['index.html', 'Tern'],
    ['docs/guide.html', 'Guide'],
    ['docs/syntax-blocks.html', 'Syntax: blocks'],
    ['docs/syntax-inline.html', 'Syntax: inline'],
    ['docs/elements.html', 'Elements and output'],
    ['docs/schema.html', 'Vocabulary and behaviour'],
    ['docs/diagnostics.html', 'Diagnostics'],
    ['docs/tools.html', 'Command line and editors'],
    ['docs/publishing.html', 'Publishing'],
    ['docs/api.html', 'JavaScript API'],
  ];
  const EXAMPLES = [
    ['examples/lecture.html', 'Lecture notes'],
    ['examples/cheatsheet.html', 'Cheat sheet'],
    ['examples/code.html', 'Code notes'],
    ['examples/media.html', 'Field notes'],
    ['examples/layout.html', 'Project plan'],
  ];

  window.ternDocs = { demo, schemas: { none, demo }, pages: PAGES, examples: EXAMPLES };

  // ---------------------------------------------------------------- the browser

  // Under node, document is an inert stand-in (cli/note.js): stop here.
  const DOM = typeof document === 'object' && document !== null && document.nodeType === 9;
  if (!DOM) return;

  // The site root: docs.js lives in docs/.
  const SCRIPT = document.currentScript && document.currentScript.src;
  function siteRoot() {
    let src = SCRIPT;
    if (!src) {
      const s = [...document.scripts].find((x) => /(?:^|\/)docs\.js(?:[?#]|$)/.test(x.getAttribute('src') || ''));
      src = s ? s.src : '';
    }
    try {
      return new URL('../', src || location.href).href;
    } catch {
      return null;
    }
  }

  // Where this page is, from the root: {rel: 'docs/guide.html', up: '../'}.
  function here() {
    const root = siteRoot();
    let page = location.href.replace(/[?#].*$/, '');
    if (page.endsWith('/')) page += 'index.html';
    if (!root || !page.startsWith(root)) return { root, rel: null, up: null };
    const rel = decodeURIComponent(page.slice(root.length));
    return { root, rel, up: '../'.repeat((rel.match(/\//g) || []).length) };
  }

  // A URL for a path from the site root, relative to this page when it can be.
  function link(path, at = here()) {
    if (at.up !== null) return at.up + path;
    try {
      return new URL(path, at.root || location.href).href;
    } catch {
      return path;
    }
  }

  const el = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  // A behaviour leaves alone what sits inside an example's result: the
  // result shows the note as it renders without this add-on.
  const inResult = (node) => !!node.closest('.docs-live-out');

  // ---------------------------------------------------------------- site-nav

  T.define('site-nav', (nav) => {
    if (inResult(nav)) return;
    const at = here();
    const current = (path) => (at.rel === path ? 'page' : null);
    const item = ([path, title]) => el('li', null, el('a', { href: link(path, at), 'aria-current': current(path) }, title));
    const [home, ...docs] = PAGES;
    const list = el('ul', { class: 'docs-nav-list', id: 'docs-nav-list' }, ...docs.map(item));
    if (EXAMPLES.length) {
      list.append(el('li', { class: 'docs-nav-group' }, el('span', { class: 'docs-nav-heading', id: 'docs-nav-examples' }, 'Examples'), el('ul', { 'aria-labelledby': 'docs-nav-examples' }, ...EXAMPLES.map(item))));
    }
    const toggle = el('button', { type: 'button', class: 'docs-nav-toggle', 'aria-expanded': 'false', 'aria-controls': 'docs-nav-list' }, 'Menu');
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('docs-nav-open', open);
    });
    const bar = el('div', { class: 'docs-nav-bar' }, el('a', { class: 'docs-nav-home', href: link(home[0], at), 'aria-current': current(home[0]) }, home[1]), toggle);
    nav.setAttribute('aria-label', nav.getAttribute('aria-label') || 'Site');
    nav.replaceChildren(bar, list);
  });

  // ---------------------------------------------------------------- code

  let examples = 0;

  T.define('code', (node) => {
    if (inResult(node)) return;
    const code = node.querySelector('code.language-tern');
    if (!code) return;
    if (node.classList.contains('live')) live(node, code, ++examples);
    else highlightTern(code);
  });

  // A live example: the fence, then what the engine makes of it. Nothing it
  // contains can break the page: a failure is shown in its place.
  function live(node, code, n) {
    const source = code.textContent + '\n'; // a note ends with a line break, as in the corpus
    const attr = (k) => node.getAttribute(k); // the fence's {expect=… schema=… head=…}, as the emitter writes them
    const expect = (attr('expect') || '').split(/\s+/).filter(Boolean);
    const schemaName = attr('schema') || 'none';
    const head = attr('head');
    const id = `docs-ex${n}`;

    const box = el('div', { class: 'docs-live', id, 'data-example': String(n) });
    node.replaceWith(box);
    box.append(part(id, 'source', 'Source', 'docs-live-source', node));
    try {
      const schema = Object.prototype.hasOwnProperty.call(window.ternDocs.schemas, schemaName) ? window.ternDocs.schemas[schemaName] : null;
      if (!schema) throw new Error(`schema="${schemaName}" is not a schema docs.js knows (none, demo)`);
      const opts = { schema, positions: false };
      if (head != null) opts.head = head;
      const html = T.toHTML(source, opts);
      const diagnostics = T.check(source, opts);

      // The result is the same HTML with positions (data-pos), so that a
      // formula KaTeX rejects is placed in the example. Its math is hidden
      // from the runtime and typeset here, with the example's own macros.
      const out = el('div', { class: 'docs-live-out' });
      const tpl = document.createElement('template');
      tpl.innerHTML = T.toHTML(source, { ...opts, positions: true });
      neutralise(tpl.content, `ex${n}-`);
      const math = isolateMath(tpl.content);
      out.append(tpl.content);
      box.append(part(id, 'result', 'Result', 'docs-live-result', out));

      for (const d of diagnostics) addDiagnostic(box, d);
      const got = diagnostics.map((d) => d.code).sort();
      const want = expect.slice().sort();
      if (got.join(' ') !== want.join(' ')) {
        const say = (l) => (l.length ? l.join(' ') : 'none');
        box.classList.add('docs-live-mismatch');
        box.append(el('p', { class: 'docs-live-problem', role: 'alert' }, `This example's diagnostics are ${say(got)}; its expect lists ${say(want)}.`));
        console.warn(`docs.js: example ${n} (${id}): diagnostics ${say(got)}, expected ${say(want)}`);
      }

      const pre = el('pre', { class: 'docs-live-html' }, el('code', { class: 'language-html' }, highlightHTML(pretty(html))));
      box.append(el('details', { class: 'docs-live-part docs-live-markup' }, el('summary', { class: 'docs-live-label' }, 'HTML'), pre));
      queueMath(box, out, math);
    } catch (e) {
      box.classList.add('docs-live-failed');
      box.append(el('p', { class: 'docs-live-problem docs-live-error', role: 'alert' }, `This example could not be rendered: ${(e && e.message) || e}`));
      console.warn(`docs.js: example ${n} (${id}) failed`, e);
    }
    try {
      highlightTern(code);
    } catch {}
  }

  // A labelled part of an example's widget.
  const part = (id, key, text, cls, ...kids) =>
    el('div', { class: `docs-live-part ${cls}`, role: 'group', 'aria-labelledby': `${id}-${key}` }, el('div', { class: 'docs-live-label', id: `${id}-${key}` }, text), ...kids);

  // Adds a diagnostic to an example's Diagnostics part, made after its
  // result when it is the first: severity, position in the example, its code
  // linking to the Diagnostics page, the message and the hint.
  function addDiagnostic(box, d) {
    let list = box.querySelector(':scope > .docs-live-diagnostics > .docs-diags');
    if (!list) {
      list = el('ul', { class: 'docs-diags' });
      const p = part(box.id, 'diagnostics', 'Diagnostics', 'docs-live-diagnostics', list);
      const result = box.querySelector(':scope > .docs-live-result');
      if (result) result.after(p);
      else box.append(p);
    }
    const p = d.position && d.position.start;
    list.append(
      el(
        'li',
        { class: `docs-diag docs-diag-${d.severity}`, 'data-code': d.code },
        el('span', { class: 'docs-sev' }, d.severity),
        ' ',
        el('span', { class: 'docs-pos', title: 'line:column in the example' }, p ? `${p.line}:${p.column}` : '—'),
        ' ',
        el('a', { class: 'docs-code', href: link(`docs/diagnostics.html#${d.code.replace(/\./g, '-')}`) }, el('code', null, d.code)),
        ' ',
        el('span', { class: 'docs-msg' }, codeText(d.message)),
        d.hint ? el('span', { class: 'docs-hint' }, codeText(d.hint)) : null,
      ),
    );
    list.parentElement.querySelector('.docs-live-label').textContent = `Diagnostics (${list.children.length})`;
  }

  // A message's `code` parts as <code>, built from text nodes.
  function codeText(s) {
    const frag = document.createDocumentFragment();
    String(s)
      .split(/(`[^`]+`)/)
      .forEach((part) => part && frag.append(/^`[^`]+`$/.test(part) ? el('code', null, part.slice(1, -1)) : part));
    return frag;
  }

  // ---------------------------------------------------------------- the result

  const ID_LISTS = ['for', 'headers', 'list', 'form', 'popovertarget', 'commandfor', 'anchor', 'itemref', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto'];
  const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster'];

  // Makes a result safe to show inside the page:
  //   - ids get the example's prefix, and what points at them follows
  //     (fragment links, label for=, aria-*, headers, SVG url(#…)), so an
  //     example never clashes with the page or another example;
  //   - scripts are shown, never run: each <script> becomes its source, on*
  //     handlers and javascript: URLs are dropped, an iframe is sandboxed,
  //     and <base>, <meta http-equiv> and autofocus, which would reach the
  //     page, are dropped too;
  //   - a <style> is scoped to the result (@scope), so it styles only it.
  function neutralise(root, prefix) {
    const ids = new Set();
    for (const e of root.querySelectorAll('[id]')) {
      ids.add(e.id);
      e.id = prefix + e.id;
    }
    const fix = (v) => (ids.has(v) ? prefix + v : v);
    for (const s of root.querySelectorAll('script')) {
      const shown = el('pre', { class: 'docs-live-script' }, el('span', { class: 'docs-live-note' }, 'A script, shown here but not run:'), '\n', s.outerHTML);
      s.replaceWith(shown);
    }
    for (const e of root.querySelectorAll('base, meta[http-equiv]')) e.remove();
    for (const f of root.querySelectorAll('iframe')) f.setAttribute('sandbox', '');
    for (const s of root.querySelectorAll('style')) s.textContent = `@scope {\n${s.textContent}\n}`;
    for (const e of root.querySelectorAll('*')) {
      for (const a of [...e.attributes]) {
        const name = a.name.toLowerCase();
        if (name.startsWith('on') || name === 'autofocus') {
          e.removeAttribute(a.name);
          continue;
        }
        let v = a.value;
        if (URL_ATTRS.includes(name) && /^\s*(?:javascript|vbscript|data:text\/html)/i.test(v)) {
          e.removeAttribute(a.name);
          continue;
        }
        if ((name === 'href' || name === 'xlink:href') && v.startsWith('#') && v.length > 1) {
          let frag = v.slice(1);
          try {
            frag = decodeURIComponent(frag);
          } catch {}
          v = `#${prefix}${frag}`;
        } else if (ID_LISTS.includes(name)) v = v.split(/\s+/).filter(Boolean).map(fix).join(' ');
        if (v.includes('url(#')) v = v.replace(/url\(#([^)\s]+)\)/g, (m, x) => `url(#${fix(x)})`);
        if (v !== a.value) e.setAttribute(a.name, v);
      }
    }
  }

  // ---------------------------------------------------------------- example math

  // An example is a note of its own, so its math must not reach the page's:
  // the runtime typesets every .t-math and reads every .t-macros under the
  // root after the behaviours ran, into one macro table, and reports what
  // KaTeX rejects as the page's diagnostics. So the result's formulas become
  // .docs-math and its :::macros .docs-macros before they are inserted (the
  // runtime never sees them: behaviours run before its math pass), and docs.js
  // typesets them itself once window.katex is there, example by example:
  //   - each example's macro table is its own :::macros bodies, in order;
  //   - a formula keeps the runtime's look, and once typeset it is a .t-math
  //     again with its data-tex: the runtime skips a typeset formula, and its
  //     copy handler copies it as $tex$;
  //   - one KaTeX rejects keeps its TeX with t-error, as the runtime shows
  //     it, and is a math.error in the example's Diagnostics, never the page's;
  //   - without KaTeX (data-katex="none", offline, quirks), the TeX stays.
  function isolateMath(root) {
    const macros = [...root.querySelectorAll('.t-macros')];
    const formulas = [...root.querySelectorAll('.t-math')];
    for (const m of macros) m.classList.replace('t-macros', 'docs-macros');
    for (const f of formulas) {
      if (!f.hasAttribute('data-tex')) f.setAttribute('data-tex', f.textContent);
      f.classList.replace('t-math', 'docs-math');
    }
    return { macros, formulas };
  }

  const jobs = []; // examples waiting for their math: {box, out, macros, formulas, table, started}
  let pumping = false;
  let K = null;

  function queueMath(box, out, { macros, formulas }) {
    if (!macros.length && !formulas.length) return;
    jobs.push({ box, out, macros, formulas, table: {}, started: false });
    if (pumping) return;
    pumping = true;
    katexReady().then((k) => {
      K = k;
      if (k) pump();
      else (jobs.length = 0), (pumping = false); // no KaTeX: the TeX stays
    });
  }

  // window.katex, which the runtime loads (it requests KaTeX at capture, math
  // or not), or null when it will not come.
  let waiting = null;
  function katexReady() {
    if (waiting) return waiting;
    const t0 = Date.now();
    return (waiting = new Promise((resolve) => {
      (function poll() {
        if (window.katex && typeof window.katex.render === 'function') return resolve(window.katex);
        const k = T.config && T.config.katex;
        const none = (k && k.base === 'none') || document.compatMode === 'BackCompat';
        const failed = (T.diagnostics || []).some((d) => d.code === 'katex.unavailable');
        if (none || failed || Date.now() - t0 > 30000) return resolve(null);
        setTimeout(poll, 50);
      })();
    }));
  }

  // In slices of about 8 ms, one per frame (at once while the page is hidden).
  function pump(budget = 8) {
    const end = performance.now() + budget;
    do {
      const job = jobs[0];
      if (!job.started) {
        job.started = true;
        for (const m of job.macros) defineMacros(job, m);
      }
      if (job.formulas.length) typesetFormula(job, job.formulas.shift());
      if (!job.formulas.length) jobs.shift();
    } while (jobs.length && performance.now() < end);
    if (!jobs.length) return void (pumping = false);
    if (document.hidden) setTimeout(() => pump(), 0);
    else requestAnimationFrame(() => setTimeout(() => pump(), 0));
  }
  // Printing takes the layout right away: everything pending first.
  window.addEventListener('beforeprint', () => {
    if (K && jobs.length) pump(Infinity);
  });

  // An example's position of an element: its data-pos, within the result.
  function where(job, e) {
    const at = e.closest('[data-pos]');
    const m = at && job.out.contains(at) && /^(\d+):(\d+)$/.exec(at.getAttribute('data-pos'));
    if (!m) return null;
    const p = { line: Number(m[1]), column: Number(m[2]) };
    return { start: p, end: p };
  }

  function defineMacros(job, m) {
    try {
      K.renderToString(m.textContent, { macros: job.table, globalGroup: true, throwOnError: true, displayMode: false });
    } catch (e) {
      addDiagnostic(job.box, { code: 'math.error', severity: 'error', message: `the :::macros block does not parse: ${e.message}`, hint: 'fix the TeX of the definitions', position: where(job, m) });
    }
  }

  function typesetFormula(job, f) {
    if (!f.isConnected) return;
    const span = document.createElement('span');
    try {
      K.render(f.getAttribute('data-tex') || '', span, { macros: job.table, throwOnError: true, displayMode: f.hasAttribute('data-display') });
    } catch (e) {
      f.classList.add('t-error');
      f.title = e.message;
      addDiagnostic(job.box, { code: 'math.error', severity: 'error', message: `KaTeX cannot typeset this formula: ${e.message}`, hint: 'the formula is shown as written; fix its TeX', position: where(job, f) });
      return;
    }
    f.replaceChildren(...span.childNodes);
    f.classList.replace('docs-math', 't-math');
  }

  // ---------------------------------------------------------------- HTML

  // The emitter's HTML, lightly pretty-printed for reading: block elements
  // on their own lines, indented by nesting; inline content and everything
  // inside <pre>, <script>, <style> and <textarea> exactly as emitted.
  const BLOCK = new Set('address article aside blockquote caption details dialog div dl dd dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr legend li main menu nav ol p section search summary table tbody tfoot thead tr ul'.split(' '));
  const VOIDBLOCK = new Set(['hr']);
  const VERBATIM = /^(?:pre|script|style|textarea|xmp)$/;
  function pretty(html) {
    const out = [];
    const stack = [];
    let line = '';
    const indent = () => '  '.repeat(stack.length);
    const flush = () => {
      if (line.trim()) out.push(line.replace(/\s+$/, ''));
      line = '';
    };
    const child = () => {
      if (stack.length) stack[stack.length - 1].blocks = true;
    };
    const re = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|[^<]+|</g;
    for (let m; (m = re.exec(html)); ) {
      const tok = m[0];
      const name = m[2] ? m[2].toLowerCase() : '';
      if (name && !m[1] && VERBATIM.test(name)) {
        const end = html.toLowerCase().indexOf(`</${name}`, re.lastIndex);
        const close = end < 0 ? html.length : html.indexOf('>', end) + 1 || html.length;
        flush();
        child();
        out.push(indent() + html.slice(m.index, close));
        re.lastIndex = close;
        continue;
      }
      if (name && BLOCK.has(name)) {
        if (!m[1]) {
          flush();
          child();
          line = indent() + tok;
          if (!VOIDBLOCK.has(name)) stack.push({ name, blocks: false });
          else flush();
        } else {
          const top = stack.pop();
          if (top && top.blocks) {
            flush();
            line = indent() + tok;
          } else line += tok;
          flush();
        }
        continue;
      }
      if (!line.trim()) {
        if (!tok.trim()) continue;
        line = indent() + tok.replace(/^\s+/, '');
      } else line += tok;
    }
    flush();
    return out.join('\n');
  }

  // Highlighting, always built from text nodes: the source never goes
  // through innerHTML.
  function spans(text, re, classes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      if (m.index > last) frag.append(text.slice(last, m.index));
      let k = 1;
      while (k < m.length && m[k] === undefined) k++;
      const cls = classes[k - 1];
      frag.append(cls ? el('span', { class: cls }, m[0]) : m[0]);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  const TAG = /(<!--[\s\S]*?(?:-->|$))|(<\/?[a-zA-Z][^<>]*>)/g;
  const IN_TAG = /(^<\/?[a-zA-Z][a-zA-Z0-9-]*|\/?>$)|(\s[^\s=<>"']+)(?==)|(=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))/g;
  function highlightHTML(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(TAG)) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      if (m[1]) frag.append(el('span', { class: 'tk-comment' }, m[1]));
      else frag.append(el('span', { class: 'tk-tag' }, spans(m[2], IN_TAG, ['tk-name', 'tk-key', 'tk-value'])));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  // Tern: block markers at line starts, names, attributes, math, code,
  // emphasis, references, raw HTML tags. Light by design: a fence's body and
  // a $$ block are one colour each; everything else is a line-local guess.
  const NAME = '[\\p{L}][\\p{L}\\p{M}\\p{N}_-]*';
  const INLINE = new RegExp(
    [
      '(\\\\[\\s\\S])', // an escape
      '(`+)[\\s\\S]*?\\2', // a code span
      '(\\$\\$.+?\\$\\$|\\$(?![\\s$])(?:[^$\\\\]|\\\\.)*?[^\\s\\\\]\\$|\\$[^\\s$]\\$)', // math
      '(\\{[^{}\\n]*\\})', // attributes
      '(<!--.*?-->|</?[a-zA-Z][^<>\\n]*>)', // raw HTML
      '(\\*\\*(?=\\S).*?\\S\\*\\*|\\*(?=[^\\s*]).*?[^\\s*]\\*|==(?=\\S).*?\\S==|~~(?=\\S).*?\\S~~)', // emphasis, mark, delete
      '((?<![\\p{L}\\p{N}_])@[\\p{L}\\p{N}_](?:[\\p{L}\\p{M}\\p{N}_:.-]*[\\p{L}\\p{M}\\p{N}_])?)', // a reference
      `((?<![\\p{L}\\p{N}_:/]):${NAME}(?=[\\[{]))`, // an inline element's name
      '(\\[\\^[^\\]\\n]+\\])', // a footnote reference
    ].join('|'),
    'gu',
  );
  const INLINE_CLASSES = ['tk-esc', 'tk-code', 'tk-math', 'tk-attr', 'tk-html', 'tk-em', 'tk-ref', 'tk-name', 'tk-ref'];
  const inline = (s) => spans(s, INLINE, INLINE_CLASSES);
  const mark = (s, cls = 'tk-mark') => (s ? el('span', { class: cls }, s) : '');

  function ternLine(line, frag) {
    let m;
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return frag.append(mark(line));
    // Prefixes: quote markers and list markers, then the line's own construct.
    while ((m = /^(\s*>\s?|\s*(?:[-*+]|\d{1,9}[.)])(?=\s)\s+(?:\[[ xX]\]\s)?)/.exec(line)) && m[0].trim()) {
      frag.append(mark(m[0]));
      line = line.slice(m[0].length);
    }
    if ((m = /^(\s{0,3})(#{1,6})(\s.*|)$/.exec(line))) return frag.append(m[1], mark(m[2]), inline(m[3]));
    if ((m = new RegExp(`^(\\s*)(:{3,})(\\/?${NAME})?(.*)$`, 'u').exec(line))) return frag.append(m[1], mark(m[2]), mark(m[3], 'tk-name'), inline(m[4]));
    if ((m = new RegExp(`^(\\s*)(::)(${NAME})(.*)$`, 'u').exec(line))) return frag.append(m[1], mark(m[2]), mark(m[3], 'tk-name'), inline(m[4]));
    if ((m = /^(\s*)(\+\+\+)(.*)$/.exec(line))) return frag.append(m[1], mark(m[2]), inline(m[3]));
    if (/^\s*\{.*\}\s*$/.test(line)) return frag.append(mark(line, 'tk-attr'));
    if ((m = /^(\s*\[\^[^\]\n]+\]:)(.*)$/.exec(line))) return frag.append(mark(m[1], 'tk-ref'), inline(m[2]));
    if (/^\s*\|/.test(line)) return frag.append(...line.split(/(\|)/).map((s) => (s === '|' ? mark(s) : inline(s))));
    frag.append(inline(line));
  }

  function highlightTern(code) {
    if (code.querySelector('*')) return; // already marked up (line numbers, highlighting)
    const lines = code.textContent.split('\n');
    const frag = document.createDocumentFragment();
    let fence = null; // the closing fence's character and length
    let math = false;
    lines.forEach((line, i) => {
      if (i) frag.append('\n');
      let m;
      if (fence) {
        if ((m = /^\s*(`{3,}|~{3,})\s*$/.exec(line)) && m[1][0] === fence[0] && m[1].length >= fence.length) {
          fence = null;
          return frag.append(mark(line));
        }
        return frag.append(mark(line, 'tk-code'));
      }
      if (math) {
        if (line.includes('$$')) {
          math = false;
          const at = line.indexOf('$$') + 2;
          return frag.append(mark(line.slice(0, at), 'tk-math'), inline(line.slice(at)));
        }
        return frag.append(mark(line, 'tk-math'));
      }
      if ((m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line)) && !(m[2][0] === '`' && m[3].includes('`'))) {
        fence = m[2];
        return frag.append(m[1], mark(m[2]), spans(m[3], /(\[[^\]]*\])|(\{[^{}]*\})/g, [null, 'tk-attr']));
      }
      if ((m = /^(\s*)(\$\$)(.*)$/.exec(line))) {
        if (!m[3].includes('$$')) math = true;
        return frag.append(m[1], mark(m[2] + m[3], 'tk-math'));
      }
      ternLine(line, frag);
    });
    code.replaceChildren(frag);
    code.classList.add('docs-tern');
  }
})();
