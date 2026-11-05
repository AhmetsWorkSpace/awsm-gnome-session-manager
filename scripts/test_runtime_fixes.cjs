'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
function method(file, from, to) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
}

async function main() {
    const moveMethod = method('moveSession.js', '    async _moveWindowByMetaWindow(', '    _changeWorkspace(');
    const Mover = new Function('UiHelper', `return class { ${moveMethod} }`)({ignoreWindows: () => false});
    const mover = new Mover();
    mover._movingWindows = new WeakSet();
    mover._log = {warn() {}, error(e) { throw e; }};
    let release;
    mover._waitForWindowReady = () => new Promise(resolve => { release = resolve; });
    const window = {};
    const first = mover._moveWindowByMetaWindow(window, [{}], false);
    await mover._moveWindowByMetaWindow(window, [{}], false);
    assert.equal(mover._movingWindows.has(window), true, 'second call released first call lock');
    await mover._moveWindowByMetaWindow(window, [{}], false);
    assert.equal(mover._movingWindows.has(window), true, 'third call released first call lock');
    mover._getOneMatchedSavedWindow = () => null;
    release(true);
    await first;
    assert.equal(mover._movingWindows.has(window), false);
    console.log('[PASS] Reentrant calls preserve the original window lock');

    const restoreMethod = method('restoreSession.js', '    async _restoreOneSession(', '    async _moveExistingWindows(');
    const shared = {restoringApps: new Map()};
    let received;
    const Gio = {SubprocessFlags: {NONE: 0}, Subprocess: {new(argv, flags) {
        received = {argv, flags};
        return {get_identifier: () => '4312'};
    }}};
    const Restore = new Function('Gio', 'restoreSessionObject', 'global', 'logError',
        `return class { ${restoreMethod} }`)(Gio, shared, {notify_error() {}}, () => {});
    const restore = new Restore();
    restore._lookupShellApp = () => null;
    restore._log = {info() {}, warn() {}, error() {}};
    const argv = ['/opt/with space/app', 'hello world', '$(not-executed)', "quote'\"" ];
    const session = {app_name: 'test', cmd: argv, cmd_argv_verified: true};
    assert.deepEqual(await restore._restoreOneSession(session), [true, false]);
    assert.deepEqual(received.argv, argv);
    assert.deepEqual(shared.restoringApps.get(4312).saved_window_sessions, [session]);
    console.log('[PASS] Direct subprocess receives unchanged argv and registers PID');

    const fileMethod = method('restoreSession.js', '    async restoreSessionFromFile(', '    async restorePreviousSession(');
    const records = [{app_name: 'broken'}, {app_name: 'following'}];
    const fakeGio = {File: {new_for_path: () => ({load_contents: () => [true, 'data']})}};
    const FakeBarrier = class { constructor() { this.closed = false; } settle() {} };
    const Loader = new Function('Gio', 'FileUtils', 'global', 'GLib', 'DateUtils', 'TargetBarrier',
        `return class { ${fileMethod} }`)(fakeGio,
        {getJsonObj: () => ({x_session_config_objects: records})}, {}, {}, {}, FakeBarrier);
    const loader = new Loader();
    loader._isDestroyed = false;
    loader._log = {trace() {}, error() {}};
    loader._prepareWindowGroups = () => {};
    loader._ensureWindowCreatedRestoreSignal = () => {};
    loader._maybeDisconnectWindowCreatedRestoreSignal = () => {};
    loader._finishStacking = async () => {};
    loader._waitRestoreInterval = async () => true;
    const visited = [];
    loader._restoreOneSession = async record => {
        visited.push(record.app_name);
        if (record.app_name === 'broken') throw new Error('synthetic failure');
        return [false, false];
    };
    await loader.restoreSessionFromFile('/unused');
    assert.deepEqual(visited, ['broken', 'following']);
    console.log('[PASS] Per-record failure does not stop later records');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
