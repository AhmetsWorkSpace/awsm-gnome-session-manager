# AI GELİŞTİRME, DENETİM VE KODLAMA KURALLARI (GNOME 50 WAYLAND REFACTORING)

Bu belge, bu dizindeki eklenti kodlarını analiz eden ve düzenleyen yapay zeka modelleri için bağlayıcı teknik şartnamedir. Model, herhangi bir kod önermeden veya dosya değiştirmeden önce buradaki mimari kısıtlamaları ve denetim adımlarını uygulamalıdır.

## 1. TEMEL MİMARİ VE ORTAM KISITLARI

1. **Oturum tipi:** GNOME Shell / Mutter Wayland. X11 varsayılmamalıdır.
2. **Harici araç yasağı:** Çözüm olarak `xdotool`, `wmctrl`, `xrandr`, `ydotool` veya benzeri harici CLI/X11 araçları önerilmemelidir. Yeni çözümler saf GJS ve dahili Mutter/Clutter API'leriyle yazılmalıdır.
3. **Güncel API zorunluluğu:** GNOME 50'de kaldırılmış eski yöntemler, özellikle `global.screen` ve güvenilmez senkron pencere konumlandırması, kullanılmamalıdır.
4. **Hedef yazılım:** Firefox Snap paketi `wm_class: "firefox_firefox"` kullanır. Çoklu pencereler aynı ana process ve PID altında bulunabilir.

## 2. ZORUNLU ÖZ-DENETİM KONTROL LİSTESİ

### Denetim 1: Monitör hesaplama (`saveSession.js`)

`metaWindow.get_monitor()` tek başına güvenilir kabul edilmemelidir. Pencerenin fiziksel çerçeve geometrisi kullanılmalıdır:

```javascript
const rect = metaWindow.get_frame_rect();
let monitorIndex = global.display.get_monitor_index_for_rect(rect);
if (monitorIndex < 0 || monitorIndex === null || monitorIndex === undefined) {
    monitorIndex = metaWindow.get_monitor();
}
```

API bulunmayan sürümlerde monitör geometrileri ile dikdörtgen kesişimi hesaplanabilir. Fallback kullanılıyorsa açıkça belgelenmelidir.

### Denetim 2: Asenkron kilitlenme (`moveSession.js`)

`window-entered-monitor` sinyalinin her zaman tetiklenmeyeceği kabul edilmelidir. Her bağlantıda en fazla 250-300 ms'lik `GLib.timeout_add` fallback'i bulunmalı ve sinyal bağlantısı güvenli biçimde `disconnect` edilmelidir.

### Denetim 3: Bellek ve nesne yaşam döngüsü (`ui/sessionItemButtons.js`)

Menü yeniden çizilirken veya kapatılırken yok edilmiş Clutter aktörlerine ve switch nesnelerine erişilmemelidir. Gerekli widget erişimleri geçerlilik kontrolü ve/veya `try/catch` ile korunmalıdır.

### Denetim 4: Çoklu pencere eşleştirme (`restoreSession.js`)

Snap Firefox gibi uygulamalarda kaydedilen her pencere için pencere oluşturma olayı üretilmelidir. Ek Firefox pencereleri `--new-window` ile açılmalı ve her kayıt `restoringApps` kuyruğuna tek tek bağlanmalıdır. Aynı PID paylaşımı pencere kimliği olarak kullanılmamalıdır; sıra, başlık ve kayıt kuyruğu birlikte değerlendirilmelidir.

### Denetim 5: Wayland geometrisi ve koordinat senkronizasyonu

`move_to_monitor()` tek başına yeterli kabul edilmemelidir. Monitör taşımasından sonra kayıtlı `x_offset` ve `y_offset` koordinatları hedef monitör bağlamında `metaWindow.move_frame(true, x, y)` ve gerektiğinde `move_resize_frame()` ile uygulanmalıdır. Wayland'daki gecikmeli sinyaller için işlem zaman aşımına dayanıklı olmalıdır.

## 3. UYGULAMA VE ÇIKTI STANDARDI

1. Tüm büyük dosyalar baştan sona yeniden yazılmamalıdır.
2. Değişiklikten önce ilgili fonksiyon, çağrı zinciri ve mevcut yaşam döngüsü incelenmelidir.
3. Yalnızca ilgili dosya, fonksiyon ve yaklaşık satır aralığı belirtilmelidir.
4. Kod değişiklikleri mümkün olduğunda şu diff mantığıyla sunulmalıdır:

```javascript
// DEĞİŞTİRİLECEK ESKİ KOD

// YENİ EKLENECEK GÜNCEL KOD
```

5. Sözdizimi doğrulaması yapılmalı; gerçek Wayland/çoklu monitör kabulü yapılmadıysa bu durum açıkça belirtilmelidir.
