'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'restoreSession.js'), 'utf8');
const start = source.indexOf('    _observePlacement(');
const end = source.indexOf('    async _finishStacking(', start);
assert.ok(start >= 0 && end > start);
let callback;
const GLib = {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
    timeout_add(_priority, delay, fn) { assert.equal(delay, 750); callback = fn; return 12; }};
const Coordinator = new Function('global', 'GLib', `return class { ${source.slice(start, end)} }`)
    ({display: {get_monitor_index_for_rect: () => 1}}, GLib);
async function main() {
    const coordinator = new Coordinator();
    coordinator._pendingPlacementObservations = new Set();
    coordinator._log = {warn() {}};
    const window = {get_frame_rect: () => ({x: 2, y: 3, width: 800, height: 600}),
        is_maximized: () => false, is_fullscreen: () => false, minimized: false};
    const record = {monitor_number: 1, fullscreen: false, minimized: false, maximized: false,
        window_position: {x_offset: 2, y_offset: 3, width: 800, height: 600}};
    const good = coordinator._observePlacement(window, record);
    callback();
    assert.equal(await good, true);
    assert.equal(coordinator._pendingPlacementObservations.size, 0);
    const bad = coordinator._observePlacement(window, {...record, monitor_number: 2});
    callback();
    assert.equal(await bad, false);
    console.log('[PASS] Placement observation requires matching monitor, geometry and states');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
