// SPDX-License-Identifier: MIT
// HTML normalisation for comparing expected and actual output, in the spirit
// of CommonMark's normalize.py: formatting differences that do not change the
// rendered page or the DOM contract are ignored, everything else is compared.
//
// Ignored: whitespace next to block-level tags and <br>; runs of ASCII
// whitespace in text (collapsed to one space) outside <pre>, <code>,
// <textarea>, <script> and <style>; U+00A0 is not whitespace here;
// attribute order (sorted, `class` keeps its token order); attribute quoting;
// `a=""` vs bare `a`; `<br/>` vs `<br>`; `&quot;` `&#39;` `&gt;` vs the
// literal character in text and values; the case of tag and attribute names;
// `data-pos` (positions are asserted in the AST, not in HTML); one newline
// right after <pre> or right before </code>/</pre> (both spellings of a code
// block are common and render the same).
// Compared exactly: tag names, attribute values, class token order, text,
// `&lt;` and `&amp;`, comments, and everything inside raw-text elements.
'use strict';

const BLOCK = new Set(
  ('address article aside blockquote body caption col colgroup dd details dialog div dl dt fieldset ' +
    'figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html legend li link main ' +
    'menu meta nav ol optgroup option p pre search section summary table tbody td tfoot th thead title tr ul')
    .split(' '),
);
const TRIM = new Set([...BLOCK, 'br']);
const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));
const RAWTEXT = new Set(['script', 'style', 'textarea', 'title']);

function decodeSoft(s) {
  return s.replace(/&quot;|&#0*34;|&#x0*22;|&#0*39;|&#x0*27;|&apos;|&gt;|&#0*62;|&#x0*3e;/gi, (e) => {
    const l = e.toLowerCase();
    if (l === '&gt;' || /^&#0*62;$/.test(l) || /^&#x0*3e;$/.test(l)) return '>';
    if (l === '&quot;' || /^&#0*34;$/.test(l) || /^&#x0*22;$/.test(l)) return '"';
    return "'";
  });
}

function tokenize(html) {
  const out = [];
  let i = 0;
  const n = html.length;
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  while (i < n) {
    const c = html[i];
    if (c === '<' && html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const stop = end < 0 ? n : end + 3;
      flush();
      out.push({ t: 'comment', v: html.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === '<' && /[A-Za-z/!?]/.test(html[i + 1] || '')) {
      const tag = readTag(html, i);
      if (tag) {
        flush();
        out.push(tag.tok);
        i = tag.end;
        if (tag.tok.t === 'open' && RAWTEXT.has(tag.tok.name)) {
          const re = new RegExp('</' + tag.tok.name + '\\s*>', 'ig');
          re.lastIndex = i;
          const m = re.exec(html);
          const stop = m ? m.index : n;
          if (stop > i) out.push({ t: 'raw', v: html.slice(i, stop) });
          i = stop;
        }
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

function readTag(html, start) {
  const closing = html[start + 1] === '/';
  let i = start + (closing ? 2 : 1);
  const m = /^[A-Za-z][A-Za-z0-9-]*/.exec(html.slice(i, i + 64));
  if (!m) {
    if (html[start + 1] === '!' || html[start + 1] === '?') {
      const end = html.indexOf('>', start);
      if (end < 0) return null;
      return { tok: { t: 'decl', v: html.slice(start, end + 1) }, end: end + 1 };
    }
    return null;
  }
  const name = m[0].toLowerCase();
  i += m[0].length;
  if (closing) {
    const end = html.indexOf('>', i);
    if (end < 0 || /\S/.test(html.slice(i, end))) return null;
    return { tok: { t: 'close', name }, end: end + 1 };
  }
  const attrs = [];
  for (;;) {
    const ws = /^\s*/.exec(html.slice(i))[0];
    i += ws.length;
    if (i >= html.length) return null;
    if (html[i] === '>') return { tok: { t: 'open', name, attrs }, end: i + 1 };
    if (html.startsWith('/>', i)) return { tok: { t: 'open', name, attrs, selfClosed: true }, end: i + 2 };
    const an = /^[^\s"'>\/=]+/.exec(html.slice(i));
    if (!an || (!ws && attrs.length)) return null;
    i += an[0].length;
    let value = null;
    const eq = /^\s*=\s*/.exec(html.slice(i));
    if (eq) {
      i += eq[0].length;
      const q = html[i];
      if (q === '"' || q === "'") {
        const end = html.indexOf(q, i + 1);
        if (end < 0) return null;
        value = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const uv = /^[^\s>]+/.exec(html.slice(i));
        if (!uv) return null;
        value = uv[0];
        i += uv[0].length;
      }
    }
    attrs.push([an[0].toLowerCase(), value]);
  }
}

function serializeOpen(tok) {
  const attrs = tok.attrs
    .filter(([k]) => k !== 'data-pos')
    .map(([k, v]) => {
      if (v === null || v === '') return k;
      let val = decodeSoft(v);
      if (k === 'class') val = val.trim().split(/\s+/).join(' ');
      return `${k}="${val.replace(/"/g, '&quot;')}"`;
    })
    .sort((a, b) => {
      const ka = a.split('=')[0];
      const kb = b.split('=')[0];
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return '<' + tok.name + (attrs.length ? ' ' + attrs.join(' ') : '') + '>';
}

function normalize(html) {
  const toks = tokenize(String(html).replace(/\r\n?/g, '\n'));
  const parts = [];
  let pre = 0;
  let code = 0;
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.t === 'open') {
      parts.push({ s: serializeOpen(tok), block: TRIM.has(tok.name), name: tok.name, open: true });
      if (tok.name === 'pre' && !tok.selfClosed) pre++;
      if (tok.name === 'code' && !tok.selfClosed) code++;
    } else if (tok.t === 'close') {
      if (tok.name === 'pre' && pre > 0) pre--;
      if (tok.name === 'code' && code > 0) code--;
      if (VOID.has(tok.name)) continue;
      parts.push({ s: '</' + tok.name + '>', block: TRIM.has(tok.name), name: tok.name });
    } else if (tok.t === 'text') {
      let v = decodeSoft(tok.v);
      if (!pre && !code) v = v.replace(/[ \t\n\r\f]+/g, ' ');
      parts.push({ s: v, text: true, pre: pre > 0 || code > 0, inPre: pre > 0 });
    } else {
      parts.push({ s: tok.v });
    }
  }
  // Drop whitespace that touches a block-level tag (outside <pre>), and the
  // optional newline at either end of a code block.
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p.text && p.pre) {
      const prev = parts[k - 1];
      const next = parts[k + 1];
      if (p.inPre && prev && prev.open && prev.name === 'pre') p.s = p.s.replace(/^\n/, '');
      if (p.inPre && next && !next.open && (next.name === 'code' || next.name === 'pre')) p.s = p.s.replace(/\n$/, '');
      continue;
    }
    if (!p.text) continue;
    if (k === 0 || (parts[k - 1] && parts[k - 1].block)) p.s = p.s.replace(/^ /, '');
    if (k === parts.length - 1 || (parts[k + 1] && parts[k + 1].block)) p.s = p.s.replace(/ $/, '');
  }
  return parts
    .map((p) => p.s)
    .join('')
    .trim();
}

// Where two normalised strings first differ, for failure messages.
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

module.exports = { normalize, firstDifference, tokenize };
