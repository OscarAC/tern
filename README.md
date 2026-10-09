# Tern

Documents with the full power of HTML, CSS and JavaScript, without the verbosity of HTML. A note is one HTML file: its first line loads `tern.js`, and everything below it is written in Tern's syntax and rendered in place when the file is opened.

```html
<!doctype html><meta charset="utf-8"><script src="tern.js"></script>

# Linear maps {#maps}

:::theorem[Rank–nullity]{#thm-rn}
If $V$ is finite-dimensional then $\dim V = \dim \ker T + \dim \operatorname{im} T$.
:::

By @thm-rn, an injective map between spaces of equal dimension is surjective.
```


## Documentation

The documentation is published at **[oscarac.github.io/tern](https://oscarac.github.io/tern/)**. Start with the [guide](https://oscarac.github.io/tern/docs/guide.html). The pages are themselves Tern notes: the same files are [`index.html`](index.html) and [`docs/`](docs/) in this repository, and they open locally in a browser too.

## Getting tern.js

A note needs only `tern.js`; it adds its own stylesheet and loads KaTeX for math when a note has some.

**From jsDelivr**, which serves this repository's tagged releases:

```html
<!doctype html><meta charset="utf-8"><script src="https://cdn.jsdelivr.net/gh/OscarAC/tern@v0.1.1/tern.js"></script>
```

- **Pin an exact tag,** as above, in notes you publish: jsDelivr caches a tag's files permanently, and a note keeps rendering the same way.
- **To follow releases,** use `@0.1` (the newest 0.1.x) or `@latest` (the newest release). jsDelivr re-checks these about every 12 hours. A new release can change how existing notes render, so keep these for notes you're happy to see change.
- **Keep the file name `tern.js`.** jsDelivr's minified `tern.min.js` is not recognised: a note is an HTML file whose tag loads a file named `tern.js` ([note detection](https://oscarac.github.io/tern/docs/tools.html#detection)).

**As a file:** copy `tern.js` next to your notes and load it relatively (`src="tern.js"`, `src="../tern.js"`). Notes then work offline and straight from disk. [Publishing](https://oscarac.github.io/tern/docs/publishing.html) covers static hosts, GitHub Pages, the Content-Security-Policy and offline use.

## Using it

```
node tern-cli.js new notes/linear-maps.html     # write the first line
node tern-cli.js check notes/                    # diagnostics, with file lines
node tern-cli.js build notes/linear-maps.html -o out.html   # a static, pre-rendered page
node tern-cli.js lsp                              # the language server, over stdio
```

Named blocks such as `:::theorem` get labels, counters and elements from a schema: an add-on listed in `data-use`, or `window.TERN = {schema: …}` in a script before the tern.js line ([Vocabulary and behaviour](docs/schema.html)).

## Development

```
npm run build       # src/ → tern.js and tern.css
npm test            # build check, corpus, samples, perf, fuzz, API, CLI, LSP, documentation
npm run smoke       # Chromium and Firefox (Playwright)
```

MIT licensed.

## AI-generated project

This project was developed with assistance from AI. 
