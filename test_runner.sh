#!/usr/bin/env bash
# AWSM yerel test ve dogrulama otomasyonu.
# Bu arac GNOME Shell'i yeniden baslatmaz; yalnizca eklentiyi yeniler.
set -euo pipefail

UUID='another-window-session-manager@gmail.com'
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_ID='org.gnome.shell.extensions.another-window-session-manager'
TARGET_FILE=''
SAVE_SESSION_NAME=''
UNIT_ONLY=false

while (($# > 0)); do
    case "$1" in
        --unit-only)
            UNIT_ONLY=true
            shift
            ;;
        --save-session)
            (($# >= 2)) || fail '--save-session bir oturum adi ister.'
            SAVE_SESSION_NAME="$2"
            shift 2
            ;;
        --)
            shift
            TARGET_FILE="${1:-}"
            [[ $# -le 1 ]] || fail 'Tek bir hedef dosya belirtilebilir.'
            break
            ;;
        *)
            [[ -z "$TARGET_FILE" ]] || fail 'Tek bir hedef dosya belirtilebilir.'
            TARGET_FILE="$1"
            shift
            ;;
    esac
done

fail() {
    printf '[FAIL] %s\n' "$1" >&2
    exit 1
}

printf '=== [1/4] SOZDIZIMI (SYNTAX) DENETIMI ===\n'
if [[ -n "$TARGET_FILE" ]]; then
    [[ "$TARGET_FILE" != /* && "$TARGET_FILE" != *'..'* ]] \
        || fail 'Hedef dosya yolu proje dizini disinda.'
    target_path="$REPO_DIR/$TARGET_FILE"
    [[ -f "$target_path" ]] || fail "Dosya bulunamadi: $TARGET_FILE"
    printf 'Denetleniyor: %s\n' "$TARGET_FILE"
    node --check "$target_path" || fail "Sozdizimi hatasi: $TARGET_FILE"
    printf '[PASS] Hedef JavaScript dosyasi parse edildi.\n'
else
    mapfile -t js_files < <(cd "$REPO_DIR" && rg --files -g '*.js' -g '*.mjs' -g '!node_modules/**' | sort)
    (( ${#js_files[@]} > 0 )) || fail 'JavaScript dosyasi bulunamadi.'
    for file in "${js_files[@]}"; do
        node --check "$REPO_DIR/$file" || fail "Sozdizimi hatasi: $file"
    done
    printf '[PASS] %d JavaScript dosyasi parse edildi.\n' "${#js_files[@]}"
fi

printf '=== [2/4] GSETTINGS SEMA DERLEME VE PROJE KONTROLU ===\n'
if [[ -d "$REPO_DIR/schemas" ]]; then
    command -v glib-compile-schemas >/dev/null \
        || fail 'glib-compile-schemas bulunamadi.'
    glib-compile-schemas "$REPO_DIR/schemas"
    printf '[PASS] GSettings semalari derlendi.\n'
else
    fail 'schemas dizini bulunamadi.'
fi

git -C "$REPO_DIR" diff --check || fail 'git diff --check basarisiz.'
printf '[PASS] git diff --check\n'

node "$REPO_DIR/scripts/test_restore_pool.cjs" || fail 'Restore hedef havuzu testi basarisiz.'
node "$REPO_DIR/scripts/test_process_argv.cjs" || fail 'Process argv testi basarisiz.'
node "$REPO_DIR/scripts/test_runtime_fixes.cjs" || fail 'Restore runtime testleri basarisiz.'
node "$REPO_DIR/scripts/test_settled_geometry.cjs" || fail 'Gecikmeli geometri testi basarisiz.'
node "$REPO_DIR/scripts/test_placement_observation.cjs" || fail 'Yerlesim gozlem testi basarisiz.'
node "$REPO_DIR/scripts/test_window_stacking.cjs" || fail 'Pencere katmanlama testi basarisiz.'
if $UNIT_ONLY; then
    printf '[PASS] Yalnizca yerel testler tamamlandi; eklenti yenilenmedi.\n'
    exit 0
fi

command -v gnome-extensions >/dev/null || fail 'gnome-extensions bulunamadi.'
command -v gdbus >/dev/null || fail 'gdbus bulunamadi.'
if [[ -z "$SAVE_SESSION_NAME" ]]; then
    printf '=== [3/4] GUVENLI EKLENTI YENILEME ===\n'
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
    gnome-extensions enable "$UUID" >/dev/null 2>&1 \
        || fail 'Eklenti yeniden etkinlestirilemedi.'
else
    printf '=== [3/4] CANLI DBUS SERVIS DURUMU (RELOAD YOK) ===\n'
    printf '[INFO] --save-session modu mevcut Shell servisinin yeniden yuklenmesini beklemeden kullaniliyor.\n'
fi

extension_info=''
extension_dbus_info=''
for attempt in {1..10}; do
    extension_info="$(gnome-extensions info "$UUID" 2>/dev/null || true)"
    extension_dbus_info="$(gdbus call --session \
        --dest org.gnome.Shell \
        --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Extensions.GetExtensionInfo \
        "$UUID" 2>/dev/null || true)"
    if printf '%s\n' "$extension_dbus_info" | rg -q "'enabled': <true>" \
        && printf '%s\n' "$extension_dbus_info" | rg -q "'state': <1(\.0)?>"; then
        break
    fi
    sleep 0.5
done

printf '%s\n' "$extension_dbus_info" | rg -q "'enabled': <true>" \
    || fail "Eklenti D-Bus enabled=true degil (10 denemeden sonra). CLI: $(printf '%s' "$extension_info" | tr '\n' ' ')"
printf '%s\n' "$extension_dbus_info" | rg -q "'state': <1(\.0)?>" \
    || fail "Eklenti D-Bus state=ACTIVE degil (10 denemeden sonra). CLI: $(printf '%s' "$extension_info" | tr '\n' ' ')"
printf '[PASS] Eklenti D-Bus enabled=true, state=ACTIVE\n'

printf '=== [4/4] LOG, KOMUT VE GSETTINGS KONTROLU ===\n'
command -v gnome-extensions-app >/dev/null \
    || fail 'gnome-extensions-app bulunamadi.'
for icon in \
    "$REPO_DIR/icons/preferences-system-symbolic.svg" \
    "$REPO_DIR/icons/applications-system-symbolic.svg"; do
    [[ -s "$icon" ]] || fail "Menu ikonu bulunamadi veya bos: $icon"
    rg -q 'fill="#ffffff"' "$icon" \
        || fail "Menu ikonu acik renk dolgulu degil: $icon"
done
rg -q 'gnome-extensions.*prefs|preferences-system-symbolic' \
    "$REPO_DIR/ui/popupMenuButtonItems.js" \
    || fail 'Preferences komutu/ikonu bulunamadi.'
rg -q 'gnome-extensions-app|applications-system-symbolic' \
    "$REPO_DIR/ui/popupMenuButtonItems.js" \
    || fail 'GNOME Extensions komutu/ikonu bulunamadi.'
rg -q 'this\.actor\.add_child\(preferencesButton\)|set_size\(28, 28\)' \
    "$REPO_DIR/ui/popupMenuButtonItems.js" \
    || fail 'Menu ikonlari ayni satirda sabitlenmemis.'
printf '[PASS] Menu aksiyon ikonlari, komutlar ve yerlesim bulundu.\n'

mapfile -t schema_lines < <(
    gsettings --schemadir "$REPO_DIR/schemas" list-recursively "$SCHEMA_ID"
)
(( ${#schema_lines[@]} > 0 )) || fail 'GSettings anahtarlari okunamadi.'
printf '[PASS] %d GSettings anahtari okundu; iki GNOME komutu mevcut.\n' "${#schema_lines[@]}"

errors="$(journalctl -b 0 /usr/bin/gnome-shell -p err -n 20 --no-pager 2>/dev/null \
    | rg -i 'awsm|another-window|sessionItem|popupMenuButtonItems' || true)"
if [[ -n "$errors" ]]; then
    printf '[WARN] Son GNOME Shell hata kayitlarinda AWSM eslesmesi var:\n%s\n' "$errors"
else
    printf '[PASS] Son GNOME Shell hata kayitlarinda AWSM eslesmesi yok.\n'
fi

if [[ -n "$SAVE_SESSION_NAME" ]]; then
    printf '=== [5/5] DBUS TAZE OTURUM KAYDI VE JSON DOGRULAMA ===\n'
    command -v gdbus >/dev/null || fail 'gdbus bulunamadi.'
    command -v gjs >/dev/null || fail 'gjs bulunamadi.'

    handler_probe=''
    for attempt in {1..20}; do
        handler_probe="$(gdbus call --session \
            --dest org.gnome.Shell.Extensions.awsm \
            --object-path /org/gnome/Shell/Extensions/awsm \
            --method org.gnome.Shell.Extensions.awsm.Autostart.SaveSession \
            '..' 2>&1 || true)"
        if printf '%s\n' "$handler_probe" | rg -q 'ERROR: invalid session name'; then
            break
        fi
        sleep 0.25
    done
    if ! printf '%s\n' "$handler_probe" | rg -q 'ERROR: invalid session name'; then
        if printf '%s\n' "$handler_probe" | rg -qi 'UnknownMethod|Missing handler'; then
            fail 'D-Bus SaveSession handler Shell surecinde yuklu degil; GNOME oturumu yenilendikten sonra tekrar deneyin.'
        fi
        fail "D-Bus SaveSession hazir degil: $handler_probe"
    fi

    session_path="$HOME/.config/another-window-session-manager/sessions/$SAVE_SESSION_NAME"
    previous_file_state="$(stat -c '%i:%y:%s' -- "$session_path" 2>/dev/null || true)"
    save_response="$(gdbus call --session \
        --dest org.gnome.Shell.Extensions.awsm \
        --object-path /org/gnome/Shell/Extensions/awsm \
        --method org.gnome.Shell.Extensions.awsm.Autostart.SaveSession \
        "$SAVE_SESSION_NAME" 2>&1)" \
        || fail "D-Bus SaveSession cagrisi basarisiz: $save_response"
    printf '[INFO] %s\n' "$save_response"
    [[ "$save_response" != *ERROR* && "$save_response" != *'already in progress'* ]] \
        || fail "Kayit istegi kabul edilmedi: $save_response"

    verified_output=''
    for attempt in {1..40}; do
        current_file_state="$(stat -c '%i:%y:%s' -- "$session_path" 2>/dev/null || true)"
        if [[ -n "$current_file_state" && "$current_file_state" != "$previous_file_state" ]]; then
            verified_output="$(gjs -m "$REPO_DIR/scripts/verify_session_state.js" "$session_path" --strict 2>&1 || true)"
            if printf '%s\n' "$verified_output" | rg -q 'RESULT: PASS' \
                && printf '%s\n' "$verified_output" | rg -q 'legacy_screen_geometry=0'; then
                printf '[PASS] %s taze kaydedildi; legacy_screen_geometry=0.\n' "$SAVE_SESSION_NAME"
                break
            fi
        fi
        if (( attempt == 40 )); then
            printf '%s\n' "$verified_output" | tail -n 5
            fail "Taze oturum dogrulamasi basarisiz: legacy_screen_geometry=0 olmadi."
        fi
        sleep 0.5
    done
fi

printf '=== BUTUN TESTLER BASARILI ===\n'
exit 0
