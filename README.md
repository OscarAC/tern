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

The documentation is itself a set of Tern notes: open [`index.html`](index.html) in a browser, or read them published at the project's GitHub Pages site.

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
