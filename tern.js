/* tern — notes written as a markdown superset inside a plain .html file.
 *
 * Usage: make this the first line of the note, then just write:
 *
 *   <script src="tern.js"></script>
 *
 * Loaded synchronously, the script writes a <plaintext> tag into the stream.
 * That switches the HTML tokenizer into PLAINTEXT state, which has no exit:
 * everything after the script tag arrives as one untouched text node, so
 * `a < b`, `&`, and `<tags>` survive verbatim. On DOMContentLoaded the source
 * is parsed to HTML and the document is rewritten with the result.
 *
 * Script attributes:
 *   data-raw     show the captured source instead of rendering it
 *   data-katex   base URL of a KaTeX dist folder (default: jsDelivr CDN)
 */
(function () {
  'use strict';

  /* ===================================================================== *
   *  Parser: source text -> HTML string (no DOM needed, runs under node)  *
   * ===================================================================== */

  // name -> [label, counter group | null, kind]
  var ENVS = {
    theorem: ['Theorem', 'theorem', 'env'],
    lemma: ['Lemma', 'theorem', 'env'],
    proposition: ['Proposition', 'theorem', 'env'],
    corollary: ['Corollary', 'theorem', 'env'],
    definition: ['Definition', 'definition', 'env'],
    example: ['Example', 'example', 'env'],
    exercise: ['Exercise', 'exercise', 'env'],
    remark: ['Remark', null, 'env'],
    proof: ['Proof', null, 'env'],
    note: ['Note', null, 'callout'],
    info: ['Info', null, 'callout'],
    tip: ['Tip', null, 'callout'],
    important: ['Important', null, 'callout'],
    warning: ['Warning', null, 'callout']
  };

  // Inline directives that map straight onto a native tag.
  var INLINE_TAGS = { kbd: 'kbd', sub: 'sub', sup: 'sup', hl: 'mark' };

  var BLOCK_TAGS = {};
  ('address article aside audio blockquote body canvas center dd details dialog dir div dl dt ' +
    'fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html iframe legend li ' +
    'link main menu nav noscript ol p pre script section style summary svg table tbody td template ' +
    'textarea tfoot th thead title tr ul video').split(' ').forEach(function (t) { BLOCK_TAGS[t] = 1; });
  var RAW_TAGS = { script: 1, style: 1, pre: 1, textarea: 1 };

  var FENCE = /^(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
  var HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  var HR = /^([-*_])(?:\s*\1){2,}\s*$/;
  var LIST = /^(?:([-*+])|(\d{1,9})([.)]))(?:(\s+)(.*)|\s*)$/;
  var TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
  var CONTAINER = /^(:{3,})\s*([a-zA-Z][\w-]*)(.*)$/;
  var CONTAINER_END = /^(:{3,})\s*$/;
  var LEAF = /^::([a-zA-Z][\w-]*)(.*)$/;
  var QUESTION = /^\?\?\s+(.*)$/;
  var HTML_START = /^<(?:!--|\/?([a-zA-Z][\w-]*)(?=[\s/>]|$))/;
  var MATH_ONE_LINE = /^\$\$(.+?)\$\$\s*(?:#([\w:-]+))?\s*$/;
  var MATH_CLOSE = /^(.*?)\$\$\s*(?:#([\w:-]+))?\s*$/;

  var AUTOLINK = /<(https?:\/\/[^\s<>]+)>/y;
  var INLINE_HTML = /<!--[\s\S]*?-->|<\/?[a-zA-Z][\w:-]*(?:\s+[^<>]*)?\/?>/y;
  var ENTITY = /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]\w*);/y;
  var DIRECTIVE = /:([a-zA-Z][\w-]*)\[/y;
  var REF = /@([A-Za-z][\w-]*(?::[\w-]+)*)/y;
  var HARD_BREAK = / {2,}\n/y;
  var PUNCT = /[!-\/:-@\[-`{-~]/;
  var ALNUM = /[A-Za-z0-9]/;

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function at(re, s, i) {
    re.lastIndex = i;
    return re.exec(s);
  }

  function indentOf(line) {
    var w = 0;
    for (var i = 0; i < line.length; i++) {
      if (line[i] === ' ') w++;
      else if (line[i] === '\t') w += 4;
      else break;
    }
    return w;
  }

  // Remove up to `cols` columns of leading whitespace.
  function unindent(line, cols) {
    var i = 0, w = 0;
    while (i < line.length && w < cols) {
      if (line[i] === ' ') w++;
      else if (line[i] === '\t') w += 4;
      else break;
      i++;
    }
    return line.slice(i);
  }

  function parseAttrs(s) {
    var a = { id: '', classes: [], kv: {} }, m;
    s = s.trim();
    if (s[0] === '{' && s[s.length - 1] === '}') s = s.slice(1, -1);
    var re = /#([\w:-]+)|\.([\w-]+)|([a-zA-Z_][\w-]*)(?:=(?:"([^"]*)"|(\S+)))?/g;
    while ((m = re.exec(s))) {
      if (m[1]) a.id = m[1];
      else if (m[2]) a.classes.push(m[2]);
      else a.kv[m[3]] = m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
    }
    return a;
  }

  function attrString(a, classes) {
    var cls = classes.concat(a.classes).join(' '), out = '';
    if (a.id) out += ' id="' + esc(a.id) + '"';
    if (cls) out += ' class="' + esc(cls) + '"';
    for (var k in a.kv) out += ' ' + k + '="' + esc(a.kv[k]) + '"';
    return out;
  }

  function mathHTML(tex, display) {
    return '<span class="t-math"' + (display ? ' data-display' : '') + '>' + esc(tex) + '</span>';
  }

  /* ---- inline ---------------------------------------------------------- */

  function codeSpan(s, i) {
    var k = i;
    while (s[k] === '`') k++;
    var len = k - i, j = k;
    while ((j = s.indexOf('`', j)) >= 0) {
      var e = j;
      while (s[e] === '`') e++;
      if (e - j === len) return { text: s.slice(k, j), end: e };
      j = e;
    }
    return null;
  }

  function mathSpan(s, i) {
    var n = s.length, j;
    if (s[i + 1] === '$') {
      j = s.indexOf('$$', i + 2);
      return j > i + 2 ? { tex: s.slice(i + 2, j).trim(), display: true, end: j + 2 } : null;
    }
    if (i + 1 >= n || /\s/.test(s[i + 1])) return null;
    for (j = i + 1; j < n; j++) {
      if (s[j] === '\\') { j++; continue; }
      // Pandoc's rule: the closer follows a non-space and isn't followed by a digit ("$5 and $10").
      if (s[j] === '$' && !/\s/.test(s[j - 1]) && !/\d/.test(s[j + 1] || '')) {
        return { tex: s.slice(i + 1, j), display: false, end: j + 1 };
      }
    }
    return null;
  }

  // End index of the code/math span starting at i, or -1.
  function atomEnd(s, i) {
    var a = s[i] === '`' ? codeSpan(s, i) : mathSpan(s, i);
    return a ? a.end : -1;
  }

  function matchBracket(s, i, open, close) {
    var depth = 0, n = s.length, e;
    for (; i < n; i++) {
      var c = s[i];
      if (c === '\\') i++;
      else if ((c === '`' || c === '$') && (e = atomEnd(s, i)) > 0) i = e - 1;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) return i;
    }
    return -1;
  }

  function canOpen(s, i, c, len) {
    var next = s[i + len];
    if (!next || /\s/.test(next)) return false;
    return c !== '_' || i === 0 || !ALNUM.test(s[i - 1]);
  }

  function canClose(s, i, c, len) {
    if (i === 0 || /\s/.test(s[i - 1])) return false;
    return c !== '_' || !ALNUM.test(s[i + len] || '');
  }

  // Index of the delimiter `d` ("*", "**", "_", "__") closing a span whose content starts at i.
  function findCloser(s, i, d) {
    var c = d[0], len = d.length, n = s.length, e;
    while (i < n) {
      var ch = s[i];
      if (ch === '\\') { i += 2; continue; }
      if ((ch === '`' || ch === '$') && (e = atomEnd(s, i)) > 0) { i = e; continue; }
      if (ch === c) {
        var dbl = s[i + 1] === c;
        if (len === 2) {
          if (dbl && canClose(s, i, c, 2)) return i;
          if (dbl) { i += 2; continue; }
          if (canOpen(s, i, c, 1) && (e = findCloser(s, i + 1, c)) > i + 1) { i = e + 1; continue; }
        } else {
          if (dbl && canOpen(s, i, c, 2) && (e = findCloser(s, i + 2, c + c)) > i + 2) { i = e + 2; continue; }
          if (canClose(s, i, c, 1)) return i;
        }
      }
      i++;
    }
    return -1;
  }

  // Closer for the symmetric two-char delimiters (~~ and ==).
  function findPlain(s, i, d) {
    var n = s.length, e;
    while (i < n) {
      var ch = s[i];
      if (ch === '\\') { i += 2; continue; }
      if ((ch === '`' || ch === '$') && (e = atomEnd(s, i)) > 0) { i = e; continue; }
      if (s.startsWith(d, i) && !/\s/.test(s[i - 1])) return i;
      i++;
    }
    return -1;
  }

  function inlineDirective(name, content, attrs) {
    var tag = INLINE_TAGS[name] || 'span';
    return '<' + tag + attrString(attrs, [name]) + ' data-t="' + name + '">' + inline(content) + '</' + tag + '>';
  }

  function inline(s) {
    var out = '', i = 0, n = s.length, m, j, a;
    while (i < n) {
      var c = s[i];
      if (c === '\\' && i + 1 < n) {
        if (s[i + 1] === '\n') { out += '<br>\n'; i += 2; continue; }
        if (PUNCT.test(s[i + 1])) { out += esc(s[i + 1]); i += 2; continue; }
      } else if (c === '`') {
        if ((a = codeSpan(s, i))) { out += '<code>' + esc(a.text.trim()) + '</code>'; i = a.end; continue; }
      } else if (c === '$') {
        if ((a = mathSpan(s, i))) { out += mathHTML(a.tex, a.display); i = a.end; continue; }
      } else if (c === '*' || c === '_') {
        var dbl = s[i + 1] === c;
        if (canOpen(s, i, c, dbl ? 2 : 1)) {
          if (dbl && (j = findCloser(s, i + 2, c + c)) > i + 2) {
            out += '<strong>' + inline(s.slice(i + 2, j)) + '</strong>'; i = j + 2; continue;
          }
          if ((j = findCloser(s, i + 1, c)) > i + 1) {
            out += '<em>' + inline(s.slice(i + 1, j)) + '</em>'; i = j + 1; continue;
          }
        }
      } else if ((c === '~' || c === '=') && s[i + 1] === c && s[i + 2] && !/\s/.test(s[i + 2])) {
        if ((j = findPlain(s, i + 2, c + c)) > i + 2) {
          var tag = c === '~' ? 'del' : 'mark';
          out += '<' + tag + '>' + inline(s.slice(i + 2, j)) + '</' + tag + '>'; i = j + 2; continue;
        }
      } else if (c === '[' || (c === '!' && s[i + 1] === '[')) {
        var b = c === '!' ? i + 1 : i;
        j = matchBracket(s, b, '[', ']');
        if (j > 0 && s[j + 1] === '(') {
          var k = matchBracket(s, j + 1, '(', ')');
          if (k > 0) {
            var dest = /^\s*(\S*)(?:\s+"([^"]*)")?\s*$/.exec(s.slice(j + 2, k));
            if (dest) {
              var text = s.slice(b + 1, j), title = dest[2] ? ' title="' + esc(dest[2]) + '"' : '';
              out += c === '!'
                ? '<img src="' + esc(dest[1]) + '" alt="' + esc(text) + '"' + title + '>'
                : '<a href="' + esc(dest[1]) + '"' + title + '>' + inline(text) + '</a>';
              i = k + 1; continue;
            }
          }
        }
      } else if (c === ':' && (i === 0 || !/[\w:]/.test(s[i - 1]))) {
        if ((m = at(DIRECTIVE, s, i)) && (j = matchBracket(s, i + m[0].length - 1, '[', ']')) > 0) {
          var content = s.slice(i + m[0].length, j), attrs = '';
          i = j + 1;
          if (s[i] === '{' && (j = s.indexOf('}', i)) > 0) { attrs = s.slice(i, j + 1); i = j + 1; }
          out += inlineDirective(m[1], content, parseAttrs(attrs));
          continue;
        }
      } else if (c === '@' && (i === 0 || !ALNUM.test(s[i - 1]))) {
        if ((m = at(REF, s, i))) {
          out += '<a class="t-ref" href="#' + m[1] + '">@' + m[1] + '</a>'; i += m[0].length; continue;
        }
      } else if (c === '<') {
        if ((m = at(AUTOLINK, s, i))) {
          out += '<a href="' + esc(m[1]) + '">' + esc(m[1]) + '</a>'; i += m[0].length; continue;
        }
        if ((m = at(INLINE_HTML, s, i))) { out += m[0]; i += m[0].length; continue; }
      } else if (c === '&') {
        if ((m = at(ENTITY, s, i))) { out += m[0]; i += m[0].length; continue; }
      } else if (c === ' ') {
        if ((m = at(HARD_BREAK, s, i))) { out += '<br>\n'; i += m[0].length; continue; }
      }
      out += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c;
      i++;
    }
    return out;
  }

  /* ---- blocks ---------------------------------------------------------- */

  function isHtmlBlock(t) {
    var m = HTML_START.exec(t);
    return !!m && (!m[1] || BLOCK_TAGS[m[1].toLowerCase()] === 1 || m[1].indexOf('-') > 0);
  }

  // Can this (left-trimmed) line interrupt a paragraph?
  function isBlockStart(t) {
    return FENCE.test(t) || HEADING.test(t) || HR.test(t) || t[0] === '>' ||
      /^(?:[-*+]|1[.)])\s+\S/.test(t) || t.slice(0, 2) === '::' || t.slice(0, 2) === '$$' ||
      QUESTION.test(t) || isHtmlBlock(t);
  }

  function slugify(text, used) {
    var base = text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'section';
    var slug = base, k = 1;
    while (used[slug]) slug = base + '-' + (++k);
    used[slug] = 1;
    return slug;
  }

  function splitRow(line) {
    var cells = [], cur = '', code = false, math = false;
    line = line.trim();
    if (line[0] === '|') line = line.slice(1);
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '\\' && i + 1 < line.length) {
        cur += line[i + 1] === '|' && !math && !code ? '|' : c + line[i + 1];
        i++;
        continue;
      }
      if (c === '`' && !math) code = !code;
      else if (c === '$' && !code) math = !math;
      if (c === '|' && !code && !math) { cells.push(cur.trim()); cur = ''; } else cur += c;
    }
    if (cur.trim()) cells.push(cur.trim());
    return cells;
  }

  function table(lines) {
    var head = splitRow(lines[0]);
    var align = splitRow(lines[1]).map(function (d) {
      var l = d[0] === ':', r = d[d.length - 1] === ':';
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    function row(cells, tag) {
      var out = '<tr>';
      for (var i = 0; i < head.length; i++) {
        out += '<' + tag + (align[i] ? ' style="text-align:' + align[i] + '"' : '') + '>' +
          inline(cells[i] || '') + '</' + tag + '>';
      }
      return out + '</tr>';
    }
    var out = '<table>\n<thead>' + row(head, 'th') + '</thead>\n<tbody>\n';
    for (var i = 2; i < lines.length; i++) out += row(splitRow(lines[i]), 'td') + '\n';
    return out + '</tbody>\n</table>';
  }

  function container(name, rest, body, ctx) {
    var title = '', j;
    rest = rest.trim();
    if (rest[0] === '[' && (j = matchBracket(rest, 0, '[', ']')) > 0) {
      title = rest.slice(1, j);
      rest = rest.slice(j + 1);
    }
    var attrs = parseAttrs(rest);
    if (name === 'macros') return '<div class="t-macros" hidden>' + esc(body.join('\n')) + '</div>';
    if (name === 'details') {
      return '<details' + attrString(attrs, ['t-block', 'details']) + '><summary>' + inline(title || 'Details') +
        '</summary>\n' + blocks(body, false, ctx) + '\n</details>';
    }
    // Layout: `:::columns widths="2 1"` and `:::grid cols=3` set the column template.
    var cols = '';
    if (name === 'columns' && attrs.kv.widths) {
      cols = attrs.kv.widths.trim().split(/\s+/).map(function (w) {
        return /^[\d.]+$/.test(w) ? 'minmax(0,' + w + 'fr)' : w;
      }).join(' ');
      delete attrs.kv.widths;
    } else if (name === 'grid' && /^\d+$/.test(attrs.kv.cols || '')) {
      cols = 'repeat(' + attrs.kv.cols + ',minmax(0,1fr))';
      delete attrs.kv.cols;
    }
    if (cols) attrs.kv.style = '--t-cols:' + cols + ';' + (attrs.kv.style || '');
    var env = ENVS[name], head = '';
    var classes = ['t-block', name];
    if (env) {
      classes.push('t-' + env[2]);
      if (env[2] === 'callout' && title) head = '<span class="t-label">' + inline(title) + '</span>';
      else head = '<span class="t-label">' + env[0] + '</span>' + (title ? '<span class="t-title">' + inline(title) + '</span>' : '');
    } else if (title) {
      head = '<span class="t-label">' + inline(title) + '</span>';
    }
    return '<div' + attrString(attrs, classes) + ' data-t="' + name + '">\n' +
      (head ? '<div class="t-head">' + head + '</div>\n' : '') +
      blocks(body, false, ctx) + '\n</div>';
  }

  function list(lines, i, ctx) {
    var n = lines.length, items = [], loose = false, k;
    var first = LIST.exec(lines[i].trimStart()), ordered = !!first[2];
    while (i < n) {
      var raw = lines[i], t = raw.trimStart(), m = LIST.exec(t);
      if (!m || !!m[2] !== ordered || HR.test(t)) break;
      var base = indentOf(raw), markerW = m[1] ? 1 : m[2].length + 1;
      var spaces = m[4] && m[4].length <= 4 ? m[4].length : 1;
      var offset = base + markerW + spaces, thresh = base + Math.min(markerW + spaces, 2);
      var item = [m[5] || ''];
      i++;
      while (i < n) {
        var l = lines[i];
        if (!l.trim()) {
          k = i;
          while (k < n && !lines[k].trim()) k++;
          if (k < n && indentOf(lines[k]) >= thresh) {
            for (; i < k; i++) item.push('');
            loose = true;
            continue;
          }
          break;
        }
        if (indentOf(l) >= thresh) { item.push(unindent(l, offset)); i++; continue; }
        var lt = l.trimStart();
        if (item[item.length - 1].trim() && !isBlockStart(lt) && !LIST.test(lt)) { item.push(lt); i++; continue; }
        break;
      }
      items.push(item);
      k = i;
      while (k < n && !lines[k].trim()) k++;
      if (k > i) {
        var next = k < n && LIST.exec(lines[k].trimStart());
        if (!next || !!next[2] !== ordered) break;
        loose = true;
        i = k;
      }
    }
    var tag = ordered ? 'ol' : 'ul';
    var out = '<' + tag + (ordered && first[2] !== '1' ? ' start="' + first[2] + '"' : '') + '>\n';
    items.forEach(function (item) {
      var task = /^\[([ xX])\]\s+/.exec(item[0]);
      if (task) item[0] = item[0].slice(task[0].length);
      out += (task ? '<li class="t-task"><input type="checkbox"' + (task[1] !== ' ' ? ' checked' : '') + '> ' : '<li>') +
        blocks(item, !loose, ctx) + '</li>\n';
    });
    return { html: out + '</' + tag + '>', next: i };
  }

  function blocks(lines, tight, ctx) {
    var out = [], i = 0, n = lines.length, m, j, body;
    while (i < n) {
      var raw = lines[i], line = raw.trimStart();
      if (!line) { i++; continue; }

      if ((m = FENCE.exec(line))) {
        var indent = indentOf(raw), close = new RegExp('^\\s*' + m[1][0] + '{' + m[1].length + ',}\\s*$');
        body = [];
        for (j = i + 1; j < n && !close.test(lines[j]); j++) body.push(unindent(lines[j], indent));
        out.push('<pre><code' + (m[2] ? ' class="language-' + esc(m[2]) + '"' : '') + '>' +
          esc(body.join('\n')) + '</code></pre>');
        i = j + 1;
        continue;
      }

      if (isHtmlBlock(line)) {
        m = HTML_START.exec(line);
        var tag = m[1] ? m[1].toLowerCase() : '', end;
        if (!m[1]) end = /-->/;
        else if (RAW_TAGS[tag] && line[1] !== '/') end = new RegExp('</' + tag + '\\s*>', 'i');
        j = i;
        if (end) {
          while (j < n && !end.test(lines[j])) j++;
          j++;
        } else {
          while (j < n && lines[j].trim()) j++;
        }
        out.push(lines.slice(i, j).join('\n'));
        i = j;
        continue;
      }

      if ((m = HEADING.exec(line))) {
        var text = m[2], idm = /\s*\{#([\w:-]+)\}$/.exec(text), id;
        if (idm) { text = text.slice(0, idm.index); id = idm[1]; ctx.ids[id] = 1; }
        else id = slugify(text, ctx.ids);
        var level = m[1].length;
        out.push('<h' + level + ' id="' + esc(id) + '">' + inline(text) + '</h' + level + '>');
        i++;
        continue;
      }

      if (HR.test(line)) { out.push('<hr>'); i++; continue; }

      if (line.indexOf('|') >= 0 && i + 1 < n && lines[i + 1].indexOf('|') >= 0 && TABLE_DELIM.test(lines[i + 1])) {
        j = i + 2;
        while (j < n && lines[j].trim() && lines[j].indexOf('|') >= 0) j++;
        out.push(table(lines.slice(i, j)));
        i = j;
        continue;
      }

      if (line[0] === '>' && line[1] !== '>') {
        body = [];
        for (j = i; j < n && lines[j].trim(); j++) {
          var q = lines[j].trimStart();
          if (q[0] === '>') body.push(q.replace(/^> ?/, ''));
          else if (isBlockStart(q)) break;
          else body.push(q);
        }
        out.push('<blockquote>\n' + blocks(body, false, ctx) + '\n</blockquote>');
        i = j;
        continue;
      }

      if (LIST.test(line)) {
        var l = list(lines, i, ctx);
        out.push(l.html);
        i = l.next;
        continue;
      }

      if ((m = QUESTION.exec(line))) {
        var question = [m[1]];
        for (j = i + 1; j < n && lines[j].trim(); j++) {
          var qt = lines[j].trimStart();
          if (qt.slice(0, 2) === '>>' || isBlockStart(qt)) break;
          question.push(qt);
        }
        if (j < n && lines[j].trimStart().slice(0, 2) === '>>') {
          body = [];
          for (; j < n && lines[j].trim() && !QUESTION.test(lines[j].trimStart()); j++) {
            body.push(lines[j].trimStart().replace(/^>> ?/, ''));
          }
          out.push('<details class="t-card"><summary>' + inline(question.join('\n')) + '</summary>\n' +
            '<div class="t-answer">' + blocks(body, false, ctx) + '</div></details>');
          i = j;
          continue;
        }
      }

      if ((m = CONTAINER.exec(line))) {
        var colons = m[1].length, depth = 1, fence = null;
        body = [];
        for (j = i + 1; j < n; j++) {
          var ct = lines[j].trimStart(), fm, cm;
          if (fence) {
            if (fence.test(ct)) fence = null;
          } else if ((fm = FENCE.exec(ct))) {
            fence = new RegExp('^' + fm[1][0] + '{' + fm[1].length + ',}\\s*$');
          } else if ((cm = CONTAINER.exec(ct)) && cm[1].length === colons) {
            depth++;
          } else if ((cm = CONTAINER_END.exec(ct)) && cm[1].length === colons && --depth === 0) {
            break;
          }
          body.push(lines[j]);
        }
        out.push(container(m[2], m[3], body, ctx));
        i = j + 1;
        continue;
      }

      if ((m = LEAF.exec(line))) {
        var rest = m[2].trim(), content = '';
        if (rest[0] === '[' && (j = matchBracket(rest, 0, '[', ']')) > 0) {
          content = rest.slice(1, j);
          rest = rest.slice(j + 1);
        }
        out.push('<div' + attrString(parseAttrs(rest), [m[1]]) + ' data-t="' + m[1] + '">' + inline(content) + '</div>');
        i++;
        continue;
      }

      if (line.slice(0, 2) === '$$') {
        var tex = null, label;
        if ((m = MATH_ONE_LINE.exec(line))) {
          tex = m[1]; label = m[2]; j = i;
        } else if (line.indexOf('$$', 2) < 0) {
          body = [line.slice(2)];
          for (j = i + 1; j < n; j++) {
            if ((m = MATH_CLOSE.exec(lines[j]))) { body.push(m[1]); label = m[2]; tex = body.join('\n'); break; }
            body.push(lines[j]);
          }
        }
        if (tex !== null) {
          out.push('<div class="t-eq"' + (label ? ' id="' + esc(label) + '"' : '') + '>' + mathHTML(tex.trim(), true) + '</div>');
          i = j + 1;
          continue;
        }
      }

      for (j = i + 1; j < n && lines[j].trim() && !isBlockStart(lines[j].trimStart()); j++);
      var para = inline(lines.slice(i, j).map(function (l) { return l.replace(/^\s+/, ''); }).join('\n').trimEnd());
      out.push(tight ? para : '<p>' + para + '</p>');
      i = j;
    }
    return out.join('\n');
  }

  function toHTML(source) {
    return blocks(source.replace(/\r\n?/g, '\n').split('\n'), false, { ids: {} });
  }

  if (typeof document === 'undefined') {
    module.exports = { toHTML: toHTML, inline: inline };
    return;
  }

  /* ===================================================================== *
   *  Browser: capture source, render, post-process                        *
   * ===================================================================== */

  var CSS = [
    ':root{--t-bg:#fdfdfb;--t-fg:#1f2328;--t-muted:#6a737d;--t-line:#d9dde3;--t-soft:#f3f4f1;--t-link:#0b62c4;--t-mark:#fff2a8;',
    '--t-font:Charter,"Bitstream Charter","Iowan Old Style",Georgia,serif;--t-sans:system-ui,-apple-system,"Segoe UI",sans-serif;',
    '--t-mono:ui-monospace,"JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace}',
    '@media(prefers-color-scheme:dark){:root{--t-bg:#16181c;--t-fg:#dcdfe4;--t-muted:#8b949e;--t-line:#30363d;--t-soft:#1f2329;--t-link:#6cb0ff;--t-mark:#5c4d00}}',
    'html{background:var(--t-bg);color:var(--t-fg);font:18px/1.6 var(--t-font);-webkit-text-size-adjust:100%}',
    'body{margin:0;padding:2.5rem 1rem 6rem}',
    '.tern{max-width:40rem;margin:0 auto}',
    '.tern>:first-child{margin-top:0}',
    '.tern h1,.tern h2,.tern h3,.tern h4,.tern h5,.tern h6{font-family:var(--t-sans);line-height:1.25;margin:2em 0 .6em;text-wrap:balance}',
    '.tern h1{font-size:1.9rem;margin-top:0}.tern h2{font-size:1.4rem;padding-bottom:.25em;border-bottom:1px solid var(--t-line)}',
    '.tern h3{font-size:1.15rem}.tern h4,.tern h5,.tern h6{font-size:1rem}',
    '.tern p,.tern ul,.tern ol,.tern pre,.tern table,.tern blockquote,.t-block,.t-card,.t-eq{margin:0 0 1rem}',
    '.tern a{color:var(--t-link);text-decoration-thickness:.06em;text-underline-offset:.15em}',
    '.tern ul,.tern ol{padding-left:1.6rem}.tern li>ul,.tern li>ol{margin-bottom:0}.tern li>p{margin-bottom:.5rem}',
    '.tern li.t-task{list-style:none;margin-left:-1.4rem}',
    '.tern hr{border:0;border-top:1px solid var(--t-line);margin:2rem 0}',
    '.tern img,.tern svg,.tern canvas,.tern video{max-width:100%}',
    '.tern blockquote{padding:0 0 0 1rem;border-left:3px solid var(--t-line);color:var(--t-muted)}',
    '.tern code,.tern kbd{font:.85em var(--t-mono)}.tern :not(pre)>code{background:var(--t-soft);padding:.12em .35em;border-radius:4px}',
    '.tern pre{background:var(--t-soft);padding:.8rem 1rem;border-radius:6px;overflow-x:auto;line-height:1.45}',
    '.tern kbd{border:1px solid var(--t-line);border-bottom-width:2px;border-radius:4px;padding:.05em .4em}',
    '.tern mark{background:var(--t-mark);color:inherit;padding:0 .15em;border-radius:2px}',
    '.tern table{border-collapse:collapse;display:block;overflow-x:auto;font-size:.95em}',
    '.tern th,.tern td{border:1px solid var(--t-line);padding:.35em .7em}.tern th{background:var(--t-soft);font-family:var(--t-sans);font-size:.9em}',
    /* directive blocks */
    '.t-block>:last-child,.t-answer>:last-child,.tern blockquote>:last-child{margin-bottom:0}',
    '.t-head{font-family:var(--t-sans);font-size:.92em;font-weight:650;margin-bottom:.3rem}',
    '.t-title{font-weight:400}.t-title::before{content:" ("}.t-title::after{content:")"}',
    '.t-env{padding:.1rem 0 .1rem 1rem;border-left:3px solid var(--t-accent,var(--t-line))}',
    '.t-block.theorem,.t-block.lemma,.t-block.proposition,.t-block.corollary{--t-accent:#7c5cd6}',
    '.t-block.definition{--t-accent:#1f8a5b}.t-block.example,.t-block.exercise{--t-accent:#c98a1b}',
    '.t-block.proof{border-left-color:transparent;padding-left:0}.t-block.proof .t-head{font-style:italic;font-weight:500}',
    '.t-block.proof::after{content:"∎";display:block;text-align:right;margin-top:-1.4em}',
    '.t-callout{padding:.7rem 1rem;border-radius:6px;border-left:4px solid var(--t-accent);background:color-mix(in srgb,var(--t-accent) 9%,transparent)}',
    '.t-callout .t-head{color:var(--t-accent)}',
    '.t-block.note,.t-block.info{--t-accent:#2f7fd6}.t-block.tip{--t-accent:#1f8a5b}.t-block.important{--t-accent:#8a4fd0}.t-block.warning{--t-accent:#cf6a12}',
    /* layout */
    '.t-block.columns{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:1.5rem}',
    '.t-block.columns[style*="--t-cols"]{grid-auto-flow:row;grid-template-columns:var(--t-cols)}',
    '.t-block.grid{display:grid;grid-template-columns:var(--t-cols,repeat(2,minmax(0,1fr)));gap:1rem}',
    '.t-block.columns>*,.t-block.grid>*{margin:0;min-width:0}',
    '.t-block.columns>.t-head,.t-block.grid>.t-head{grid-column:1/-1}',
    '@media(max-width:36rem){.t-block.columns,.t-block.columns[style*="--t-cols"],.t-block.grid{grid-auto-flow:row;grid-template-columns:minmax(0,1fr)}}',
    '.tern .card{border:1px solid var(--t-line);border-radius:8px;padding:.8rem 1rem;background:var(--t-soft)}',
    '.tern .center{text-align:center}.tern .center>table,.tern .center>img{margin-inline:auto;width:fit-content}',
    '@media(min-width:76rem){.tern .wide{margin-right:-16.5rem}}',
    'details.t-block,.t-card{border:1px solid var(--t-line);border-radius:6px;padding:.5rem .9rem}',
    'details.t-block>summary,.t-card>summary{cursor:pointer;font-family:var(--t-sans);font-size:.95em}',
    'details.t-block[open]>summary{margin-bottom:.5rem}',
    '.t-card>summary::marker{content:"Q  ";font-weight:700;color:var(--t-muted)}',
    '.t-answer{margin-top:.5rem;padding-top:.5rem;border-top:1px dashed var(--t-line)}',
    /* inline directives */
    '.tern .hide{background:var(--t-fg);color:transparent;border-radius:3px;cursor:pointer;padding:0 .2em;user-select:none}',
    '.tern .hide *{visibility:hidden}.tern .hide.revealed{background:var(--t-soft);color:inherit;user-select:auto}.tern .hide.revealed *{visibility:visible}',
    '.tern .aside{display:block;margin:.5rem 0 .5rem 1rem;padding-left:.7rem;border-left:2px solid var(--t-line);color:var(--t-muted);font-size:.85rem;line-height:1.45}',
    '@media(min-width:76rem){.tern{margin-left:calc(50% - 28rem)}.tern .aside{float:right;clear:right;width:14rem;margin:.2rem -16.5rem .8rem 0}}',
    /* math, refs, toc */
    '.t-eq{display:flex;align-items:center;overflow-x:auto;overflow-y:hidden}.t-eq>.t-math{flex:1;text-align:center;min-width:0}.t-eq .katex-display{margin:.4em 0}',
    '.t-eqno{font-family:var(--t-font);color:var(--t-muted);padding-left:1rem}',
    '.t-math:not(.t-done){font-family:var(--t-mono);font-size:.85em;white-space:pre-wrap}',
    '.t-math.t-error{color:#c0392b}',
    '.t-toc{font-family:var(--t-sans);font-size:.92em;margin:0 0 1.5rem;padding:.7rem 1rem;background:var(--t-soft);border-radius:6px}',
    '.t-toc a{display:block;text-decoration:none;padding:.1em 0}.t-toc a.t-l3{padding-left:1.2rem;font-size:.95em}',
    '@media print{html{font-size:11pt;background:#fff}body{padding:0}.tern{margin:0 auto}.t-card>.t-answer{display:block}.t-block,.t-card,pre{break-inside:avoid}}'
  ].join('\n');

  var script = document.currentScript;
  var handlers = {};
  var root = null;
  var api = window.tern = {
    source: '',
    envs: ENVS,
    macros: {},
    toHTML: toHTML,
    // Attach behaviour to a directive: fn(el) runs once per :name[...] / :::name element.
    define: function (name, fn) {
      handlers[name] = fn;
      if (root) applyHandler(name);
    }
  };

  if (!script || script.async || script.defer || document.readyState !== 'loading') {
    console.error('tern: must be loaded with a plain <script src> (no async/defer/module).');
    return;
  }

  document.write('<plaintext id="tern-source" style="display:none">');

  document.addEventListener('DOMContentLoaded', function () {
    var holder = document.getElementById('tern-source');
    // The parser drops a single newline right after the script tag's line; trim only that.
    var source = api.source = holder.textContent.replace(/^\r?\n/, '');
    holder.remove();

    if (script.hasAttribute('data-raw')) {
      var pre = document.createElement('pre');
      pre.id = 'tern-out';
      pre.textContent = source;
      document.body.appendChild(pre);
      return;
    }

    // A note has no doctype, so this document is in quirks mode (which KaTeX rejects and which
    // skews CSS). Rewrite it in place as a standards-mode document. Scripts in the note run
    // natively, in source order, as the parser reaches them.
    var html = toHTML(source);
    document.open();
    document.addEventListener('DOMContentLoaded', finish);
    document.write('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<style id="tern-style">' + CSS + '</style></head><body><main class="tern">\n' + html + '\n</main></body></html>');
    document.close();
  });

  function finish() {
    var main = root = document.querySelector('main.tern');
    number(main);
    resolveRefs(main);
    buildToc(main);
    var h1 = main.querySelector('h1');
    if (!document.title && h1) document.title = h1.textContent;
    main.addEventListener('click', function (e) {
      var hide = e.target.closest && e.target.closest('.hide');
      if (hide) hide.classList.toggle('revealed');
    });
    renderMath(main);
    for (var name in handlers) applyHandler(name);
    if (location.hash.length > 1) {
      var target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target) target.scrollIntoView();
    }
  }

  function applyHandler(name) {
    root.querySelectorAll('[data-t="' + name + '"]').forEach(function (el) {
      if (el.ternDone) return;
      el.ternDone = true;
      try { handlers[name](el); } catch (err) { console.error('tern: handler "' + name + '" failed', err); }
    });
  }

  // Number theorem-like blocks and labelled equations, in document order.
  function number(main) {
    var counters = {};
    main.querySelectorAll('.t-env[data-t]').forEach(function (el) {
      var env = ENVS[el.dataset.t], label = env[0];
      if (env[1]) {
        counters[env[1]] = (counters[env[1]] || 0) + 1;
        label += ' ' + counters[env[1]];
        var span = el.querySelector(':scope > .t-head > .t-label');
        if (span) span.textContent = label;
      }
      el.dataset.label = label;
    });
    var eq = 0;
    main.querySelectorAll('.t-eq[id]').forEach(function (el) {
      var no = document.createElement('span');
      no.className = 't-eqno';
      no.textContent = el.dataset.label = '(' + (++eq) + ')';
      el.appendChild(no);
    });
  }

  // @label -> link text; unknown labels fall back to plain text ("@someone").
  function resolveRefs(main) {
    main.querySelectorAll('a.t-ref').forEach(function (a) {
      var target = document.getElementById(a.getAttribute('href').slice(1));
      if (!target) { a.replaceWith(a.textContent); return; }
      a.textContent = target.dataset.label || (/^H[1-6]$/.test(target.tagName) ? target.textContent : a.textContent.slice(1));
    });
  }

  function buildToc(main) {
    var tocs = main.querySelectorAll('[data-t="toc"]');
    if (!tocs.length) return;
    var links = '';
    main.querySelectorAll('h2[id],h3[id]').forEach(function (h) {
      links += '<a class="t-l' + h.tagName[1] + '" href="#' + esc(h.id) + '">' + esc(h.textContent) + '</a>';
    });
    tocs.forEach(function (el) {
      el.classList.add('t-toc');
      el.innerHTML = links;
    });
  }

  function renderMath(main) {
    var nodes = main.querySelectorAll('.t-math');
    if (!nodes.length && !main.querySelector('.t-macros')) return;
    loadKatex(function (katex) {
      if (!katex) return;
      main.querySelectorAll('.t-macros').forEach(function (el) {
        try {
          katex.renderToString(el.textContent, { macros: api.macros, globalGroup: true });
        } catch (err) { console.error('tern: bad :::macros block', err); }
      });
      nodes.forEach(function (el) {
        var tex = el.textContent;
        try {
          katex.render(tex, el, {
            displayMode: el.hasAttribute('data-display'), macros: api.macros, globalGroup: true, throwOnError: true
          });
          el.classList.add('t-done');
        } catch (err) {
          el.classList.add('t-error');
          el.title = err.message;
        }
      });
    });
  }

  function loadKatex(cb) {
    if (window.katex) return cb(window.katex);
    var base = (script.getAttribute('data-katex') || 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist').replace(/\/$/, '');
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = base + '/katex.min.css';
    document.head.insertBefore(link, document.getElementById('tern-style'));
    var s = document.createElement('script');
    s.src = base + '/katex.min.js';
    s.onload = function () { cb(window.katex); };
    s.onerror = function () {
      console.error('tern: could not load KaTeX from ' + base + '; math is shown as source.');
      cb(null);
    };
    document.head.appendChild(s);
  }
})();
