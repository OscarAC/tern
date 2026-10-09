// SPDX-License-Identifier: MIT
// The schema the conformance corpus runs with (unless a case says
// `options: schema=none`), and the sample, perf, fuzz and LSP tests too: the
// vocabulary that examples with labels, counters and `::toc` assume, since
// the core declares none. It is exactly the documentation's demo schema
// (docs/schema.html#demo-schema; test/docs.js checks). The shape is the
// registry `tern.schema` holds: plain data keyed by level and name, exactly
// what `tern.block/leaf/inline(name, spec)` write.
'use strict';

const theoremLike = (label) => ({ tag: 'section', counter: 'theorem', label, ref: '{label} {n}' });
const callout = (label) => ({ label });

module.exports = {
  block: {
    theorem: theoremLike('Theorem'),
    lemma: theoremLike('Lemma'),
    proposition: theoremLike('Proposition'),
    corollary: theoremLike('Corollary'),
    definition: { tag: 'section', counter: 'definition', label: 'Definition' },
    example: { tag: 'section', counter: 'example', label: 'Example' },
    exercise: { tag: 'section', counter: 'exercise', label: 'Exercise' },
    proof: { tag: 'section', label: 'Proof', end: '∎' },
    note: callout('Note'),
    tip: callout('Tip'),
    important: callout('Important'),
    warning: callout('Warning'),
    caution: callout('Caution'),
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
