#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Browser smoke tests, in Chromium and Firefox through
// Playwright. Tests that need CDP (throttling, PDF) run in Chromium only;
// one that needs an API Firefox lacks skips there.
//
// A local server serves the repository, plus:
//   /nocharset/PATH      the file as text/html with no charset (charset test)
//   /csp/PATH            the file with a strict Content-Security-Policy
//   /csp-nonce/PATH      the same policy, plus the nonce csp-layout.html sets
//   /gen/big.js          a ≥ 250 KB script that records its execution
//   /gen/addon.js|.css   add-ons of a fixed size (waterfall test)
//   /gen/math4000.html   a long note with 4,000 formulas (mathNote)
//   /gen/fragment.html   two closed <details> below the fold (fragment tests)
//   /gen/built.html      test/smoke/built.html through `tern build`;
//                        built-katex.html with --katex; guarded.html from
//                        `tern new --guarded`; built-own-schema.html,
//                        built-note-config.html, built-addon-throws.html
//                        and built-poster.html are test/smoke/own-schema.html,
//                        note-config.html, addon-throws.html and
//                        poster.html built
//   /gen/poster.png      a 1-pixel PNG, poster.html's poster
//   {{CDN}}              in test/smoke/*.html: a second, slow origin (a "CDN")
//   /test/samples/…      tern.js and tern.css resolve to the
//                        repository's; images, videos and component scripts
//                        the samples name but the repository lacks get
//                        stand-ins, so the console-error check sees Tern's
//                        errors and not 404s
//   index.html, docs/,   the documentation: files a page's live
//   examples/            examples name but the repository lacks get the same
//                        stand-ins, listed in that page's report
//
// KaTeX is served from a local copy: requests for cdn.jsdelivr.net/npm/
// katex@X.Y.Z/dist/… are answered from node_modules/.cache/tern-smoke/,
// filled once from the npm registry (tarball checked against its sha512) for
// the version the page asks for. The bytes are the ones jsDelivr serves, so
// SRI still applies, and runs are deterministic and work offline after the
// first. --live-cdn uses the real CDN instead; so does any request the cache
// cannot answer.
//
// Each test has a timeout (30 s unless it says otherwise). A test can skip
// itself with a reason (a missing tool); skips are reported, not failed.
//
//   node test/smoke.js [--browsers=chromium,firefox] [--filter=TEXT] [--headed] [--live-cdn]
//
// TERN_JS=FILE serves FILE as /tern.js (and for the samples' tern.js), to
// try a build without writing the committed bundle.
//
// Needs the dev dependency: npm install && npx playwright install chromium firefox.
// The print test also needs mutool (MuPDF; Debian/Ubuntu: mupdf-tools).
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ROOT } = require('./lib/engine');

const args = process.argv.slice(2);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null;
const BROWSERS = (opt('browsers') || 'chromium,firefox').split(',');
const FILTER = opt('filter');
const LIVE_CDN = args.includes('--live-cdn');
const DEFAULT_TIMEOUT = 30000;
const TERN_JS = process.env.TERN_JS ? path.resolve(process.env.TERN_JS) : path.join(ROOT, 'tern.js');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const CSP = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:";
const NONCE = 'tern-smoke-nonce';
const CSP_NONCE = CSP.replace(/(script-src|style-src) 'self'/g, `$1 'self' 'nonce-${NONCE}'`);

// ---- servers

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

const SAMPLES = path.join(ROOT, 'test', 'samples');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// What a sample note names but the repository does not have.
function sampleStandIn(file) {
  const base = path.basename(file);
  if (['tern.js', 'tern.css'].includes(base) && fs.existsSync(path.join(ROOT, base))) return { file: path.join(ROOT, base) };
  const ext = path.extname(file);
  if (ext === '.svg') return { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#ccc"/></svg>' };
  if (/^\.(png|jpe?g|gif|webp)$/.test(ext)) return { type: 'image/png', body: PNG_1PX };
  if (/^\.(mp4|webm|ogg|mp3)$/.test(ext)) return { status: 204 }; // silent in both browsers; an empty 200 stalls Firefox's load event
  if (ext === '.js') {
    // A component script: define the element its file is named after.
    const tag = path.basename(file, ext);
    return { type: 'text/javascript', body: /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(tag) ? `customElements.define(${JSON.stringify(tag)}, class extends HTMLElement { connectedCallback() { this.textContent = '[stand-in ${tag}]'; } });\n` : '' };
  }
  return null;
}

// The documentation's examples name files that do not exist (cat.png,
// tide.mp4), and Chromium's preload scanner fetches what a fence shows
// (`<script src="tern.js">`). Those requests get the samples' stand-ins,
// recorded per page so its test can list them; a page's own links and
// images are test/docs.js's to check.
const docStandIns = new Map(); // page path -> Set of stood-in paths
function docsReferer(req) {
  try {
    const p = new URL(req.headers.referer).pathname;
    return /^\/(?:index\.html)?$|^\/(?:docs|examples)\/[^/]+\.html$/.test(p) ? p : null;
  } catch {
    return null;
  }
}

function staticHandler(cdnOrigin) {
  return (req, res) => {
    let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let charset = true;
    const headers = {};
    if (url.startsWith('/nocharset/')) {
      url = url.slice('/nocharset'.length);
      charset = false;
    }
    if (url.startsWith('/csp/')) {
      url = url.slice('/csp'.length);
      headers['Content-Security-Policy'] = CSP;
    }
    if (url.startsWith('/csp-nonce/')) {
      url = url.slice('/csp-nonce'.length);
      headers['Content-Security-Policy'] = CSP_NONCE;
    }
    if (url.startsWith('/gen/') && GENERATED[url.slice(5)]) {
      const [type, body] = GENERATED[url.slice(5)]();
      res.writeHead(200, { 'Content-Type': /^text\/|javascript/.test(type) ? `${type}; charset=utf-8` : type });
      res.end(body);
      return;
    }
    let file = path.join(ROOT, path.normalize(url));
    const missing = !file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory();
    const docs = missing && file.startsWith(ROOT + path.sep) && docsReferer(req);
    if (missing && (file.startsWith(SAMPLES + path.sep) || docs)) {
      const stand = sampleStandIn(file);
      if (docs && stand) {
        if (!docStandIns.has(docs)) docStandIns.set(docs, new Set());
        docStandIns.get(docs).add(url);
      }
      if (stand && stand.file) file = stand.file;
      else if (stand) {
        res.writeHead(stand.status || 200, stand.type ? { 'Content-Type': stand.type } : {});
        res.end(stand.body);
        return;
      }
    }
    if (file === path.join(ROOT, 'tern.js')) file = TERN_JS;
    if ((file !== TERN_JS && !file.startsWith(ROOT)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let body = fs.readFileSync(file);
    if (file.startsWith(path.join(ROOT, 'test', 'smoke'))) body = Buffer.from(body.toString('utf8').replace(/\{\{CDN\}\}/g, cdnOrigin));
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { ...headers, 'Content-Type': charset && /^text|javascript|json|svg/.test(type) ? `${type}; charset=utf-8` : type });
    res.end(body);
  };
}

function cdnHandler(_req, res) {
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end("window.order = (window.order || []).concat('cdn');\n");
  }, 300);
}

// ---- generated pages

const pad = (kb) => '/*' + 'x'.repeat(kb * 1024) + '*/\n';

// A 4,000-formula note in the core vocabulary: 80 sections, each a heading
// with one formula and seven blocks of seven formulas (a title, three inline,
// one display, two inline), two of the seven blocks being closed <details>
// (1,120 formulas, 28 %). 3,440 inline and 560 display. The note script
// records when 'render' and 'math' fire.
function mathNote(sections = 80) {
  const kinds = ['theorem', 'definition', 'lemma', 'example', 'details', 'details', 'remark'];
  const out = [
    '<!doctype html><meta charset="utf-8"><script src="/tern.js"></script>',
    '',
    '<script>',
    "  window.__t = { script: performance.now() };",
    "  tern.on('render', () => { window.__t.render = performance.now(); });",
    "  tern.on('math', () => { window.__t.math = performance.now(); });",
    '</script>',
    '',
    '# A long note: 4,000 formulas',
    '',
  ];
  for (let s = 1; s <= sections; s++) {
    out.push(`## Section ${s}: the space $L^{${(s % 5) + 1}}(\\Omega)$`, '');
    kinds.forEach((kind, i) => {
      const b = i + 1;
      const id = `${s}-${b}`;
      out.push(
        `:::${kind}[Result ${s}.${b} on $\\|x\\|_{${b}}$]{#r-${id}}`,
        `Let $x \\in \\mathbb{R}^n$ and $\\lambda_{${b}} > 0$. Then $\\sum_{i=1}^n x_i^2 \\le C \\lambda_{${b}}$ by @eq-${id}.`,
        '',
        `$$ \\int_\\Omega |\\nabla u|^2 \\, dx = \\lambda_{${b}} \\int_\\Omega u^2 \\, dx $$ {#eq-${id}}`,
        '',
        `Second paragraph with $\\alpha_{${b}}$ and $\\beta$; compare @eq-${id}.`,
        ':::',
        '',
      );
    });
  }
  return out.join('\n');
}

// Two closed <details> after enough prose to be below the fold: #box holds
// the fragment target #deep and a formula, #fold holds two formulas.
function fragmentNote() {
  const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i + 1}, to put what follows below the fold.`).join('\n\n');
  return [
    '<!doctype html><meta charset="utf-8"><script src="/tern.js"></script>',
    '',
    '# Smoke: fragment targets',
    '',
    filler,
    '',
    ':::details[Closed, holding the target]{#box}',
    'Beside the target: $\\sqrt{2}$.',
    '',
    '{#deep}',
    'The target paragraph.',
    ':::',
    '',
    filler,
    '',
    ':::details[Closed, with math to typeset on toggle]{#fold}',
    'Inline $e^{i\\pi} + 1 = 0$ and display:',
    '',
    '$$ \\sum_{n=1}^\\infty \\frac{1}{n^2} = \\frac{\\pi^2}{6} $$',
    ':::',
    '',
  ].join('\n');
}

const GENERATED = {
  'big.js': () => ['text/javascript', pad(260) + "window.order = (window.order || []).concat('external');\n"],
  'addon.js': () => ['text/javascript', pad(20) + 'window.__addon = (window.__addon || 0) + 1;\n'],
  'addon.css': () => ['text/css', pad(6) + '.tern { outline-color: currentColor; }\n'],
  'math4000.html': () => ['text/html', mathNote()],
  'fragment.html': () => ['text/html', fragmentNote()],
  'built.html': () => ['text/html', cliPage('built')],
  'built-katex.html': () => ['text/html', cliPage('built-katex')],
  'built-missing.html': () => ['text/html', cliPage('built-missing')],
  'built-own-schema.html': () => ['text/html', cliPage('built-own-schema')],
  'built-note-config.html': () => ['text/html', cliPage('built-note-config')],
  'built-addon-throws.html': () => ['text/html', cliPage('built-addon-throws')],
  'built-poster.html': () => ['text/html', cliPage('built-poster')],
  'poster.png': () => ['image/png', PNG_1PX],
  'guarded.html': () => ['text/html', cliPage('guarded')],
};

// ---- pages written by the command line

// `tern build` and `tern new --guarded`, run once per page; a test's setup
// calls cliPage first, so a failure fails that test. built-katex.html
// pre-renders with the local KaTeX copy (below) as the `katex` package, on
// NODE_PATH: the setup awaits katexDist first.
const CLI = path.join(ROOT, 'tern-cli.js');
const KATEX_VERSION = /katex@([\d.]+)/.exec(require('../src/runtime').KATEX.base)[1];
const GUARDED_NOTE = '# Smoke: a guarded note\n\nRendered by tern.js, or shown as its source when tern.js does not load.\n';
const cliPages = new Map();
function cliPage(name) {
  if (cliPages.has(name)) return cliPages.get(name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-smoke-cli-'));
  const cli = (args, env) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', ...env } });
    if (r.status !== 0) throw new Error(`tern ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
    return r.stdout;
  };
  try {
    let html;
    if (name === 'built') html = cli(['build', 'test/smoke/built.html']);
    else if (/^built-(?:own-schema|note-config|addon-throws|poster)$/.test(name)) html = cli(['build', `test/smoke/${name.slice(6)}.html`]);
    else if (name === 'built-missing') {
      const file = path.join(tmp, 'missing.html');
      fs.writeFileSync(file, '<!doctype html><meta charset="utf-8"><script src="/tern.js" data-use="/test/smoke/missing-addon.js /test/smoke/missing-addon.css"></script>\n# Smoke: a built page whose add-ons are missing\n');
      html = cli(['build', file]);
    } else if (name === 'built-katex') {
      const pkg = path.join(tmp, 'node_modules', 'katex');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'katex', version: KATEX_VERSION, main: 'dist/katex.js' }));
      fs.symlinkSync(path.join(CACHE, `katex-${KATEX_VERSION}`, 'dist'), path.join(pkg, 'dist'), 'dir');
      html = cli(['build', 'test/smoke/built.html', '--katex'], { NODE_PATH: path.join(tmp, 'node_modules') });
      if (!/<script data-built src=/.test(html)) throw new Error('tern build --katex left formulas to tern.js');
    } else {
      const file = path.join(tmp, 'guarded.html');
      cli(['new', file, '--guarded', '--tern=/tern.js']);
      html = fs.readFileSync(file, 'utf8') + GUARDED_NOTE;
    }
    cliPages.set(name, html);
    return html;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- KaTeX from a local copy

const CACHE = path.join(ROOT, 'node_modules', '.cache', 'tern-smoke');
const KATEX_URL = /^https:\/\/cdn\.jsdelivr\.net\/npm\/katex@(\d+\.\d+\.\d+)\/(dist\/[^?#]+)/;
const katexCache = new Map();

// The files of a ustar/pax tarball whose path starts with `prefix`.
function untar(buf, prefix, onFile) {
  let off = 0;
  let paxPath = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => h.toString('utf8', a, b).replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const name = paxPath || (field(345, 500) ? field(345, 500) + '/' : '') + field(0, 100);
    const body = buf.subarray(off + 512, off + 512 + size);
    paxPath = null;
    if (type === 'x') paxPath = (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8')) || [])[1] || null;
    else if (type === '0' && name.startsWith(prefix)) onFile(name.slice(prefix.length), body);
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

// node_modules/.cache/tern-smoke/katex-X.Y.Z/, holding dist/; null if it
// cannot be fetched (offline on the first run).
function katexDist(version) {
  if (!katexCache.has(version)) {
    katexCache.set(
      version,
      (async () => {
        const dir = path.join(CACHE, `katex-${version}`);
        if (fs.existsSync(path.join(dir, 'dist', 'katex.min.js'))) return dir;
        const meta = await (await fetch(`https://registry.npmjs.org/katex/${version}`)).json();
        const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
        const want = String(meta.dist.integrity || '').replace(/^sha512-/, '');
        if (crypto.createHash('sha512').update(tgz).digest('base64') !== want) throw new Error(`katex ${version}: tarball does not match its sha512`);
        const tmp = `${dir}.tmp-${process.pid}`;
        untar(zlib.gunzipSync(tgz), 'package/dist/', (rel, body) => {
          const out = path.join(tmp, 'dist', rel);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, body);
        });
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(tmp, dir);
        return dir;
      })().catch((e) => {
        console.log(`    (KaTeX ${version} not cached, using the live CDN: ${e.message})`);
        return null;
      }),
    );
  }
  return katexCache.get(version);
}

// Answers KaTeX requests from the cache. ctx.cdnDelay(bytes), when set,
// holds each response back as a throttled network would: CDP throttling
// does not apply to responses fulfilled by a route (measured: 12 ms instead
// of 1.4 s for 50 KB at 400 kbit/s), so the waterfall test sets it.
async function routeKatex(context, ctx) {
  await context.route(
    (url) => KATEX_URL.test(url.href),
    async (route) => {
      const [, version, rel] = KATEX_URL.exec(route.request().url());
      const dir = await katexDist(version);
      const file = dir && path.join(dir, path.normalize(rel));
      if (!file || !file.startsWith(dir + path.sep) || !fs.existsSync(file)) return route.continue();
      const body = fs.readFileSync(file);
      if (ctx.cdnDelay) await new Promise((r) => setTimeout(r, ctx.cdnDelay(body.length)));
      await route
        .fulfill({
          status: 200,
          body,
          headers: {
            'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Timing-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        })
        .catch(() => {}); // the context closed while we waited
    },
  );
}

// ---- measurement helpers

// Slow 3G: 400 kbit/s each way, 400 ms round trip.
const SLOW_3G = { latency: 400, bytesPerSecond: (400 * 1000) / 8 };
const STAGE_TOL = 25; // ms

// Serial stages: a page loads in three, HTML → tern.js ∥ add-ons ∥ KaTeX
// preload → mount. The document is stage 1.
// Every other request is one stage later than the latest-staged request that
// had already finished when it started, and at least stage 2, since
// everything is discovered from the document's bytes:
//
//   stage(r) = max(2, 1 + max{ stage(q) : q.end ≤ r.start + STAGE_TOL })
//
// start is CDP Network.requestWillBeSent, end is Network.loadingFinished (or
// loadingFailed). STAGE_TOL absorbs timestamp jitter between the renderer and
// the network service, in the strict direction: a request sent just before
// another finished still counts as waiting for it. Under Slow 3G a response
// takes at least one 400 ms round trip, so requests genuinely in flight
// together overlap by far more than 25 ms, while a request issued by a script
// starts after that script finished loading.
function assignStages(requests, doc) {
  const byStart = [...requests].sort((a, b) => a.start - b.start);
  for (const r of byStart) {
    if (r === doc) {
      r.stage = 1;
      continue;
    }
    r.stage = 2;
    for (const q of byStart) if (q !== r && q.stage && q.end != null && q.end <= r.start + STAGE_TOL / 1000) r.stage = Math.max(r.stage, q.stage + 1);
  }
  return byStart;
}

let mutoolChecked;
function hasMutool() {
  if (mutoolChecked === undefined) mutoolChecked = !spawnSync('mutool', ['-v'], { stdio: 'ignore' }).error;
  return mutoolChecked;
}

// The page printed by Chromium, as text extracted by mutool.
async function pdfText(page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-smoke-'));
  try {
    const file = path.join(dir, 'page.pdf');
    await page.pdf({ path: file, format: 'A4' });
    const r = spawnSync('mutool', ['draw', '-q', '-F', 'txt', '-o', '-', file], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`mutool draw failed: ${(r.stderr || '').trim()}`);
    return r.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Every formula outside a closed <details> rendered by KaTeX ('ready' comes
// after 'math'; closed details render on toggle).
const MATH_STATE = () => {
  const all = [...document.querySelectorAll('main.tern .t-math')];
  const shown = all.filter((e) => !e.closest('details:not([open])'));
  const rendered = shown.filter((e) => e.querySelector('.katex'));
  return { all: all.length, shown: shown.length, rendered: rendered.length, firstMissing: (shown.find((e) => !e.querySelector('.katex')) || {}).outerHTML };
};

// Formulas under node, for the sample-notes test.
function mathCountUnderNode(file) {
  try {
    const tern = require(TERN_JS);
    const src = fs.readFileSync(file, 'utf8').replace(/^[^\n]*\n/, '');
    return (tern.toHTML(src).match(/class="t-math[ "]/g) || []).length;
  } catch {
    return null;
  }
}

class Skip extends Error {}

// ---- the documentation (docs/README.md)

// The documentation's pages: index.html, docs/*.html and examples/*.html
// that are notes, with what node knows of them (cli/examples.js): their
// live examples, and whether they load docs.js.
function docPages() {
  const note = require('../cli/note');
  const pages = [];
  const add = (rel) => {
    const file = path.join(ROOT, rel);
    const text = fs.readFileSync(file, 'utf8');
    const parts = note.split(text);
    if (!parts) return;
    const use = (note.attributes(parts.tag)['data-use'] || '').split(/\s+/);
    pages.push({ rel, file, text, docs: use.some((u) => /(?:^|\/)docs\.js(?:[?#]|$)/.test(u)) });
  };
  if (fs.existsSync(path.join(ROOT, 'index.html'))) add('index.html');
  for (const dir of ['docs', 'examples']) {
    const d = path.join(ROOT, dir);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d).sort()) if (/\.html$/.test(f)) add(`${dir}/${f}`);
  }
  return pages;
}

// What a page shows of docs.js: the site nav, the toc, the live examples
// and their results, and the math inside those results.
const DOCS_STATE = () => {
  const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
  const outs = [...document.querySelectorAll('.docs-live-out')];
  // docs.js typesets an example's math itself: .docs-math until then, .t-math after
  const math = outs.flatMap((o) => [...o.querySelectorAll('.t-math, .docs-math')]);
  const panel = document.querySelector('.t-diagnostics');
  const listed = (window.ternDocs ? window.ternDocs.pages.concat(window.ternDocs.examples) : []).some(([p]) => location.pathname.endsWith(`/${p}`) || (p === 'index.html' && location.pathname.endsWith('/')));
  return {
    main: !!document.querySelector('main.tern'),
    nav: document.querySelectorAll('main.tern > nav.site-nav[aria-label] a[href]').length,
    current: document.querySelectorAll('nav.site-nav [aria-current="page"]').length,
    listed,
    toc: !!document.querySelector('main.tern nav.toc:not(.docs-live-out *)'),
    widgets: document.querySelectorAll('.docs-live').length,
    results: outs.length,
    failed: [...document.querySelectorAll('.docs-live-failed .docs-live-problem')].map((p) => p.textContent),
    mismatched: [...document.querySelectorAll('.docs-live-mismatch .docs-live-problem')].map((p) => p.textContent),
    scripts: document.querySelectorAll('.docs-live-out script').length,
    math: math.length,
    // typeset, or rejected by KaTeX: the TeX stays, with t-error (an example
    // may show a formula KaTeX refuses; it is listed in the example)
    typeset: math.filter((m) => m.querySelector('.katex') || m.classList.contains('t-error')).length,
    rejected: math.filter((m) => m.classList.contains('t-error')).length,
    untypeset: (math.find((m) => !m.querySelector('.katex') && !m.classList.contains('t-error')) || {}).outerHTML,
    duplicates: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))],
    diagnostics: (window.tern.diagnostics || []).map((d) => `${d.code} at ${d.position && d.position.start ? `${d.position.start.line}:${d.position.start.column}` : 'the head'}: ${d.message}`),
    panel: !!panel && panel.getClientRects().length > 0,
  };
};

// Each example's :::macros are its own: a formula that uses a macro its
// example defines typesets; one that uses a macro only another example
// defines does not; and none reaches the page's macro table, probed through
// the runtime itself (tern.render on formulas that use them; run last, as
// the probe's failures are the page's diagnostics).
const MACRO_STATE = async () => {
  const K = window.katex;
  if (!K) return { skipped: 'KaTeX did not load' };
  const names = (tex) => [...tex.matchAll(/\\(?:(?:re|provide)?newcommand\*?\s*\{?\s*|[gex]?def\s*)(\\[A-Za-z]+)/g)].map((m) => m[1]);
  const builtin = (n) => {
    try {
      K.renderToString(n, { throwOnError: true });
      return true;
    } catch {
      return false;
    }
  };
  const uses = (tex, n) => new RegExp(`${n.replace(/\\/g, '\\\\')}(?![A-Za-z])`).test(tex);
  const widgets = [...document.querySelectorAll('.docs-live')];
  const defs = widgets.map((w) => new Set([...w.querySelectorAll('.docs-live-out .docs-macros')].flatMap((m) => names(m.textContent)).filter((n) => !builtin(n))));
  const broken = widgets.map((w) => [...w.querySelectorAll('.docs-diag[data-code="math.error"] .docs-msg')].some((m) => /:::macros block does not parse/.test(m.textContent)));
  const problems = [];
  let used = 0;
  let foreign = 0;
  widgets.forEach((w, i) => {
    for (const f of w.querySelectorAll('.docs-live-out .t-math, .docs-live-out .docs-math')) {
      const tex = f.getAttribute('data-tex') || '';
      for (const n of defs[i]) {
        if (!uses(tex, n)) continue;
        used++;
        if (!broken[i] && !f.querySelector('.katex')) problems.push(`example ${i + 1}: ${n}, from its own :::macros, does not typeset in ${tex}`);
      }
      widgets.forEach((_, j) => {
        if (j === i) return;
        for (const n of defs[j]) {
          if (defs[i].has(n) || !uses(tex, n)) continue;
          foreign++;
          if (f.querySelector('.katex')) problems.push(`example ${i + 1} typesets ${n}, which only example ${j + 1} defines`);
        }
      });
    }
  });
  const own = new Set([...document.querySelectorAll('main.tern .t-macros')].flatMap((m) => names(m.textContent)));
  const probe = [...new Set(defs.flatMap((d) => [...d]))].filter((n) => !own.has(n));
  if (probe.length) {
    const div = document.createElement('div');
    for (const n of probe) div.append(Object.assign(document.createElement('span'), { className: 't-math', textContent: n }));
    document.querySelector('main.tern').append(div);
    await window.tern.render(div);
    [...div.children].forEach((f, k) => f.querySelector('.katex') && problems.push(`${probe[k]}, from an example's :::macros, reached the page's macros`));
    div.remove();
  }
  return { problems, defined: defs.reduce((a, d) => a + d.size, 0), used, foreign, probed: probe.length };
};

// The checks every documentation page must pass; `want` is the number of
// live examples node finds in it. Returns the state, for notes.
async function checkDocsPage(page, { docs, want }) {
  await expect(page, () => !!document.querySelector('main.tern'), 'main.tern');
  const done = `(${DOCS_STATE})().typeset === (${DOCS_STATE})().math`;
  try {
    await page.waitForFunction(done, null, { timeout: 8000 });
  } catch {}
  const s = await page.evaluate(DOCS_STATE);
  const problems = [];
  if (docs) {
    if (s.nav < 5) problems.push(`the site nav has ${s.nav} links`);
    if (s.listed && s.current !== 1) problems.push(`the site nav marks ${s.current} links as the current page, expected 1`);
    if (!s.toc) problems.push('no ::toc (nav.toc)');
  }
  if (s.widgets !== want || s.results !== want) problems.push(`${s.widgets} example widgets and ${s.results} rendered results for ${want} live fences`);
  if (s.failed.length) problems.push(`${s.failed.length} example(s) failed: ${s.failed[0]}`);
  if (s.mismatched.length) problems.push(`${s.mismatched.length} example(s) do not match their expect: ${s.mismatched[0]}`);
  if (s.scripts) problems.push(`${s.scripts} <script> element(s) left in example results`);
  if (s.typeset !== s.math) problems.push(`${s.math - s.typeset} of ${s.math} formulas in example results not typeset; first: ${String(s.untypeset).slice(0, 160)}`);
  if (s.duplicates.length) problems.push(`duplicate ids: ${s.duplicates.slice(0, 5).join(', ')}`);
  if (s.diagnostics.length) problems.push(`tern.diagnostics has ${s.diagnostics.length}, expected none: ${s.diagnostics[0]}`);
  if (s.panel) problems.push('the diagnostics panel shows');
  const m = await page.evaluate(MACRO_STATE);
  if (m.problems) problems.push(...m.problems.slice(0, 3));
  s.macros = m;
  if (problems.length) throw new Error(problems.join(' | '));
  return s;
}

const DOC_TESTS = (() => {
  const examples = require('../cli/examples');
  const pages = docPages();
  const tests = pages.map((p) => ({
    name: `docs: ${p.rel} renders with zero console errors${p.docs ? ', a site nav and a toc' : ''}; every live example has a result; math in results is typeset`,
    url: `/${p.rel}`,
    offline: true,
    async check(page, ctx) {
      const x = examples.extract(p.text, p.file);
      const want = x ? x.examples.length : 0;
      const s = await checkDocsPage(page, { docs: p.docs, want });
      ctx.note(`${want} live example(s), ${s.math} formula(s) in their results${s.rejected ? ` (${s.rejected} rejected by KaTeX)` : ''}${p.docs ? `, ${s.nav} site links` : ''}`);
      if (s.macros.defined) ctx.note(`${s.macros.defined} macro(s) defined in examples: ${s.macros.used} use(s) typeset, ${s.macros.foreign} use(s) from other examples refused, ${s.macros.probed} kept from the page`);
      const stood = [...(docStandIns.get(`/${p.rel}`) || [])].map((u) => path.posix.relative(path.posix.dirname(`/${p.rel}`), u));
      if (stood.length) ctx.note(`stand-ins for ${stood.length} missing file(s) its examples name: ${stood.sort().join(', ')}`);
    },
  }));
  if (!pages.length) tests.push({ name: 'docs: the documentation pages render', todo: 'no pages yet in index.html, docs/ or examples/' });
  tests.push({
    name: 'docs: docs.js live examples: ids prefixed, scripts shown not run, styles scoped, math and macros isolated, diagnostics linked, Tern highlighted',
    url: '/test/smoke/docs-live.html',
    async check(page) {
      await checkDocsPage(page, { docs: true, want: 8 });
      await page.evaluate(() => document.querySelector('.docs-live-out button').click());
      const r = await page.evaluate(() => {
        const out = [...document.querySelectorAll('.docs-live-out')];
        const styled = out[3].querySelector('p');
        const pagePara = [...document.querySelectorAll('main.tern > p')].find((p) => /page paragraph/.test(p.textContent));
        return {
          ran: window.__ran,
          shown: (out[3].querySelector('.docs-live-script') || {}).textContent || '',
          onclick: out[3].querySelector('button').hasAttribute('onclick'),
          scope: 'CSSScopeRule' in window,
          styled: getComputedStyle(styled).color,
          page: getComputedStyle(pagePara).color,
          ids: [...out[0].querySelectorAll('[id]')].map((e) => e.id).sort(),
          hrefs: [...out[0].querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).sort(),
          bare: !!document.getElementById('k') || !!document.getElementById('fn-a'),
          math: out[0].querySelectorAll('.t-math .katex').length + out[2].querySelectorAll('.t-math .katex').length,
          ref: (out[2].querySelector('a.t-ref') || {}).textContent,
          refHref: (out[2].querySelector('a.t-ref') || {}).getAttribute?.('href'),
          diag: [...document.querySelectorAll('.docs-live')[1].querySelectorAll('.docs-diags a')].map((a) => a.getAttribute('href')),
          titled: !!document.querySelectorAll('.docs-live')[4].querySelector('.docs-live-source figure figcaption'),
          nav: (document.querySelector('nav.site-nav .docs-nav-list a') || {}).getAttribute?.('href'),
          tern: document.querySelectorAll('code.docs-tern .tk-mark, code.docs-tern .tk-name, code.docs-tern .tk-attr, code.docs-tern .tk-math').length,
          html: (document.querySelector('.docs-live-html') || {}).textContent || '',
          // the math examples: 6 defines \RR and uses it, 7 uses it without, 8 has a bad :::macros and a bad formula
          own: [...out[5].querySelectorAll('.t-math, .docs-math')].map((f) => `${f.className}${f.querySelector('.katex') ? ' katex' : ''} ${f.getAttribute('data-tex').trim()}`),
          macrosHidden: getComputedStyle(out[5].querySelector('.docs-macros')).display,
          runtimeMacros: document.querySelectorAll('.docs-live-out .t-macros').length,
          other: [...out[6].querySelectorAll('.t-math, .docs-math')].map((f) => `${f.className}${f.querySelector('.katex') ? ' katex' : ''}`),
          codes: [5, 6, 7].map((i) => [...document.querySelectorAll('.docs-live')[i].querySelectorAll('.docs-diag')].map((d) => `${d.dataset.code} ${d.querySelector('.docs-pos').textContent}`)),
          errorLink: (document.querySelectorAll('.docs-live')[7].querySelector('.docs-diag[data-code="math.error"] a') || {}).getAttribute?.('href'),
          label: (document.querySelectorAll('.docs-live')[7].querySelector('.docs-live-diagnostics .docs-live-label') || {}).textContent,
        };
      });
      const problems = [];
      if (r.ran !== undefined) problems.push(`a script in an example ran (window.__ran = ${r.ran})`);
      if (!r.shown.includes('window.__ran')) problems.push(`the example's script is not shown: ${JSON.stringify(r.shown)}`);
      if (r.onclick) problems.push('an on* handler survived');
      if (r.page === 'rgb(200, 0, 0)') problems.push("the example's <style> reached the page");
      if (r.scope && r.styled !== 'rgb(200, 0, 0)') problems.push(`the example's <style> does not style its own result (${r.styled})`);
      const ids = ['ex1-eq', 'ex1-fn-a', 'ex1-fnref-a', 'ex1-k'];
      if (JSON.stringify(r.ids) !== JSON.stringify(ids)) problems.push(`result ids ${JSON.stringify(r.ids)}, expected ${JSON.stringify(ids)}`);
      if (JSON.stringify(r.hrefs) !== JSON.stringify(['#ex1-fn-a', '#ex1-fnref-a', '#ex1-k'])) problems.push(`result fragment links ${JSON.stringify(r.hrefs)}`);
      if (r.bare) problems.push('an unprefixed example id is in the page');
      if (r.math !== 3) problems.push(`${r.math} typeset formulas in results 1 and 3, expected 3`);
      if (r.ref !== 'Theorem 1' || r.refHref !== '#ex3-rn') problems.push(`the demo-schema reference reads ${JSON.stringify(r.ref)} → ${r.refHref}`);
      if (JSON.stringify(r.diag) !== JSON.stringify(['../../docs/diagnostics.html#block-unclosed', '../../docs/diagnostics.html#attr-malformed'])) problems.push(`diagnostic links ${JSON.stringify(r.diag)}`);
      if (!r.titled) problems.push('the titled example lost its figure and caption');
      if (r.nav !== '../../docs/guide.html') problems.push(`the site nav's first link is ${r.nav}, expected ../../docs/guide.html`);
      if (r.tern < 10) problems.push(`only ${r.tern} highlighted Tern tokens`);
      if (!/^<p>A <em>short<\/em> example/.test(r.html) || !/\n<section class="t-footnotes">\n {2}<ol>\n {4}<li id="fn-a">/.test(r.html)) problems.push(`the HTML pane: ${JSON.stringify(r.html.slice(0, 300))}`);
      const own = ['t-math katex f\\colon \\RR \\to \\RR', 't-math katex \\RR^2'];
      if (JSON.stringify(r.own) !== JSON.stringify(own)) problems.push(`the example's own macro: ${JSON.stringify(r.own)}, expected ${JSON.stringify(own)} (typeset .t-math with data-tex, for copy)`);
      if (r.macrosHidden !== 'none' || r.runtimeMacros) problems.push(`:::macros in a result: display ${r.macrosHidden}, ${r.runtimeMacros} left as .t-macros for the runtime`);
      if (JSON.stringify(r.other) !== JSON.stringify(['docs-math t-error'])) problems.push(`another example's macro: ${JSON.stringify(r.other)}, expected one formula KaTeX rejects`);
      const codes = [[], ['math.error 1:28'], ['math.error 1:1', 'math.error 5:26']];
      if (JSON.stringify(r.codes) !== JSON.stringify(codes)) problems.push(`the examples' diagnostics ${JSON.stringify(r.codes)}, expected ${JSON.stringify(codes)}`);
      if (r.errorLink !== '../../docs/diagnostics.html#math-error' || r.label !== 'Diagnostics (2)') problems.push(`math.error in the example: ${r.errorLink}, ${r.label}`);
      if (problems.length) throw new Error(problems.join(' | '));
    },
  });
  return tests;
})();

// ---- tests

// Each test opens `url` and runs `check(page, ctx)`; ctx.diagnostics holds
// tern.diagnostics after ready, ctx.console every console message, ctx.browser
// the browser's name, and ctx.note(line) adds a line to the report.
// `browsers` limits where it runs; `todo` lists what is still to build for it
// (reported, not run). Optional: `timeout` (whole test), `readyTimeout`,
// `waitUntil` for page.goto, `init` (an init script), `setup(context, page,
// ctx)` before navigation, `offline` (stub every request to another origin
// except KaTeX), `allowConsole` (a RegExp for the console errors the test
// provokes), `expectConsoleErrors` (allow any), `context` (browser context
// options), `noTern` (the page runs without tern.js: no wait for tern.ready).
const TESTS = [
  {
    name: 'basic note mounts in place, math renders, refs resolve',
    url: '/test/smoke/basic.html',
    async check(page) {
      await expect(page, () => document.compatMode === 'CSS1Compat', 'standards mode');
      await expect(page, () => !!document.querySelector('main.tern h1#top'), 'main.tern with the heading');
      await expect(page, () => !!document.querySelector('.t-math .katex'), 'KaTeX output');
      await expect(page, () => document.querySelector('a.t-ref[href="#eq-int"]')?.textContent === '(1)', 'ref text "(1)"');
      await expect(page, () => document.characterSet === 'UTF-8', 'UTF-8');
    },
  },
  {
    name: 'note scripts run in order: inline, ≥ 250 KB external, slow CDN, inline; sentinel and load',
    url: '/test/smoke/scripts-order.html',
    async check(page) {
      await expect(page, () => JSON.stringify(window.order) === JSON.stringify(['inline1', 'external', 'cdn', 'inline2']), "order inline1, external, cdn, inline2");
      await expect(page, () => !!document.querySelector('#sentinel'), 'the sentinel after the scripts');
      await expect(page, () => document.readyState === 'complete', 'load fired');
    },
  },
  {
    name: 'UTF-8 without a charset header',
    url: '/nocharset/test/smoke/charset.html',
    async check(page) {
      await expect(page, () => document.querySelector('h1')?.textContent.includes('Überblick: naïve café, 日本語, ∀x ∃y'), 'decoded heading');
    },
  },
  {
    name: 'unclosed $$ keeps the heading after it, with math.unclosed',
    url: '/test/smoke/unclosed-math.html',
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('.t-eq.t-error'), 'the visible error block');
      await expect(page, () => document.querySelector('h2')?.textContent === 'The heading survives', 'the heading');
      if (!ctx.diagnostics.some((d) => d.code === 'math.unclosed')) throw new Error('no math.unclosed diagnostic');
    },
  },
  {
    name: 'a KaTeX error keeps the TeX and reports math.error',
    url: '/test/smoke/katex-error.html',
    async check(page, ctx) {
      await expect(page, () => [...document.querySelectorAll('.t-math')].some((e) => e.dataset.tex === '\\frac{1}{' && e.textContent.trim() !== ''), 'the failing formula keeps visible source');
      if (!ctx.diagnostics.some((d) => d.code === 'math.error')) throw new Error('no math.error diagnostic');
    },
  },
  {
    name: 'RTL note: math and code stay left-to-right',
    url: '/test/smoke/rtl.html',
    async check(page) {
      await expect(page, () => document.documentElement.dir === 'rtl', 'dir kept from the head');
      await expect(page, () => getComputedStyle(document.querySelector('.t-math')).direction === 'ltr', 'math is LTR');
      await expect(page, () => getComputedStyle(document.querySelector('code')).direction === 'ltr', 'code is LTR');
    },
  },
  {
    name: 'strict CSP with an external tern.css: renders, no violations',
    url: '/csp/test/smoke/csp.html',
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern h1'), 'mounted');
      if (ctx.cspViolations.length) throw new Error(`CSP violations: ${ctx.cspViolations.join('; ')}`);
    },
  },
  {
    name: 'no doctype: mounts with doc.quirks, math as source',
    url: '/test/smoke/no-doctype.html',
    expectConsoleErrors: true,
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern h1'), 'mounted');
      if (!ctx.diagnostics.some((d) => d.code === 'doc.quirks')) throw new Error('no doc.quirks diagnostic');
    },
  },
  // ---- runtime behaviour (docs/api.html#lifecycle)
  {
    // KaTeX is loaded by the page's head, so it is present before the
    // behaviours run: the order must hold even then.
    name: "lifecycle: behaviours once per element before math; 'render', 'math', 'ready'; tern.render() again changes nothing",
    url: '/test/smoke/lifecycle.html',
    async check(page, ctx) {
      await expect(page, () => window.__log && window.__log.includes('ready-promise'), 'the lifecycle log to reach tern.ready');
      const want = ['define p1 katex=0', 'define p2 katex=0', 'render katex=0', 'math main katex=3', 'ready', 'ready-promise'];
      const log = await page.evaluate(() => window.__log.slice());
      if (JSON.stringify(log) !== JSON.stringify(want)) throw new Error(`lifecycle ${JSON.stringify(log)}, expected ${JSON.stringify(want)}`);
      const html = await page.evaluate(() => document.querySelector('main.tern').innerHTML);
      await page.evaluate(async () => {
        await tern.render();
        await tern.render();
      });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
      const after = await page.evaluate(() => ({
        html: document.querySelector('main.tern').innerHTML,
        log: window.__log.slice(),
        katex: [...document.querySelectorAll('main.tern .t-math')].map((e) => e.querySelectorAll('.katex').length),
      }));
      const ran = after.log.filter((l) => l.startsWith('define'));
      if (ran.length !== 2) throw new Error(`behaviours ran ${ran.length} times after tern.render() twice, expected 2: ${JSON.stringify(ran)}`);
      if (after.katex.join() !== '1,1,1') throw new Error(`.katex per formula after tern.render() twice: ${after.katex.join(', ')}`);
      if (after.html !== html) throw new Error('tern.render() with no source changed main.tern');
      ctx.note(`events from the two extra tern.render() calls: ${after.log.slice(want.length).join(', ') || 'none'}`);
    },
  },
  {
    name: 'note scripts: document.write gives script.document-write; a DOMContentLoaded listener gives script.domcontentloaded and never runs',
    url: '/test/smoke/interception.html',
    async check(page, ctx) {
      await expect(page, () => !!document.getElementById('after'), 'the paragraph after the script');
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({
        written: !!document.getElementById('written'),
        dcl: window.__dcl,
        restored: document.write === Document.prototype.write && document.addEventListener === EventTarget.prototype.addEventListener && window.addEventListener === EventTarget.prototype.addEventListener,
      }));
      const of = (code) => ctx.diagnostics.filter((d) => d.code === code);
      const write = of('script.document-write');
      const dcl = of('script.domcontentloaded');
      if (write.length !== 1) throw new Error(`${write.length} script.document-write diagnostics, expected 1`);
      if (dcl.length !== 2) throw new Error(`${dcl.length} script.domcontentloaded diagnostics, expected 2 (document and window)`);
      // The <script> tag is on note line 4 (line 1 follows the tern.js line).
      const lines = [...write, ...dcl].map((d) => d.position && d.position.start && d.position.start.line);
      if (lines.some((l) => l !== 4)) throw new Error(`diagnostics at note lines ${lines.join(', ')}, expected the script's line 4`);
      if (r.written) throw new Error("document.write's output reached the page");
      if (r.dcl.document || r.dcl.window) throw new Error(`DOMContentLoaded listeners ran: on document ${r.dcl.document} time(s), on window ${r.dcl.window} time(s); expected never`);
      if (!r.restored) throw new Error('document.write or addEventListener is still intercepted after the note scripts');
    },
  },
  {
    name: 'a missing add-on gives addon.failed, and the note still mounts',
    url: '/test/smoke/addon-missing.html',
    allowConsole: /Failed to load resource|Loading failed for the <script>|MIME type/,
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern h1'), 'mounted');
      await expect(page, () => !!document.querySelector('main.tern .t-math .katex'), 'math rendered');
      const failed = ctx.diagnostics.filter((d) => d.code === 'addon.failed');
      for (const file of ['missing-addon.js', 'missing-addon.css']) {
        if (!failed.some((d) => d.message.includes(file))) throw new Error(`no addon.failed naming ${file}; got ${JSON.stringify(failed.map((d) => d.message))}`);
      }
    },
  },
  {
    name: 'KaTeX that fails to load gives katex.unavailable, and math stays as source',
    url: '/test/smoke/katex-unavailable.html',
    allowConsole: /Failed to load resource|Loading failed for the <script>|MIME type|katex/i,
    async setup(context) {
      // Registered after the KaTeX cache route, so it wins.
      await context.route((url) => /^https:\/\/cdn\.jsdelivr\.net\/npm\/katex@/.test(url.href), (route) => route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/plain', body: 'not found' }));
    },
    async check(page, ctx) {
      const math = await page.evaluate(() => [...document.querySelectorAll('main.tern .t-math')].map((e) => ({ text: e.textContent, katex: !!e.querySelector('.katex') })));
      if (math.length !== 1 || math[0].katex || math[0].text !== 'x^2 + 1') throw new Error(`math ${JSON.stringify(math)}, expected its source "x^2 + 1"`);
      const n = ctx.diagnostics.filter((d) => d.code === 'katex.unavailable').length;
      if (n !== 1) throw new Error(`${n} katex.unavailable diagnostics, expected 1`);
    },
  },
  {
    name: 'data-katex="none": no KaTeX request, and math stays as source',
    url: '/test/smoke/katex-none.html',
    async setup(_context, page, ctx) {
      ctx.katexRequests = [];
      page.on('request', (r) => r.resourceType() !== 'document' && /katex/i.test(r.url()) && ctx.katexRequests.push(r.url()));
    },
    async check(page, ctx) {
      await page.waitForTimeout(500);
      if (ctx.katexRequests.length) throw new Error(`KaTeX requested: ${ctx.katexRequests.join(', ')}`);
      const r = await page.evaluate(() => ({
        tags: document.querySelectorAll('link[href*="katex" i], script[src*="katex" i]').length,
        math: [...document.querySelectorAll('main.tern .t-math')].map((e) => ({ text: e.textContent, katex: !!e.querySelector('.katex') })),
      }));
      if (r.tags) throw new Error(`${r.tags} KaTeX <link>/<script> in the page`);
      if (r.math.length !== 1 || r.math[0].katex || r.math[0].text !== 'x^2 + 1') throw new Error(`math ${JSON.stringify(r.math)}, expected its source "x^2 + 1"`);
      if (ctx.diagnostics.some((d) => d.code === 'katex.unavailable')) throw new Error('katex.unavailable reported, though KaTeX is off');
    },
  },
  {
    name: ':::meta writes <title>, html[lang] and <meta name>',
    url: '/test/smoke/meta.html',
    async check(page) {
      const r = await page.evaluate(() => ({ title: document.title, titles: document.querySelectorAll('title').length, lang: document.documentElement.lang, description: (document.querySelector('meta[name="description"]') || {}).content }));
      const want = { title: 'Meta from the note', titles: 1, lang: 'de', description: 'Written by the note' };
      if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(`head ${JSON.stringify(r)}, expected ${JSON.stringify(want)}`);
    },
  },
  {
    name: ':::meta against a head that sets title and lang: the head wins, with meta.conflict',
    url: '/test/smoke/meta-head.html',
    async check(page, ctx) {
      const r = await page.evaluate(() => ({ title: document.title, titles: document.querySelectorAll('title').length, lang: document.documentElement.lang }));
      const want = { title: 'Title from the head', titles: 1, lang: 'fr' };
      if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(`head ${JSON.stringify(r)}, expected ${JSON.stringify(want)}`);
      const n = ctx.diagnostics.filter((d) => d.code === 'meta.conflict').length;
      if (n !== 2) throw new Error(`${n} meta.conflict diagnostics, expected 2 (title, lang)`);
    },
  },
  {
    name: 'a fragment target in a closed <details>: loading #id opens it and scrolls to it',
    url: '/gen/fragment.html#deep',
    async check(page) {
      const r = await page.evaluate(() => {
        const rect = document.getElementById('deep').getBoundingClientRect();
        return { box: document.getElementById('box').open, fold: document.getElementById('fold').open, top: rect.top, bottom: rect.bottom, vh: innerHeight, y: scrollY, math: !!document.querySelector('#box .t-math .katex') };
      });
      if (!r.box) throw new Error('the <details> holding #deep is still closed');
      if (r.y <= 0) throw new Error('the page did not scroll');
      if (r.top < -20 || r.bottom > r.vh + 20) throw new Error(`#deep is out of view: top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)}, viewport ${r.vh}`);
      if (r.fold) throw new Error('the other <details> opened too');
      if (!r.math) throw new Error('the formula beside the target was not typeset');
    },
  },
  {
    name: "math in a closed <details> is typeset on toggle, and 'math' fires on it",
    url: '/gen/fragment.html',
    async check(page) {
      const before = await page.evaluate(() => ({ n: document.querySelectorAll('#fold .t-math').length, typeset: document.querySelectorAll('#fold .t-math .katex, #box .t-math .katex').length, open: document.getElementById('fold').open }));
      if (before.n !== 2 || before.typeset || before.open) throw new Error(`before the toggle: ${JSON.stringify(before)}, expected 2 formulas, none typeset, closed`);
      await page.evaluate(() => {
        window.__mathRoots = [];
        tern.on('math', (root) => window.__mathRoots.push(root.id || root.localName));
        document.getElementById('fold').open = true;
      });
      await expect(page, () => document.querySelectorAll('#fold .t-math .katex').length === 2, 'both formulas in the opened <details> typeset');
      await expect(page, () => window.__mathRoots.includes('fold'), "'math' fired on the <details>");
      if (await page.evaluate(() => document.querySelectorAll('#box .t-math .katex').length)) throw new Error('math in the other, still closed <details> was typeset too');
    },
  },
  {
    name: 'a second tern.js tag does not mount twice',
    url: '/test/smoke/reentry.html',
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern .t-math .katex'), 'math rendered');
      const r = await page.evaluate(() => ({ mains: document.querySelectorAll('main.tern').length, h1: document.querySelectorAll('h1').length, once: document.querySelectorAll('#once').length, same: !!window.__first && window.tern === window.__first }));
      if (r.mains !== 1 || r.h1 !== 1 || r.once !== 1) throw new Error(`${r.mains} main.tern, ${r.h1} h1, ${r.once} #once; expected one of each`);
      if (!r.same) throw new Error('window.tern is no longer the first copy');
      if (!ctx.console.some((m) => /already loaded/.test(m.text))) throw new Error('no console warning from the second copy (did it run?)');
    },
  },
  {
    // A counter's value cannot be read from the DOM, so: the first number is
    // the code element's computed counter-reset plus the first line's
    // ::before counter-increment, shown by content: counter(t-line). In
    // Chromium the rendered text is also read from a DOMSnapshot.
    name: 'code lines: data-start=10 numbers from 10, no start from 1',
    url: '/test/smoke/code-lines.html',
    async check(page, ctx) {
      const blocks = await page.evaluate(() =>
        [...document.querySelectorAll('main.tern pre[data-lines] > code')].map((code) => {
          const line = code.querySelector('.t-line');
          const before = getComputedStyle(line, '::before');
          return { text: line.textContent, reset: getComputedStyle(code).counterReset, increment: before.counterIncrement, content: before.content };
        }),
      );
      const num = (s, re, dflt) => {
        const m = re.exec(s || '');
        return m ? (m[1] == null ? dflt : Number(m[1])) : null;
      };
      const first = blocks.map((b) => (b.content === 'counter(t-line)' ? num(b.reset, /\bt-line(?:\s+(-?\d+))?/, 0) + num(b.increment, /\bt-line(?:\s+(-?\d+))?/, 1) : NaN));
      if (first.join() !== '10,1') throw new Error(`first line numbers ${first.join(', ')}, expected 10, 1: ${JSON.stringify(blocks)}`);
      if (ctx.browser === 'chromium') {
        const cdp = await page.context().newCDPSession(page);
        const snap = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
        const texts = snap.documents[0].layout.text.map((i) => (i >= 0 ? snap.strings[i] : '')).filter((x) => x.trim());
        for (const [i, b] of blocks.entries()) {
          const at = texts.indexOf(b.text);
          const shown = at > 0 ? texts[at - 1].trim() : null;
          if (shown !== String(first[i])) throw new Error(`rendered number before "${b.text}" is ${JSON.stringify(shown)}, expected "${first[i]}"`);
        }
        ctx.note('rendered numbers checked through a DOMSnapshot');
      }
    },
  },
  {
    // tern's presentational styles (column alignment, a grid's --t-cols)
    // must survive a policy with no 'unsafe-inline' for styles; data-nonce
    // covers tern's <style> and the note's scripts.
    name: 'strict CSP with data-nonce: aligned table cells and a cols grid, no violations',
    url: '/csp-nonce/test/smoke/csp-layout.html',
    async check(page) {
      await expect(page, () => !!document.querySelector('main.tern .t-math .katex'), 'math rendered under the CSP');
      await page.waitForTimeout(200);
      const r = await page.evaluate(() => {
        const grid = document.querySelector('main.tern .t-cols');
        const cs = grid && getComputedStyle(grid);
        return {
          csp: window.__csp,
          cells: [...document.querySelectorAll('main.tern table tr')].map((tr) => [...tr.children].map((c) => getComputedStyle(c).textAlign)),
          display: cs && cs.display,
          columns: cs && cs.gridTemplateColumns,
          script: window.__noteScript === true,
          base: getComputedStyle(document.querySelector('main.tern')).maxWidth,
        };
      });
      const problems = [];
      if (r.csp.length) problems.push(`${r.csp.length} CSP violation(s): ${[...new Set(r.csp)].join('; ')}`);
      const bad = r.cells.flatMap((row, i) => row.map((a, j) => [i, j, a])).filter(([, j, a]) => a !== ['left', 'right'][j]);
      if (bad.length || r.cells.length !== 3) problems.push(`text-align by row: ${JSON.stringify(r.cells)}, expected left, right in each of 3 rows`);
      const tracks = String(r.columns || '').split(/\s+/).map(parseFloat);
      if (r.display !== 'grid' || tracks.length !== 2 || !(Math.abs(tracks[0] / tracks[1] - 2) < 0.02)) problems.push(`grid: display ${r.display}, grid-template-columns ${JSON.stringify(r.columns)}, expected two tracks at 2:1`);
      if (!r.script) problems.push('the note script did not run (nonce)');
      if (r.base === 'none') problems.push("tern's base stylesheet is not applied (nonce)");
      if (problems.length) throw new Error(problems.join(' | '));
    },
  },
  ...DOC_TESTS,

  // The five sample notes (test/samples/), as written:
  // tern.js by a relative URL, no add-ons.
  ...['lecture', 'cheatsheet', 'media', 'code', 'layout'].map((name) => ({
    name: `sample ${name}.html: mounts, math renders, no console errors`,
    url: `/test/samples/${name}.html`,
    offline: true,
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern h1'), 'main.tern with its h1');
      const expected = mathCountUnderNode(path.join(SAMPLES, `${name}.html`));
      await expect(page, (n) => document.querySelectorAll('main.tern .t-math').length >= Math.min(n || 0, 1), `the note's formulas in main.tern (${expected} under node)`, 8000, expected);
      try {
        await page.waitForFunction(`(${MATH_STATE})().rendered === (${MATH_STATE})().shown`, null, { timeout: 8000 });
      } catch {
        const m = await page.evaluate(MATH_STATE);
        throw new Error(`${m.shown - m.rendered} of ${m.shown} formulas outside closed <details> not rendered by KaTeX; first: ${String(m.firstMissing).slice(0, 160)}`);
      }
      const m = await page.evaluate(MATH_STATE);
      ctx.note(m.all ? `${m.all} formula(s) (${expected} under node), ${m.rendered} typeset, ${m.all - m.shown} in closed <details>` : `no math (${expected} formulas under node)`);
    },
  })),

  {
    // A real key press in both browsers (in Firefox a synthetic
    // ClipboardEvent has no clipboardData). A window listener records what
    // the copy event carries after tern's handler, which listens on the
    // document and so runs first. Chromium also reads the system clipboard
    // back (the permission exists there); Firefox's clipboard read needs a
    // user's paste prompt, so there the event's data is the evidence.
    name: 'copy: a selection with formulas reaches the clipboard as $tex$ and $$tex$$',
    url: '/test/smoke/copy.html',
    init: () =>
      window.addEventListener('copy', (e) => {
        const d = e.clipboardData;
        window.__copy = { plain: d ? d.getData('text/plain') : null, html: d ? d.getData('text/html') : null, prevented: e.defaultPrevented, trusted: e.isTrusted };
      }),
    async setup(context, _page, ctx) {
      if (ctx.browser === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ctx.origin });
    },
    async check(page, ctx) {
      const INLINE = 'a^2 + b^2 = c^2';
      const DISPLAY = '\\int_0^1 x\\,dx = \\tfrac12';
      await expect(page, () => document.querySelectorAll('main.tern .t-math .katex').length === 2, 'both formulas rendered by KaTeX');
      const tex = await page.evaluate(() => [...document.querySelectorAll('main.tern .t-math')].map((e) => e.dataset.tex));
      if (tex[0] !== INLINE || tex[1] !== DISPLAY) throw new Error(`data-tex ${JSON.stringify(tex)}, expected ${JSON.stringify([INLINE, DISPLAY])}`);
      // Select from the paragraph before the inline formula to the one after
      // the equation, with the DOM Range API, and copy with the keyboard.
      if (ctx.browser === 'chromium') await page.evaluate(() => navigator.clipboard.writeText('(nothing was copied)'));
      await page.evaluate(() => {
        const range = document.createRange();
        range.setStartBefore(document.getElementById('copy-from'));
        range.setEndAfter(document.getElementById('copy-to'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      await page.keyboard.press('ControlOrMeta+C');
      await expect(page, () => !!window.__copy, 'a copy event from the key press', 3000);
      const event = await page.evaluate(() => window.__copy);
      if (!event.trusted) throw new Error('the copy event was not trusted');
      if (!event.prevented) throw new Error("tern's copy handler did not take the copy (the event was not cancelled)");
      const checks = [['the copy event', event.plain, event.html]];
      if (ctx.browser === 'chromium') {
        const clip = await page.evaluate(async () => {
          const out = {};
          for (const item of await navigator.clipboard.read()) for (const type of item.types) out[type] = await (await item.getType(type)).text();
          return out;
        });
        checks.push(['the clipboard', clip['text/plain'], clip['text/html']]);
      }
      for (const [where, plainRaw, html] of checks) {
        const plain = (plainRaw || '').replace(/\s+/g, ' ').trim();
        const show = JSON.stringify(plain.slice(0, 240));
        for (const want of [`Pythagoras: $${INLINE}$ for every right triangle.`, `$$${DISPLAY}$$`, 'The end of the selection.']) {
          if (!plain.includes(want)) throw new Error(`text/plain on ${where} lacks ${JSON.stringify(want)}: ${show}`);
        }
        // KaTeX's own text (HTML glyphs, MathML tokens, the annotation) must
        // be replaced, not kept beside the TeX.
        if (plain.split(INLINE).length !== 2) throw new Error(`text/plain on ${where} holds the inline TeX ${plain.split(INLINE).length - 1} times: ${show}`);
        if (/a2\+b2=c2|∫/.test(plain.replace(/\s/g, ''))) throw new Error(`text/plain on ${where} keeps KaTeX's rendered text: ${show}`);
        // The handler rewrites both flavours, text/plain and text/html.
        if (!html) throw new Error(`no text/html on ${where}`);
        const htmlText = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
        if (/class="[^"]*\bkatex\b/.test(html)) throw new Error(`text/html on ${where} keeps KaTeX markup`);
        for (const want of [`$${INLINE}$`, `$$${DISPLAY}$$`]) {
          if (!htmlText.includes(want)) throw new Error(`text/html on ${where} lacks ${JSON.stringify(want)}: ${JSON.stringify(htmlText.slice(0, 240))}`);
        }
      }
      ctx.note(`checked ${checks.map(([w]) => w).join(' and ')}`);
    },
  },
  {
    name: 'print: PDF text keeps a formula adjacent to its sentence',
    url: '/test/smoke/print.html',
    browsers: ['chromium'],
    async check(page, ctx) {
      if (!hasMutool()) ctx.skip('mutool not found; install MuPDF (mupdf-tools) to extract PDF text');
      await expect(page, () => !!document.querySelector('main.tern .t-math .katex'), 'the formula rendered by KaTeX');
      await page.evaluate(() => document.fonts.ready);
      // `7 \times 6 = 42` has only upright glyphs on one baseline, so its
      // text is the same in KaTeX's HTML and MathML layers ("7×6=42") and
      // has no sub/superscript parts, which stay displaced even when fixed.
      // The MathML layer is clipped and absolutely positioned: if Chromium
      // ever prints its text it lands after the page's prose, as scattered
      // HTML glyphs do. So the check is that one copy sits between the words
      // around it, and a control proves the check can fail.
      const inPlace = (text) => /Theproduct(?:7×6=42){1,2}istheanswer/.test(text.replace(/[\s\u200b]+/g, ''));
      const text = await pdfText(page);
      if (!inPlace(text)) throw new Error(`the formula left its sentence in the PDF text: ${JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 200))}`);
      // KaTeX positions .katex (0.19) and its bases (.base; .katex-base in 0.19) relatively.
      await page.addStyleTag({ content: '@media print { .katex, .katex .base, .katex .katex-base { position: relative !important; } }' });
      const control = await pdfText(page);
      if (inPlace(control)) throw new Error("control: with KaTeX's relative positioning restored the formula still reads in place, so this test no longer detects scattering");
      ctx.note(`PDF text: ${JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 90))}; control scattered as expected`);
    },
  },
  {
    // Throttling: CDP Network.emulateNetworkConditions for the local server;
    // the KaTeX route holds its responses back by the same latency and rate
    // (see routeKatex). Mount is when main.tern enters the document. Stages
    // are defined at assignStages. KaTeX's fonts are a fourth wave, found
    // through katex.min.css once math is typeset, which is after mount; mount
    // does not wait for them, so the budget counts only requests started
    // before mount. The report lists them all. Also checked: tern.js, both
    // add-ons and KaTeX's js and css start before mount, and nothing is
    // fetched twice (a preload the page did not reuse).
    name: 'Slow-3G waterfall: at most 3 serial stages before mount',
    url: '/test/smoke/waterfall.html',
    browsers: ['chromium'],
    timeout: 120000,
    readyTimeout: 90000,
    waitUntil: 'commit',
    init: () => {
      new MutationObserver((_, mo) => {
        if (document.querySelector('main.tern')) {
          window.__mountedAt = performance.timeOrigin + performance.now();
          mo.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    },
    async setup(context, page, ctx) {
      const cdp = await context.newCDPSession(page);
      const requests = new Map();
      ctx.requests = requests;
      cdp.on('Network.requestWillBeSent', (e) => {
        if (!/^https?:/.test(e.request.url)) return;
        // A redirect keeps the id: keep the first start.
        if (!requests.has(e.requestId)) requests.set(e.requestId, { id: e.requestId, url: e.request.url, start: e.timestamp, wall: e.wallTime, type: e.type, initiator: e.initiator && e.initiator.type });
      });
      cdp.on('Network.loadingFinished', (e) => requests.has(e.requestId) && (requests.get(e.requestId).end = e.timestamp));
      cdp.on('Network.loadingFailed', (e) => requests.has(e.requestId) && Object.assign(requests.get(e.requestId), { end: e.timestamp, failed: e.errorText }));
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: SLOW_3G.latency, downloadThroughput: SLOW_3G.bytesPerSecond, uploadThroughput: SLOW_3G.bytesPerSecond });
      ctx.cdnDelay = (bytes) => SLOW_3G.latency + (bytes / SLOW_3G.bytesPerSecond) * 1000;
    },
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern .t-math .katex'), 'math rendered', 60000);
      if ((await page.evaluate(() => window.__addon)) !== 1) throw new Error('the JS add-on did not run exactly once');
      // Let late requests (fonts) finish, for the report.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1500);
      const all = [...ctx.requests.values()].filter((r) => !/\/favicon\.ico$/.test(r.url));
      const doc = all.find((r) => r.type === 'Document');
      if (!doc) throw new Error('no document request recorded');
      const mountedAt = await page.evaluate(() => window.__mountedAt);
      if (!mountedAt) throw new Error('main.tern never entered the document');
      // CDP timestamps are monotonic seconds; map the page's epoch time onto
      // them through the document request's wallTime.
      const mount = mountedAt / 1000 - (doc.wall - doc.start);
      const ordered = assignStages(all, doc);
      const at = (t) => (t - doc.start).toFixed(2).padStart(6);
      const short = (u) => u.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '').replace(/^https:\/\/cdn\.jsdelivr\.net\/npm\//, 'cdn:');
      for (const r of ordered) {
        ctx.note(`${r.start < mount ? ' ' : '+'} stage ${r.stage}  ${at(r.start)} → ${r.end != null ? at(r.end) : '   (open)'} s  ${short(r.url)}${r.failed ? `  FAILED ${r.failed}` : ''}`);
      }
      ctx.note(`  mount at ${at(mount)} s; "+" = requested after mount (not counted); stage tolerance ${STAGE_TOL} ms`);
      const before = ordered.filter((r) => r.start < mount);
      const want = [/\/tern\.js$/, /\/gen\/addon\.js$/, /\/gen\/addon\.css$/, /katex@[^/]+\/dist\/katex(\.min)?\.js$/, /katex@[^/]+\/dist\/katex(\.min)?\.css$/];
      for (const re of want) {
        if (!before.some((r) => re.test(r.url))) throw new Error(`nothing matching ${re} was requested before mount (add-ons and KaTeX are preloaded at capture)`);
      }
      const seen = new Map();
      for (const r of all) seen.set(r.url, (seen.get(r.url) || 0) + 1);
      const twice = [...seen].filter(([, n]) => n > 1).map(([u]) => short(u));
      if (twice.length) throw new Error(`fetched more than once (a preload not reused?): ${twice.join(', ')}`);
      const failed = all.filter((r) => r.failed);
      if (failed.length) throw new Error(`failed requests: ${failed.map((r) => `${short(r.url)} (${r.failed})`).join(', ')}`);
      const stages = Math.max(...before.map((r) => r.stage));
      const late = ordered.filter((r) => r.start >= mount);
      const fonts = late.filter((r) => /katex@[^/]+\/dist\/fonts\//.test(r.url));
      ctx.note(`  ${stages} serial stages before mount; after mount ${late.length} request(s)${late.length ? ` up to stage ${Math.max(...late.map((r) => r.stage))}` : ''}, ${fonts.length} of them KaTeX fonts (not counted: mount does not wait for them)`);
      if (stages > 3) throw new Error(`${stages} serial stages before mount, budget 3 (see the waterfall below)`);
    },
  },
  {
    // Parse+transform+emit+mount is one synchronous task by design, and the
    // browser lays the whole note out in the frame that follows
    // it; the first math slice shares that task when KaTeX is ready (the
    // first paint is typeset). The mount frame is the long animation frame
    // (LoAF) holding 'render', or without LoAF the long task holding it.
    // The budget is for what comes after: no long task (> 50 ms, the Long
    // Tasks API threshold) from the end of the mount frame until 'math', plus
    // a settling window for the last slice's layout. Both are reported.
    name: 'no math task over 50 ms on the 4,000-formula note',
    url: '/gen/math4000.html',
    timeout: 120000,
    readyTimeout: 60000,
    async setup(_context, page, ctx) {
      if (!(await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('longtask')))) ctx.skip(`${ctx.browser} exposes no longtask entries (PerformanceObserver.supportedEntryTypes)`);
    },
    init: () => {
      window.__lt = [];
      window.__loaf = [];
      try {
        new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push({ start: e.startTime, duration: e.duration }))).observe({ type: 'longtask', buffered: true });
      } catch {}
      try {
        new PerformanceObserver((l) =>
          l.getEntries().forEach((e) =>
            window.__loaf.push({
              start: e.startTime,
              duration: e.duration,
              layout: e.duration - (e.styleAndLayoutStart ? e.styleAndLayoutStart - e.startTime : e.duration),
              scripts: (e.scripts || []).map((s) => `${s.invoker || s.invokerType}:${Math.round(s.duration)}`).join(' '),
            }),
          ),
        ).observe({ type: 'long-animation-frame', buffered: true });
      } catch {}
    },
    async check(page, ctx) {
      const SETTLE = 300;
      await expect(page, () => window.__t && window.__t.math != null, "the 'math' event", 30000);
      await page.evaluate((ms) => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), ms)), SETTLE);
      const m = await page.evaluate(MATH_STATE);
      if (m.all !== 4000) throw new Error(`${m.all} formulas in the note, expected 4,000`);
      if (m.rendered !== m.shown) throw new Error(`${m.shown - m.rendered} of ${m.shown} formulas outside closed <details> not rendered`);
      const { t, lt, loaf } = await page.evaluate(() => ({ t: window.__t, lt: window.__lt, loaf: window.__loaf }));
      if (t.render == null) throw new Error("'render' never fired");
      const end = (e) => e.start + e.duration;
      const ms = (x) => `${Math.round(x)} ms`;
      const mountTask = lt.find((e) => e.start <= t.render + 1 && t.render <= end(e) + 1);
      const frame = loaf.find((f) => f.start <= t.render + 1 && t.render <= end(f) + 1);
      const mountEnd = frame ? end(frame) : mountTask ? end(mountTask) : t.render;
      const inMount = lt.filter((e) => e.start < mountEnd && end(e) > t.render - 1);
      const math = lt.filter((e) => !inMount.includes(e) && end(e) > t.render && e.start <= t.math + SETTLE);
      ctx.note(`mount task (parse+transform+emit+mount, to 'render'): ${mountTask ? `${ms(mountTask.duration)} at ${ms(mountTask.start)}, ${ms(end(mountTask) - t.render)} of it after 'render'` : 'under 50 ms'}`);
      if (frame) ctx.note(`mount frame (LoAF): ${ms(frame.duration)} at ${ms(frame.start)}, of which style, layout and paint ${ms(frame.layout)}; its long tasks: ${inMount.map((e) => `${ms(e.start)}+${ms(e.duration)}`).join(', ') || 'none'}`);
      ctx.note(`'render' at ${ms(t.render)}, 'math' at ${ms(t.math)}: ${ms(t.math - t.render)} of math; ${m.all} formulas, ${m.rendered} typeset, ${m.all - m.shown} left for closed <details>`);
      ctx.note(`long tasks during math: ${math.length ? math.map((e) => `${ms(e.start)}+${ms(e.duration)}`).join(', ') : 'none'}`);
      if (math.length) {
        const frames = loaf.filter((f) => f.start >= mountEnd - 1 && math.some((e) => f.start < end(e) && e.start < end(f)));
        if (frames.length) ctx.note(`their frames (LoAF): ${frames.map((f) => `${ms(f.start)}+${ms(f.duration)} = style, layout and paint ${ms(f.layout)} + ${f.scripts || 'no script'}`).join('; ')}`);
        throw new Error(`${math.length} long task(s) during math rendering, longest ${ms(Math.max(...math.map((e) => e.duration)))} (budget: none over 50 ms)`);
      }
    },
  },

  // ---- a note's own vocabulary (window.TERN.schema), as a note and as a built page
  ...[
    ['a single-file note numbers with its window.TERN.schema, which wins over an add-on', '/test/smoke/own-schema.html', null],
    ['tern build: the built page keeps the note\'s window.TERN.schema, behaviours included', '/gen/built-own-schema.html', 'built-own-schema'],
  ].map(([name, url, built]) => ({
    name,
    url,
    async setup() {
      if (built) cliPage(built);
    },
    async check(page) {
      const r = await page.evaluate(() => ({
        labels: [...document.querySelectorAll('main.tern .t-label')].map((e) => e.textContent),
        refs: [...document.querySelectorAll('main.tern a.t-ref')].map((e) => e.textContent),
        dom: document.getElementById('t1').dataset.dom,
        tags: [document.getElementById('t1').localName, document.getElementById('l2').localName],
      }));
      const want = { labels: ['Theorem 1', 'Lemma 2'], refs: ['Theorem 1', 'Lemma 2'], dom: 'own', tags: ['section', 'section'] };
      if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(`${JSON.stringify(r)}, expected ${JSON.stringify(want)}`);
    },
  })),

  // ---- what the note sets, and what its add-ons do, as a note and as a built page
  ...[
    ['data-lang sets the label language over window.TERN.lang and :::meta; window.TERN.schema.strict gives name.unknown', '/test/smoke/note-config.html', null],
    ['tern build: the built page has the same label language and name.unknown', '/gen/built-note-config.html', 'built-note-config'],
  ].map(([name, url, built]) => ({
    name,
    url,
    async setup() {
      if (built) cliPage(built);
    },
    async check(page, ctx) {
      const r = await page.evaluate(() => ({
        labels: [...document.querySelectorAll('main.tern .t-label')].map((e) => e.textContent),
        refs: [...document.querySelectorAll('main.tern a.t-ref')].map((e) => e.textContent),
      }));
      if (JSON.stringify(r) !== JSON.stringify({ labels: ['Satz 1'], refs: ['Satz 1'] })) throw new Error(`${JSON.stringify(r)}, expected the label and the reference Satz 1`);
      const codes = ctx.diagnostics.map((d) => `${d.code} ${d.position.start.line}:${d.position.start.column}`);
      if (codes.join() !== 'name.unknown 14:4') throw new Error(`tern.diagnostics ${JSON.stringify(codes)}, expected name.unknown at 14:4`);
    },
  })),
  ...[
    ['an add-on that throws while it runs gives addon.failed with its message; the note mounts with what it declared first', '/test/smoke/addon-throws.html', null],
    ['tern build: an add-on that throws on the built page gives addon.failed with its message', '/gen/built-addon-throws.html', 'built-addon-throws'],
  ].map(([name, url, built]) => ({
    name,
    url,
    expectConsoleErrors: true, // the add-ons' uncaught errors
    async setup() {
      if (built) cliPage(built);
    },
    async check(page, ctx) {
      await expect(page, () => (document.getElementById('k') || {}).localName === 'aside', 'the kept block as an aside');
      const failed = ctx.diagnostics.filter((d) => d.code === 'addon.failed').map((d) => d.message);
      const want = [
        ['addon-throws.js', 'addon-boom'],
        ['addon-throws-api.js', '"figures" is a built-in transform'],
      ];
      if (failed.length !== 2 || !want.every((w) => failed.some((m) => w.every((x) => m.includes(x))))) throw new Error(`addon.failed ${JSON.stringify(failed)}, expected one naming each add-on with its error`);
      if (!failed.every((m) => /^the add-on \S+ threw while it ran: /.test(m))) throw new Error(`messages ${JSON.stringify(failed)}`);
      const panel = await page.evaluate(() => (document.querySelector('.t-diagnostics') || {}).textContent || '');
      if (!panel.includes('addon-boom')) throw new Error(`the panel does not show it: ${JSON.stringify(panel)}`);
    },
  })),
  ...[
    ["a video's poster loads after the mount (Chromium skips one parsed in a <template>)", '/test/smoke/poster.html', null],
    ["tern build: a video's poster loads on the built page", '/gen/built-poster.html', 'built-poster'],
  ].map(([name, url, built]) => ({
    name,
    url,
    async setup(_context, page, ctx) {
      if (built) cliPage(built);
      ctx.posters = [];
      page.on('requestfinished', (q) => /\/gen\/poster\.png$/.test(q.url()) && ctx.posters.push(q.url()));
    },
    async check(page, ctx) {
      for (let i = 0; i < 30 && !ctx.posters.length; i++) await page.waitForTimeout(100);
      const v = await page.evaluate(() => {
        const el = document.querySelector('main.tern video');
        return el && { poster: el.poster, mounted: !!el.closest('main.tern') };
      });
      if (!v || !/\/gen\/poster\.png$/.test(v.poster)) throw new Error(`the video ${JSON.stringify(v)}`);
      if (!ctx.posters.length) throw new Error('the poster image was never requested');
      ctx.note(`poster requests: ${ctx.posters.length}`);
    },
  })),

  // ---- the command line's pages (docs/tools.html#built-page)
  {
    // The content is in the HTML: blocked, tern.js leaves it as built (its
    // add-on and the note's script, which call tern, throw).
    name: 'tern build: the page shows its content, styled, with tern.js blocked',
    url: '/gen/built.html',
    noTern: true,
    expectConsoleErrors: true,
    async setup(context) {
      cliPage('built');
      await context.route((url) => url.pathname === '/tern.js', (route) => route.abort());
    },
    async check(page) {
      await expect(page, () => document.readyState === 'complete', 'the page to load');
      const r = await page.evaluate(() => {
        const box = document.querySelector('main.tern aside.box');
        return {
          tern: typeof window.tern,
          h1: (document.querySelector('main.tern h1') || {}).textContent,
          label: box && box.querySelector('.t-label').textContent,
          ref: (document.querySelector('main.tern a.t-ref[href="#b1"]') || {}).textContent,
          math: document.querySelectorAll('main.tern .t-math').length,
          source: !!document.querySelector('script[type="text/tern"]#tern-source'),
          title: document.title,
          lang: document.documentElement.lang,
          width: getComputedStyle(document.querySelector('main.tern')).maxWidth,
          border: box && getComputedStyle(box).borderTopStyle,
          panel: !!document.querySelector('.t-diagnostics'),
        };
      });
      const want = { tern: 'undefined', h1: 'Smoke: a built page', label: 'Box 1', ref: 'Box 1', math: 2, source: true, title: 'Smoke: a built page', lang: 'en', border: 'solid', panel: false };
      const got = { ...r };
      delete got.width;
      if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`page ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      if (r.width === 'none') throw new Error('tern.css is not applied (main.tern has no max-width)');
    },
  },
  {
    name: "tern build: tern.js starts the built page: note scripts once, behaviours, math, the panel, 'ready'",
    url: '/gen/built.html',
    async setup() {
      cliPage('built');
    },
    async check(page, ctx) {
      await expect(page, () => document.querySelectorAll('main.tern .t-math .katex').length === 2, 'both formulas typeset by tern.js');
      const r = await page.evaluate(() => ({
        log: window.__log,
        scripts: window.__script,
        mains: document.querySelectorAll('main.tern').length,
        dom: document.getElementById('b1').dataset.dom,
        define: document.getElementById('b1').dataset.define,
        tex: [...document.querySelectorAll('main.tern .t-math')].map((e) => e.dataset.tex),
        panel: (document.querySelector('.t-diagnostics') || {}).textContent || '',
        sheets: [...document.head.querySelectorAll('style, link[rel="stylesheet"]')].map((e) => (e.id === 'tern-style' ? 'base' : e.href ? e.href.replace(/^.*\//, '') : /aside\.box/.test(e.textContent) ? 'tern.style' : 'other')),
      }));
      const want = ['script tern=object', 'define katex=0', 'render', 'math main', 'ready'];
      if (JSON.stringify(r.log) !== JSON.stringify(want)) throw new Error(`lifecycle ${JSON.stringify(r.log)}, expected ${JSON.stringify(want)}`);
      if (r.scripts !== 1 || r.mains !== 1) throw new Error(`the note script ran ${r.scripts} time(s), ${r.mains} main.tern; expected 1 and 1`);
      if (r.dom !== 'yes' || r.define !== 'yes') throw new Error(`behaviours: the add-on's dom ${r.dom}, tern.define ${r.define}`);
      if (r.tex.join(' | ') !== 'a^2 + b^2 = c^2 | \\int_0^1 x\\,dx = \\tfrac12') throw new Error(`data-tex ${JSON.stringify(r.tex)}`);
      const codes = ctx.diagnostics.map((d) => d.code);
      if (codes.join() !== 'ref.dangling') throw new Error(`tern.diagnostics ${JSON.stringify(codes)}, expected the build's ref.dangling`);
      const d = ctx.diagnostics[0];
      if (!r.panel.includes('ref.dangling') || !r.panel.includes(`line ${d.position.start.line}:${d.position.start.column} (file line ${d.position.start.line + 1})`)) throw new Error(`the panel: ${JSON.stringify(r.panel)}`);
      const [base, own, css] = ['base', 'tern.style', 'built-addon.css'].map((s) => r.sheets.indexOf(s));
      if (!(base >= 0 && base < own && own < css)) throw new Error(`head sheets ${JSON.stringify(r.sheets)}: expected the base, then the add-on's tern.style, then the CSS add-on (data-use order)`);
    },
  },
  {
    // A missing CSS add-on is not reported on a built page: its link comes
    // before tern.js.
    name: 'tern build: a missing script add-on gives addon.failed on the built page',
    url: '/gen/built-missing.html',
    allowConsole: /Failed to load resource|Loading failed for the <script>|MIME type/,
    async setup() {
      cliPage('built-missing');
    },
    async check(page, ctx) {
      await expect(page, () => !!document.querySelector('main.tern h1'), 'main.tern');
      const failed = ctx.diagnostics.filter((d) => d.code === 'addon.failed').map((d) => d.message);
      if (failed.length !== 1 || !failed[0].includes('missing-addon.js')) throw new Error(`addon.failed ${JSON.stringify(failed)}, expected one naming missing-addon.js`);
    },
  },
  {
    name: "tern build --katex: math pre-rendered, KaTeX's script never requested",
    url: '/gen/built-katex.html',
    async setup(_context, page, ctx) {
      if (!(await katexDist(KATEX_VERSION))) ctx.skip(`no local copy of KaTeX ${KATEX_VERSION} to pre-render with`);
      cliPage('built-katex');
      ctx.katexScripts = [];
      page.on('request', (q) => /katex(?:\.min)?\.js(?:[?#]|$)/.test(q.url()) && ctx.katexScripts.push(q.url()));
    },
    async check(page, ctx) {
      const r = await page.evaluate(() => ({
        log: window.__log,
        katex: document.querySelectorAll('main.tern .t-math .katex').length,
        mathml: document.querySelectorAll('main.tern .t-math math').length,
        tex: [...document.querySelectorAll('main.tern .t-math')].map((e) => e.dataset.tex),
        css: [...document.querySelectorAll('link[rel="stylesheet"]')].filter((l) => /katex/.test(l.href) && l.sheet).length,
      }));
      const want = ['script tern=object', 'define katex=2', 'render', 'math main', 'ready'];
      if (JSON.stringify(r.log) !== JSON.stringify(want)) throw new Error(`lifecycle ${JSON.stringify(r.log)}, expected ${JSON.stringify(want)}`);
      if (r.katex !== 2 || r.mathml !== 2) throw new Error(`${r.katex} .katex and ${r.mathml} <math> in main.tern, expected 2 of each`);
      if (r.tex.join(' | ') !== 'a^2 + b^2 = c^2 | \\int_0^1 x\\,dx = \\tfrac12') throw new Error(`data-tex ${JSON.stringify(r.tex)}`);
      if (!r.css) throw new Error("KaTeX's stylesheet did not load");
      await page.waitForTimeout(300);
      if (ctx.katexScripts.length) throw new Error(`KaTeX's script was requested: ${ctx.katexScripts.join(', ')}`);
    },
  },
  {
    name: 'tern new --guarded: the note renders and the guard stays inert',
    url: '/gen/guarded.html',
    async setup() {
      cliPage('guarded');
    },
    async check(page) {
      await expect(page, () => (document.querySelector('main.tern h1') || {}).textContent === 'Smoke: a guarded note', 'the heading in main.tern');
      const r = await page.evaluate(() => ({ text: document.body.innerText, xmp: document.querySelectorAll('xmp, plaintext').length }));
      if (/did not load|JavaScript is off/.test(r.text) || r.xmp) throw new Error(`the guard acted: ${JSON.stringify(r)}`);
    },
  },
  ...[
    ['tern.js does not load', { setup: (context) => context.route((url) => url.pathname === '/tern.js', (route) => route.abort()) }, 'tern.js did not load; the source follows.'],
    ['JavaScript is off', { context: { javaScriptEnabled: false } }, 'JavaScript is off; the source follows.'],
  ].map(([when, opts, message]) => ({
    name: `tern new --guarded: when ${when}, the note shows as its source`,
    url: '/gen/guarded.html',
    noTern: true,
    allowConsole: /Failed to load resource|Loading failed for the <script>/,
    ...opts,
    async setup(context, page, ctx) {
      cliPage('guarded');
      if (opts.setup) await opts.setup(context, page, ctx);
    },
    async check(page) {
      await expect(page, () => document.readyState === 'complete', 'the page to load');
      const r = await page.evaluate(() => ({
        p: [...document.querySelectorAll('body > p')].map((p) => p.textContent),
        source: (document.querySelector('body > plaintext') || {}).textContent,
        hidden: [...document.querySelectorAll('xmp')].every((x) => x.hidden),
        main: !!document.querySelector('main.tern'),
      }));
      if (r.p.join() !== message) throw new Error(`the message ${JSON.stringify(r.p)}, expected ${JSON.stringify(message)}`);
      if (!r.source || !r.source.trimStart().startsWith(GUARDED_NOTE.trim().split('\n')[0]) || !r.source.includes(GUARDED_NOTE.trim())) throw new Error(`the source shown ${JSON.stringify(r.source)}, expected the note and nothing before it`);
      if (!r.hidden || r.main) throw new Error(`the guard shows itself (${!r.hidden}) or the note mounted (${r.main})`);
    },
  })),
];

async function expect(page, fn, what, timeout = 8000, arg) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch {
    throw new Error(`expected ${what}`);
  }
}

function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require(name);
    } catch {}
  }
  return null;
}

async function runTest(browser, origin, t) {
  const context = await browser.newContext(t.context || {});
  const consoleErrors = [];
  const ctx = {
    browser: browser.browserType().name(),
    origin,
    diagnostics: [],
    cspViolations: [],
    console: [],
    notes: [],
    step: 'opening the page',
    note: (line) => ctx.notes.push(line),
    skip: (why) => {
      throw new Skip(why);
    },
  };
  const run = (async () => {
    if (!LIVE_CDN) await routeKatex(context, ctx);
    if (t.offline) await context.route((url) => url.origin !== origin && !KATEX_URL.test(url.href), (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }));
    const page = await context.newPage();
    page.on('console', (m) => {
      ctx.console.push({ type: m.type(), text: m.text() });
      if (m.type() === 'error' && !(t.allowConsole && t.allowConsole.test(m.text()))) consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    if (t.init) await page.addInitScript(t.init);
    if (t.setup) await t.setup(context, page, ctx);
    await page.goto(origin + t.url, { waitUntil: t.waitUntil || 'load', timeout: t.readyTimeout || 30000 });
    if (!t.noTern) await waitForReady(page, t, ctx);
    ctx.step = 'checking';
    await t.check(page, ctx);
    if (!t.expectConsoleErrors && consoleErrors.length) throw new Error(`console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
  })();
  run.catch(() => {}); // after a timeout, closing the context rejects what was pending
  const ms = t.timeout || DEFAULT_TIMEOUT;
  let timer;
  try {
    await Promise.race([run, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s while ${ctx.step}`)), ms)))]);
  } catch (e) {
    if (!(e instanceof Skip) && consoleErrors.length && !/^console errors/.test(e.message)) e.message += ` [console: ${consoleErrors.slice(0, 2).join(' | ').slice(0, 300)}]`;
    e.notes = ctx.notes;
    throw e;
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
  return ctx.notes;
}

// tern.ready settles; ctx gets tern.diagnostics and the CSP violations.
async function waitForReady(page, t, ctx) {
  ctx.step = 'waiting for tern.ready';
  try {
    await page.waitForFunction(() => window.tern && window.tern.ready, null, { timeout: t.readyTimeout || 10000 });
  } catch {
    const seen = await page.evaluate(() => (window.tern ? `window.tern has ${Object.keys(window.tern).slice(0, 8).join(', ')}…` : 'window.tern is undefined')).catch(() => '');
    throw new Error(`expected window.tern.ready (the runtime); ${seen}`);
  }
  await page.evaluate(() => window.tern.ready.then(() => (window.__ternReady = 'yes'), (e) => (window.__ternReady = `rejected: ${e}`)));
  await expect(page, () => window.__ternReady, 'tern.ready to settle', t.readyTimeout || 10000);
  const settled = await page.evaluate(() => window.__ternReady);
  if (settled !== 'yes') throw new Error(`tern.ready ${settled}`);
  ctx.diagnostics = await page.evaluate(() => JSON.parse(JSON.stringify(window.tern.diagnostics || [])));
  ctx.cspViolations = await page.evaluate(() => window.__csp);
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) {
    console.log('✗ playwright is not installed: npm install && npx playwright install chromium firefox');
    process.exit(2);
  }
  const cdn = await serve(cdnHandler);
  const site = await serve(staticHandler(cdn.origin));
  const count = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  const notes = (lines) => (lines || []).forEach((l) => console.log(`      ${l}`));
  try {
    for (const name of BROWSERS) {
      let browser;
      try {
        browser = await pw[name].launch({ headless: !args.includes('--headed') });
      } catch (e) {
        count.failed++;
        console.log(`✗ ${name}: cannot launch (${e.message.split('\n')[0]}); npx playwright install ${name}`);
        continue;
      }
      console.log(`${name} ${browser.version()}`);
      for (const t of TESTS) {
        if (FILTER && !t.name.includes(FILTER)) continue;
        if (t.browsers && !t.browsers.includes(name)) continue;
        if (t.todo) {
          count.todo++;
          console.log(`  · ${t.name} (todo: ${t.todo})`);
          continue;
        }
        try {
          const lines = await runTest(browser, site.origin, t);
          count.passed++;
          console.log(`  ✓ ${t.name}`);
          notes(lines);
        } catch (e) {
          if (e instanceof Skip) {
            count.skipped++;
            console.log(`  - ${t.name} (skipped: ${e.message})`);
            continue;
          }
          count.failed++;
          console.log(`  ✗ ${t.name}: ${e.message.split('\n')[0]}`);
          notes(e.notes);
        }
      }
      await browser.close();
    }
  } finally {
    site.server.close();
    cdn.server.close();
  }
  const extra = [count.skipped && `${count.skipped} skipped`, count.todo && `${count.todo} todo`].filter(Boolean).join(', ');
  console.log(`\n${count.failed ? `${count.failed} failure(s), ` : ''}${count.passed} passed${extra ? `; ${extra}` : ''}`);
  process.exit(count.failed ? 1 : 0);
}

main();
