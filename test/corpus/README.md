# The conformance corpus

The corpus is Tern's conformance test: small notes, each with what the engine must make of it. `node test/run.js` runs the cases against the engine, and `node test/run.js --lint` checks the corpus itself ("The lint", below). Every case cites the sections of the documentation it tests, and every reference section and every diagnostic code has at least one case.

The engine, this corpus and the documentation in `docs/` are the reference together. When they disagree, that is a bug to report, not something to settle by adjusting whichever side is easiest.

## File format

Files are `test/corpus/*.txt`, read in name order. Anything outside a case is ignored; a `# Title` line ends the case before it, so file-level notes go under one.

`````text
## heading/slug-unicode

spec: syntax-blocks#slugs syntax-blocks#character-classes
options: schema=none

A slug keeps letters from any script; NFKC then lower case.

````tern
## Überblick
### 日本語
````

````html
<h2 id="überblick">Überblick</h2>
<h3 id="日本語">日本語</h3>
````

````diagnostics
````
`````

- **`## area/slug`** starts a case. The id is kebab case, unique across the corpus, and greppable; the area is the construct it belongs to (`heading`, `inline-math`, `table` …).
- **`spec:`** (required, before the first block) lists the documentation sections the case tests, as anchors `PAGE#ID` separated by spaces. PAGE is `guide`, `syntax-blocks`, `syntax-inline`, `elements`, `schema`, `diagnostics`, `tools`, `publishing` or `api` (the file `docs/PAGE.html`), or `index` (`index.html`). ID is an id that page defines: `syntax-blocks#fence`, `syntax-inline#inline-math`, `elements#ids`, `diagnostics#block-unclosed`. Cite the most specific section that covers what the case tests, and a code's section on the diagnostics page (the code with dashes) when the case is about that diagnostic.
- **`options:`** (optional): `schema=none` runs without the fixture schema (core only); `schema=extended` runs with `test/fixtures/schema-extended.js`, the fixture plus test-only entries no example declares (a schema `tag` naming a reserved element, labelled and counted leaves and inline elements); `strict` sets `schema.strict` (for `name.unknown`); `safe` renders with `safe: true` (`elements#safe`); `diagnostics=partial` requires the listed diagnostics but allows others; `diagnostics=any` skips the diagnostics check; `escaped` decodes `\t \r \n \0 \\ \uXXXX \u{X…}` in the `tern` block (for tabs, CR, NUL, BOM, trailing spaces as `\u0020`; every literal backslash is then `\\`); `noeol` drops the final newline of the source.
- **Prose** lines between the heading and the blocks say what the case is about, in one or two sentences. Start a line with `Open:` to flag something the documentation does not settle (see "When the documentation is silent"); `node test/run.js --open` lists them all.
- **Writing the file.** Some editing tools decode `\uXXXX` when they write a file, which turns `\u0020` into a real space (then trimmed) and `\uFEFF` into an invisible BOM. After writing an `escaped` case, check what it decodes to: `node -e "const c=require('./test/lib/corpus').loadAll().cases.find(c=>c.id==='ID');console.log(JSON.stringify(c.source))"`.
- **Blocks** are fenced with **four or more** backticks (more than any run inside), with one of these info strings:

| Block | Meaning |
|---|---|
| `tern` | the note source: everything after the `tern.js` line. The harness adds a final newline unless `noeol` |
| `tern js` | instead of `tern`: one JavaScript expression producing the source, for generated input (`':::d\n'.repeat(65)`); used exactly as produced, with no final newline added |
| `html head` | the preserved head (HTML before the `tern.js` line), passed as `opts.head`; for `:::meta` conflicts |
| `html` | the expected body HTML (what goes inside `main.tern`), compared after normalisation (below) |
| `diagnostics` | the expected diagnostics, one per line: `LINE:COL[-LINE:COL] SEVERITY CODE ["substring"]` |
| `json diagnostics` | the same as JSON, a subset match per diagnostic, when more fields matter |
| `json ast` | a subset of `tern.parse(source).ast` (before transforms) |
| `json transformed` | a subset of the AST after `tern.transform` (numbers, ref text, ids) |

A case needs a source and at least one expectation. **A case without a diagnostics block expects no diagnostics at all**, infos included; write an empty `diagnostics` block to say so explicitly.

### Diagnostics lines

```
12:1 error math.unclosed
3:15 error block.opener-junk "attributes go in braces"
5:1-5:9 warning attr.malformed
```

- Severity is `error`, `warning` or `info` (or `E` `W` `I`) and must equal the engine's (`src/diag.js`); the lint checks.
- The position is where the engine puts the diagnostic (each code's section on the diagnostics page says where), as `line:column`, both 1-based. An optional `-line:column` gives the end (exclusive).
- An optional `"substring"` must occur in the message or the hint. Use it sparingly, for the part of a hint that is the point (`"\@alice"`), never for whole sentences.
- Order does not matter. Every expected diagnostic must be produced and nothing else may be.
- A leading `?` marks a diagnostic the documentation leaves undetermined: `? 3:1 info latex.linebreak` may appear or not, and the rest of the block is still exact. Pair it with an `Open:` line. Prefer this to `diagnostics=any`.
- A line `! CODE` asserts that the code does not appear; it is checked even with `diagnostics=any`.
- To leave a column (or anything else) unasserted, use `json diagnostics` with only the fields that matter, e.g. `{"code": "table.extra-cell", "severity": "warning", "position": {"start": {"line": 3}}}`.

### Positions

- Lines are 1-based within the `tern` source (the note; the `tern.js` line is not line 1 of it).
- Columns are 1-based and count UTF-16 code units of the line after normalisation (`syntax-blocks#normalisation`), leading whitespace included; a tab is one column here (tab stops matter for list membership, not for positions).
- `offset` is the 0-based UTF-16 index into the normalised source.
- An end is exclusive: the column just after the last character, as in unist.

### The AST

Node shapes are mdast's, remark-directive's and mdast-util-math's, plus Tern's additions (`footnoteReference`, `footnoteDefinition`, `code.data.tern.title`, `html.data.tern.kind`, `root.data.tern.meta`, `attributes` on `table`, `cell`, `ref`, `inlineMath`); `api#node-types` lists them. A `json ast` block is a subset: give the fields that are the point of the case and leave out the rest, but arrays must list every element (so a `children` array is complete). Positions appear only where the case asserts them. The value `"$absent"` asserts that a field is missing: `{"type": "math", "attributes": "$absent"}`. The same subset rules apply to `json transformed` and `json diagnostics`.

## The lint

`node test/run.js --lint` checks the corpus without running it; `node test/run.js` refuses to run a corpus with lint problems, though not one with coverage gaps. It ends with a summary line such as `corpus: 1395 cases in 34 files citing 123 anchors; reference sections 63/63, engine codes 53/53`. The rules are in `test/lib/spec.js`; the pages are read by `test/lib/anchors.js`, which `test/docs.js` shares.

- **Format.** Every case parses as above, and its id is unique.
- **Anchors.** Every `spec:` anchor names a page and an id that page defines: its id registry after `tern.transform`, or an id its HTML emits, found by analysing the page with the engine.
- **Codes.** Every expected diagnostic is one of the engine's codes (`SEVERITY` in `src/diag.js`), with the engine's severity. The runtime's and the tools' codes (`math.error`, `addon.failed`, `script.document-write`, `script.domcontentloaded`, `katex.unavailable`, `doc.quirks`, `head.script`, `addon.remote`) are not the corpus's: `test/smoke.js` and `test/cli.js` test them.
- **The diagnostics page.** Every code, the engine's, the runtime's and the tools', has its section on `docs/diagnostics.html`: the code with dashes, `block.unclosed` at `diagnostics#block-unclosed`.
- **Coverage of codes.** Every engine code is expected (without `?`) by at least one case.
- **Coverage of sections.** Every required section is cited by at least one case. The required sections are each level-2 section of `syntax-blocks`, `syntax-inline` and `elements`, except the two "at a glance" summaries, and each of the eight rules, `syntax-blocks#r1` to `#r8`. A section counts as cited when a case cites its id or any id inside it, up to the next heading of its level. So a case cites the most specific anchor (`syntax-blocks#fence-info`) and still covers its section (`syntax-blocks#fence`).

  Level-2 sections are the constructs; requiring every level-3 section would demand a case per paragraph of the documentation. The rules are required one by one because they share one level-2 section. A new level-2 section on those pages is required as soon as it is written.

## Cases from the documentation

`tern corpus FILE…` prints a documentation page's live examples (`docs/README.md` "Live examples") as cases in this format, and `--out=DIR` writes one file per page (`DIR/docs-PAGE.txt`).

- **Id.** `## docs/PAGE-SLUG`. PAGE is the file name (`examples-NAME` for a page in `examples/`). SLUG is the fence's own `#id` when it has one; otherwise it is the id of the heading the example follows plus its number under that heading (`docs/syntax-blocks-fence-2`), or its number on the page before any heading. So adding an example renumbers only its own section.
- **`spec:`** is the fence's `spec="…"` attribute when it has one (anchors, as above). Otherwise it is the section the example is in: `PAGE#ID` for the nearest heading with an id before it, or `PAGE#top` before any. `index.html` cites its own sections (`index#tour-math`); a page in `examples/` cites `guide#top`.
- **`options:`** `schema=none` for an example with no schema; `schema=demo` uses the fixture schema, which `docs/docs.js`'s demo schema equals (`test/docs.js` checks). `escaped` when the source holds tabs, CR, NUL, a BOM or trailing spaces.
- **Blocks.** The `tern` block is the fence's text; `html head` is its `head=`; `diagnostics` lists the codes of its `expect`, with the positions and severities the engine gives them. An example whose diagnostics differ from its `expect` is left out and reported, and the command exits 1.

`test/docs.js` runs the extraction on every page and checks that the cases parse, that their codes and severities are the engine's, and that every anchor they cite exists. These cases count toward no coverage: the corpus's own cases must cover everything.

## Running the cases

The harness calls the engine with `opts = {schema, head}` where `schema` is `test/fixtures/schema.js` (the documentation's demo schema, `schema#demo-schema`: theorem/lemma/proposition/corollary on one counter as `<section>`, definition/example/exercise, proof with `∎`, the callouts note/tip/important/warning/caution with labels, recall as `<details>`, figure, table, code listings, the `toc` leaf), an empty registry with `schema=none`, or `test/fixtures/schema-extended.js` with `schema=extended`. Names not in the fixture behave as names without a schema entry.

| Expectation | Engine call |
|---|---|
| `json ast` | `tern.parse(source, opts).ast` |
| diagnostics | `tern.check(source, opts)` |
| `json transformed` | `tern.transform(tern.parse(…).ast, opts)` |
| `html` | `tern.toHTML(source, {...opts, positions: false})` |

## HTML comparison

Both sides go through `test/lib/html.js`. Ignored: whitespace next to block-level tags and `<br>`; runs of ASCII whitespace in text (one space) outside `<pre>` and `<code>` (U+00A0 is not whitespace); attribute order and quoting; `a=""` versus bare `a`; `<br/>` versus `<br>`; `&quot;` `&#39;` `&gt;` versus the character; `data-pos`; a newline right after `<pre>` or right before `</code>`/`</pre>`. Compared exactly: tags, attribute values, the order of class tokens, text, `&lt;` and `&amp;`, comments, raw-text element bodies, and whitespace inside `<pre>` and `<code>`.

So write expected HTML readably, one block per line, and do not worry about attribute order. Do worry about class order (`t-block NAME then author classes`), escaping `<` and `&`, and exact text.

## Output conventions

The documentation shows most of the output: its live examples, and `elements#output-contract`. Where it shows no example, use these, which are the emitter's contract:

- **Headings always get an id**: `## Kernel` → `<h2 id="kernel">Kernel</h2>` (slug rules in `syntax-blocks#slugs`). Every heading in every case's expected HTML carries one.
- **Paragraphs** are `<p>`; a soft break is a newline in the text. Lists follow CommonMark: tight items hold inline content directly, loose items hold `<p>`.
- **Code blocks**: `<pre data-t="code"><code class="language-LANG">…</code></pre>`, with no `class` on `<code>` without a language; content is HTML-escaped.
- **Math**: `<span class="t-math">TeX</span>` inline; display is `<div class="t-eq"><span class="t-math" data-display>TeX</span></div>`, plus `id` and `<span class="t-eqno">(n)</span>` when numbered. TeX is HTML-escaped (`<` → `&lt;`, `&` → `&amp;`) and otherwise unchanged.
- **Containers, leaves, inline elements, spans, cells**: the output contract (`elements#output-contract`). Without a schema entry a container is `<div class="t-block NAME" data-t="NAME">`, its title `<div class="t-title">` as the first child.
- **Labels**: `<span class="t-label">Theorem 1</span>` first in the title element, followed by a space and the title when there is one. A leaf or inline element has no title element: its label is its own first child, followed by a space when content follows; a void element gets none.
- **References**: `<a class="t-ref" href="#id">Theorem 1</a>`; unresolved ones stay as literal text.
- **Footnotes**: the reference is `<sup class="t-fnref"><a id="fnref-LABEL" href="#fn-LABEL">N</a></sup>`; the definitions follow all content as `<section class="t-footnotes"><ol><li id="fn-LABEL">…</li></ol></section>`, with ` <a class="t-fnback" href="#fnref-LABEL">↩</a>` appended inside the definition's last paragraph.
- **Errors made visible**: junk on an opener is `<p class="t-error">junk</p>` as the body's first child; an unclosed display math block is `<div class="t-eq t-error">` holding the escaped source, opening `$$` included; reserved verbatim containers are `<pre class="t-error">`.
- **Raw HTML** is emitted byte for byte.

## When the documentation is silent

Do not invent behaviour. If the documentation does not determine an output detail the case depends on:

1. prefer asserting what it does determine (the diagnostics, or a `json ast` subset) and leave the `html` block out; or
2. write the most direct reading, and add a prose line `Open: <the question>` so the gap is visible and can be settled in the documentation.

A case never encodes a guess silently.
