'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'restoreSession.js'), 'utf8');
const start = source.indexOf('    async _finishStacking(');
const end = source.indexOf('    _ensureWindowCreatedRestoreSignal(', start);
assert.ok(start >= 0 && end > start);
let timeout;
const GLib = {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
    timeout_add(_priority, _delay, fn) { timeout = fn; return 42; }, Source: {remove() {}}};
const Coordinator = new Function('global', 'GLib', `return class { ${source.slice(start, end)} }`)
    ({get_current_time: () => 123}, GLib);

async function main() {
    const {TargetBarrier} = await import('../utils/targetBarrier.mjs');
    const coordinator = new Coordinator();
    const events = [];
    const back = {stack_index: 0};
    const front = {stack_index: 4, is_focused: true};
    const missing = {stack_index: 2};
    const win = name => ({minimized: false, raise: () => events.push(`raise-${name}`),
        activate: time => events.push(`focus-${name}-${time}`)});
    coordinator._isDestroyed = false;
    coordinator._activePlacementMoves = 0;
    coordinator._restoredWindowMap = new Map([[front, win('front')], [back, win('back')]]);
    coordinator._targetBarrier = new TargetBarrier([front, back, missing]);
    let warnings = 0;
    coordinator._log = {warn() { warnings++; }};
    const pending = coordinator._finishStacking([front, back, missing]);
    coordinator._targetBarrier.settle(front, 'PLACED');
    coordinator._targetBarrier.settle(back, 'PLACED');
    await Promise.resolve();
    assert.deepEqual(events, [], 'stacking ran before all targets were terminal');
    timeout();
    await pending;
    assert.equal(coordinator._targetBarrier.states.get(missing), 'TIMED_OUT');
    assert.deepEqual(events, ['raise-back', 'raise-front', 'focus-front-123']);
    assert.equal(warnings, 1);
    assert.equal(coordinator._targetBarrier.settle(missing, 'PLACED'), false);
    events.length = 0;
    coordinator._targetBarrier = new TargetBarrier([back]);
    coordinator._activePlacementMoves = 1;
    const blocked = coordinator._finishStacking([back]);
    timeout();
    await blocked;
    assert.deepEqual(events, [], 'stacking ran with a timed-out move still in flight');
    coordinator._isDestroyed = true;
    await coordinator._finishStacking([front, back]);
    assert.deepEqual(events, []);
    console.log('[PASS] Terminal-state barrier, timeout, late settlement and cancellation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
