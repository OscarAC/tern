#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Builds the committed tern.js from src/. Each module keeps its own scope:
// the bundle is one IIFE holding the modules as functions, in a fixed order,
// with a ten-line require. Under node the bundle is the module's export; in
// the browser it is window.tern, and a second copy leaves the first in place.
// It also writes tern.css, the base stylesheet of src/css.js, which a page
// links instead of the runtime's inline <style> under a strict CSP.
//
//   node tools/concat.js           write tern.js and tern.css
//   node tools/concat.js --check   exit 1 if either is not the current build (CI)
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'tern.js');
const CSS_OUT = path.join(ROOT, 'tern.css');

// Dependencies first. A file in src/ that is not listed is an error, so a
// new module cannot be left out of the build silently.
const ORDER = ['diag', 'scan', 'ast', 'entities', 'inline', 'block', 'outline', 'schema', 'transform', 'emit', 'css', 'runtime', 'index'];
const ENTRY = 'index';

function build() {
  const present = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
  const unknown = present.filter((m) => !ORDER.includes(m));
  if (unknown.length) throw new Error(`src/ has modules not in tools/concat.js ORDER: ${unknown.join(', ')}`);
  const version = /const version = '([^']+)'/.exec(fs.readFileSync(path.join(SRC, `${ENTRY}.js`), 'utf8'))[1];
  const parts = [
    '// SPDX-License-Identifier: MIT',
    `// tern.js ${version}: built from src/ by tools/concat.js. Edit the sources, not this file.`,
    '(function (global) {',
    "  'use strict';",
    '  var defs = {};',
    '  var cache = {};',
    '  function require(name) {',
    "    var id = name.replace(/^\\.\\//, '').replace(/\\.js$/, '');",
    '    if (!cache[id]) {',
    '      cache[id] = { exports: {} };',
    '      defs[id](cache[id], cache[id].exports, require);',
    '    }',
    '    return cache[id].exports;',
    '  }',
  ];
  for (const m of ORDER) {
    if (!present.includes(m)) continue;
    const body = fs
      .readFileSync(path.join(SRC, `${m}.js`), 'utf8')
      .replace(/^\/\/ SPDX-License-Identifier: MIT\n/, '')
      .replace(/^'use strict';\n/m, '')
      .trimEnd();
    parts.push(`  // ---- src/${m}.js`, `  defs['${m}'] = function (module, exports, require) {`, body, '  };');
  }
  parts.push(
    `  var tern = require('${ENTRY}');`,
    "  if (typeof module === 'object' && module && module.exports) module.exports = tern;",
    '  else if (!(global.tern && global.tern.version)) global.tern = tern;',
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    '',
  );
  return parts.join('\n');
}

// tern.css: the same stylesheet the runtime injects as <style id="tern-style">.
function buildCss() {
  const file = path.join(SRC, 'css.js');
  delete require.cache[require.resolve(file)];
  const { css } = require(file);
  return `/* SPDX-License-Identifier: MIT */\n/* tern.css: built from src/css.js by tools/concat.js. Edit the source, not this file. */\n${css}`;
}

function main() {
  const out = build();
  const sheet = buildCss();
  const lines = out.split('\n').length - 1;
  const bytes = Buffer.byteLength(out);
  const gz = zlib.gzipSync(out, { level: 9 }).length;
  const size = `${lines} lines, ${(bytes / 1024).toFixed(1)} KB, ${(gz / 1024).toFixed(1)} KB gzipped`;
  if (process.argv.includes('--check')) {
    const current = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    const stale = [current(OUT) !== out && 'tern.js', current(CSS_OUT) !== sheet && 'tern.css'].filter(Boolean);
    if (stale.length) {
      console.log(`✗ ${stale.join(' and ')} ${stale.length > 1 ? 'are' : 'is'} not the current build of src/: run node tools/concat.js`);
      process.exit(1);
    }
    console.log(`✓ tern.js and tern.css are current; tern.js ${size}`);
    process.exit(0);
  }
  fs.writeFileSync(OUT, out);
  fs.writeFileSync(CSS_OUT, sheet);
  console.log(`wrote tern.js (${size}) and tern.css (${(Buffer.byteLength(sheet) / 1024).toFixed(1)} KB)`);
}

main();
