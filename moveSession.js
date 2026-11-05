'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as UiHelper from './ui/uiHelper.js';

import * as FileUtils from './utils/fileUtils.js';
import * as Log from './utils/log.js';
import * as DateUtils from './utils/dateUtils.js';
import { shellVersion } from './constants.js';

import {WindowTilingSupport} from './windowTilingSupport.js';

function getMonitorForFrame(metaWindow) {
    const display = global.display;
    const rect = metaWindow.get_frame_rect();

    if (typeof display.get_monitor_index_for_rect === 'function') {
        try {
            const index = display.get_monitor_index_for_rect(rect);
            if (Number.isInteger(index) && index >= 0) {
                return index;
            }
        } catch (e) {
            // Use the overlap calculation below.
        }
    }

    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    let bestIndex = -1;
    let bestArea = 0;
    for (let index = 0; index < display.get_n_monitors(); index++) {
        const monitor = display.get_monitor_geometry(index);
        const width = Math.max(0, Math.min(right, monitor.x + monitor.width) - Math.max(rect.x, monitor.x));
        const height = Math.max(0, Math.min(bottom, monitor.y + monitor.height) - Math.max(rect.y, monitor.y));
        const area = width * height;
        if (area > bestArea) {
            bestArea = area;
            bestIndex = index;
        }
    }

    return bestIndex >= 0 ? bestIndex : metaWindow.get_monitor();
}

function getFrameRectForLog(metaWindow) {
    try {
        const rect = metaWindow.get_frame_rect();
        return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
    } catch (e) {
        return null;
    }
}

function getTitleForLog(metaWindow) {
    try {
        return metaWindow.get_title();
    } catch (e) {
        return '<disposed-window>';
    }
}

function getRestoreMonitorIndex(savedWindowSession) {
    const display = global.display;
    const savedGeometry = savedWindowSession?.monitor_geometry;
    const monitorCount = display.get_n_monitors();

    // Monitor enumeration can change after a dock or an external display is
    // reconnected. Prefer the saved Mutter geometry when it identifies the
    // same logical monitor, and only then fall back to the saved index.
    if (savedGeometry?.provider === 'Meta') {
        const exactIndex = Array.from({length: monitorCount}, (_, index) => index)
            .find(index => {
                const current = display.get_monitor_geometry(index);
                return current.x === Number(savedGeometry.x) &&
                    current.y === Number(savedGeometry.y) &&
                    current.width === Number(savedGeometry.width) &&
                    current.height === Number(savedGeometry.height);
            });
        if (exactIndex !== undefined) {
            return exactIndex;
        }

        // If the whole layout moved, position is no longer exact but a
        // monitor with the same logical size is still a useful identity hint.
        const sameSize = Array.from({length: monitorCount}, (_, index) => index)
            .filter(index => {
                const current = display.get_monitor_geometry(index);
                return current.width === Number(savedGeometry.width) &&
                    current.height === Number(savedGeometry.height);
            })
            .sort((left, right) => {
                const leftGeometry = display.get_monitor_geometry(left);
                const rightGeometry = display.get_monitor_geometry(right);
                const leftDistance = Math.abs(leftGeometry.x - Number(savedGeometry.x)) +
                    Math.abs(leftGeometry.y - Number(savedGeometry.y));
                const rightDistance = Math.abs(rightGeometry.x - Number(savedGeometry.x)) +
                    Math.abs(rightGeometry.y - Number(savedGeometry.y));
                return leftDistance - rightDistance;
            });
        if (sameSize.length) {
            return sameSize[0];
        }
    }

    const savedMonitorIndex = savedWindowSession?.monitor_number;
    if (Number.isInteger(savedMonitorIndex) &&
        savedMonitorIndex >= 0 && savedMonitorIndex < monitorCount) {
        return savedMonitorIndex;
    }

    return -1;
}


export const MoveSession = class {

    constructor() {
        this._log = new Log.Log();

        this.sessionName = FileUtils.default_sessionName;
        this._defaultAppSystem = Shell.AppSystem.get_default();
        this._windowTracker = Shell.WindowTracker.get_default();

        this._sourceIds = [];
        this._pendingReadyWaits = new Set();
        this._pendingMonitorMoves = new Set();
        this._isDestroyed = false;

        this._delayRestoreGeometryId = 0;
        this._movingWindows = new WeakSet();

    }

    async moveWindows(sessionName) {
        if (!sessionName) {
            sessionName = this.sessionName;
        }

        const sessions_path = FileUtils.get_sessions_path();
        const session_file_path = GLib.build_filenamev([sessions_path, sessionName]);
        if (!GLib.file_test(session_file_path, GLib.FileTest.EXISTS)) {
            logError(new Error(`Session file not found: ${session_file_path}`));
            return;
        }

        this._log.info(`Moving windows by saved session located in ${session_file_path}`);
        const session_file = Gio.File.new_for_path(session_file_path);
        let [success, contents] = session_file.load_contents(null);
        if (success) {
            let session_config = FileUtils.getJsonObj(contents);

            const session_config_objects = session_config.x_session_config_objects;
            if (!session_config_objects) {
                logError(new Error(`Session details not found: ${session_file_path}`));
                return;
            }

            // TODO Use global.get_window_actors(); / Meta.get_window_actors() / display.list_all_windows() instead and then call this.moveWindowByMetaWindow() and then can remove this.moveWindowsByShellApp()?
            await this.moveApps(session_config_objects);
        }

    }

    async moveApps(session_config_objects) {
        try {
            const running_apps = this._defaultAppSystem.get_running();
            for (const shellApp of running_apps) {
                await this.moveWindowsByShellApp(shellApp, session_config_objects);
            }   
        } catch (error) {
            Log.Log.getDefault().error(error);
        }
    }

    async moveWindowsByShellApp(shellApp, saved_window_sessions) {
        try {
            for (const metaWindow of shellApp.get_windows()) {
                await this.moveWindowByMetaWindow(metaWindow, saved_window_sessions, true);
            }
        } catch (error) {
            this._log.error(error, shellApp ? shellApp.get_name() : 'This app may be closed.');
        }
    }

    // Inspired by https://github.com/Leleat/Tiling-Assistant/blob/main/tiling-assistant%40leleat-on-github/src/extension/resizeHandler.js
    _restoreTiling(metaWindow, saved_window_session) {
        WindowTilingSupport.prepareToTile(metaWindow, saved_window_session.window_tiling);
    }

    /**
     * We need to move the window to the monitor it belongs before moving it to the workspace, because
     * the move itself could cause a workspace change if the window enters
     * the primary monitor
     * 
     * @see https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-41/js/ui/workspace.js#L1497
     */
    async _restoreMonitor(metaWindow, saved_window_session) {
        const currentMonitorIndex = getMonitorForFrame(metaWindow);
        // -1 if the window has been recently unmanaged and does not have a monitor
        if (currentMonitorIndex === -1) {
            return Promise.resolve(metaWindow);
        }

        const shellApp = this._windowTracker.get_window_app(metaWindow);
        const primaryMonitorIndex = global.display.get_primary_monitor();
        const savedMonitorIndex = getRestoreMonitorIndex(saved_window_session);

        let toMonitorIndex = null;
        if (savedMonitorIndex < 0) {
            if (currentMonitorIndex !== primaryMonitorIndex) {
                this._log.info(`${shellApp.get_name()} - ${metaWindow.get_title()} doesn't have the monitor number data, click the save open windows button to save it. Moving it to the primary monitor ${primaryMonitorIndex} from ${currentMonitorIndex}`);
                toMonitorIndex = primaryMonitorIndex;
            }
        }
        else if (currentMonitorIndex !== savedMonitorIndex) {
            this._log.debug(`Moving ${shellApp.get_name()} - ${metaWindow.get_title()} to monitor ${savedMonitorIndex} from ${currentMonitorIndex}`);
            // So, you don't want to unplug the monitor, which we are moving the window in to, at this moment. 🤣
            toMonitorIndex = savedMonitorIndex;
        }

        if (toMonitorIndex != null) {
            return new Promise((resolve, reject) => {
                // MetaWindow.move_to_monitor() can no longer be assumed to have updated the monitor on return, as under wayland
                // Wait for the monitor change to take effect
                // See: https://gitlab.gnome.org/GNOME/gnome-shell/-/commit/1cb01ec5b139da136cac665fc705e4ddd1d926a1
                let resolved = false;
                let timeoutId = 0;
                let cancel = null;
                const cleanup = () => {
                    this._sourceIds = this._sourceIds?.filter(sourceId => sourceId !== timeoutId) ?? [];
                    try {
                        global.display.disconnect(id);
                    } catch (e) {}
                };
                const finish = (applyPosition = true) => {
                    if (resolved) {
                        return;
                    }
                    resolved = true;
                    if (cancel) {
                        this._pendingMonitorMoves.delete(cancel);
                    }
                    cleanup();
                    if (applyPosition) {
                        this._moveFrameToSavedPosition(metaWindow, saved_window_session);
                    }
                    let actualMonitor = null;
                    try {
                        actualMonitor = getMonitorForFrame(metaWindow);
                    } catch (e) {}
                    this._log.trace(
                        'moveSession.js',
                        'move-to-monitor-after',
                        JSON.stringify({
                            title: getTitleForLog(metaWindow),
                            requested_monitor: toMonitorIndex,
                            actual_monitor: actualMonitor,
                            position_applied: applyPosition,
                            frame_rect: getFrameRectForLog(metaWindow),
                        }));
                    resolve(metaWindow);
                };
                cancel = () => finish(false);
                this._pendingMonitorMoves.add(cancel);
                const id = global.display.connect('window-entered-monitor',
                    (dsp, num, w) => {
                        if (w === metaWindow && !resolved) {
                            if (timeoutId) {
                                try { GLib.Source.remove(timeoutId); } catch (e) {}
                            }
                            finish();
                        }
                    });
                try {
                    this._log.trace(
                        'moveSession.js',
                        'move-to-monitor-before',
                        JSON.stringify({
                            title: getTitleForLog(metaWindow),
                            from_monitor: currentMonitorIndex,
                            requested_monitor: toMonitorIndex,
                            frame_rect: getFrameRectForLog(metaWindow),
                        }));
                    metaWindow.move_to_monitor(toMonitorIndex);
                    this._log.trace(
                        'moveSession.js',
                        'move-to-monitor-return',
                        JSON.stringify({
                            title: getTitleForLog(metaWindow),
                            requested_monitor: toMonitorIndex,
                            frame_rect: getFrameRectForLog(metaWindow),
                        }));
                } catch (e) {
                    this._log.error(e, `Failed to move ${metaWindow.get_title()} to monitor ${toMonitorIndex}`);
                    finish();
                    return;
                }
                timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    if (!resolved) {
                        this._log.trace(
                            'moveSession.js',
                            'move-to-monitor-timeout',
                            JSON.stringify({
                                title: getTitleForLog(metaWindow),
                                requested_monitor: toMonitorIndex,
                                fallback: 'finish-after-timeout',
                            }));
                        finish();
                    }
                    return GLib.SOURCE_REMOVE;
                });
                this._sourceIds.push(timeoutId);
            });
        }
        
        return Promise.resolve(metaWindow);
    }

    async moveWindowByMetaWindow(metaWindow, saved_window_sessions, preferTitle = false) {
        return this._moveWindowByMetaWindow(metaWindow, saved_window_sessions, preferTitle);
    }

    async _moveWindowByMetaWindow(metaWindow, saved_window_sessions, preferTitle) {
        let ownsWindowLock = false;
        try {
            if (UiHelper.ignoreWindows(metaWindow)) return;

            // Wayland can emit first-frame, shown and title notifications for
            // one window in quick succession. Do not consume the same saved
            // record concurrently from those callbacks.
            if (this._movingWindows.has(metaWindow)) {
                return;
            }
            if (!saved_window_sessions?.length) {
                return false;
            }

            this._movingWindows.add(metaWindow);
            ownsWindowLock = true;

            if (!await this._waitForWindowReady(metaWindow)) {
                this._log.warn(`Window surface was not ready for ${metaWindow.get_title()}`);
                return false;
            }

            const matchedSavedWindowSession = this._getOneMatchedSavedWindow(
                metaWindow,
                saved_window_sessions,
                preferTitle);
            if (!matchedSavedWindowSession) {
                return false;
            }

            if (matchedSavedWindowSession.moved) {
                await this._restoreWindowStates(metaWindow, matchedSavedWindowSession);
            } else {
                await this._restoreWindowStates(metaWindow, matchedSavedWindowSession);
                const desktop_number = matchedSavedWindowSession.desktop_number;
                // It's necessary to move window again to ensure an app goes to its own workspace.
                // Some apps do not accept a workspace change until after the
                // monitor and geometry operations have completed.
                this._createEnoughWorkspace(desktop_number);
                const shellApp = this._windowTracker.get_window_app(metaWindow);
                const is_sticky = Boolean(matchedSavedWindowSession.window_state?.is_sticky);
                if (is_sticky && metaWindow.is_on_all_workspaces()) {
                    this._log.debug(`The window '${shellApp.get_name()} - ${metaWindow.get_title()}' is already sticky on workspace ${desktop_number}`);
                } else {
                    this._log.debug(`MWMW: Moving ${shellApp?.get_name()} - ${metaWindow.get_title()} to workspace ${desktop_number} from ${metaWindow.get_workspace().index()}`);
                    this._changeWorkspace(metaWindow, desktop_number);
                }
                // The window state get lost during moving the window, and we need to restore window state again.
                this._restoreWindowState(metaWindow, matchedSavedWindowSession);
                this._restorePresentationState(metaWindow, matchedSavedWindowSession);

                matchedSavedWindowSession.moved = true;
            }
            this._scheduleSettledGeometry(metaWindow);
            return true;
        } catch (error) {
            this._log.error(error, metaWindow ? metaWindow.get_title() : 'This window may be destroyed.');
            return false;
        } finally {
            if (ownsWindowLock) this._movingWindows.delete(metaWindow);
        }
    }

    _scheduleSettledGeometry(metaWindow) {
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 750, () => {
            this._sourceIds = this._sourceIds?.filter(id => id !== sourceId) ?? [];
            if (this._isDestroyed || !this._log) return GLib.SOURCE_REMOVE;
            try {
                const rect = metaWindow.get_frame_rect();
                this._log.trace('moveSession.js', 'geometry-settled', JSON.stringify({
                    window_id: metaWindow.get_id(), title: metaWindow.get_title(),
                    monitor: getMonitorForFrame(metaWindow),
                    rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
                    is_maximized: typeof metaWindow.is_maximized === 'function'
                        ? metaWindow.is_maximized() : Boolean(metaWindow.get_maximized()),
                    fullscreen: metaWindow.is_fullscreen(), minimized: metaWindow.minimized,
                    observation_delay_ms: 750,
                }));
            } catch (error) {
                this._log.debug(`Settled geometry unavailable: ${error.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._sourceIds.push(sourceId);
    }

    _changeWorkspace(metaWindow, desktop_number) {
        const currentFocusedWindow = global.display.get_focus_window();
        metaWindow.change_workspace_by_index(desktop_number, false);
        if (currentFocusedWindow === metaWindow && !Main.layoutManager._inOverview) {
            this._log.debug(`Following the previous focused window ${metaWindow.get_title()}`);
            Main.activateWindow(metaWindow, DateUtils.get_current_time());
        }
    }

    _getOneMatchedSavedWindow(metaWindow, saved_window_sessions, preferTitle = false) {
        const windowWmClass = metaWindow.get_wm_class();
        saved_window_sessions = saved_window_sessions.filter(saved_window_session => {
            return !saved_window_session.moved &&
                (!saved_window_session._awsmRestoreInFlight ||
                    saved_window_session._awsmRestoreInFlight === metaWindow) &&
                (!saved_window_session.wm_class || saved_window_session.wm_class === windowWmClass);
        });

        const title = metaWindow.get_title();
        // Prefer a title match, but fall back to queue order. Firefox and
        // other Wayland clients can emit a temporary or empty title while the
        // final title is still being assigned.
        const saved_window_session = (preferTitle
            ? saved_window_sessions.find(session => title && session.window_title === title)
            : null) ?? saved_window_sessions[0];
        if (!saved_window_session) {
            return null;
        }

        const workspace = metaWindow.get_workspace();
        const open_window_workspace_index = workspace ? workspace.index() : -1;
        const desktop_number = saved_window_session.desktop_number;
        if (open_window_workspace_index === desktop_number) {
            if (this._log.isDebug()) {
                const shellApp = this._windowTracker.get_window_app(metaWindow);
                this._log.debug(`The window '${shellApp?.get_name()} - ${title}' is already on workspace ${desktop_number}`);
            }
            saved_window_session.moved = true;
        }
        return saved_window_session;
    }

    _getWindowReadiness(metaWindow) {
        try {
            const overrideRedirect = metaWindow.is_override_redirect();
            const bufferRect = typeof metaWindow.get_buffer_rect === 'function'
                ? metaWindow.get_buffer_rect()
                : metaWindow.get_frame_rect();
            return {
                ready: !metaWindow._aboutToClose && !overrideRedirect &&
                    bufferRect.width > 0 && bufferRect.height > 0,
                override_redirect: overrideRedirect,
                buffer_rect: {
                    x: bufferRect.x,
                    y: bufferRect.y,
                    width: bufferRect.width,
                    height: bufferRect.height,
                },
            };
        } catch (e) {
            return {ready: false, buffer_rect: null, error: e.message};
        }
    }

    _isWindowReady(metaWindow) {
        return this._getWindowReadiness(metaWindow).ready;
    }

    _waitForWindowReady(metaWindow, maxAttempts = 6) {
        if (this._isDestroyed) {
            return Promise.resolve(false);
        }

        const initialReadiness = this._getWindowReadiness(metaWindow);
        this._log.trace(
            'moveSession.js',
            'surface-check',
            JSON.stringify({
                title: getTitleForLog(metaWindow),
                attempt: 0,
                ...initialReadiness,
            }));
        if (initialReadiness.ready) {
            return Promise.resolve(true);
        }

        return new Promise(resolve => {
            let attempts = 0;
            let sourceId = 0;
            const waiter = result => {
                this._pendingReadyWaits.delete(waiter);
                resolve(result);
            };
            this._pendingReadyWaits.add(waiter);
            sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 75, () => {
                const finish = result => {
                    this._sourceIds = this._sourceIds.filter(id => id !== sourceId);
                    waiter(result);
                    return GLib.SOURCE_REMOVE;
                };
                if (this._isDestroyed) {
                    return finish(false);
                }
                attempts++;
                const readiness = this._getWindowReadiness(metaWindow);
                this._log.trace(
                    'moveSession.js',
                    'surface-check',
                    JSON.stringify({
                        title: getTitleForLog(metaWindow),
                        attempt: attempts,
                        ...readiness,
                    }));
                if (readiness.ready) {
                    return finish(true);
                }
                if (attempts >= maxAttempts) {
                    this._log.trace(
                        'moveSession.js',
                        'surface-timeout',
                        JSON.stringify({title: getTitleForLog(metaWindow), attempts, ...readiness}));
                    return finish(false);
                }
                return GLib.SOURCE_CONTINUE;
            });
            this._sourceIds.push(sourceId);
        });
    }

    /**
     * Restore varies window states, including:
     * * window states, such as Always on Top, Always on Visible Workspace
     * * window geometry
     * * window tiling
     * 
     * @see https://help.gnome.org/users/gnome-help/stable/shell-windows-maximize.html.en
     */
    async _restoreWindowStates(metaWindow, saved_window_session, markToMoved = false) {
        try {
            if (UiHelper.ignoreWindows(metaWindow)) return;

            this._log.trace(
                'moveSession.js',
                'window-state-restore',
                JSON.stringify({
                    title: getTitleForLog(metaWindow),
                    monitor: saved_window_session.monitor_number,
                    workspace: saved_window_session.desktop_number,
                    frame_rect: saved_window_session.window_position,
                    fullscreen: saved_window_session.fullscreen,
                    minimized: saved_window_session.minimized,
                    window_state: saved_window_session.window_state,
                }));

            await this._restoreMonitor(metaWindow, saved_window_session);
            this._restoreWindowState(metaWindow, saved_window_session);
            this._restoreWindowGeometry(metaWindow, saved_window_session);
            this._restoreTiling(metaWindow, saved_window_session);
            this._restorePresentationState(metaWindow, saved_window_session);
            if (markToMoved) {
                saved_window_session.moved = true;
            }
        } catch (error) {
            this._log.error(error, metaWindow ? metaWindow.get_title() : 'This window may be destroyed.');
        }
    }

    _restoreWindowState(metaWindow, saved_window_session) {
        // window state
        const window_state = saved_window_session.window_state ?? {};
        if (window_state.is_above) {
            if (!metaWindow.is_above()) {
                this._log.debug(`Making ${metaWindow.get_title()} above`);
                metaWindow.make_above();
            }
        } else if (metaWindow.is_above()) {
            this._log.debug(`Removing above state from ${metaWindow.get_title()}`);
            metaWindow.unmake_above();
        }
        if (window_state.is_sticky) {
            if (!metaWindow.is_on_all_workspaces()) {
                this._log.debug(`Making ${metaWindow.get_title()} sticky`);
                metaWindow.stick();
            }
        } else if (metaWindow.is_on_all_workspaces()) {
            this._log.debug(`Removing sticky state from ${metaWindow.get_title()}`);
            metaWindow.unstick();
        }

        const savedMetaMaximized = window_state.meta_maximized;
        if (shellVersion >= 49) {
            // Maximize a window to take up all of the space
            if (savedMetaMaximized) {
                const currentMetaMaximized = metaWindow.is_maximized();
                if (!currentMetaMaximized) {
                    this._log.debug(`Maximizing ${metaWindow.get_title()}`);
                    metaWindow.maximize();
                }
            }
        } else {
            // Maximize a window to take up all of the space
            if (savedMetaMaximized === Meta.MaximizeFlags.BOTH) {
                const currentMetaMaximized = metaWindow.get_maximized();
                if (currentMetaMaximized !== Meta.MaximizeFlags.BOTH) {
                    this._log.debug(`Maximizing ${metaWindow.get_title()}`);
                    metaWindow.maximize(savedMetaMaximized);
                }
            }
        }

    }

    _restorePresentationState(metaWindow, saved_window_session) {
        const savedFullscreen = saved_window_session.fullscreen;
        if (typeof savedFullscreen === 'boolean') {
            if (savedFullscreen && !metaWindow.is_fullscreen()) {
                this._log.debug(`Making ${metaWindow.get_title()} fullscreen`);
                metaWindow.make_fullscreen();
            } else if (!savedFullscreen && metaWindow.is_fullscreen()) {
                this._log.debug(`Leaving ${metaWindow.get_title()} fullscreen`);
                metaWindow.unmake_fullscreen();
            }
        }

        const savedMinimized = saved_window_session.minimized;
        if (typeof savedMinimized === 'boolean') {
            if (savedMinimized && !metaWindow.minimized) {
                this._log.debug(`Minimizing ${metaWindow.get_title()}`);
                metaWindow.minimize();
            } else if (!savedMinimized && metaWindow.minimized) {
                this._log.debug(`Unminimizing ${metaWindow.get_title()}`);
                metaWindow.unminimize();
            }
        }
    }

    /**
     * @see https://help.gnome.org/users/gnome-help/stable/shell-windows-maximize.html.en
     */
    _restoreWindowGeometry(metaWindow, saved_window_session) {
        let delay = false;
        const window_state = saved_window_session.window_state ?? {};
        const savedMetaMaximized = window_state.meta_maximized;
        if (shellVersion >= 49) {
            if (!savedMetaMaximized) {
                // It can't be resized if current window is in maximum mode, including vertically maximization along the left and right sides of the screen
                const currentMetaMaximized = metaWindow.is_maximized();
                if (currentMetaMaximized) {
                    metaWindow.set_unmaximize_flags(Meta.MaximizeFlags.BOTH);
                    metaWindow.unmaximize();
                    delay = true;
                }
            }
        } else {
            if (savedMetaMaximized !== Meta.MaximizeFlags.BOTH) {
                // It can't be resized if current window is in maximum mode, including vertically maximization along the left and right sides of the screen
                const currentMetaMaximized = metaWindow.get_maximized();
                if (currentMetaMaximized) {
                    metaWindow.unmaximize(currentMetaMaximized);
                    if (true && currentMetaMaximized !== Meta.MaximizeFlags.BOTH) {
                        delay = true;
                    }
                }
            }
        }

        if (delay) {
            // Fix: https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager/issues/25
            // TODO Note that this is not a perfect solution to address the above issue.
            this._delayRestoreGeometryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._moveResizeFrame(metaWindow, saved_window_session);
                this._restorePresentationState(metaWindow, saved_window_session);
                this._delayRestoreGeometryId = 0;
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._moveResizeFrame(metaWindow, saved_window_session);
        }
    }

    _moveResizeFrame(metaWindow, saved_window_session) {
        const window_position = saved_window_session.window_position;
        if (window_position?.provider === 'Meta') {
            let to_x = window_position.x_offset;
            let to_y = window_position.y_offset;
            const to_width = window_position.width;
            const to_height = window_position.height;

            // After move_to_monitor() Mutter may update get_monitor() one
            // frame later on Wayland. Use the saved monitor for clamping so a
            // delayed monitor signal cannot clamp the geometry to the old
            // display.
            const savedMonitor = getRestoreMonitorIndex(saved_window_session);
            const currentMonitor = savedMonitor >= 0
                ? savedMonitor
                : metaWindow.get_monitor();
            if (currentMonitor < 0) {
                return;
            }
            const rectWorkArea = metaWindow.get_work_area_for_monitor(currentMonitor);

            // New sessions keep Mutter's logical monitor geometry. Rebase the
            // saved global position when the monitor layout changed; old sessions
            // without this field retain their original absolute coordinates.
            const savedMonitorGeometry = saved_window_session.monitor_geometry;
            if (savedMonitorGeometry?.provider === 'Meta') {
                const currentMonitorGeometry = global.display.get_monitor_geometry(currentMonitor);
                to_x = currentMonitorGeometry.x + (window_position.x_offset - savedMonitorGeometry.x);
                to_y = currentMonitorGeometry.y + (window_position.y_offset - savedMonitorGeometry.y);
            }

            this._log.trace(
                'moveSession.js',
                'geometry-apply-before',
                JSON.stringify({
                    title: getTitleForLog(metaWindow),
                    monitor: currentMonitor,
                    x: to_x,
                    y: Math.max(to_y, rectWorkArea.y),
                    width: to_width,
                    height: to_height,
                    work_area: {
                        x: rectWorkArea.x,
                        y: rectWorkArea.y,
                        width: rectWorkArea.width,
                        height: rectWorkArea.height,
                    },
                    current_frame_rect: getFrameRectForLog(metaWindow),
                }));
            
            // For more info about the below issue see also: https://github.com/Leleat/Tiling-Assistant/blob/1e4176a9a7037ee5dd0612e4c9f9dbe45d4e67cf/tiling-assistant%40leleat-on-github/src/extension/tilingWindowManager.js#L186-L199
            
            // Move first. Just in case that some apps can only be resized but not moved after `metaWindow.move_resize_frame()`
            metaWindow.move_frame(true, to_x, to_y);
            metaWindow.move_resize_frame(
                // Set `user_op` to true to fix an issue that a window does not move to negative x (like -176),
                // in which case if `user_op` is false it will move to (0,Y,W,H).
                true, // user_op
                to_x,
                
                // Fix the below issue:
                // No rect to clip to found!
                // No rect whose size to clamp to found!

                // Window might flies outside of the screen when resizing due to 
                // the y axis of the saved window is less than the one of work area, see:
                // https://gitlab.gnome.org/GNOME/mutter/-/issues/1461
                // https://gitlab.gnome.org/GNOME/mutter/-/issues/1499

                Math.max(to_y, rectWorkArea.y),
                to_width,
                to_height);
            this._log.trace(
                'moveSession.js',
                'geometry-apply-after',
                JSON.stringify({
                    title: getTitleForLog(metaWindow),
                    monitor: currentMonitor,
                    frame_rect: getFrameRectForLog(metaWindow),
                }));
        }
    }

    _moveFrameToSavedPosition(metaWindow, saved_window_session) {
        const windowPosition = saved_window_session.window_position;
        if (!windowPosition || windowPosition.provider !== 'Meta') {
            return;
        }

        try {
            let x = windowPosition.x_offset;
            let y = windowPosition.y_offset;
            const savedGeometry = saved_window_session.monitor_geometry;
            const targetMonitor = getRestoreMonitorIndex(saved_window_session);
            if (savedGeometry?.provider === 'Meta' && targetMonitor >= 0) {
                const currentGeometry = global.display.get_monitor_geometry(targetMonitor);
                x = currentGeometry.x + (windowPosition.x_offset - Number(savedGeometry.x));
                y = currentGeometry.y + (windowPosition.y_offset - Number(savedGeometry.y));
            }
            metaWindow.move_frame(true, x, y);
        } catch (e) {
            this._log.debug(`Could not apply early Wayland position for ${metaWindow.get_title()}: ${e.message}`);
        }
    }

    _createEnoughWorkspace(workspaceNumber) {
        let workspaceManager = global.workspace_manager;

        // We have enough workspace now, return
        if (workspaceManager.n_workspaces >= workspaceNumber + 1) {
            return;
        }

        // First, make all existing workspaces persistent
        for (let i = 0; i <= workspaceManager.n_workspaces - 1; i++) {
            let workspace = workspaceManager.get_workspace_by_index(i);
            if (!workspace._keepAliveId) {
                workspace._keepAliveId = true;
            }
        }

        // Second, make all newly added workspaces persistent, so they can not removed due to it does not contain any windows
        // And keep the last one non-persistent
        for (let i = workspaceManager.n_workspaces; i <= workspaceNumber; i++) {
            workspaceManager.append_new_workspace(false, 0);
            workspaceManager.get_workspace_by_index(i)._keepAliveId = true;
        }
    }

    destroy() {
        this._isDestroyed = true;

        if (this._pendingReadyWaits) {
            for (const waiter of this._pendingReadyWaits) {
                waiter(false);
            }
            this._pendingReadyWaits.clear();
        }

        if (this._pendingMonitorMoves) {
            for (const cancel of this._pendingMonitorMoves) {
                cancel();
            }
            this._pendingMonitorMoves.clear();
        }

        if (this._defaultAppSystem) {
            this._defaultAppSystem = null;
        }

        if (this._log) {
            this._log.destroy();
            this._log = null;
        }

        if (this._sourceIds) {
            this._sourceIds.forEach(sourceId => {
                GLib.Source.remove(sourceId);
            });
            this._sourceIds = null;
        }

        if (this._windowTracker) {
            this._windowTracker = null;
        }

        if (this._delayRestoreGeometryId) {
            GLib.Source.remove(this._delayRestoreGeometryId);
            this._delayRestoreGeometryId = 0;
        }

    }

}
