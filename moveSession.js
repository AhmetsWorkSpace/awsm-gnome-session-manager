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
        const primaryMonitorIndex = global.display.get_primary_monitor()
        const savedMonitorIndex = saved_window_session.monitor_number;

        let toMonitorIndex = null;
        if (savedMonitorIndex === undefined) {
            if (currentMonitorIndex !== primaryMonitorIndex) {
                this._log.info(`${shellApp.get_name()} - ${metaWindow.get_title()} doesn't have the monitor number data, click the save open windows button to save it. Moving it to the primary monitor ${primaryMonitorIndex} from ${currentMonitorIndex}`);
                toMonitorIndex = primaryMonitorIndex;
            }
        }
        // It is possible to save unmanaged windows or old/invalid JSON.
        else if (!Number.isInteger(savedMonitorIndex) || savedMonitorIndex < 0) {
            if (currentMonitorIndex !== primaryMonitorIndex) {
                this._log.info(`${shellApp.get_name()} - ${metaWindow.get_title()} is unmanaged when saving, moving it to the primary monitor ${primaryMonitorIndex} from ${currentMonitorIndex}`);
                toMonitorIndex = primaryMonitorIndex;
            }
        }
        // It causes Gnome shell to crash, if we move a monitor to a non-existing monitor on X11 and Wayland!
        // We move all windows on non-existing monitors to the primary monitor
        else if (savedMonitorIndex > global.display.get_n_monitors() - 1) {
            if (currentMonitorIndex !== primaryMonitorIndex) {
                this._log.info(`Monitor ${savedMonitorIndex} doesn't exist. Moving ${shellApp.get_name()} - ${metaWindow.get_title()} to the primary monitor ${primaryMonitorIndex} from ${currentMonitorIndex}`);
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
                    metaWindow.move_to_monitor(toMonitorIndex);
                } catch (e) {
                    this._log.error(e, `Failed to move ${metaWindow.get_title()} to monitor ${toMonitorIndex}`);
                    finish();
                    return;
                }
                timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    if (!resolved) {
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

                matchedSavedWindowSession.moved = true;
            }
            return true;
        } catch (error) {
            this._log.error(error, metaWindow ? metaWindow.get_title() : 'This window may be destroyed.');
            return false;
        } finally {
            this._movingWindows.delete(metaWindow);
        }
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

    _isWindowReady(metaWindow) {
        try {
            if (metaWindow._aboutToClose || metaWindow.is_override_redirect()) {
                return false;
            }
            const bufferRect = typeof metaWindow.get_buffer_rect === 'function'
                ? metaWindow.get_buffer_rect()
                : metaWindow.get_frame_rect();
            return bufferRect.width > 0 && bufferRect.height > 0;
        } catch (e) {
            return false;
        }
    }

    _waitForWindowReady(metaWindow, maxAttempts = 6) {
        if (this._isDestroyed) {
            return Promise.resolve(false);
        }

        if (this._isWindowReady(metaWindow)) {
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
                if (this._isWindowReady(metaWindow)) {
                    return finish(true);
                }
                if (attempts >= maxAttempts) {
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

            await this._restoreMonitor(metaWindow, saved_window_session);
            this._restoreWindowState(metaWindow, saved_window_session);
            this._restoreWindowGeometry(metaWindow, saved_window_session);
            this._restoreTiling(metaWindow, saved_window_session);
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
        }
        if (window_state.is_sticky) {
            if (!metaWindow.is_on_all_workspaces()) {
                this._log.debug(`Making ${metaWindow.get_title()} sticky`);
                metaWindow.stick();
            }
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
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._moveResizeFrame(metaWindow, saved_window_session);
        }
    }

    _moveResizeFrame(metaWindow, saved_window_session) {
        const window_position = saved_window_session.window_position;
        if (window_position?.provider === 'Meta') {
            const to_x = window_position.x_offset;
            const to_y = window_position.y_offset;
            const to_width = window_position.width;
            const to_height = window_position.height;

            // After move_to_monitor() Mutter may update get_monitor() one
            // frame later on Wayland. Use the saved monitor for clamping so a
            // delayed monitor signal cannot clamp the geometry to the old
            // display.
            const savedMonitor = saved_window_session.monitor_number;
            const currentMonitor = Number.isInteger(savedMonitor) &&
                savedMonitor >= 0 && savedMonitor < global.display.get_n_monitors()
                ? savedMonitor
                : metaWindow.get_monitor();
            if (currentMonitor < 0) {
                return;
            }
            const rectWorkArea = metaWindow.get_work_area_for_monitor(currentMonitor);
            
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
        }
    }

    _moveFrameToSavedPosition(metaWindow, saved_window_session) {
        const windowPosition = saved_window_session.window_position;
        if (!windowPosition || windowPosition.provider !== 'Meta') {
            return;
        }

        try {
            metaWindow.move_frame(true, windowPosition.x_offset, windowPosition.y_offset);
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
