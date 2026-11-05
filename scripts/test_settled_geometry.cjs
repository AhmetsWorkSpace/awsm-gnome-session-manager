'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'moveSession.js'), 'utf8');
const start = source.indexOf('    _scheduleSettledGeometry(');
const end = source.indexOf('    _changeWorkspace(', start);
assert.ok(start >= 0 && end > start);
let callback;
const GLib = {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
    timeout_add(_priority, delay, fn) { assert.equal(delay, 750); callback = fn; return 42; }};
const Mover = new Function('GLib', 'getMonitorForFrame', `return class { ${source.slice(start, end)} }`)
    (GLib, () => 2);
const mover = new Mover();
let logged;
mover._sourceIds = [];
mover._log = {trace(_source, operation, details) { logged = {operation, ...JSON.parse(details)}; }, debug() {}};
const window = {get_id: () => 10, get_title: () => 'Window',
    get_frame_rect: () => ({x: 1, y: 2, width: 3, height: 4}),
    is_maximized: () => true, is_fullscreen: () => false, minimized: false};
mover._scheduleSettledGeometry(window);
assert.deepEqual(mover._sourceIds, [42]);
callback();
assert.deepEqual(mover._sourceIds, []);
assert.equal(logged.operation, 'geometry-settled');
assert.equal(logged.window_id, 10);
assert.equal(logged.monitor, 2);
assert.equal(logged.is_maximized, true);
console.log('[PASS] Delayed geometry observation and source cleanup');
