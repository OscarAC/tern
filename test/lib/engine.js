// SPDX-License-Identifier: MIT
// Loads the engine under test: tern.js, or the file $TERN_ENGINE names
// (TERN_ENGINE=src/index.js runs the sources without a build).
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// {tern, why}: the engine, or null and why it did not load.
function load() {
  const file = process.env.TERN_ENGINE ? path.resolve(process.env.TERN_ENGINE) : path.join(ROOT, 'tern.js');
  try {
    return { tern: require(file), why: null };
  } catch (e) {
    return { tern: null, why: `cannot load ${path.relative(ROOT, file)}: ${e.message.split('\n')[0]}` };
  }
}

module.exports = { load, ROOT };
