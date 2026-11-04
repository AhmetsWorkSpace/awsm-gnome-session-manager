# gnome-shell-extension-another-window-session-manager
Close open windows gracefully and save them as a session. And you can restore them when necessary manually or automatically at startup.

Most importantly, it supports both X11 and Wayland!

## AWSM GNOME 50 Wayland Refactoring Guide

Bu bölüm, mevcut proje belgelerini ve GNOME 50 / Mutter Wayland refactoring kurallarını tek yerde toplar. Eski proje kullanım belgeleri aşağıdaki teknik çalışma kurallarıyla birlikte okunmalıdır.

### Kural ve şartname dosyaları

- [AI_GUIDELINES.md](./AI_GUIDELINES.md): GNOME 50 Wayland mimarisi, Mutter API kısıtları, monitör tespiti, yüzey hazır olma yarışı, sinyal yaşam döngüsü ve pencere eşleştirme kuralları.
- [DEVELOPER_TEST_RULES.md](./DEVELOPER_TEST_RULES.md): Yerel-öncelikli çalışma, atomik Save/Restore/Move test hattı, statik doğrulama ve canlı kabul sınırları.
- [metadata.json](./metadata.json): Eklenti UUID'si, GNOME Shell sürüm uyumluluğu ve meta veriler.
- [GSettings şeması](./schemas/org.gnome.shell.extensions.another-window-session-manager.gschema.xml): Kullanılabilecek ayar anahtarlarının tek yetkili kaynağı. Özellikle `windows-mapping`, `stash-and-restore-states`, `autorestore-sessions` ve `enable-autoclose-session` anahtarları buradan doğrulanmalıdır.
- [SYSTEM_ENVIRONMENT.md](./SYSTEM_ENVIRONMENT.md): Yerel GNOME/GJS/Wayland kanıtları, GIR kaynak durumu, Mutter DisplayConfig erişim sonucu ve doğrulanmamış ortam alanları.

### SYSTEM_ENVIRONMENT.md ayrıntılı kullanım

SYSTEM_ENVIRONMENT.md, geliştirici AI'ın GNOME ve Wayland davranışı hakkında varsayım üretmesini engelleyen yerel ortam kayıt dosyasıdır. Bu belge kodun kendisi veya canlı test sonucu değildir; sistemden ölçülen değerleri, ölçülemeyen alanları ve ölçümün nasıl tekrarlanacağını ayırır.

#### Belgenin kanıt kapsamı

Belge beş ayrı bilgi katmanını tanımlar:

1. **Çalışma ortamı:** GNOME Shell, GJS ve oturum türü sürümleri.
2. **Yerel GIR durumu:** Meta, Shell ve Clutter introspection dosyalarının sistemde bulunup bulunmadığı.
3. **Mutter DisplayConfig:** Bağlı monitörler, çözünürlükler ve global koordinatlar için D-Bus erişiminin başarılı, başarısız veya bilinmiyor durumu.
4. **Wayland mimari sınırları:** window-created, ilk buffer commit'i, move_to_monitor() ve move_frame() arasındaki asenkron yaşam döngüsü.
5. **Yenileme prosedürü:** Belgenin canlı hedef makinede tekrar oluşturulması için güvenli yerel komutlar.

#### Güvenilirlik ve bilinmeyen değerler

- gnome-shell --version, gjs --version ve $XDG_SESSION_TYPE çıktıları yalnızca çalıştırıldıkları ortam için geçerli kanıttır.
- GIR dosyalarının bulunamaması, API'nin bulunmadığını kanıtlamaz; yalnızca bu dosya yolunda yerel GIR kanıtı olmadığını gösterir.
- Mutter DisplayConfig D-Bus çağrısının izin hatası vermesi, monitör bulunmadığı anlamına gelmez. Bu durumda monitör sayısı ve koordinatları 'bilinmiyor' olarak kalır.
- Oturum JSON'undaki monitor_number, fiziksel ekran düzeninin bağımsız kanıtı değildir.
- Statik ortam kaydı, üç monitörlü canlı Wayland pencere taşıma kabulü yerine kullanılamaz.

Bu nedenle geliştirici AI, SYSTEM_ENVIRONMENT.md içindeki bir değeri yalnızca belgedeki kanıt türüyle uyumlu kapsamda kullanmalı; bilinmeyen alanları 0, false veya varsayılan monitör olarak yorumlamamalıdır.

#### AI'ın kaynak önceliği

GNOME/Wayland API davranışı araştırılırken kaynaklar şu sırada değerlendirilir:

1. Çalışan makinedeki doğrulanmış runtime ve yerel dosya kanıtı.
2. Bu projedeki çağrı noktaları, modeller, şemalar ve yaşam döngüsü kodu.
3. [GJS API belgeleri](https://gjs-docs.gnome.org/).
4. [GJS Extensions Guide](https://gjs.guide/extensions/).
5. [GNOME Shell kaynak kodu](https://gitlab.gnome.org/GNOME/gnome-shell/).

İnternetteki farklı GNOME sürümüne ait örnekler, yerel runtime kanıtının yerine geçirilemez. Bir API imzası veya davranışı yerel olarak doğrulanamıyorsa AI bunu açıkça 'doğrulanmadı' olarak belirtmeli ve varsayımsal kod üretmemelidir.

#### Kod değişikliğinde kullanım

saveSession.js, restoreSession.js veya moveSession.js üzerinde değişiklik yapılmadan önce AI:

1. SYSTEM_ENVIRONMENT.md içindeki sürüm ve oturum türünü okur.
2. İlgili Meta.Window, Meta.Display veya Gio çağrısının projede nasıl kullanıldığını arar.
3. Monitör geometrisi veya D-Bus verisi bilinmiyorsa sabit koordinat/monitör varsayımı yapmaz.
4. Wayland surface hazır olma yarışını ve destroy() temizliğini hesaba katar.
5. Değişikliğin statik kanıt mı, yerel/sentetik kanıt mı, yoksa canlı hedef kanıtı mı olduğunu raporlar.

#### Belgeyi yenileme ve yorumlama

Canlı hedef makinede belge yenilendiğinde en az şu bilgiler tekrar kontrol edilmelidir:

    printf 'GNOME Shell: '; gnome-shell --version
    printf 'Session: '; printf '%s\n' "$XDG_SESSION_TYPE"
    printf 'GJS: '; gjs --version
    find /usr/share/gir-1.0 -maxdepth 1 -type f \
      \( -name 'Meta-*.gir' -o -name 'Shell-*.gir' -o -name 'Clutter-*.gir' \) \
      -printf '%f\n' | sort

Monitör geometrisi gerekiyorsa Mutter DisplayConfig ayrıca denenmelidir:

    gdbus call --session \
      --dest org.gnome.Mutter.DisplayConfig \
      --object-path /org/gnome/Mutter/DisplayConfig \
      --method org.gnome.Mutter.DisplayConfig.GetCurrentState

Bu komutun ham çıktısı README'ye veya sohbet geçmişine yapıştırılmaz. Çıktı yerelde filtrelenir; yalnızca monitör kimlikleri, koordinatlar, çözünürlükler ve hata durumu gibi gerekli kısa kanıtlar kaydedilir. Güncelleme sonrasında [DEVELOPER_TEST_RULES.md](./DEVELOPER_TEST_RULES.md) içindeki Save, Restore ve Wayland taşıma aşamaları yeniden değerlendirilir.

### Geliştirici AI çalışma protokolü

Kod değiştirmeden önce AI şu sırayı izlemelidir:

1. Bu README, [AI_GUIDELINES.md](./AI_GUIDELINES.md) ve [DEVELOPER_TEST_RULES.md](./DEVELOPER_TEST_RULES.md) okunur.
2. İlgili JS dosyalarının yorumları, çağrı noktaları ve yerel şema tanımları araştırılır.
3. Yalnızca tek mikro-problem için minimal diff uygulanır.
4. Önce yerel statik doğrulama, sonra ilgili atomik canlı test yapılır.
5. Statik veya sentetik sonuç, gerçek Wayland/çoklu monitör kabulü olarak raporlanmaz.

### Orijinal yazar notlarını yerel CPU ile tarama

Ham belge ve log içerikleri sohbete taşınmadan, proje kökünde aşağıdaki komutlarla dosya ve URL envanteri çıkarılabilir:

```bash
python3 - <<'PY'
from pathlib import Path
import re

repo = Path.cwd()
allowed = {'.md', '.txt', '.json', '.xml', '.org'}
print('=== DOKÜMANTASYON VE METİN DOSYALARI ===')
for path in sorted(p for p in repo.rglob('*') if p.is_file() and p.suffix.lower() in allowed):
    print(path.relative_to(repo))

print('\n=== JS DOSYALARINDAKİ WEB REFERANSLARI ===')
pattern = re.compile(r'https?://[^\s)<>]+')
for path in sorted(repo.rglob('*.js')):
    try:
        for line_no, line in enumerate(path.read_text(errors='replace').splitlines(), 1):
            if pattern.search(line):
                print(f'{path.relative_to(repo)}:{line_no}:{line.strip()}')
    except OSError:
        pass
PY
```

Şema anahtarlarını ayrıca doğrudan doğrulamak için:

```bash
gsettings --schemadir ./schemas list-keys org.gnome.shell.extensions.another-window-session-manager
```

Bu envanter araştırma kanıtıdır; tek başına kod değişikliği veya canlı kabul kanıtı değildir.

This extension is based on several [Gnome technologies](https://www.gnome.org/technologies/) and APIs including [Meta](https://gjs-docs.gnome.org/meta9~9_api), [Shell](https://gjs-docs.gnome.org/shell01~0.1_api/) and [St(Shell Toolkit)](https://gjs-docs.gnome.org/st10~1.0_api/).


<p align="left">
  <a href="https://extensions.gnome.org/extension/4709/another-window-session-manager/">
    <img alt="Get it on GNOME Extensions" width="228" src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extensions-badge/master/get-it-on-ego.svg?sanitize=true"/>
  </a>
</p>

# Screenshot

## Overview
![image](https://user-images.githubusercontent.com/2271720/163019716-2177ca8e-97b7-4a6c-9c4a-74a2326642be.png)

## Close open windows
Click item to close open windows:

![image](https://user-images.githubusercontent.com/2271720/163229388-5504c439-ae4a-445b-a3f7-aa768af3975d.png)


After confirm to close:

![image](https://user-images.githubusercontent.com/2271720/163229434-2c06b9d2-2b19-4205-80e8-58c2ae68a0cd.png)

## Save open windows
Click item to save open windows as a session:

![image](https://user-images.githubusercontent.com/2271720/147727121-82cb063f-339d-481c-bccb-07e91e0fe5d4.png)


After confirm to save:

![image](https://user-images.githubusercontent.com/2271720/163229511-f83df883-5afe-47ae-8855-fef68586e5a4.png)

## Activate the current session to be restored at startup
![image](https://user-images.githubusercontent.com/2271720/162792703-20da002b-b590-4df5-964e-9c586e8915bc.png)

## Preferences

### Restore sessions
![image](https://user-images.githubusercontent.com/2271720/214390369-04736886-6dac-48de-bcde-782277a4448e.png)

### Close windows
![image](https://user-images.githubusercontent.com/2271720/215283405-5c052244-8223-4aa4-9786-2798a073c3e0.png)

# Main features
1. Restore the previous session at startup. **disabled by default**, to enable it please activate `Restore previous apps and windows at startup` under `Restore sessions`. (See also: [Restore previous apps and windows at startup](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager#restore-previous-apps-and-windows-at-startup)).
1. Save running apps and windows automatically when necessary, this will be used to restore the previous session at startup.
1. Close running apps and windows automatically before `Log Out`, `Restart`, `Power Off`. **disabled by default**, to enable it please activate `Auto close session` under `Close windows`. (See also: [Auto close session](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager#auto-close-session)).
1. Close running windows gracefully
1. Close apps with multiple windows gracefully via `ydotool` so you don't lose sessions of this app (See also: [How to make Close by rules work](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager#how-to-make-close-by-rules-work))
1. Save running apps and windows manually
1. Restore a selected session at startup (See also: [#9](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager/issues/9#issuecomment-1097012874)). **disabled by default**.
1. Restore a saved session manually
1. Restore window state, including `Always on Top`, `Always on Visible Workspace` and maximization
1. Restore window workspace, size and position
1. Restore 2 column window tiling
1. Stash all supported window states so that those states will be restored after gnome shell restarts via `Alt+F2 -> r` or `killall -3 gnome-shell`.
1. Move windows to their own workspace according to a saved session
1. Support multi-monitor
1. Remove saved session to trash
1. Search saved session by the session name fuzzily
1. ...

## Close windows

### Auto close session
Enable this feature through `Auto close session` under `Close windows`:

![image](https://user-images.githubusercontent.com/2271720/214387813-fece3c78-6e27-494a-9edd-4705350c7179.png)

After you click the `Log Out/Restart/Power Off` button:

![image](https://user-images.githubusercontent.com/2271720/214377307-0af5b841-93b8-4b6c-bd09-7a620dc79025.png)

If the second button on the above dialog has `via AWSM`, it means this feature is enabled. 

After you click `Log Out(via AWSM)`, all apps and windows will be closed automatically by AWSM. But some apps might be still opening, you have to close them yourself; then if there are no running apps, this extension logs out the current user immediately.

![image](https://user-images.githubusercontent.com/2271720/214394659-651e6259-842c-49ca-9c97-6df62c9485d1.png)

You can move it around in case it covers other windows.

Please note that currently if this option is enabled, it modifies the Gnome Shell `endSessionDialog` **globally**, which means running `gnome-session-quit --logout` will also popup the new modified dialog.

### How to make `Close by rules` work

To make this feature work, you need to install [ydotool](https://github.com/ReimuNotMoe/ydotool):

```bash
# 1. Install `ydotool` using the package manager and make sure the version is greater than v1.0.0
sudo dnf install ydotool
#Or install it from the source code: https://github.com/ReimuNotMoe/ydotool

#Check the permission of `/dev/uinput`, if it's `crw-rw----+`, you can skip step 2
# 2. Get permission to access to `/dev/uinput` as the normal user
sudo touch /etc/udev/rules.d/60-awsm-ydotool-uinput.rules
# Here we use `tee`, not redirect(>), to avoid `warning: An error occurred while redirecting file '/etc/udev/rules.d/60-awsm-ydotool-uinput.rules' open: Permission denied`
# See: https://www.shellhacks.com/sudo-echo-to-file-permission-denied/
echo '# See:
  # https://github.com/ValveSoftware/steam-devices/blob/master/60-steam-input.rules 
  # https://github.com/ReimuNotMoe/ydotool/issues/25

  # ydotool udev write access
  KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput"' | sudo tee --append /etc/udev/rules.d/60-awsm-ydotool-uinput.rules

cat /etc/udev/rules.d/60-awsm-ydotool-uinput.rules
#Remove executable permission (a.k.a. x)
sudo chmod 644 /etc/udev/rules.d/60-awsm-ydotool-uinput.rules

# 3. Copy ydotool.service to /usr/lib/systemd/user, so `systemctl --user enable ydotool.service` can work
sudo cp /usr/lib/systemd/system/ydotool.service /usr/lib/systemd/user
# 4. Start ydotool.service at startup automatically for the current normal user
systemctl --user enable ydotool.service
# 5. Note that you may have to restart the system if the following commands are not working
# 6. Start the ydotoold service for the current normal user
systemctl --user start ydotool.service
# 7. Check if ydotoold service is working. The word `hello` should print on the terminal, if not you might need to reboot the system or try to relogin your account. 
ydotool type 'hello'

## misc. ##

# Check if the ydotoold service is running, if not you may have to restart the system or start ydotool.service
systemctl --user status ydotool.service

```

Note that it's no necessary to run `systemctl --user enable ydotool.service`, because this extension starts `ydotool.service` every time while you use it to close windows.

Feel free to fill an issue if `ydotool` does not work under normal user, you may also want to do that in [its git issue area](https://github.com/ReimuNotMoe/ydotool/issues)

## Restore sessions

### Restore previous apps and windows at startup
![image](https://user-images.githubusercontent.com/2271720/214390369-04736886-6dac-48de-bcde-782277a4448e.png)

Activate `Restore previous apps and windows at startup` to enable this feature. This option and `Restore selected session at startup` are exclusive. And this option works for shutting down the system normally (via Log Out/Restart/Power Off buttons) and other ways (like pressing the physical power-off button).

Then while startup, AWSM will launch and restore apps and states from the previous saved session configs.

The session configs are saved in the path `~/.config/another-window-session-manager/sessions/currentSession`.

You can use the below command to test it. 
```bash
gdbus call --session --dest org.gnome.Shell.Extensions.awsm --object-path /org/gnome/Shell/Extensions/awsm --method org.gnome.Shell.Extensions.awsm.Autostart.RestorePreviousSession "{'removeAfterRestore': <false>}"
```

### How to `Restore a session at startup`?

To make it work, you must enable it through `Restore sessions -> Restore at startup` in the Preferences AND active a session by clicking <img src=https://user-images.githubusercontent.com/2271720/162792222-0fc7e6ca-1382-49cf-975a-f53d878d0479.png width="24" height="13"> in the popup menu.

While you enable it through `Restore sessions -> Restore at startup`, it creates a `_gnome-shell-extension-another-window-session-manager.desktop` under the folder `~/.config/autostart/`. 

Test the settings in command line via:
```Bash
gdbus call --session --dest org.gnome.Shell.Extensions.awsm --object-path /org/gnome/Shell/Extensions/awsm --method org.gnome.Shell.Extensions.awsm.Autostart.RestoreSession
```

Please do not modify `_gnome-shell-extension-another-window-session-manager.desktop`, all changes by yourself could be overidden or deleted.

# Panel menu items

## Icons description

| Icon                                                         | Description                                                  |
|--------------------------------------------------------------|--------------------------------------------------------------|
| <img src=icons/save-symbolic.svg width="14" height="14">     | Save open windows as a session, which name is the item's name |
| <img src=icons/restore-symbolic.svg width="14" height="14">  | Restore the saved session using the item's name               |
| <img src=icons/move-symbolic.svg width="14" height="14">     | Move the open windows using the item's name                  |
| <img src=icons/close-symbolic.svg width="14" height="14">    | Close the current open windows                               |
| <img src=icons/toggle-on-autorestore-symbolic.svg width="24" height="13">    | Activate the current session to be restored at startup |
| <img src=https://user-images.githubusercontent.com/2271720/162792222-0fc7e6ca-1382-49cf-975a-f53d878d0479.png width="24" height="13">    | Inactivate the current session to be restored at startup |
| <img src=icons/autorestore-symbolic.svg width="13" height="13">    | Indicate the autorestore button       |


# Dependencies
* procps-ng

Use `ps` and `pwdx` to get some information from a process, install it via `dnf install procps-ng` if you don't have.

* glib2

Use `gdbus` to call the remote method, which is provided by this exension, to implement the `restore at start` feature. `gdbus` is part of `glib2`.

* ydotool

Send keys to close the application gracefully with multiple windows.

* libgtop2

As of version 34, AWSM also uses `libgtop2` to query process information, just like `ps`. The cost of calling `ps` is very high, so I'm planing to remove this entirely.

To install it:

* Fedora and derivatives:
`dnf install libgtop2`

* Debian, Ubuntu, Pop!_OS, and derivatives:
`apt install gir1.2-gtop-2.0 libgtop2-dev`

* Arch and derivatives:
`pacman -S libgtop`

# Known issues

1. On both X11 and Wayland, if click restore button (<img src=icons/restore-symbolic.svg width="14" height="14">) continually during the process of restoring, the window size and position may can't be restored, and it may restore many instances of an application. **As a workaround, click the restore button (<img src=icons/restore-symbolic.svg width="14" height="14">) only once until all apps are restored.**

# Support applications launched via a command line or applications that don't have a proper .desktop file
If the .desktop is missing from a session file, restoring an application relies on the command line completely.

In this case this extension will generate a .desktop in the `journalctl` when you click the save button (<img src=icons/save-symbolic.svg width="14" height="14">). Search `Generated a .desktop file` in `journalctl /usr/bin/gnome-shell -r` to find it: `journalctl /usr/bin/gnome-shell -b -o cat --no-pager | grep 'Generated a .desktop file'`. To make it work, You need to copy it to `~/.local/share/applications`, and relaunch the app and save the session again. This extension should be able to restore the workspace, state, size and position of this application.

**The generated .desktop might not work sometimes, it's better to check whether the value of `Exec` is correct or not.** If you restore an app using a bad .desktop, this extension will give you a notification and log error level logs in the `journalctl`.

I tested on Anki, VirtualBox machine and two .AppImage apps, they all have no .desktop and are launched in the terminal. By using the generated .desktop, Anki, VirtualBox machine works. One .AppImage app works. Another .AppImage app is `Wire_x86_64.AppImage` and doesn't work, because the command line returned is something like `/tmp/.mount_Wire-3xxxxx/wire-desktop`, you can use it to launch Wire but files in the `/tmp` will be deleted during the OS shutdown and start.

It's impossible / hard to query the command line from a process, the pid of a window might not be right too and I don't find a standard way for this.

## How can I know whether a .desktop of an application is proper or not?

One of the following should be enough to prove the .desktop is not proper:
1. Right click on the icon in the panel or dash, if there is no `Add to Favorites` in the menu
2. This extension can launch an application, but can't move the window to its workspace. (But it might suggest there is a bug in this extension, LOL :))

Most existing applications should have a proper .desktop. I'm just handling the special case. Someone like myself might want this feature.

# Where are the saved sessions?
They are all in `~/.config/another-window-session-manager/sessions`. When use an existing name to save the current open windows, the previous file will be copied to `~/.config/another-window-session-manager/sessions/backups` as a new name, which is the-old-session-name**.backup-current-timestamp**.

Note that I've marked `backups` as a reserved word, so you can't use it as a session name when saving a session. But you do have the freedom to manually create a file named `backups` in `~/.config/another-window-session-manager/sessions`. But this extension will only backup the session file that you are clicking the save button and you will receive an error log in the `journalctl` and an error notification every time you save an existing session.

# TODO
1. - Close open windows
     - [ ] Close all windows on the current workspace. (WIP, see https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager/pull/71)
1. - Save open windows
     - [x] Save open windows 
1. - Restore saved open windows
      - [x] Restore saved open windows
      - [x] Move to belonging workspace automatically
      - [x] Restore window size and position ([issue 17](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager/issues/17))
      - [x] Restore window workspace, size and position of applications launched via a command line and don't have a recognizable `.desktop` file by `Shell.AppSystem.get_default().get_running()`.
      - [x] Support multi-monitor ([issue 21](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager/issues/21))
1. - Saved open windows list
      - [x] Save open windows button
      - [x] Restore button
      - [ ] Rename button (double click text to rename?)
      - [x] Move button
      - [x] Delete button
1. - [x] Move windows according to a saved session.
1. - [ ] Settings
      - [x] Debugging mode
      - [ ] whitelist using for closing application with multiple windows
1. - [x] Support restoring a saved session at startup ([issue 9](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager/issues/9))
1. - [x] Support saving and closing windows when Log Out, Power off, Reboot ([issue 9](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager/issues/9))
1. - [ ] All TODO tags in the projects
1. - [ ] Translation?
1. - [ ] A client tool called `awsm-client` (See: [issue 34](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager/issues/34))
1. - [ ] Fix any typo or grammar errors.
1. - [ ] Open the Preferences on the popup menu 
1. - [x] Open the session file from the popup menu

