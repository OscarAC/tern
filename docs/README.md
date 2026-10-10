# Writing Tern's documentation

The documentation is a set of Tern notes. Every page is a `.html` file whose first line loads `tern.js`. Each page renders itself, so the docs are also the largest real use of Tern. Readers who open the source see the syntax they are learning.

**Accuracy beats everything.** These pages and the engine's conformance tests are Tern's reference, and the engine decides: verify every claim with `tern.js`, as in `node -e "console.log(require('./tern.js').toHTML('…'))"`. The conformance corpus, `test/corpus/*.txt`, shows the exact output and diagnostics for each construct; look there for a case before you describe an edge. `npm test` runs `test/docs.js` over every page.

## The pages

| File | Title | What it covers |
|---|---|---|
| `index.html` | Tern | what Tern is, a first note, a tour, links to everything |
| `docs/guide.html` | Guide | a complete tutorial, from the first line to schemas, publishing and the editor |
| `docs/syntax-blocks.html` | Syntax: blocks | the eight rules, lexical conventions, attributes, every block construct |
| `docs/syntax-inline.html` | Syntax: inline | every inline construct, the ambiguity rules, escapes, the residual cases |
| `docs/elements.html` | Elements and output | how names become elements, the output contract, titles and labels, numbering, references, ids, figures, table captions, raw HTML, metadata |
| `docs/schema.html` | Vocabulary and behaviour | schemas, `window.TERN.schema`, add-ons, `tern.define`, transforms, styling, themes, labels in other languages |
| `docs/diagnostics.html` | Diagnostics | every diagnostic: when it fires, what happens to the content, an example, the fix |
| `docs/tools.html` | Command line and editors | `tern new/check/parse/build/corpus/lsp`, the language server, the language module editors embed, editor setup, the outline notification, note detection |
| `docs/publishing.html` | Publishing | the file, opening locally, static hosts, `tern build`, CSP, KaTeX and offline use, browsers, trust, "When it does not render" |
| `docs/api.html` | JavaScript API | `tern.*`, options, the AST and `data.tern`, the transformed AST, the runtime lifecycle, events, config |
| `examples/*.html` | Examples | complete notes, each declaring its own vocabulary |

## A page's first lines

```html
<!doctype html><html lang="en"><meta charset="utf-8"><title>Syntax: blocks · Tern</title><script src="../tern.js" data-use="docs.js docs.css"></script>

:::meta
description: Every block-level construct of Tern: paragraphs, headings, fences, raw HTML, math, quotes, lists, tables, containers, cells, leaves, footnotes, attribute lines.
:::

::site-nav

# Syntax: blocks {#top}

::toc
```

- **Paths.** Pages in `docs/` load `../tern.js`, and `docs.js` and `docs.css` from `docs/`. `index.html` loads `tern.js`, `docs/docs.js` and `docs/docs.css`. Examples load `../tern.js` and declare their own vocabulary (below).
- **The page's own markup.**
  - `::site-nav` is the site navigation, drawn by docs.js.
  - `::toc` is the page's contents, levels 2 and 3.
  - The title in the head is "Page · Tern".
- **docs.js vocabulary.** It declares what the pages use:
  - `toc`;
  - `site-nav`;
  - the callouts `note`, `tip`, `warning` and `important`;
  - `figure`, `table` and `code` with counters;
  - `kbd`, `syntax` (a construct's spelling, shown as a summary box).

  Use nothing else without adding it to docs.js.

## Live examples

A fence whose info is `tern` with the class `live` is an example. docs.js shows it four ways, all computed by the engine on the reader's machine when the page is viewed:
- the source;
- the result;
- the generated HTML;
- the diagnostics.

````
```tern {.live}
A *short* example with $x^2$.
```
````

- **Diagnostics.** By default an example must produce no diagnostics. An example that shows a problem lists the codes it must produce: `{.live expect="block.unclosed attr.malformed"}`. The list is a set, so order doesn't matter, and the same code twice counts twice. `test/docs.js` checks that the example produces exactly that set.
- **Schema.** By default an example renders with **no schema**, which is what a plain note gets. An example that needs vocabulary says so: `{.live schema=demo}`. The demo schema is defined in docs.js and listed on the Vocabulary page; say so in the prose. An example may give a preserved head with `head="…"`: the engine reads its `<title>`, `<html lang dir>` and `<meta name>` (for `:::meta` conflicts and the label language). It does not run head scripts, so `window.TERN.schema` in a `head` has no effect on a live example; show that with plain `html` fences. Use `head` rarely.
- **Spec** (optional). `spec="syntax-blocks#fence"` names the documentation sections an example illustrates, as `PAGE#ID` anchors, where `PAGE` is a page of `docs/` without `.html`. `tern corpus` cites them on the case's `spec:` line. Without it, the case cites the section the example is in, so `spec=` is needed only for an example that illustrates another section ([tern corpus](tools.html#corpus)).
- **Fence length.** To show a fence inside an example, make the outer fence longer: four backticks around three.
- **Size.** Keep examples small and focused, one idea each. Show edge cases as separate examples.
- **Ids.** docs.js prefixes the ids in a result, so examples never clash with the page's ids.
- **Plain source.** A fence that only shows source, with nothing to render, is a plain ```` ```tern ```` fence, or ```` ```html ````, ```` ```js ````, ```` ```sh ````.

## Style

- **Voice.** Write for someone who knows a little Markdown and HTML. Address the reader directly, in plain words, with short sentences. Lead with what the reader can do, then the rule, then the edge cases.
- **Every construct**, in this order:
  1. what it is, in one line;
  2. its spelling (a `:::syntax` box or a short fence);
  3. a live example;
  4. the rules, as a short list;
  5. edge cases, each with a live example;
  6. the diagnostics it can produce, linking to the Diagnostics page;
  7. how to write it literally (the escape).
- **Headings.** Give every heading that others link to an explicit id (`## Fenced code {#fence}`). Ids are stable: never change one that other pages link to.
- **Links** between pages name the section: `[fences](syntax-blocks.html#fence)`. The pages stand alone: a rule is explained on a page, never left to a file in the repository.
- **Tables** for options, fields, codes and spellings.
- **Callouts.** `:::tip` for advice, `:::warning` for something that loses content or surprises, `:::note` for background. Use them sparingly.
- **Coverage.** Don't invent features, and don't promise future ones. If the engine's behaviour looks wrong, or disagrees with a corpus case, stop and report it rather than documenting it.
- **Length.** Long is fine when it is detailed and organised. Repetition between pages is fine when each page stands alone; link to the main treatment.

## Checking

```
node tern-cli.js check docs/ examples/ index.html   # the pages themselves
node test/docs.js                                   # pages, live examples and links
NODE_PATH=… node test/smoke.js --filter=docs        # the pages in Chromium and Firefox
```

`tern corpus FILE…` prints a page's live examples as conformance-corpus cases (the `test/corpus/README.md` format).
