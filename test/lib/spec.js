// SPDX-License-Identifier: MIT
// What the corpus lint (test/run.js --lint) checks the cases against. The
// engine and the documentation are the reference:
//   codes        the engine's diagnostic codes and their severities (src/diag.js)
//   runtimeCodes the codes only the browser runtime or the tools report; the
//                corpus must not test them (test/smoke.js and test/cli.js do)
//   resolve      what a `spec:` anchor PAGE#ID must name (test/lib/anchors.js)
//   required     the anchors the corpus must cite: [{anchor, covers}], where
//                citing any anchor in `covers` counts
//   problems     the documentation's own gaps: a code with no section on
//                docs/diagnostics.html, a reference page that does not load
'use strict';

const { SEVERITY } = require('../../src/diag');
const anchors = require('./anchors');

const RUNTIME_CODES = ['math.error', 'addon.failed', 'script.document-write', 'script.domcontentloaded', 'katex.unavailable', 'doc.quirks', 'head.script', 'addon.remote'];

// Coverage: every level-2 section of the three reference pages, and each of
// the eight rules on its own (they share one level-2 section). A section is
// covered by a case citing its id or any id inside it, so cases cite the
// most specific anchor without losing coverage. The at-a-glance tables only
// summarise the other sections.
const REFERENCE = ['syntax-blocks', 'syntax-inline', 'elements'];
const SUMMARIES = ['at-a-glance'];
const RULES = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `r${n}`);

function load() {
  const codes = new Map(Object.entries(SEVERITY));
  const runtimeCodes = new Set(RUNTIME_CODES);
  const problems = [];

  // Every code has its section on the diagnostics page: block.unclosed is #block-unclosed.
  for (const code of [...codes.keys(), ...runtimeCodes]) {
    const r = anchors.resolve(`diagnostics#${code.replace(/\./g, '-')}`);
    if (r.error) problems.push(`${code} has no section: ${r.error}`);
  }

  const required = [];
  for (const page of REFERENCE) {
    const list = anchors.headings(page);
    if (!list) {
      problems.push(anchors.page(page).error);
      continue;
    }
    const ids = list.filter((h) => h.depth === 2 && !SUMMARIES.includes(h.id)).map((h) => h.id);
    if (page === 'syntax-blocks') ids.push(...RULES);
    for (const id of ids) {
      const covers = anchors.section(page, id);
      if (covers) required.push({ anchor: `${page}#${id}`, covers });
      else problems.push(`docs/${page}.html: no heading #${id}, a section the corpus must cover`);
    }
  }

  return { codes, runtimeCodes, resolve: anchors.resolve, required, problems };
}

module.exports = { load };
