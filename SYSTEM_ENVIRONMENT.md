# Sistem Ortamı ve Mutter Wayland Teknik Spesifikasyonları

Bu belge, AWSM refactoring çalışmasında kullanılan sistem gerçeklerini ve doğrulanamayan alanları birbirinden ayırır. Değerler otomatik olarak keşfedilmiştir; bilinmeyen değerler tahmin edilmez.

## 1. Doğrulanmış çalışma ortamı

| Alan | Değer | Kanıt |
| --- | --- | --- |
| GNOME Shell | `GNOME Shell 50.1` | `gnome-shell --version` |
| Oturum türü | `wayland` | `$XDG_SESSION_TYPE` |
| GJS | `gjs 1.88.0` | `gjs --version` |
| Eklenti hedefi | GNOME Shell 50 | [`metadata.json`](./metadata.json) |

## 2. Yerel GIR/API kaynakları

Kontrol edilen yollar:

- `/usr/share/gir-1.0/Meta-*.gir`
- `/usr/share/gir-1.0/Shell-*.gir`
- `/usr/share/gir-1.0/Clutter-*.gir`

Bu çalışma ortamında bu glob'larla eşleşen GIR dosyası bulunamadı. Bu nedenle `Meta.Window`, `Meta.Display` veya Clutter imzaları için yerel GIR kanıtı varmış gibi davranılmamalıdır. Kod değişikliğinde mevcut GJS runtime introspection, proje içindeki çağrı noktaları ve resmi GNOME API belgeleri ayrı ayrı kaynak olarak belirtilmelidir.

Resmi başvuru noktaları:

- [GJS API belgeleri](https://gjs-docs.gnome.org/)
- [GJS Extensions Guide](https://gjs.guide/extensions/)
- [GNOME Shell kaynak kodu](https://gitlab.gnome.org/GNOME/gnome-shell)

## 3. Monitör ve koordinat kanıtı

Mutter DisplayConfig çağrısı bu çalışma ortamında aşağıdaki nedenle başarısız oldu:

```text
Error connecting: Could not connect: Operation not permitted
```

Bu nedenle bağlı monitör sayısı, global koordinatları, çalışma alanı geometrileri ve fiziksel ekran sıralaması burada `bilinmiyor` durumundadır. JSON oturum kayıtlarındaki `monitor_number` değerleri bu eksikliği gidermek için kullanılmamalı; bunlar yalnızca kayıt kanıtıdır.

Canlı GNOME kullanıcı oturumunda yenilemek için proje kökünden şu komut kullanılabilir:

```bash
gdbus call --session \
  --dest org.gnome.Mutter.DisplayConfig \
  --object-path /org/gnome/Mutter/DisplayConfig \
  --method org.gnome.Mutter.DisplayConfig.GetCurrentState
```

Ham D-Bus çıktısı sohbete yapıştırılmamalı; yerel olarak monitör kimlikleri, çözünürlükler ve koordinatlar filtrelenmelidir.

## 4. Wayland tasarım sınırları

1. Wayland istemcisi diğer pencerelerin mutlak koordinatlarını kendisi bilemez. Pencere konumlandırma yetkisi Mutter/`Meta.Window` tarafındadır.
2. `window-created` olayı, istemci yüzeyinin ilk buffer commit'inin tamamlandığını garanti etmez.
3. Taşıma akışı yüzeyin hazır olmasını, `window-entered-monitor` sinyalini ve timeout fallback'ini birlikte ele almalıdır.
4. `move_to_monitor()` tek başına geometrinin uygulanmış olduğunu kanıtlamaz; kayıtlı `Meta` koordinatları ayrıca uygulanmalıdır.
5. Snap iç revision binary yolları doğrudan başlatılmamalı; desktop ID, `Shell.App`/`Gio.DesktopAppInfo` veya doğrulanmış `/snap/bin/...` launcher tercih edilmelidir.

## 5. Yenileme komutu

Bu belgeyi canlı hedef makinede yeniden üretmek için aşağıdaki komutlar kullanılabilir. D-Bus çıktısı dosyaya yazılmadan önce izin ve kapsam kontrol edilmelidir:

```bash
printf 'GNOME Shell: '; gnome-shell --version
printf 'Session: '; printf '%s\n' "${XDG_SESSION_TYPE:-unknown}"
printf 'GJS: '; gjs --version
find /usr/share/gir-1.0 -maxdepth 1 -type f \
  \( -name 'Meta-*.gir' -o -name 'Shell-*.gir' -o -name 'Clutter-*.gir' \) \
  -printf '%f\n' | sort
```

Bu çıktı statik ortam kanıtıdır. Gerçek üç monitörlü Wayland pencere taşıma kabulü için [DEVELOPER_TEST_RULES.md](./DEVELOPER_TEST_RULES.md) içindeki üç aşamalı canlı test hattı ayrıca uygulanmalıdır.
