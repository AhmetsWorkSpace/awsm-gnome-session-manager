'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const path = ARGV[0];
const strict = ARGV.includes('--strict');
if (!path) {
    print('Kullanim: gjs -m scripts/verify_session_state.js <session.json>');
    System.exit(2);
}

function readJson(filePath) {
    const [, bytes] = Gio.File.new_for_path(filePath).load_contents(null);
    return JSON.parse(new TextDecoder().decode(bytes));
}

function currentMutterState() {
    const proxy = Gio.DBusProxy.new_for_bus_sync(
        Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
        'org.gnome.Mutter.DisplayConfig',
        '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig', null);
    return proxy.call_sync('GetCurrentState', null, Gio.DBusCallFlags.NONE, -1, null).deep_unpack();
}

function monitorsFrom(state) {
    const outputs = new Map();
    for (const monitor of state[1]) {
        const connector = monitor[0][0];
        const mode = monitor[1].find(item => Object.hasOwn(item[6], 'is-current'));
        if (mode) outputs.set(connector, {width: mode[1], height: mode[2]});
    }
    return state[2].map((item, index) => {
        const connector = item[5][0][0];
        const mode = outputs.get(connector);
        if (!mode) throw new Error(`Aktif mod bulunamadi: ${connector}`);
        return {
            index, connector, x: item[0], y: item[1],
            width: Math.round(mode.width / item[2]), height: Math.round(mode.height / item[2]),
            physicalWidth: mode.width, physicalHeight: mode.height,
            scale: item[2], primary: item[4],
        };
    });
}

function monitorForRect(rect, monitors) {
    let best = null;
    let bestArea = 0;
    for (const monitor of monitors) {
        const right = Math.min(rect.x_offset + rect.width, monitor.x + monitor.width);
        const bottom = Math.min(rect.y_offset + rect.height, monitor.y + monitor.height);
        const left = Math.max(rect.x_offset, monitor.x);
        const top = Math.max(rect.y_offset, monitor.y);
        const area = Math.max(0, right - left) * Math.max(0, bottom - top);
        if (area > bestArea) {
            best = monitor;
            bestArea = area;
        }
    }
    if (best) return best;
    const centerX = rect.x_offset + rect.width / 2;
    const centerY = rect.y_offset + rect.height / 2;
    return monitors.find(m => centerX >= m.x && centerX < m.x + m.width && centerY >= m.y && centerY < m.y + m.height) ?? null;
}

function yesNo(value) {
    return value === true ? 'evet' : value === false ? 'hayir' : 'bilinmiyor';
}

try {
    const session = readJson(path);
    const windows = session.x_session_config_objects ?? [];
    const monitors = monitorsFrom(currentMutterState());
    const counts = new Map();
    let legacyGeometryCount = 0;
    for (const window of windows)
        counts.set(window.wm_class, (counts.get(window.wm_class) ?? 0) + 1);

    print(`Session: ${session.session_name ?? path}`);
    print(`Kayitli pencere: ${windows.length}`);
    print(`Mutter monitörleri: ${monitors.map(m => `${m.index}:${m.connector}(${m.x},${m.y} logical=${m.width}x${m.height} physical=${m.physicalWidth}x${m.physicalHeight} scale=${m.scale})`).join(' | ')}`);
    print(`Primary monitor: ${monitors.find(m => m.primary)?.index ?? 'bilinmiyor'}`);

    let pass = monitors.length > 0 && windows.length > 0;
    const ids = new Set();
    for (const [index, window] of windows.entries()) {
        const rect = window.window_position ?? {};
        const state = window.window_state ?? {};
        const actual = monitorForRect(rect, monitors);
        const savedGeometry = window.monitor_geometry;
        const geometryOk = !savedGeometry || (actual &&
            Number(savedGeometry.x) === actual.x && Number(savedGeometry.y) === actual.y &&
            Number(savedGeometry.width) === actual.width && Number(savedGeometry.height) === actual.height);
        if (!savedGeometry) legacyGeometryCount++;
        const monitorOk = actual && Number(window.monitor_number) === actual.index;
        const primaryOk = actual && Boolean(window.is_on_primary_monitor) === actual.primary;
        const pidLive = Number.isInteger(window.pid) && GLib.file_test(`/proc/${window.pid}`, GLib.FileTest.IS_DIR);
        const countOk = counts.get(window.wm_class) === Number(window.windows_count);
        const idOk = !ids.has(window.window_id);
        const rectOk = [rect.x_offset, rect.y_offset, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
        const stateOk = typeof window.fullscreen === 'boolean' && typeof window.minimized === 'boolean' &&
            typeof window.maximized === 'boolean' &&
            (typeof state.meta_maximized === 'boolean' || Number.isInteger(state.meta_maximized)) &&
            window.maximized === Boolean(state.meta_maximized);
        const identityOk = window.window_id !== null && window.window_id !== undefined &&
            typeof window.wm_class === 'string' && window.wm_class.length > 0 &&
            typeof window.desktop_file_id === 'string' && Number.isInteger(window.pid) &&
            window.session_window_index === index;
        const metadataOk = rectOk && stateOk && identityOk && Boolean(savedGeometry);
        ids.add(window.window_id);
        pass &&= Boolean(actual && monitorOk && primaryOk && geometryOk && countOk && idOk);
        if (strict) pass &&= metadataOk;
        print(`${monitorOk && primaryOk && geometryOk ? 'OK' : 'FAIL'} #${index + 1} ${window.app_name} | monitor=${window.monitor_number}/${actual?.index ?? 'none'} | screen=${savedGeometry ? (geometryOk ? 'ok' : 'mismatch') : 'legacy'} | rect=(${rect.x_offset},${rect.y_offset} ${rect.width}x${rect.height}) | primary=${yesNo(window.is_on_primary_monitor)} | fullscreen=${yesNo(window.fullscreen)} | maximized=${yesNo(state.meta_maximized)} | sticky=${yesNo(state.is_sticky)} | above=${yesNo(state.is_above)} | minimized=${yesNo(window.minimized)} | workspace=${window.desktop_number ?? 'bilinmiyor'} | pid=${pidLive ? 'canli' : 'kapali'} | windows_count=${countOk ? 'ok' : 'mismatch'}`);
        if (strict && !metadataOk)
            print(`FAIL #${index + 1} metadata: rect=${rectOk} state=${stateOk} identity=${identityOk} monitor_geometry=${Boolean(savedGeometry)}`);
    }
    print(`RESULT: ${pass ? 'PASS' : 'FAIL'} (monitor/primary/screen/duplicate/count checks; legacy_screen_geometry=${legacyGeometryCount})`);
    System.exit(pass ? 0 : 1);
} catch (error) {
    printerr(`VERIFY ERROR: ${error.message}`);
    System.exit(2);
}
