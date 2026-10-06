'use strict';
/*
 * Small filesystem helpers shared by the modules that persist state.
 */
const fs = require('fs');

function atomicWrite(file, data, mode) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
  if (mode) {
    try {
      fs.chmodSync(file, mode);
    } catch (err) {
      /* ignore */
    }
  }
}

module.exports = { atomicWrite };
