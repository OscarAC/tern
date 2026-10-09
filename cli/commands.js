// SPDX-License-Identifier: MIT
// tern new, check, parse, build and corpus, and the arguments of tern lsp.
// Each command takes its arguments and returns the exit code (tern lsp: none,
// it runs until its client exits it):
//   0  done
//   1  check: a diagnostic at or above --fail-on; new: it refused (the file
//      exists, or the line it would write is not detected); corpus: an
//      example whose diagnostics differ from its expect, or a bad schema=
//   2  a usage error, or a path that cannot be used
// Diagnostics print as `file:line:col: severity code: message`, the hint
// indented below, with file lines (cli/note.js filePosition).
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { split, notNote, attributes, addons, transformWith, loadingDiagnostic, analyse, tern } = require('./note');
const { build, escAttr } = require('./build');
const examples = require('./examples');

const SYNOPSIS = {
  new: 'tern new FILE [--tern=PATH] [--use=LIST] [--title=TEXT] [--guarded] [--force]',
  check: 'tern check PATH… [--json] [--fail-on=error|warning|info] [--quiet]',
  parse: 'tern parse FILE [--transformed] [--compact]',
  build: 'tern build FILE [-o OUT] [--katex]',
  corpus: 'tern corpus PATH… [--out=DIR]',
  lsp: 'tern lsp [--stdio]',
};

const usage = () =>
  `usage: tern COMMAND …

  ${SYNOPSIS.new}
      Write a new note: the canonical first line, loading the nearest tern.js
      in FILE's directory or above (or PATH); --use sets data-use (add-ons,
      separated by commas or spaces); --title adds a :::meta block; --guarded
      shows the source when tern.js does not load.
  ${SYNOPSIS.check}
      Print the diagnostics of notes; directories are searched for .html
      notes. --quiet prints only those at or above --fail-on (default error).
  ${SYNOPSIS.parse}
      Print the note's AST as JSON, parsed or after the transforms.
  ${SYNOPSIS.build}
      Write a static, pre-rendered page (to stdout without -o) that still
      loads tern.js; --katex pre-renders math if the katex package is installed.
  ${SYNOPSIS.corpus}
      Print the live examples of documentation pages (tern fences with the
      class live) as conformance-corpus cases. A case's spec: line is the
      fence's spec=, else PAGE#ID, the section of docs/PAGE.html it is in
      (PAGE#top before any heading; guide#top for a page outside docs/).
      --out writes DIR/docs-PAGE.txt.
  ${SYNOPSIS.lsp}
      The language server, over stdio (--stdio, which some editors pass, is
      accepted and changes nothing).

Exit codes: 0 done; 1 check found problems, new refused, or corpus found an
example that does not match its expect; 2 a usage error.
`;

class UsageError extends Error {
  constructor(message, synopsis = true) {
    super(message);
    this.synopsis = synopsis;
  }
}

// util.parseArgs, strict, with --help on every command.
function options(args, spec) {
  try {
    return parseArgs({ args, options: { ...spec, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e.message);
  }
}

// A command: usage errors print with the synopsis and exit 2.
const command = (name, fn) => (args) => {
  try {
    return fn(args || []);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`tern ${name}: ${e.message}\n${e.synopsis ? `usage: ${SYNOPSIS[name]}\n` : ''}`);
    return 2;
  }
};

const say = (s) => process.stdout.write(`${s}\n`);
const warn = (s) => process.stderr.write(`${s}\n`);
// --help prints the command's synopsis.
function help(name) {
  say(`usage: ${SYNOPSIS[name]}`);
  return 0;
}
// tern new declines: the reason on stderr, exit 1.
function refuse(reason) {
  warn(`tern new: ${reason}`);
  return 1;
}
const RANK = { info: 1, warning: 2, error: 3 };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.code === 'EISDIR' ? 'it is a directory' : e.message}`, false);
  }
}

function format(file, d) {
  const p = d.filePosition.start;
  return `${file}:${p.line}:${p.column}: ${d.severity} ${d.code}: ${d.message}${d.hint ? `\n    ${d.hint}` : ''}`;
}

// ---------------------------------------------------------------- new

// With --guarded, the rest of the tern.js line shows the source when tern.js
// does not run; it is inert when it does, since tern.js's capture swallows
// the rest of the file, this included.
//   - Scripts on, tern.js missing: the <noscript> is inert text in the head;
//     the script writes the message and an <xmp hidden> that the </xmp> right
//     after it closes, and <plaintext> shows the note as text.
//   - Scripts off: the <noscript>'s <p> starts the body, and its <xmp hidden>
//     hides the guard script up to the same </xmp>; then <plaintext>.
const GUARD =
  "<noscript><p>JavaScript is off; the source follows.</p><xmp hidden></noscript><script>self.tern||document.write('<p>tern.js did not load; the source follows.</p><xmp hidden>')</script></xmp><plaintext>";

// The nearest tern.js in dir or above, relative to dir with forward slashes.
function nearestTern(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const f = path.join(d, 'tern.js');
    try {
      if (fs.statSync(f).isFile()) return path.relative(dir, f).split(path.sep).join('/');
    } catch {}
    if (path.dirname(d) === d) return null;
  }
}

function newNote(args) {
  const { values: o, positionals } = options(args, {
    tern: { type: 'string' },
    use: { type: 'string', multiple: true },
    title: { type: 'string' },
    guarded: { type: 'boolean' },
    force: { type: 'boolean' },
  });
  if (o.help) return help('new');
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'give one FILE' : 'FILE is missing');
  const given = positionals[0];
  if (!given || /[\\/]$/.test(given) || ['', '.', '..'].includes(path.basename(given))) throw new UsageError(`"${given}" names no file`);
  const file = path.resolve(given);
  const dir = path.dirname(file);
  if (o.title !== undefined && (!o.title.trim() || /[\r\n]/.test(o.title))) throw new UsageError('--title is one non-empty line');
  if (o.tern !== undefined && !o.tern.trim()) throw new UsageError('--tern is empty');
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {}
  if (st && st.isDirectory()) return refuse(`${given} is a directory`);
  if (st && !o.force) return refuse(`${given} exists; --force overwrites it`);
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error();
  } catch {
    return refuse(`there is no directory ${path.dirname(given)}`);
  }

  // The canonical first line, then the optional :::meta.
  const found = o.tern === undefined ? nearestTern(dir) : null;
  const src = o.tern !== undefined ? o.tern.trim() : found || 'tern.js';
  const use = (o.use || []).flatMap((u) => u.split(/[\s,]+/)).filter(Boolean);
  const title = o.title === undefined ? null : o.title.trim();
  const first = `<!doctype html><meta charset="utf-8"><script src="${escAttr(src)}"${use.length ? ` data-use="${escAttr(use.join(' '))}"` : ''}></script>${o.guarded ? GUARD : ''}`;
  const text = `${first}\n${title === null ? '' : `:::meta\ntitle: ${title}\n:::\n\n`}`;

  // What is written must read back as a note with that line, src and title.
  const parts = split(text);
  const meta = parts && tern.parse(parts.note, { head: parts.head }).ast.data;
  if (!parts || parts.line !== 1 || attributes(parts.tag).src !== src) {
    return refuse(`<script src="${src}"> would not make ${given} a note: the src must name a file called tern.js`);
  }
  if (title !== null && !(meta && meta.tern && meta.tern.meta && meta.tern.meta.title === title)) return refuse(`the title does not read back from :::meta`);

  try {
    fs.writeFileSync(file, text, { flag: o.force ? 'w' : 'wx' });
  } catch (e) {
    return refuse(`cannot write ${given}: ${e.code === 'EEXIST' ? 'it exists' : e.message}`);
  }
  say(`created ${given}, loading ${src}${o.guarded ? ', guarded' : ''}`);
  if (o.tern === undefined && !found) warn(`tern new: no tern.js in ${path.dirname(given)} or above; the note loads tern.js from its own directory`);
  for (const u of use) {
    const local = u.replace(/[?#].*$/, '');
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(local) || local.startsWith('/')) continue;
    if (!fs.existsSync(path.resolve(dir, local))) warn(`tern new: data-use names ${u}, which does not exist yet`);
  }
  return 0;
}

// ---------------------------------------------------------------- check

// The .html files under dir, sorted, skipping dot-directories and
// node_modules; symbolic links to directories are not followed.
function* htmlFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* htmlFiles(p);
    else if (/\.html?$/i.test(e.name)) {
      if (e.isFile()) yield p;
      else if (e.isSymbolicLink()) {
        try {
          if (fs.statSync(p).isFile()) yield p;
        } catch {}
      }
    }
  }
}

function check(args) {
  const { values: o, positionals } = options(args, { json: { type: 'boolean' }, 'fail-on': { type: 'string' }, quiet: { type: 'boolean' } });
  if (o.help) return help('check');
  const level = o['fail-on'] === undefined ? 'error' : o['fail-on'];
  if (!RANK[level]) throw new UsageError(`--fail-on is error, warning or info, not "${level}"`);
  if (!positionals.length) throw new UsageError('give at least one PATH');

  // Files named, then files found in directories, each once.
  const files = [];
  const seen = new Set();
  const add = (p, named) => {
    const key = path.resolve(p);
    if (!seen.has(key)) seen.add(key), files.push({ shown: p, named });
  };
  for (const p of positionals) {
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      throw new UsageError(`cannot read ${p}: ${e.code === 'ENOENT' ? 'no such file or directory' : e.message}`, false);
    }
    if (st.isDirectory()) for (const f of htmlFiles(p)) add(f, false);
    else add(p, true);
  }

  const out = [];
  const count = { error: 0, warning: 0, info: 0 };
  let notes = 0;
  let failed = false;
  let broken = false;
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f.shown, 'utf8');
    } catch (e) {
      warn(`tern check: cannot read ${f.shown}: ${e.message}`);
      broken = true;
      continue;
    }
    const a = analyse(text, f.shown);
    if (!a) {
      if (f.named && !o.quiet) warn(`tern check: ${f.shown} is not a note (${notNote(text)}); skipped`);
      continue;
    }
    notes++;
    for (const d of a.diagnostics) {
      count[d.severity]++;
      const over = RANK[d.severity] >= RANK[level];
      failed = failed || over;
      if (o.quiet && !over) continue;
      if (o.json) out.push({ file: f.shown, ...d });
      else say(format(f.shown, d));
    }
  }
  if (o.json) say(JSON.stringify(out, null, 2));
  if (!o.quiet) {
    const found = [plural(count.error, 'error'), plural(count.warning, 'warning'), plural(count.info, 'info')].join(', ');
    warn(notes ? `tern check: ${plural(notes, 'note')}: ${found}` : 'tern check: no notes found');
  }
  return broken ? 2 : failed ? 1 : 0;
}

// ---------------------------------------------------------------- parse

function parse(args) {
  const { values: o, positionals } = options(args, { transformed: { type: 'boolean' }, compact: { type: 'boolean' } });
  if (o.help) return help('parse');
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'give one FILE' : 'FILE is missing');
  const file = positionals[0];
  const text = read(file);
  const parts = split(text);
  if (!parts) throw new UsageError(`${file} is not a note (${notNote(text)})`, false);
  const loaded = addons(parts.tag, path.dirname(path.resolve(file)), parts.head);
  const opts = { schema: loaded.schema, head: parts.head, lang: loaded.lang };
  const { ast } = tern.parse(parts.note, opts);
  const failed = o.transformed ? transformWith(ast, opts, loaded.transforms).map((f) => ({ kind: 'transform', ...f })) : [];
  for (const p of loaded.problems.concat(failed)) warn(`tern parse: ${loadingDiagnostic(p).message}`);
  say(JSON.stringify(ast, null, o.compact ? 0 : 2));
  return 0;
}

// ---------------------------------------------------------------- build

// -o OUT: a directory when it ends in a slash or is an existing directory
// (created, with its parents, if missing), and the page is DIR/FILE's name;
// otherwise the page's own path, its directory created if missing.
function buildPage(args) {
  const { values: o, positionals } = options(args, { output: { type: 'string', short: 'o' }, katex: { type: 'boolean' } });
  if (o.help) return help('build');
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'give one FILE' : 'FILE is missing');
  const file = positionals[0];
  let out = o.output === undefined || o.output === '-' ? null : o.output;
  if (out !== null && !out) throw new UsageError('-o is empty');
  let into = null; // the directory to create before writing
  let asDir = false;
  if (out) {
    let st = null;
    try {
      st = fs.statSync(out);
    } catch {}
    asDir = out.endsWith('/') || (path.sep === '\\' && out.endsWith('\\')) || !!(st && st.isDirectory());
    into = asDir ? out : path.dirname(out);
    if (asDir) out = path.join(out, path.basename(file));
  }
  if (out && path.resolve(out) === path.resolve(file)) throw new UsageError(`-o ${o.output} is the note itself`, false);
  const text = read(file);
  const r = build(text, file, { katex: !!o.katex });
  if (!r) throw new UsageError(`${file} is not a note (${notNote(text)})`, false);
  for (const w of r.warnings) warn(`tern build: ${w}`);
  for (const d of r.diagnostics) warn(format(file, d));
  for (const f of r.failures) warn(format(file, { severity: 'warning', code: 'math.error', message: f.message, filePosition: r.toFile(f.node.position) }));
  if (out && path.resolve(path.dirname(out)) !== path.dirname(path.resolve(file)))
    warn(`tern build: relative URLs (tern.js, add-ons, images, links) are kept as written, so they resolve from ${path.dirname(out)}`);
  if (!out) process.stdout.write(r.html);
  else {
    try {
      fs.mkdirSync(into, { recursive: true });
    } catch (e) {
      throw new UsageError(`cannot create the directory ${into}: ${e.code === 'EEXIST' || e.code === 'ENOTDIR' ? 'a file is in the way' : e.message}`, false);
    }
    try {
      fs.writeFileSync(out, r.html);
    } catch (e) {
      throw new UsageError(`cannot write ${out}: ${e.code === 'EISDIR' ? 'it is a directory' : e.message}`, false);
    }
  }
  const m = r.math;
  warn(`tern build: ${out ? `wrote ${out}` : 'wrote the page'}; ${plural(m.total, 'formula')}${m.katex ? `, ${m.prerendered} pre-rendered` : ''}`);
  if (out && !asDir && !path.extname(out)) warn(`tern build: ${o.output} is written as a file; end -o with / to write ${path.basename(file)} into a directory of that name`);
  return 0;
}

// ---------------------------------------------------------------- corpus

// The live examples of documentation pages as corpus cases (cli/examples.js
// toCorpus; test/corpus/README.md "Cases from the documentation"). Paths are
// files or directories, as for check. Without --out the cases go to stdout,
// page after page; with it, each page with examples is DIR/docs-PAGE.txt
// (DIR is created). An example that does not match its expect, or names an
// unknown schema, is left out and reported as `file:line: message`: exit 1.
function corpus(args) {
  const { values: o, positionals } = options(args, { out: { type: 'string' } });
  if (o.help) return help('corpus');
  if (!positionals.length) throw new UsageError('give at least one PATH');
  if (o.out !== undefined && !o.out) throw new UsageError('--out is empty');
  const files = [];
  const seen = new Set();
  for (const p of positionals) {
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      throw new UsageError(`cannot read ${p}: ${e.code === 'ENOENT' ? 'no such file or directory' : e.message}`, false);
    }
    for (const f of st.isDirectory() ? [...htmlFiles(p)] : [p]) {
      const key = path.resolve(f);
      if (!seen.has(key)) seen.add(key), files.push({ shown: f, named: !st.isDirectory() });
    }
  }
  if (o.out) {
    try {
      fs.mkdirSync(o.out, { recursive: true });
    } catch (e) {
      throw new UsageError(`cannot create ${o.out}: ${e.message}`, false);
    }
  }
  let cases = 0;
  let pages = 0;
  let failed = false;
  const shown = (f) => f.split(path.sep).join('/');
  const written = new Map(); // output file -> the page that wrote it
  for (const f of files) {
    const text = read(f.shown);
    const x = examples.extract(text, f.shown);
    if (!x) {
      if (f.named) warn(`tern corpus: ${f.shown} is not a note (${notNote(text)}); skipped`);
      continue;
    }
    const c = examples.toCorpus(x, shown(f.shown));
    for (const p of c.problems) warn(`${f.shown}:${p.line}: ${p.message}`);
    failed = failed || c.problems.length > 0;
    if (!c.cases) continue;
    cases += c.cases;
    pages++;
    if (!o.out) {
      process.stdout.write(`${pages > 1 ? '\n' : ''}${c.text}`);
      continue;
    }
    const out = path.join(o.out, `docs-${examples.pageSlug(f.shown)}.txt`);
    if (written.has(out)) throw new UsageError(`${f.shown} and ${written.get(out)} would both write ${out}`, false);
    written.set(out, f.shown);
    fs.writeFileSync(out, c.text);
  }
  warn(`tern corpus: ${plural(cases, 'case')} from ${plural(pages, 'page')}${o.out ? `, written to ${o.out}` : ''}`);
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------- lsp

// The language server (cli/lsp.js): it runs until the client exits it.
// --clientProcessId, which some editors pass with --stdio, is accepted too.
function lsp(args) {
  const { values: o, positionals } = options(args, { stdio: { type: 'boolean' }, clientProcessId: { type: 'string' } });
  if (o.help) return help('lsp');
  if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  require('./lsp').main();
}

module.exports = {
  usage,
  new: command('new', newNote),
  check: command('check', check),
  parse: command('parse', parse),
  build: command('build', buildPage),
  corpus: command('corpus', corpus),
  lsp: command('lsp', lsp),
};
