'use strict';

import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as FileUtils from './utils/fileUtils.js';
import * as Log from './utils/log.js';
import {PrefsUtils} from './utils/prefsUtils.js';
import * as DateUtils from './utils/dateUtils.js';
import * as MoveSession from './moveSession.js';
import * as UiHelper from './ui/uiHelper.js';
import {selectTitleMatch} from './utils/titleMatcher.mjs';
import {TargetBarrier} from './utils/targetBarrier.mjs';


export const restoreSessionObject = {
    // All launching apps by Shell.App#launch()
    restoringApps: new Map()
}

export const RestoreSession = class {

    constructor() {
        this._log = new Log.Log();
        this._settings = PrefsUtils.getSettings();
        this._isDestroyed = false;

        // indicator.destroy() clears the shared queue during disable. A new
        // extension instance must always start with a usable queue.
        if (!restoreSessionObject.restoringApps) {
            restoreSessionObject.restoringApps = new Map();
        }

        this.sessionName = FileUtils.default_sessionName;
        this._defaultAppSystem = Shell.AppSystem.get_default();
        this._windowTracker = Shell.WindowTracker.get_default();   
        this._moveSession = new MoveSession.MoveSession();

        this._restore_session_interval = Math.max(200, this._settings.get_int('restore-session-interval'));
        this._windowMoveQueue = Promise.resolve();
        this._pendingStaggerWaits = new Set();

        // TODO Add to Preferences?
        // Launch apps using discrete graphics card might cause issues, like the white main window of superproductivity
        this._useDiscreteGraphicsCard = false;

        // All launched apps info by Shell.App#launch()
        this._restoredApps = new Map();
        this._launchedApps = new Set();
        this._adoptedApps = new Set();
        this._genericGroups = null;
        this._adoptedWindowIds = new Set();
        this._restoredWindowMap = new Map();
        this._targetBarrier = null;
        this._pendingPlacementObservations = new Set();
        this._activePlacementMoves = 0;

        this._display = global.display;

        this._connectIds = [];
        this._windowRestoreRetryIds = new Set();
        this._pendingTitleWaits = new Map();
        this._windowCreatedSignalId = 0;
        this._restoreBatchInProgress = false;
    }

    /**
     * Restore workspaces and make them persistent, etc
     */
    static restoreFromSummary() {
        Log.Log.getDefault().debug(`Prepare to restore summary`);
        FileUtils.loadSummary().then(([summary, path]) => {
            Log.Log.getDefault().info(`Restoring summary from ${path}`);
            const savedNWorkspace = summary.n_workspace;
            const workspaceManager = global.workspace_manager;
            const currentNWorkspace = workspaceManager.n_workspaces;
            const moreWorkspace = savedNWorkspace - currentNWorkspace;
            if (moreWorkspace) {
                for (let i = currentNWorkspace; i <= savedNWorkspace; i++) {
                    workspaceManager.append_new_workspace(false, DateUtils.get_current_time());
                    workspaceManager.get_workspace_by_index(i)._keepAliveId = true;
                }
            }
        }).catch(e => Log.Log.getDefault().error(e));
    }

    restoreSession(sessionName) {
        if (!sessionName) {
            sessionName = this.sessionName;
        }
        
        const sessions_path = FileUtils.get_sessions_path();
        const session_file_path = GLib.build_filenamev([sessions_path, sessionName]);
        if (!GLib.file_test(session_file_path, GLib.FileTest.EXISTS)) {
            logError(new Error(`Session file not found: ${session_file_path}`));
            return;
        }

        this._log.info(`Restoring saved session from ${session_file_path}`);
        try {
            this.restoreSessionFromFile(session_file_path);
        } catch (e) {
            logError(e, `Failed to restore ${session_file_path}`);
        }
    }

    async restoreSessionFromFile(session_file_path) {
        if (this._restoreSessionTimeoutId) {
            GLib.Source.remove(this._restoreSessionTimeoutId);
            this._restoreSessionTimeoutId = 0;
        }

        const session_file = Gio.File.new_for_path(session_file_path);
        let [success, contents] = session_file.load_contents(null);
        if (!success) {
            return;
        }

        let session_config = FileUtils.getJsonObj(contents);
        let session_config_objects = session_config.x_session_config_objects;
        if (!(session_config_objects && session_config_objects.length)) {
            this._log.error(new Error(`Session details not found: ${session_file_path}`));
            global.notify_error(`No session to restore from ${session_file_path}`, `session config is empty.`);
            return;
        }
        if (this._restoreBatchInProgress || (this._targetBarrier && !this._targetBarrier.closed)) {
            this._log.warn('A restore is already in progress; refusing an overlapping restore');
            return;
        }
        this._targetBarrier = new TargetBarrier(session_config_objects);

        // Snapshot the existing windows before starting any application.
        // Keep a fixed launch budget for this restore, regardless of how
        // quickly Firefox creates additional windows.
        this._prepareWindowGroups(session_config_objects);

        this._ensureWindowCreatedRestoreSignal();
        this._restoreBatchInProgress = true;

        this._log.trace(
            'restoreSession.js',
            'session-read',
            JSON.stringify({
                session_file: session_file_path,
                window_count: session_config_objects.length,
            }));

        try {
            for (const session of session_config_objects) {
                if (this._isDestroyed) break;
                try {
                    if (session.moved || session._awsmRestoreInFlight) continue;
                    const [launched, running] = await this._restoreOneSession(session);
                    if (launched && !running && !await this._waitForPlacement(session)) {
                        if (!this._isDestroyed)
                            this._log.warn('Window placement timeout; continuing with the next record');
                    }
                } catch (error) {
                    if (!this._isDestroyed)
                        this._log.error(error, `Failed to restore ${session.app_name ?? 'window'}; continuing`);
                    this._targetBarrier?.settle(session, 'FAILED');
                }
                if (!await this._waitRestoreInterval()) break;
            }
            if (!this._isDestroyed && Number.isInteger(session_config.active_workspace_index) &&
                session_config.active_workspace_index >= 0) {
                const workspace = global.workspace_manager.get_workspace_by_index(session_config.active_workspace_index);
                if (workspace) workspace.activate(DateUtils.get_current_time());
            }
            await this._finishStacking(session_config_objects);
        } catch (error) {
            if (!this._isDestroyed) this._log.error(error, 'Failed during sequential restore');
        } finally {
            this._restoreBatchInProgress = false;
            this._maybeDisconnectWindowCreatedRestoreSignal();
        }
    }

    async restorePreviousSession(removeAfterRestore) {
        if (this._restoreBatchInProgress) {
            this._log.warn('A restore is already in progress; refusing an overlapping restore');
            return;
        }
        this._targetBarrier = null;
        this._restoreBatchInProgress = true;
        try {
            this._log.info(`Restoring the previous session from ${FileUtils.current_session_path}`);
            this._ensureWindowCreatedRestoreSignal();

            const ignoringParentFolders = [
                GLib.build_filenamev([FileUtils.current_session_path, 'null']),
            ];
            const ignoringFilePaths = [
                GLib.build_filenamev([FileUtils.current_session_path, 'summary.json'])
            ];
            const sessionPaths = [];
            await FileUtils.listAllSessions(FileUtils.current_session_path, true, (file, info) => {
                const contentType = info.get_content_type();
                if (contentType !== 'application/json') {
                    return;
                }
                if (ignoringParentFolders.includes(file.get_parent().get_path())) {
                    return;
                }
                if (ignoringFilePaths.includes(file.get_path())) {
                    return;
                }
                sessionPaths.push(file.get_path());
            });

            // Keep same-application window records ordered. Parallel file
            // callbacks can otherwise race and scramble the restore queue.
            sessionPaths.sort();
            const previousSessions = [];
            for (const path of sessionPaths) {
                try {
                    const loaded = await FileUtils.loadFile(path);
                    if (!loaded) continue;
                    const [sessionConfig] = loaded;
                    sessionConfig._file_path = path;
                    previousSessions.push(sessionConfig);
                } catch (e) {
                    this._log.error(e, `Failed to load ${path}`);
                }
            }
            this._prepareWindowGroups(previousSessions);
            for (const sessionConfig of previousSessions) {
                try {
                    if (!await this._waitRestoreInterval()) break;
                    const [launched, running] = await this._restoreOneSession(sessionConfig);
                    if (removeAfterRestore && launched && !running) {
                        this._log.debug(`Restored ${sessionConfig.window_title}(${sessionConfig.app_name}), cleaning ${sessionConfig._file_path}`);
                        FileUtils.removeFile(sessionConfig._file_path);
                    }
                } catch (e) {
                    this._log.error(e, `Failed to restore ${sessionConfig._file_path}`);
                }
            }
        } catch (error) {
            this._log.error(error);
        } finally {
            this._restoreBatchInProgress = false;
            this._maybeDisconnectWindowCreatedRestoreSignal();
        }
    }

    async _restoreOneSession(session_config_object) {
        const app_name = session_config_object.app_name;
        let launched = false;
        let running = false;
        try {
            return await new Promise((resolve, reject) => {
                const shell_app = this._lookupShellApp(session_config_object);
                if (shell_app) {
                    let shellAppData = restoreSessionObject.restoringApps.get(shell_app);
                    if (shellAppData) {
                        if (!shellAppData.saved_window_sessions.includes(session_config_object))
                            shellAppData.saved_window_sessions.push(session_config_object);
                    } else {
                        shellAppData = {
                            saved_window_sessions: [session_config_object]
                        };
                        restoreSessionObject.restoringApps.set(shell_app, shellAppData);
                    }

                    this._log.trace(
                        'restoreSession.js',
                        'fifo-enqueue',
                        JSON.stringify({
                            app: app_name,
                            title: session_config_object.window_title,
                            desktop_file_id: session_config_object.desktop_file_id,
                            queue_key: shell_app.get_id(),
                            queue_length: shellAppData.saved_window_sessions.length,
                        }));

                    if (this._genericGroups?.has(session_config_object.wm_class)) {
                        shellAppData.coordinated = true;
                        this._restoreGroupedWindow(shell_app, shellAppData, session_config_object)
                            .then(resolve, reject);
                        return;
                    }
                    
                    const desktopNumber = session_config_object.desktop_number;
                    const wasRunning = this._appIsRunning(shell_app);
                    [launched, running] = this.launch(shell_app, desktopNumber, session_config_object);
                    if (launched) {
                        if (!running) {
                            this._log.info(`${app_name} has been launched! Preparing to restore window ${session_config_object.window_title}(${app_name})!`);
                        }
                        const existingShellAppData = this._restoredApps.get(shell_app);
                        if (existingShellAppData) {
                            existingShellAppData.saved_window_sessions.push(session_config_object);
                        } else {
                            this._restoredApps.set(shell_app, {
                                saved_window_sessions: [session_config_object]
                            });
                        }

                        if (running || wasRunning) {
                            this._moveExistingWindows(shell_app, shellAppData.saved_window_sessions)
                                .then(() => resolve([launched, running]))
                                .catch(error => {
                                    this._log.error(error, `Failed to adopt existing ${app_name} windows`);
                                    resolve([launched, running]);
                                });
                            return;
                        }
                    } else {
                        const queuedIndex = shellAppData.saved_window_sessions.indexOf(session_config_object);
                        if (queuedIndex >= 0) {
                            shellAppData.saved_window_sessions.splice(queuedIndex, 1);
                        }
                        if (shellAppData.saved_window_sessions.length === 0) {
                            restoreSessionObject.restoringApps.delete(shell_app);
                        }
                        this._maybeDisconnectWindowCreatedRestoreSignal();
                        this._log.error(`Failed to launch ${app_name}`, `Failed to launch ${app_name}`);
                        global.notify_error(`Failed to launch ${app_name}`, `Failed to launch ${app_name}`);
                    }
                    resolve([launched, running]);
                } else {
                    // https://gjs-docs.gnome.org/gio20~2.0/gio.subprocesslauncher#method-set_environ
                    // TODO Support snap apps
                    
                    const cmd = session_config_object.cmd;
                    if (cmd && cmd.length) {
                        if (session_config_object.cmd_argv_verified !== true ||
                            !Array.isArray(cmd) || !cmd.every(arg => typeof arg === 'string' && !arg.includes('\0')) ||
                            !cmd[0] || (cmd[0].startsWith('/snap/') && !cmd[0].startsWith('/snap/bin/'))) {
                            const error = new Error('Refusing unsafe or unverified command line; desktop application lookup failed.');
                            this._log.error(error);
                            global.notify_error(`Failed to launch ${app_name}`, error.message);
                            resolve([false, running]);
                            return;
                        }
                        const process = Gio.Subprocess.new(cmd, Gio.SubprocessFlags.NONE);
                        const pid = Number(process.get_identifier());
                        if (!Number.isSafeInteger(pid) || pid <= 0) {
                            this._log.warn(`No usable process id for ${app_name}; window matching may fail`);
                            resolve([true, false]);
                            return;
                        }
                        const existing = restoreSessionObject.restoringApps.get(pid);
                        if (existing)
                            existing.saved_window_sessions.push(session_config_object);
                        else
                            restoreSessionObject.restoringApps.set(pid, {
                                saved_window_sessions: [session_config_object],
                            });
                        this._log.info(`Launched ${app_name} with a direct argument vector (PID ${pid})`);
                        resolve([true, false]);
                    } else {
                        // TODO try to launch via app_info by searching the app name?
                        let errorMsg = `Failed to launch ${app_name} via command line`;
                        let errorDetail = `Can't restore this app from ${session_config_object._file_path}: Invalid command line: ${cmd}.`;
                        this._log.error(errorMsg, errorDetail);
                        global.notify_error(errorMsg, errorDetail);
                        resolve([launched, running]);
                    }
                }
            });
        } catch (e) {
            logError(e, `Failed to restore ${app_name}`);
            if (!launched) {
                global.notify_error(`Failed to restore ${app_name}`, e.message);
            }
            return [launched, running];
        }
    }

    async _moveExistingWindows(shellApp, savedWindowSessions) {
        try {
            for (const metaWindow of shellApp.get_windows()) {
                await this._enqueueWindowMove(metaWindow, savedWindowSessions, true);
                if (this._isDestroyed) return;
            }
            this._maybeDisconnectWindowCreatedRestoreSignal();
        } catch (e) {
            this._log.error(e, `Failed to move already-running windows for ${shellApp.get_name()}`);
        }
    }

    _prepareWindowGroups(sessionItems) {
        this._genericGroups = new Map();
        this._adoptedWindowIds.clear();
        this._restoredWindowMap.clear();
        const live = new Map();
        let reliable = true;
        const sources = [
            () => global.get_window_actors().map(actor => actor.meta_window),
            () => global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null),
        ];
        for (const collect of sources) {
            try {
                for (const window of collect()) {
                    if (window && window.get_wm_class() &&
                        window.get_window_type() === Meta.WindowType.NORMAL && !UiHelper.ignoreWindows(window))
                        live.set(window.get_id(), window);
                }
            } catch (error) {
                reliable = false;
                this._log.warn(`Window enumeration failed: ${error.message}`);
            }
        }
        for (const item of sessionItems) {
            if (!item.wm_class) continue;
            if (!this._genericGroups.has(item.wm_class)) {
                this._genericGroups.set(item.wm_class, {
                    records: [], windows: [...live.values()].filter(w => w.get_wm_class() === item.wm_class),
                    assignments: new Map(), reliable, started: false,
                    knownWindowIds: new Set(), outstandingLaunches: 0, startupUntil: 0,
                });
            }
            this._genericGroups.get(item.wm_class).records.push(item);
        }
        for (const [wmClass, group] of this._genericGroups) {
            group.budget = Math.max(0, group.records.length - group.windows.length);
            group.started = group.windows.length > 0;
            for (const window of group.windows) group.knownWindowIds.add(window.get_id());
            for (const record of group.records) {
                if (!this._isUsefulFirefoxTitle(record.window_title)) continue;
                const index = group.windows.findIndex(window => window.get_title() === record.window_title);
                if (index >= 0) group.assignments.set(record, group.windows.splice(index, 1)[0]);
            }
            if (/firefox|chromium|chrome/i.test(wmClass)) {
                for (const window of [...group.windows]) {
                    const candidates = group.records.filter(record => !group.assignments.has(record));
                    const match = selectTitleMatch(window.get_title(), candidates);
                    if (!match) continue;
                    group.assignments.set(match.record, window);
                    group.windows.splice(group.windows.indexOf(window), 1);
                }
            }
            // Register the complete target pool before any application launches.
            for (const record of group.records) {
                const app = this._lookupShellApp(record);
                if (!app) continue;
                let data = restoreSessionObject.restoringApps.get(app);
                if (!data) {
                    data = {saved_window_sessions: [], coordinated: true};
                    restoreSessionObject.restoringApps.set(app, data);
                }
                data.coordinated = true;
                if (!data.saved_window_sessions.includes(record))
                    data.saved_window_sessions.push(record);
            }
            this._log.trace('restoreSession.js', 'window-group', JSON.stringify({
                wm_class: wmClass, target: group.records.length,
                existing: group.windows.length + group.assignments.size,
                launch_budget: group.budget, reliable: group.reliable,
            }));
        }
    }

    _refreshGroupLaunchBudget(group, wmClass) {
        try {
            const live = new Map();
            for (const actor of global.get_window_actors()) {
                const window = actor.meta_window;
                if (window && window.get_wm_class() === wmClass &&
                    window.get_window_type() === Meta.WindowType.NORMAL && !UiHelper.ignoreWindows(window))
                    live.set(window.get_id(), window);
            }
            for (const id of live.keys()) {
                if (!group.knownWindowIds.has(id)) {
                    group.knownWindowIds.add(id);
                    if (group.outstandingLaunches > 0) group.outstandingLaunches--;
                }
            }
            group.budget = Math.max(0, group.records.length - live.size - group.outstandingLaunches);
            return true;
        } catch (error) {
            this._log.warn(`Cannot refresh live windows for ${wmClass}: ${error.message}`);
            return false;
        }
    }

    async _restoreGroupedWindow(shellApp, queueData, savedWindowSession) {
        const group = this._genericGroups.get(savedWindowSession.wm_class);
        let window = group.assignments.get(savedWindowSession);
        group.assignments.delete(savedWindowSession);
        if (window && this._adoptedWindowIds.has(window.get_id())) window = null;
        while (!window && group.windows.length) {
            const candidate = group.windows.shift();
            if (!this._adoptedWindowIds.has(candidate.get_id())) window = candidate;
        }
        if (window) {
            this._adoptedWindowIds.add(window.get_id());
            savedWindowSession._awsmRestoreInFlight = window;
            try {
                const isBrowser = /firefox|chromium|chrome/i.test(savedWindowSession.wm_class ?? '');
                const match = selectTitleMatch(window.get_title(), [savedWindowSession], isBrowser);
                this._log.trace('restoreSession.js', 'window-adoption', JSON.stringify({
                    window_id: window.get_id(), title: window.get_title(),
                    saved_title: savedWindowSession.window_title,
                    match_type: match?.matchType ?? 'FIFO_FALLBACK',
                }));
                const moved = await this._enqueueWindowMove(window, [savedWindowSession], false);
                return [Boolean(moved), true];
            } finally {
                delete savedWindowSession._awsmRestoreInFlight;
            }
        }
        let launched = false;
        try {
            while (group.startupUntil > GLib.get_monotonic_time()) {
                if (!await this._waitRestoreInterval()) return [false, false];
            }
            if (savedWindowSession.moved || savedWindowSession._awsmRestoreInFlight)
                return [false, true];
            if (group.reliable && this._refreshGroupLaunchBudget(group, savedWindowSession.wm_class) && group.budget > 0) {
                if (!group.started && !this._appIsRunning(shellApp)) {
                    launched = Boolean(shellApp.launch(0, savedWindowSession.desktop_number, this._getProperGpuPref(shellApp)));
                    if (launched) group.startupUntil = GLib.get_monotonic_time() + 3 * GLib.USEC_PER_SEC;
                } else if (shellApp.can_open_new_window()) {
                    shellApp.open_new_window(savedWindowSession.desktop_number);
                    launched = true;
                } else {
                    this._log.warn(`Cannot request another window for ${shellApp.get_name()}`);
                }
                if (launched) group.outstandingLaunches++;
                group.started ||= launched;
            }
        } catch (error) {
            this._log.error(error, `Failed to launch ${shellApp.get_name()}`);
        }
        return [launched, false];
    }

    _isUsefulFirefoxTitle(title) {
        return typeof title === 'string' && title.trim() !== '' &&
            !/^(mozilla firefox|firefox)$/i.test(title.trim());
    }

    _waitRestoreInterval() {
        if (this._isDestroyed) return Promise.resolve(false);
        return new Promise(resolve => {
            const wait = {id: 0, resolve};
            wait.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._restore_session_interval, () => {
                this._pendingStaggerWaits.delete(wait);
                resolve(!this._isDestroyed);
                return GLib.SOURCE_REMOVE;
            });
            this._pendingStaggerWaits.add(wait);
        });
    }

    async _waitForPlacement(session) {
        // Bounded wait: a launch acknowledgement alone is not a mapped window.
        for (let attempt = 0; attempt < 40 && !session._awsmPlacementFinished; attempt++) {
            if (!await this._waitRestoreInterval()) return false;
        }
        if (!session._awsmPlacementFinished && !this._isDestroyed)
            this._log.warn(`Timed out waiting for window placement: ${session.app_name}`);
        return Boolean(session._awsmPlacementFinished);
    }

    _enqueueWindowMove(metaWindow, savedWindowSessions, preferTitle) {
        const move = this._windowMoveQueue.then(async () => {
            if (!await this._waitRestoreInterval() || this._isDestroyed) return false;
            const record = savedWindowSessions.length === 1 ? savedWindowSessions[0] : null;
            const barrier = this._targetBarrier?.states.has(record) ? this._targetBarrier : null;
            if (barrier?.closed) {
                this._log.trace('restoreSession.js', 'late-window-ignored', JSON.stringify({window_id: metaWindow.get_id()}));
                return false;
            }
            this._activePlacementMoves++;
            try {
                const moved = await this._moveSession.moveWindowByMetaWindow(metaWindow, savedWindowSessions, preferTitle);
                if (moved && record) {
                    this._restoredWindowMap.set(record, metaWindow);
                    if (barrier && !barrier.closed) {
                        const confirmed = await this._observePlacement(metaWindow, record);
                        barrier.settle(record, confirmed ? 'PLACED' : 'TIMED_OUT');
                    }
                }
                return moved;
            } finally {
                this._activePlacementMoves--;
            }
        });
        // Keep the queue usable even if one window disappears during a move.
        this._windowMoveQueue = move.catch(error => {
            if (!this._isDestroyed) this._log.error(error, 'Failed to move a queued window');
        });
        return move;
    }

    _observePlacement(window, record) {
        return new Promise(resolve => {
            const observation = {id: 0, resolve};
            observation.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 750, () => {
                this._pendingPlacementObservations.delete(observation);
                let confirmed = false;
                try {
                    const rect = window.get_frame_rect();
                    const wanted = record.window_position;
                    const monitor = global.display.get_monitor_index_for_rect(rect);
                    const expectedMonitor = record.monitor_number;
                    const geometryMatches = wanted && ['x_offset', 'y_offset', 'width', 'height'].every(
                        (key, index) => Number(wanted[key]) === [rect.x, rect.y, rect.width, rect.height][index]);
                    const maximized = typeof window.is_maximized === 'function'
                        ? window.is_maximized() : Boolean(window.get_maximized());
                    confirmed = Number.isInteger(expectedMonitor) && monitor === expectedMonitor &&
                        geometryMatches && (typeof record.fullscreen !== 'boolean' || window.is_fullscreen() === record.fullscreen) &&
                        (typeof record.minimized !== 'boolean' || window.minimized === record.minimized) &&
                        (typeof record.maximized !== 'boolean' || maximized === record.maximized);
                } catch (error) {
                    if (!this._isDestroyed) this._log.warn(`Placement observation failed: ${error.message}`);
                }
                resolve(confirmed);
                return GLib.SOURCE_REMOVE;
            });
            this._pendingPlacementObservations.add(observation);
        });
    }

    async _finishStacking(records) {
        const targets = records.filter(record => Number.isInteger(record.stack_index) && record.stack_index >= 0);
        const barrier = this._targetBarrier;
        if (!barrier || this._isDestroyed) return;
        let timeoutId = 0;
        if (!barrier.closed) timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            timeoutId = 0;
            barrier.close();
            return GLib.SOURCE_REMOVE;
        });
        const states = await barrier.promise;
        if (timeoutId) GLib.Source.remove(timeoutId);
        if (this._isDestroyed || !targets.length) return;
        if (this._activePlacementMoves) {
            this._log.warn('Skipping stacking: a timed-out window move is still in progress');
            return;
        }
        const available = targets.filter(record => states.get(record) === 'PLACED' && this._restoredWindowMap.has(record))
            .sort((a, b) => a.stack_index - b.stack_index);
        if (available.length !== targets.length)
            this._log.warn(`Stacking is partial: ${available.length}/${targets.length} windows available`);
        for (const record of available) {
            try {
                const window = this._restoredWindowMap.get(record);
                if (!window._aboutToClose && !window.minimized) window.raise();
            } catch (error) {
                this._log.warn(`Cannot restore window stacking: ${error.message}`);
            }
        }
        const focused = available.find(record => record.is_focused && !record.minimized);
        if (focused) {
            try {
                const window = this._restoredWindowMap.get(focused);
                if (!window._aboutToClose && !window.minimized) window.activate(global.get_current_time());
            } catch (error) {
                this._log.warn(`Cannot restore window focus: ${error.message}`);
            }
        }
    }

    _ensureWindowCreatedRestoreSignal() {
        if (this._windowCreatedSignalId || this._isDestroyed) {
            return;
        }

        this._windowCreatedSignalId = this._display.connect('window-created', (_display, metaWindow) => {
            this._scheduleCreatedWindowRestore(metaWindow);
        });
    }

    _maybeDisconnectWindowCreatedRestoreSignal() {
        const hasPendingWindows = Array.from(restoreSessionObject.restoringApps?.values() ?? [])
            .some(queueData => queueData?.saved_window_sessions?.some(session => !session.moved));
        if (!this._windowCreatedSignalId || hasPendingWindows || this._restoreBatchInProgress) {
            return;
        }

        try {
            this._display.disconnect(this._windowCreatedSignalId);
        } catch (e) {
            // The display may already be disposing during extension teardown.
        }
        this._windowCreatedSignalId = 0;
    }

    _scheduleCreatedWindowRestore(metaWindow, attempt = 0) {
        if (this._isDestroyed || !metaWindow || !restoreSessionObject.restoringApps?.size) {
            return;
        }

        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, attempt === 0 ? 0 : 75, () => {
            this._windowRestoreRetryIds.delete(sourceId);
            this._restoreCreatedWindow(metaWindow, attempt);
            return GLib.SOURCE_REMOVE;
        });
        this._windowRestoreRetryIds.add(sourceId);
    }

    _getQueueForCreatedWindow(metaWindow) {
        let shellApp = null;
        try {
            shellApp = this._windowTracker.get_window_app(metaWindow);
        } catch (e) {
            // The Shell app may not be associated during the first window-created callback.
        }

        if (shellApp) {
            const directData = restoreSessionObject.restoringApps.get(shellApp);
            if (directData?.saved_window_sessions?.some(session =>
                !session.moved && !session._awsmRestoreInFlight)) {
                return [shellApp, directData];
            }
        }

        let windowWmClass = null;
        try {
            windowWmClass = metaWindow.get_wm_class();
        } catch (e) {
            return [null, null];
        }

        for (const [queueKey, queueData] of restoreSessionObject.restoringApps) {
            const hasMatch = queueData?.saved_window_sessions?.some(session =>
                !session.moved && !session._awsmRestoreInFlight &&
                session.wm_class && session.wm_class === windowWmClass);
            if (hasMatch) {
                return [queueKey, queueData];
            }
        }
        return [null, null];
    }

    _waitForBrowserTitle(metaWindow, attempt) {
        if (this._pendingTitleWaits.has(metaWindow)) return;
        const wait = {titleId: 0, unmanagingId: 0, timeoutId: 0};
        const finish = (resume, timeoutFired = false) => {
            if (this._pendingTitleWaits.get(metaWindow) !== wait) return;
            this._pendingTitleWaits.delete(metaWindow);
            if (wait.timeoutId && !timeoutFired) GLib.Source.remove(wait.timeoutId);
            for (const id of [wait.titleId, wait.unmanagingId]) {
                if (id) {
                    try { metaWindow.disconnect(id); } catch (e) {}
                }
            }
            if (resume && !this._isDestroyed)
                this._restoreCreatedWindow(metaWindow, attempt, true);
        };
        this._pendingTitleWaits.set(metaWindow, wait);
        try {
            wait.titleId = metaWindow.connect('notify::title', () => {
                const title = metaWindow.get_title()?.trim();
                const [, data] = this._getQueueForCreatedWindow(metaWindow);
                const candidates = data?.saved_window_sessions?.filter(session =>
                    !session.moved && !session._awsmRestoreInFlight &&
                    !this._genericGroups?.get(session.wm_class)?.assignments.has(session) &&
                    session.wm_class === metaWindow.get_wm_class()) ?? [];
                if (selectTitleMatch(title, candidates))
                    finish(true);
            });
            wait.unmanagingId = metaWindow.connect('unmanaging', () => finish(false));
            wait.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                finish(true, true);
                return GLib.SOURCE_REMOVE;
            });
        } catch (error) {
            finish(false);
            if (!this._isDestroyed) this._log.warn(`Unable to watch window title: ${error.message}`);
        }
        wait.cancel = () => finish(false);
    }

    _restoreCreatedWindow(metaWindow, attempt, titleWaitComplete = false) {
        if (this._isDestroyed) {
            return;
        }
        if (this._targetBarrier?.closed) {
            this._log.trace('restoreSession.js', 'late-window-ignored', JSON.stringify({window_id: metaWindow.get_id()}));
            return;
        }
        let windowId;
        try { windowId = metaWindow.get_id(); } catch (e) { return; }
        if (this._adoptedWindowIds.has(windowId)) return;

        const [queueKey, queueData] = this._getQueueForCreatedWindow(metaWindow);
        if (!queueData) {
            // The Shell app association may arrive after window-created. Retry only
            // while the restore queue still contains a compatible record.
            if (attempt < 8 && restoreSessionObject.restoringApps?.size) {
                this._scheduleCreatedWindowRestore(metaWindow, attempt + 1);
            }
            this._maybeDisconnectWindowCreatedRestoreSignal();
            return;
        }

        const savedWindowSessions = queueData.saved_window_sessions;
        const windowWmClass = (() => {
            try { return metaWindow.get_wm_class(); } catch (e) { return null; }
        })();
        const availableSessions = savedWindowSessions.filter(session =>
            !session.moved && !session._awsmRestoreInFlight &&
            !this._genericGroups?.get(session.wm_class)?.assignments.has(session) &&
            (!session.wm_class || session.wm_class === windowWmClass));
        if (availableSessions.every(session => Number.isInteger(session.session_window_index))) {
            availableSessions.sort((a, b) => a.session_window_index - b.session_window_index);
        }
        const title = (() => {
            try { return metaWindow.get_title(); } catch (e) { return null; }
        })();
        const isBrowser = /firefox|chromium|chrome/i.test(windowWmClass ?? '');
        const titleMatch = selectTitleMatch(title, availableSessions, isBrowser);
        if (isBrowser && !titleMatch && !titleWaitComplete) {
            this._waitForBrowserTitle(metaWindow, attempt);
            return;
        }
        const reservedSession = titleMatch?.record ?? availableSessions[0];
        if (!reservedSession) {
            if (attempt < 8) {
                this._scheduleCreatedWindowRestore(metaWindow, attempt + 1);
            }
            return;
        }
        this._adoptedWindowIds.add(windowId);
        reservedSession._awsmRestoreInFlight = metaWindow;

        this._log.trace(
            'restoreSession.js',
            'window-created-queue',
            JSON.stringify({
                title: (() => {
                    try { return metaWindow.get_title(); } catch (e) { return '<pending>'; }
                })(),
                queue_key: typeof queueKey === 'object' ? queueKey.get_id?.() : queueKey,
                window_id: windowId,
                saved_title: reservedSession.window_title,
                match_type: titleMatch?.matchType ?? 'FIFO_FALLBACK',
                queue_length: savedWindowSessions.filter(session =>
                    !session.moved && !session._awsmRestoreInFlight).length,
                attempt,
            }));

        this._enqueueWindowMove(metaWindow, [reservedSession], false).then(moved => {
            delete reservedSession._awsmRestoreInFlight;
            if (moved) {
                reservedSession._awsmPlacementFinished = true;
                if (!this._isDestroyed && savedWindowSessions.every(session => session.moved)) {
                    restoreSessionObject.restoringApps.delete(queueKey);
                    this._maybeDisconnectWindowCreatedRestoreSignal();
                }
                return;
            }
            this._adoptedWindowIds.delete(windowId);
            if (attempt < 8) {
                this._scheduleCreatedWindowRestore(metaWindow, attempt + 1);
            } else this._targetBarrier?.settle(reservedSession, 'FAILED');
        }).catch(error => {
            delete reservedSession._awsmRestoreInFlight;
            this._adoptedWindowIds.delete(windowId);
            this._targetBarrier?.settle(reservedSession, 'FAILED');
            if (!this._isDestroyed) this._log.error(error, 'Failed to restore a newly-created window');
        });
    }

    _isFirefoxSession(savedWindowSession) {
        const values = [
            savedWindowSession?.wm_class,
            savedWindowSession?.wm_class_instance,
            savedWindowSession?.desktop_file_id,
            savedWindowSession?.app_name,
        ].filter(value => value).join(' ').toLowerCase();
        return values.includes('firefox');
    }

    _lookupShellApp(savedWindowSession) {
        const desktopFileId = savedWindowSession?.desktop_file_id;
        let shellApp = desktopFileId
            ? this._defaultAppSystem.lookup_app(desktopFileId)
            : null;

        // Snap Firefox records can outlive a desktop-file refresh. Resolve
        // the stable desktop id before considering the raw process command.
        if (!shellApp && this._isFirefoxSession(savedWindowSession)) {
            shellApp = this._defaultAppSystem.lookup_app('firefox_firefox.desktop');
        }
        return shellApp;
    }

    launch(shellApp, desktopNumber, savedWindowSession = null) {
        const appHasOpenWindows = (() => {
            try {
                return shellApp.get_windows().length > 0;
            } catch (e) {
                return false;
            }
        })();

        if (this._adoptedApps.has(shellApp)) {
            this._log.info(`${shellApp.get_name()} is already adopted, skipping launch`);
            return [true, true];
        }

        if (this._restoredApps.has(shellApp)) {
            this._log.info(`${shellApp.get_name()} is restored, skipping`);
            return [true, false];
        }

        if (appHasOpenWindows || this._appIsRunning(shellApp)) {
            this._adoptedApps.add(shellApp);
            this._log.info(`${shellApp.get_name()} is running, skipping`);
            // Keep the queue for existing windows.
            return [true, true];
        }

        this._log.trace(
            'restoreSession.js',
            'launch-desktop-app',
            JSON.stringify({
                app: shellApp.get_name(),
                desktop_file_id: shellApp.get_id(),
                desktop_number: desktopNumber,
                title: savedWindowSession?.window_title,
            }));
        const launched = shellApp.launch(
            // 0 for current event timestamp
            0, 
            desktopNumber,
            this._getProperGpuPref(shellApp));
        if (launched) {
            this._launchedApps.add(shellApp);
        }
        return [launched, false];
    }

    _appIsRunning(app) {
        // Running apps can be empty even if there are apps running when gnome-shell starting
        const running_apps = this._defaultAppSystem.get_running();
        for (const running_app of running_apps) {
            if (running_app.get_id() === app.get_id() && 
                running_app.get_state() >= Shell.AppState.STARTING) {
                return true;
            }    
        }
        return false;
    }

    _getProperGpuPref(shell_app) {
        if (this._useDiscreteGraphicsCard) {
            const app_info = shell_app.get_app_info();
            if (app_info) {
                return app_info.get_boolean('PrefersNonDefaultGPU')
                    ? Shell.AppLaunchGpu.DEFAULT
                    : Shell.AppLaunchGpu.DISCRETE;
            }
        }
        return Shell.AppLaunchGpu.DEFAULT;
    }

    destroy() {
        this._isDestroyed = true;
        this._targetBarrier?.close();
        for (const observation of this._pendingPlacementObservations) {
            GLib.Source.remove(observation.id);
            observation.resolve(false);
        }
        this._pendingPlacementObservations.clear();
        this._restoredWindowMap.clear();

        for (const wait of this._pendingTitleWaits.values()) wait.cancel?.();
        this._pendingTitleWaits.clear();

        for (const wait of this._pendingStaggerWaits) {
            GLib.Source.remove(wait.id);
            wait.resolve(false);
        }
        this._pendingStaggerWaits.clear();

        if (this._windowCreatedSignalId) {
            try {
                this._display.disconnect(this._windowCreatedSignalId);
            } catch (e) {}
            this._windowCreatedSignalId = 0;
        }

        if (restoreSessionObject.restoringApps) {
            restoreSessionObject.restoringApps.clear();
            restoreSessionObject.restoringApps = null;
        }

        if (this._restoredApps) {
            this._restoredApps.clear();
            this._restoredApps = null;
        }

        if (this._launchedApps) {
            this._launchedApps.clear();
            this._launchedApps = null;
        }

        if (this._adoptedApps) {
            this._adoptedApps.clear();
            this._adoptedApps = null;
        }

        if (this._defaultAppSystem) {
            this._defaultAppSystem = null;
        }

        if (this._windowTracker) {
            this._windowTracker = null;
        }

        if (this._moveSession) {
            this._moveSession.destroy();
            this._moveSession = null;
        }

        if (this._log) {
            this._log.destroy();
            this._log = null;
        }

        if (this._connectIds) {
            for (let [obj, id] of this._connectIds) {
                obj.disconnect(id);
            }
            this._connectIds = null;
        }

        if (this._restoreSessionTimeoutId) {
            GLib.Source.remove(this._restoreSessionTimeoutId);
            this._restoreSessionTimeoutId = null;
        }

        if (this._windowRestoreRetryIds) {
            for (const sourceId of this._windowRestoreRetryIds) {
                GLib.Source.remove(sourceId);
            }
            this._windowRestoreRetryIds.clear();
            this._windowRestoreRetryIds = null;
        }
        
    }

}
