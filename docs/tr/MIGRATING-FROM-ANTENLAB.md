# antenlab'dan geçiş

Fairbeam, antenlab'ın yeni adıdır. Kendi kimliği, ayarları, veri klasörleri, çalışma ortamı ve
güncelleme kanalı olan ayrı bir uygulamadır. antenlab'ın yanına kurulur; onun yerine geçmez ve
antenlab güncelleme yoluyla Fairbeam'e dönüşmez. Fairbeam ilk açılışta bilgisayarda antenlab'dan
kalan verileri bulur ve içe aktarmayı önerir. Bu sayfa içe aktarılanları, dışarıda bırakılanları,
elle geçişi ve eski uygulamanın kaldırılmasını açıklar.

## Adlarda neler değişti

| | antenlab | Fairbeam |
|---|---|---|
| Uygulama | `antenlab.app`, `antenlab.exe` | `Fairbeam.app`, `fairbeam.exe` |
| Komut ve Python modülü | `antenlab` | `fairbeam` (`import fairbeam`) |
| Ortam değişkenleri | `ANTENLAB_*` | `FAIRBEAM_*` (son bölüm aynıdır; örneğin `FAIRBEAM_PYTHON`) |
| Ayarlar ve uygulama verileri | `dev.antenlab.desktop` | `org.fairbeam.desktop` |
| Çalışma alanı | `Documents/antenlab` | `Documents/Fairbeam` |
| Dosya biçimleri | `antenlab.design/1`, `antenlab.project/1`, ... | `fairbeam.design/1`, `fairbeam.project/1`, ... |
| Sürümler | `antenlab-releases` deposu | [`fairbeam-releases`](https://github.com/ismailakdag/fairbeam-releases) |

## İlk açılışta içe aktarma

İçe aktarma, antenlab'da seçilmiş dilde bir kez sorulur. Yalnızca antenlab'a ait veri bulunduğunda
ve Fairbeam bu bilgisayarda daha önce kullanılmadığında çalışır. Başlatmak için **İçe aktar**,
atlamak için **Yeni başlayın** seçeneğini seçin.

antenlab açıksa önce kapatmanız istenir (**Yeniden deneyin** veya **Daha sonra**). Daha sonra seçeneği
bir sonraki açılışta yeniden sorar. Bu sırada Fairbeam normal açılır ve `Documents/Fairbeam` içine
hazır örneklerini koyar. Yalnızca bu hazır kopyaları ve boş klasörleri içeren çalışma alanı boş
sayıldığından, sonraki açılışta eski çalışma alanınız yine içe aktarılabilir.

İçe aktarılanlar:

- **Ayarlar.** Dil, güncelleme denetimi, GPU tercihi ve son tasarımlar listesi. Harici bir Python
  seçtiyseniz ve bu Python antenlab'ın kendi klasörlerinin dışındaysa seçim korunur.
- **Çalışma alanınız.** Varsayılan alanı kullandıysanız aynı diskte `Documents/antenlab` klasörünün
  adı `Documents/Fairbeam` olur; büyük benzetim klasörleri de bu işlemle taşınır. İş kayıtlarındaki
  (`jobs/*/job.json`) yollar yeni klasöre göre yazılır; yeniden çalıştırma ve eski çalışmaları
  temizleme işlemleri bu yolları kullanır. Yeniden adlandırma yapılamazsa Fairbeam eski klasörü
  kullanmayı sürdürür ve nedenini bildirir:
  - `Documents/Fairbeam` içinde size ait dosyalar varsa (hazır örnek, model ve şablonlar dışında
    `jobs/` içinde bir çalışma, yeni bir tasarım veya düzenlenmiş bir model gibi);
  - bir program dosyaları açık tutuyorsa (kapatıp yeniden denemeniz istenir);
  - macOS'te Belgeler klasörü erişim izni reddedilmişse.

  Özel bir klasördeki çalışma alanınız yerinde kalır. Kaynak kodu çalışma kopyası taşınmaz.
- **Python modelleriniz.** Çalışma alanındaki `.py` dosyalarında `import antenlab`, `import fairbeam`
  olarak değiştirilir. `from antenlab... import`, `antenlab.Simulation(` ve üretilmiş modellerdeki
  `ANTENLAB_ORGANIZATION` özniteliği de dönüştürülür. Önce özgün dosyalar yedeklenir; aşağıdaki
  yedek bölümüne bakın. `antenlab_utils` gibi adlar ve yorumlardaki düz metin korunur.
- **Görünüm ve görüntüleyici tercihleri — önce antenlab 0.6.9 açıldıysa.** antenlab tema ve genel
  ayarlarını Fairbeam'in okuyamadığı uygulama web depolamasında tutar. Son antenlab sürümü (0.6.9)
  bunları açılışta küçük bir dosyaya kaydeder. Fairbeam'i kurmadan önce 0.6.9 sürümünü bir kez
  açtıysanız tema, genel ayarlar, özel malzemeler, başlangıç ekranındaki sık kullanılanlar ve
  sıralama, görüntüleme seçenekleri, şerit ve panel boyutları aktarılır. Aksi halde bu tercihler
  aktarılmaz; Fairbeam varsayılanlarla başlar.

İçe aktarma `.design.json` dosyalarını değiştirmez. Aşağıdaki eski dosyalar bölümüne bakın.

İçe aktarılmayanlar:

- **Kaydedilmemiş taslaklar.** İçe aktarmadan önce tasarımlarınızı antenlab'da kaydedin.
- **GitHub oturumu** ve diğer hesaplar. Fairbeam'de bu özellik sunulduğunda yeniden oturum açın.
- **Benzetim çalışma ortamı.** Fairbeam ilk açılıştaki kurulum ekranından kendi çalışma ortamını
  yeniden indirip kurar. İki uygulama aynı çalışma ortamını paylaşmaz.
- **Sunucu portu** ve eski kuruluma ait diğer ayarlar.

İşlem sonunda yapılanlar özetlenir. Bir adım başarısızsa özette belirtilir; Fairbeam yine açılır,
ancak kaldırma önerilmez. Ayrıntılar `shell.log` dosyasında `import:` ile başlayan satırlardadır
(yollar ve sayılar; dosya içerikleri değil). Tam rapor ayar dosyasının yanına `antenlab-import.json`
olarak yazılır. Eski ayarlar aynı klasördeki `imported/` içine de kopyalanır. Klasör listesi için
[DESKTOP.md](DESKTOP.md#folders) sayfasına bakın.

### Yedek

İçe aktarma bir dosyayı değiştirmeden önce özgün dosyayı şu konuma kopyalar:

```
<workspace>/.fairbeam-import-backup/<timestamp>/<path of the file inside the workspace>
```

Zaman damgası UTC'dir (`yyyymmdd-hhmmss`). Yedek, yeniden yazılan Python modellerinin ve iş
kayıtlarının özgün metinlerini içerir. Uygulama bu yedeği kullanmaz; sonuçları denetledikten sonra
isterseniz silebilirsiniz. Bir değişikliği geri almak için yedek dosyayı yeni dosyanın üzerine
kopyalayın. İçe aktarmayı tekrarlamak, zaten dönüştürülmüş dosyaları yeniden değiştirmez.

### Anahtarlar

- `FAIRBEAM_NO_IMPORT=1` içe aktarmayı kapatır. Fairbeam, antenlab yokmuş gibi başlar; taşıma,
  yeniden yazma veya içe aktarma önerisi yapılmaz.
- `FAIRBEAM_IMPORT_DRY_RUN=1` yapılacakları gösterir; antenlab verilerini veya çalışma alanınızı
  değiştirmez. Plan `shell.log` dosyasına yazılır (`<app data>/logs/shell.log`; bkz.
  [DESKTOP.md](DESKTOP.md#folders)). Fairbeam normal açıldığı için kendi ayar dosyasını ve
  `Documents/Fairbeam` içindeki hazır örneklerini oluşturur. İlk deneme çalışması ayar dosyasında
  `legacy_import.state` değerini `dry-run` yapar; sonraki normal açılışta içe aktarma yine önerilir.

Anahtarları programın başlatıldığı ortamda ayarlayın. macOS'te terminalden
`FAIRBEAM_IMPORT_DRY_RUN=1 /Applications/Fairbeam.app/Contents/MacOS/fairbeam` komutunu kullanın.
Windows'ta PowerShell'de `$env:FAIRBEAM_IMPORT_DRY_RUN = 1` komutunu çalıştırın ve aynı pencereden
`fairbeam.exe` dosyasını başlatın.

**Yeni başlayın** seçeneğinden sonra fikrinizi değiştirirseniz antenlab ve çalışma alanı yerinde
kalır. Çalışma alanını kendiniz yeniden adlandırın veya kopyalayın (ya da Ayarlar › Genel'den seçin);
modellerinizde `import antenlab` yerine `import fairbeam` yazın.

## antenlab'ı kaldırma

Başarılı içe aktarmadan sonra Fairbeam, antenlab'ı kaldırmayı sorar. **Şimdilik tutun** seçeneğini
seçtiyseniz veya yeni başladıysanız daha sonra **Yardım › antenlab'ı kaldır…** yolunu kullanın.
Bu öğe bilgisayarda antenlab'a ait kaldırılacak bir şey bulunduğu sürece görünür.

- **macOS:** önce antenlab kapatılır. Ardından `antenlab.app` ve veri klasörleri Çöp Sepeti'ne
  taşınır; sepeti boşaltana kadar geri alabilirsiniz. İndirilenler gibi başka klasörlerdeki
  uygulama kopyaları da önerilir. Taşıma yapılamazsa (örneğin standart kullanıcıyla /Applications
  içinde) Fairbeam öğeyi Finder'da gösterir; kendiniz Çöp Sepeti'ne sürükleyin.
- **Windows:** antenlab'ın kendi kaldırıcısı sessiz çalıştırılır; veri klasörleri, kayıt defteri
  girdileri ve kısayolları da kaldırılır.

Çalışma alanınıza ve yedek klasörüne dokunulmaz. Kaydedilmiş oturum belirteçleri silinmez
(macOS'te Anahtar Zinciri, Windows'ta Kimlik Bilgisi Yöneticisi girdileri). Bunları aşağıdaki gibi
ayrıca kaldırın.

### antenlab'ı elle kaldırma

Önce antenlab'ı kapatın. Fairbeam'de projelerinizi gördüğünüzü denetlemeden çalışma alanınızı
silmeyin. İçe aktarmayla taşındıysa konumu `Documents/Fairbeam`, taşınmadıysa `Documents/antenlab` olur.

**macOS.** Aşağıdakileri Çöp Sepeti'ne taşıyın. Bulunmayan öğeleri atlayın:

| Yol | İçeriği |
|---|---|
| `/Applications/antenlab.app` (veya `~/Applications/antenlab.app`) | Uygulama |
| `~/Library/Application Support/dev.antenlab.desktop` | Ayarlar, çalışma ortamı ve günlükler (büyük bölüm çalışma ortamıdır) |
| `~/Library/Caches/dev.antenlab.desktop` | Önbellekler |
| `~/Library/Logs/dev.antenlab.desktop` | Günlükler |
| `~/Library/WebKit/dev.antenlab.desktop` | Web depolaması (tema, taslaklar) |
| `~/Library/HTTPStorages/dev.antenlab.desktop` | Ağ depolaması |
| `~/Library/Saved Application State/dev.antenlab.desktop.savedState` | Pencere durumu |
| `~/Library/Preferences/dev.antenlab.desktop.plist` | Tercihler |

Oturum açtıysanız belirteçler Anahtar Zinciri'nde `dev.antenlab.desktop` adıyla bulunur.
Anahtar Zinciri Erişimi'ni açın, bu adı arayın ve ilgili öğeleri silin.

**Windows.** Ayarlar › Uygulamalar › Yüklü uygulamalar bölümünde antenlab'ı seçin, Kaldır'ı açın ve
“Uygulama verilerini sil” seçeneğini işaretleyin. Kalan öğeler varsa aşağıdaki klasörleri silin;
yolu Dosya Gezgini'nin adres çubuğuna yapıştırabilirsiniz:

| Yol | İçeriği |
|---|---|
| `%LOCALAPPDATA%\antenlab` | Kurulum klasörü (başka klasöre kurduysanız o klasör) |
| `%APPDATA%\dev.antenlab.desktop` | Ayarlar |
| `%LOCALAPPDATA%\dev.antenlab.desktop` | Çalışma ortamı, günlükler ve web verileri (büyük bölüm çalışma ortamıdır) |

`HKEY_CURRENT_USER\Software\antenlab` kayıt defteri anahtarını ve Başlat menüsü ya da masaüstündeki
`antenlab.lnk` kısayolunu da silebilirsiniz; kalmaları zarar vermez. Oturum açtıysanız Kimlik Bilgisi
Yöneticisi › Windows Kimlik Bilgileri içindeki `dev.antenlab.desktop` girdilerini oradan kaldırın.

Her iki sistemde de çalışma alanı size aittir. Korumayı seçin; `Documents/antenlab` klasörünü yalnızca
Fairbeam bu klasörü kullanmıyorsa ve içindekilere ihtiyacınız kalmadıysa silin.

## Eski dosyalar açılabilir

Dosyaları önceden dönüştürmeniz gerekmez.

- **Tasarımlar ve projeler.** antenlab'ın yazdığı `.design.json` veya proje dosyaları (`antenlab.`
  ile başlayan şemalar) Fairbeam'de doğrudan açılır. Sonraki kaydetmede Fairbeam kimliği yazılır
  (`fairbeam.design/1`, `fairbeam.project/1`). Çalışmalar ve optimizasyon sonuçları da aynı şekilde okunur.
- **Sonuç paketleri** önceki çalışmaların sonuçlarını açıp gösterir.
- **CST uyumlu VBA makro dosyaları** içe aktarılabilir. Fairbeam'in dışa aktardığı makrolar kendi
  işaretçilerini taşır.
- **Python modelleri ve betikleri** istisnadır: paket adı `fairbeam` olduğundan `import antenlab`
  çalışmaz; takma ad yoktur. İçe aktarma çalışma alanınızdaki modelleri düzeltir. Başka konumdaki
  modellerde aynı adı kendiniz değiştirin. `antenlab` komutunu çağıran veya `ANTENLAB_*` değişkenlerini
  ayarlayan betiklerde `fairbeam` ve `FAIRBEAM_*` kullanın.
- **Programa ayrılmış adlar.** Tasarım parçası adları `antenlab_` veya `fairbeam_` ile başlayamaz;
  her iki önek programın yardımcı nesneleri için ayrılmıştır.
