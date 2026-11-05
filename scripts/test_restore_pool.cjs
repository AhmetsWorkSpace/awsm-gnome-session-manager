'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'restoreSession.js'), 'utf8');
const start = source.indexOf('    _restoreCreatedWindow(');
const end = source.indexOf('    _isFirefoxSession(', start);
assert.ok(start >= 0 && end > start, 'restore method not found');
const Coordinator = new Function('restoreSessionObject', 'selectTitleMatch',
    `return class { ${source.slice(start, end)} }`);

async function main() {
    const {selectTitleMatch} = await import('../utils/titleMatcher.mjs');
    const app = {get_id: () => 'chromium.desktop'};
    const ip = {wm_class: 'chromium', window_title: 'example.test', monitor_number: 2};
    const diagnostic = {wm_class: 'chromium', window_title: 'Diagnostic messages', monitor_number: 1};
    const records = [ip, diagnostic];
    const queue = {saved_window_sessions: records};
    const shared = {restoringApps: new Map([[app, queue]])};
    const coordinator = new (Coordinator(shared, selectTitleMatch))();
    coordinator._isDestroyed = false;
    coordinator._adoptedWindowIds = new Set();
    coordinator._genericGroups = new Map([['chromium', {assignments: new Map()}]]);
    coordinator._getQueueForCreatedWindow = () => [app, queue];
    coordinator._log = {trace() {}, error(e) {throw e;}};
    coordinator._maybeDisconnectWindowCreatedRestoreSignal = () => {};
    coordinator._scheduleCreatedWindowRestore = () => {};
    let waiting = 0;
    coordinator._waitForBrowserTitle = () => { waiting++; };
    const placements = [];
    coordinator._enqueueWindowMove = async (window, [record]) => {
        placements.push([window.get_title(), record.monitor_number]);
        record.moved = true;
        return true;
    };
    const window = (id, title) => ({get_id: () => id, get_title: () => title,
        get_wm_class: () => 'chromium'});
    const first = window(1, 'Diagnostic messages');
    const second = window(2, 'example.test');
    coordinator._restoreCreatedWindow(first, 0);
    coordinator._restoreCreatedWindow(first, 0); // duplicate delivery must not consume another record
    await Promise.resolve();
    coordinator._restoreCreatedWindow(second, 0);
    await Promise.resolve();
    assert.deepEqual(placements, [['Diagnostic messages', 1], ['example.test', 2]]);
    console.log('[PASS] Out-of-order titles and duplicate event');

    // After timeout fallback consumes a record, a late duplicate cannot claim the next one.
    for (const record of records) { delete record.moved; delete record._awsmPlacementFinished; }
    shared.restoringApps.set(app, queue);
    coordinator._adoptedWindowIds.clear();
    placements.length = 0;
    const late = window(3, 'Chromium');
    coordinator._restoreCreatedWindow(late, 0);
    assert.equal(waiting, 1);
    coordinator._restoreCreatedWindow(late, 0, true);
    await Promise.resolve();
    coordinator._restoreCreatedWindow(late, 0, true);
    coordinator._restoreCreatedWindow(window(4, 'Diagnostic messages'), 0);
    await Promise.resolve();
    assert.deepEqual(placements, [['Chromium', 2], ['Diagnostic messages', 1]]);
    console.log('[PASS] Timeout fallback and late duplicate do not consume twice');

    // Snap's class must take the title-wait path, not immediate FIFO.
    const snapRecord = {wm_class: 'firefox_firefox', window_title: 'For All Mankind', monitor_number: 1};
    const snapQueue = {saved_window_sessions: [snapRecord]};
    coordinator._genericGroups.set('firefox_firefox', {assignments: new Map()});
    coordinator._getQueueForCreatedWindow = () => [app, snapQueue];
    const snapWindow = {get_id: () => 5, get_title: () => 'Mozilla Firefox',
        get_wm_class: () => 'firefox_firefox'};
    const before = placements.length;
    coordinator._restoreCreatedWindow(snapWindow, 0);
    assert.equal(waiting, 2);
    assert.equal(placements.length, before);
    console.log('[PASS] Snap Firefox generic title waits for matching title');

    const titles = [{window_title: 'For All Mankind 2. Sezon 5. Bölüm izle | Example'},
        {window_title: 'Other unique page'}];
    assert.equal(selectTitleMatch('For All Mankind 2. Sezon 6. Bölüm izle | Example', titles).matchType, 'FUZZY_SUBSTRING');
    assert.equal(selectTitleMatch(titles[0].window_title, titles).matchType, 'EXACT');
    assert.equal(selectTitleMatch('Mozilla Firefox', titles), null);
    assert.equal(selectTitleMatch('For All Mankind 2. Sezon 6. Bölüm',
        [titles[0], {window_title: 'For All Mankind 3. Sezon 1. Bölüm'}]), null);
    console.log('[PASS] Fuzzy titles, exact priority and ambiguous-title rejection');

    const budgetStart = source.indexOf('    _refreshGroupLaunchBudget(');
    const budgetEnd = source.indexOf('    async _restoreGroupedWindow(', budgetStart);
    assert.ok(budgetStart >= 0 && budgetEnd > budgetStart);
    let actors = [];
    const liveGlobal = {get_window_actors: () => actors};
    const Meta = {WindowType: {NORMAL: 0}};
    const UiHelper = {ignoreWindows: () => false};
    const Budget = new Function('global', 'Meta', 'UiHelper',
        `return class { ${source.slice(budgetStart, budgetEnd)} }`)(liveGlobal, Meta, UiHelper);
    const budget = new Budget();
    budget._log = {warn() {}};
    const group = {records: Array(6).fill({}), knownWindowIds: new Set(), outstandingLaunches: 1};
    actors = Array.from({length: 6}, (_, i) => ({meta_window: {
        get_id: () => i + 10, get_wm_class: () => 'firefox_firefox', get_window_type: () => 0,
    }}));
    assert.equal(budget._refreshGroupLaunchBudget(group, 'firefox_firefox'), true);
    assert.equal(group.budget, 0);
    assert.equal(group.outstandingLaunches, 0);
    console.log('[PASS] Self-restored windows reduce launch budget to zero');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
