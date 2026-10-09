#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// tern, the command line. Node only: a note never loads this file. The
// commands live in cli/commands.js, the language server in cli/lsp.js.
//
//   tern new FILE      write a note's first line
//   tern check PATH…   print diagnostics; exit 1 on errors
//   tern parse FILE    print the AST as JSON
//   tern build FILE    write a static, pre-rendered page
//   tern corpus PATH…  print documentation examples as corpus cases
//   tern lsp           the language server, over stdio
'use strict';

const commands = require('./cli/commands');

const COMMANDS = ['new', 'check', 'parse', 'build', 'corpus', 'lsp'];
const [name, ...args] = process.argv.slice(2);
const run = COMMANDS.includes(name) ? commands[name] : null;
if (name === '--version' || name === '-v' || name === 'version') {
  process.stdout.write(`${require('./tern.js').version}\n`);
} else if (!run) {
  const help = !name || name === 'help' || name === '--help' || name === '-h';
  (help ? process.stdout : process.stderr).write(`${help ? '' : `tern: unknown command "${name}"\n`}${commands.usage()}`);
  process.exitCode = help ? 0 : 2;
} else {
  new Promise((resolve) => resolve(run(args))).then(
    (code) => (process.exitCode = code || 0),
    (e) => {
      process.stderr.write(`tern ${name}: ${(e && e.message) || e}\n`);
      process.exitCode = 2;
    },
  );
}
