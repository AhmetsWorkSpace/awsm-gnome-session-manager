# GNOME Wayland Geliştirici Test ve Doğrulama Kuralları

Bu belge, AWSM (Another Window Session Manager) üzerinde çalışan geliştirici yapay zekâ için bağlayıcı uygulama, test ve raporlama kurallarını tanımlar. Hedef ortam GNOME Shell 50, Mutter ve Wayland'dir.

## 1. Yerel-öncelikli ve atomik çalışma

1. 100 satırdan uzun JavaScript dosyaları baştan sona yeniden üretilmez. Değişiklikler ilgili fonksiyon veya minimal unified diff ile sınırlanır.
2. Önce mevcut çağrı zinciri, yaşam döngüsü ve ilgili sinyaller incelenir; sonra en küçük güvenli yama uygulanır.
3. Büyük JSON dosyaları veya ham `journalctl` çıktıları konuşmaya taşınmaz. Yerel filtreleme için `jq`, `python3`, `sed`, `awk` veya `rg` kullanılır; yalnızca ilgili kısa hata çıktısı paylaşılır.
4. Değişiklikten önce git durumu kontrol edilir. Temiz bir git çalışma ağacı varsa küçük bir snapshot/stash alınabilir. Kirli çalışma ağacı körlemesine stash edilmez; mevcut kullanıcı değişiklikleri korunur.
5. Geri alma gerektiğinde yalnızca değiştirilen açık dosyalar hedeflenir. `git restore .`, çalışma alanını topluca silen veya ilgisiz kullanıcı değişikliklerini yok eden komutlar kullanılmaz.
6. Kod düzenlemeleri geri alınabilir ve dosya kapsamı açık olacak şekilde yapılır. Her aşamada önceki aşamanın kanıtı görülmeden sonraki mimari katmana geçilmez.

## 2. GNOME Wayland çalışma kuralları

### A. Eklenti yeniden yükleme

Wayland altında `Alt+F2 -> r` güvenilir bir yeniden yükleme yöntemi değildir. Kod değişikliğinden sonra, canlı test yetkisi ve uygun kullanıcı oturumu varsa eklenti şu şekilde yeniden yüklenebilir:

```bash
gnome-extensions disable another-window-session-manager@gmail.com && \
gnome-extensions enable another-window-session-manager@gmail.com
```

Bu komut yalnızca canlı test aşamasında çalıştırılır; statik doğrulamanın yerine geçmez.

### B. Sözdizimi kapısı

Eklenti yeniden yüklenmeden önce değişen her JS dosyası doğrulanır:

```bash
for f in saveSession.js restoreSession.js moveSession.js indicator.js; do node --check "$f" || exit 1; done
```

`node --check` kullanılamazsa uygun bir `gjs` sözdizimi kontrolü tercih edilir. Sözdizimi kontrolü yalnızca parse başarısını kanıtlar; GNOME Shell API uyumluluğunu veya canlı pencere davranışını kanıtlamaz.

### C. GSettings tahmini yasak

GUI etiketleri ile şema anahtarları aynı kabul edilmez. Anahtar kullanılmadan önce yerel şemadan okunur:

```bash
gsettings --schemadir ./schemas list-keys org.gnome.shell.extensions.another-window-session-manager
```

Şemada bulunmayan anahtar adı koda eklenmez.

### D. Odaklı log inceleme

Ham ve sınırsız Shell logu istenmez. İlk inceleme kısa ve hata seviyesine sınırlı tutulur:

```bash
journalctl -b 0 /usr/bin/gnome-shell -p err --no-pager -n 20
```

Canlı kabul için log satırı tek başına yeterli kanıt sayılmaz; ilgili çağrı, pencere durumu ve sonuç birlikte değerlendirilir.

## 3. Zorunlu üç aşamalı test hattı

### Aşama 1: Save doğrulaması

1. Pencereler fiziksel olarak farklı monitörlere yerleştirilir.
2. Oturum kaydedilir.
3. JSON yerelde filtrelenir; tüm kayıtlar konuşmaya yapıştırılmaz:

```bash
find "$HOME/.config/another-window-session-manager/currentSession" -type f -name '*.json' -print0 | xargs -0 -r jq -r '.monitor_number // "MISSING"' | sort | uniq -c
```

Beklenen sonuç, mevcut fiziksel düzenle uyumlu monitor indekslerinin görülmesidir. `0, 1, 2` değerleri her sistemde zorunlu değildir; monitör sayısı ve Mutter indekslemesi doğrulanmadan sabit çıktı beklenmez.

### Aşama 2: Temiz restore ve çoklu pencere

Önceki aşamanın JSON kanıtı geçerli olmadan restore mantığı değiştirilmez. Temiz durum testi yapılırken Firefox'un gerçekten kapanmış olduğu ayrıca doğrulanır. Beklenen kanıtlar:

- desktop ID üzerinden başlatma,
- aynı PID'e sahip pencerelerin ayrı pencere olayları olarak oluşması,
- FIFO kayıt kuyruğunun her pencereyi yalnızca bir kez tüketmesi,
- mevcut açık pencereler varsa adoption yolunun çalışması.

### Aşama 3: Wayland taşıma ve koordinat

Pencere yüzeyi hazır olmadan taşıma denenmez. Testte şu sonuçlar ayrı ayrı kontrol edilir:

- hedef monitör doğru mu,
- `window-entered-monitor` veya timeout fallback tamamlanıyor mu,
- kayıtlı `x_offset`, `y_offset`, genişlik ve yükseklik uygulanıyor mu,
- hedef workspace ve pencere durumu korunuyor mu.

Bu aşama tamamlanmadan görevin canlı olarak tamamlandığı söylenmez.

## 4. Mimari denetim listesi

### Save

- `metaWindow.get_frame_rect()` kullanılmalı.
- Öncelik `global.display.get_monitor_index_for_rect(rect)` olmalı.
- Geçersiz sonuçta geometri kesişimi ve son olarak `metaWindow.get_monitor()` fallback'i kullanılmalı.
- `is_on_primary_monitor`, son tespit edilen indeks ile `get_primary_monitor()` karşılaştırılmalı.
- Snap uygulamalarında iç revision binary yolu doğrudan restore komutu olarak güvenilmemeli.

### Restore

- `desktop_file_id`, `Shell.App` veya `Gio.DesktopAppInfo` öncelikli olmalı.
- Aynı uygulamanın pencere kayıtları FIFO kuyruğunda tutulmalı.
- Firefox gibi çoklu pencere uygulamalarında her ek kayıt için kontrollü pencere oluşturma yapılmalı.
- PID, pencere kimliği olarak kullanılmamalı; yalnızca yardımcı süreç eşleştirme bilgisi olabilir.
- Başlatma başarısızsa ilgili kuyruk kaydı temizlenmeli.

### Move

- `MetaWindow` yüzeyi hazır değilse sınırlı idle/timeout retry uygulanmalı.
- `move_to_monitor()` sinyal ve timeout fallback ile korunmalı.
- Hedef monitör sonrasında `move_frame(true, x, y)` ve gerektiğinde `move_resize_frame()` uygulanmalı.
- Tüm signal, timeout ve bekleyen Promise yaşam döngüsü `destroy()` sırasında temizlenmeli.

### Adoption

- Uygulama zaten çalışıyorsa yeni süreç beklenmemeli.
- `shellApp.get_windows()` içindeki açık pencereler kayıt kuyruğuyla eşleştirilmeli.
- Başlık eşleşmesi varsa yalnızca tercih olarak kullanılmalı; geçici Wayland başlığı nedeniyle FIFO fallback korunmalı.

## 5. Wayland çalışma ortamı güvenlik protokolü

GNOME Wayland oturumunda GNOME Shell, Mutter ile birlikte masaüstü compositor'ının çalışma sürecidir. Bu nedenle çalışma ortamını yenilemek için GNOME Shell sürecine sinyal göndermek, eklenti testinin kapsamı dışındadır ve açık kullanıcı izni olmadan kesinlikle yapılmaz.

### A. Yasaklı komutlar

Aşağıdaki komutlar çalıştırılmaz, önerilmez ve test betiklerine eklenmez:

- `kill -3`, `kill -HUP`, `killall -9 gnome-shell` veya GNOME Shell'e gönderilen diğer sinyaller.
- `gnome-shell --replace`.
- `systemctl restart gdm` veya `systemctl --user restart` ile GNOME Shell/oturum servislerini yeniden başlatma girişimleri.
- Kullanıcının açık uygulamalarını ve kaydedilmemiş verilerini etkileyebilecek izinsiz `killall -9 firefox`, `pkill` veya benzeri süreç katliamları.

Bu yasak, komutun bazı sistemlerde otomatik toparlanabilmesi ihtimalini değiştirmez: compositor yeniden başlatması açık pencereleri, paneli, test oturumunu ve kaydedilmemiş durumu bozabilir. Böyle bir durumda masaüstü yeniden başlatılmaz; çalışma durumu kullanıcıya bildirilir ve yalnızca güvenli, eklenti-sınırlı adımlar sürdürülür.

### B. İzin verilen eklenti yenilemesi

Kod değişikliklerini canlı eklentiye tanıtmak için, önce sözdizimi kapısı geçildikten sonra yalnızca şu eklenti-sınırlı yöntem kullanılabilir:

```bash
gnome-extensions disable another-window-session-manager@gmail.com && \
gnome-extensions enable another-window-session-manager@gmail.com
```

Bu işlem de yalnızca kullanıcı görevi kapsamında canlı yenileme istediğinde yapılır. Yenileme beklenen sonucu vermezse GNOME Shell yeniden başlatılmaz; durum `bilinmiyor` veya `engelli` olarak raporlanır ve kullanıcıdan yönlendirme istenir.

### C. Zorunlu ön kontrol

Eklenti yenilenmeden önce yalnızca değişen JavaScript dosyaları yerelde parse edilir. `node --check` kullanılabilir; `gjs -c <dosya>` bir dosya sözdizimi doğrulama standardı olarak kullanılmaz çünkü `-c` GJS'e komut metni verir, dosya yükleme seçeneği değildir.

```bash
for f in ui/infoDialog.js ui/popupMenuButtonItems.js indicator.js saveSession.js restoreSession.js moveSession.js; do
    node --check "$f" || exit 1
done
```

Ardından `git diff --check` ve ilgili yerel JSON/şema doğrulaması yapılır. Salt parse başarısı, GNOME Shell API uyumluluğu veya gerçek Wayland pencere davranışı kanıtı değildir.

### D. İlk tercih salt-okunur teşhis

Bir hata görüldüğünde önce `cat`, `sed`, `rg`, `jq`, `gsettings list-keys`, `gnome-extensions info` ve sınırlı `journalctl` ile durum okunur. Süreç kapatma, compositor yenileme, GDM restartı veya kullanıcı oturumunu değiştirme teşhis adımı değildir.

## 6. Otomatik yerel test aracı kullanım protokolü

Proje kökündeki `./test_runner.sh`, geliştirici yapay zekâ için zorunlu yerel doğrulama aracıdır. Betik; JavaScript parse kontrolünü, GSettings şema derlemesini, `git diff --check` doğrulamasını, güvenli eklenti yenilemesini, `Enabled/ACTIVE` durumunu, iki menü komutunu, şema anahtarlarını ve kısa AWSM hata taramasını otomatik olarak çalıştırır.

### Zorunlu döngü

1. Minimal kod yamasını uygula.
2. Değişen JavaScript dosyası için proje kökünde `./test_runner.sh <degisen-dosya.js>` çalıştır.
3. Kod dışı değişikliklerde veya kapsamlı kontrolde `./test_runner.sh` çalıştır.
4. `=== BUTUN TESTLER BASARILI ===` ve çıkış kodu `0` görülmeden bir sonraki geliştirmeye geçme.
5. `[FAIL]` oluşursa yalnızca başarısız kontrolü düzelt; GNOME Shell restartı, süreç öldürme veya geniş kapsamlı yıkıcı komut çalıştırma.

Bu araç gerçek üç monitörlü Wayland pencere yerleşimini tek başına kabul etmez; canlı pencere davranışı ayrıca `statik`, `yerel/sentetik` ve `canlı hedef ortamı` kanıt sınırlarıyla raporlanır.

### D-Bus ile başlıksız Save doğrulaması

Panel etkileşimi gerektirmeyen kayıt doğrulaması için:

```bash
./test_runner.sh --save-session FireFoxSetup
```

Bu mod mevcut canlı D-Bus servisini kullanır ve kayıt sonrasında `scripts/verify_session_state.js` ile `RESULT: PASS` ve `legacy_screen_geometry=0` koşullarını arar. Yeni bir D-Bus handler ilk kez eklenmişse, GJS modül önbelleği nedeniyle aynı GNOME Shell sürecindeki `disable/enable` döngüsü handler'ı yenilemeyebilir. Betik bu durumu açıkça `[FAIL] ... handler Shell sürecinde yuklu degil` olarak raporlar; XML introspection tek başına handler'ın çalıştığını kanıtlamaz.

## 7. Çıktı ve kabul formatı

Her geliştirme adımı şu kısa formatla raporlanır:

1. **Hedef:** Tek cümlelik mikro-problem.
2. **Etkilenen dosya ve satırlar:** Dosya adı ve yaklaşık aralık.
3. **Uygulanan değişiklik:** Minimal diff özeti.
4. **Yerel test komutu:** Tek satır veya kısa komut grubu.
5. **Kanıt durumu:** `statik`, `yerel/sentetik`, `canlı hedef ortamı` veya `bilinmiyor`.

Statik parse, JSON doğrulaması veya sentetik test; üç monitörlü gerçek Wayland kabulü olarak sunulmaz. Bilinmeyen metrikler `0` değil, açıkça `bilinmiyor` olarak raporlanır.
