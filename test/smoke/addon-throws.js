// SPDX-License-Identifier: MIT
// An add-on of test/smoke/addon-throws.html that throws at its top level,
// after declaring `kept`.
tern.block('kept', { tag: 'aside' });
throw new Error('addon-boom');
