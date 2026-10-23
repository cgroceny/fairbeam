# Çalıştırma sunucusu ve Simülasyon çalıştır paneli

## Arayüzden simülasyon çalıştırma

Yerel çalıştırma sunucusu görüntüleyicinin yanında çalışırken görüntüleyici model parametrelerini düzenleyebilir, geometriyi canlı önizleyebilir ve openEMS'i çalıştırabilir:

```bash
npm run serve        # fairbeam serve on http://127.0.0.1:5320 (uses ~/opt/openEMS/venv/bin/python)
npm run dev          # the viewer; /api is proxied to the run server
npm run app          # or: build the viewer and serve it and the API on one free port (fairbeam app)
```

Masaüstü uygulaması sunucuyu kendisi başlatır. Bir **tasarım dosyası** şeritten çalıştırılır: Simülasyon › **Çalıştır** (veya üst çubuktaki **Çalıştır** düğmesi), motor, iş parçacığı sayısı, S-parametresi örnek noktaları ve isteğe bağlı sonuç adını içeren pencereyi açar. Önce tasarımı kaydeder; Denetimler listesinde hata varken başlamaz. Alt panel ilerlemeyi (Çalıştırma sekmesi), tasarımın önceki çalıştırmalarını (Çalıştırmalar) ve günlüğü (Günlük) gösterir. Şeridin Optimizasyon sekmesinde **Parametre taraması** ve **Optimize et** bulunur (tasarımcının tarama penceresi adlandırılmış dizileri ve en fazla 500 ızgara hücresini destekler). **Python modeli** (Ana ekran › Python modelleri), sağdaki özellik tablosunun yerini alan ve aşağıda açıklanan Çalıştırma panelinden çalıştırılır. Birlikte gelen örnekler salt okunurdur ve Çalıştırma panelleri yoktur. Çalıştırma paneli:

- **Model ve parametreler.** Form, modelin `PARAMS` tanımından (etiket, birim, min/maks) oluşturulur. Açık sonuç bu modelden üretilmişse değerleri doldurulur. Değiştirilen alanlar işaretlenir ve tek tek sıfırlanabilir.
- **Canlı geometri önizlemesi.** Düzenlemeden yaklaşık 0,4 s sonra sunucu modeli oluşturur (`fairbeam geometry` gibi; dosya yazılmaz) ve 3B görünüm “Önizleme (simüle edilmedi)” etiketiyle gösterir. “Sonuca dön” seçeneği veya paneli kapatmak sonucu geri getirir.
- **Çalıştırma adı** (isteğe bağlı): sonuç dosyası bu ada göre adlandırılır (`Dipole 60 mm` → `dipole-60-mm.json`); ad verilmezse model ve değişen parametreler kullanılır.
- **Tarama.** Çalıştırma bölümünü *Tarama* moduna geçirin, bir veya iki sayısal parametre seçip aralık (başlangıç, bitiş, adım sayısı) ya da değer listesi girin. Panel çalıştırma sayısını (en fazla 25) ve modelin son çalıştırmasına dayanan tahmini toplam süreyi gösterir. Sunucu taramayı ortak tarama kimliği taşıyan ayrı işlere dönüştürür.
- **Simülasyonu başlat**, bir `fairbeam run` işini kuyruğa alır (aynı anda tek iş; varsayılan iş parçacığı sayısı Otomatik: fiziksel çekirdek sayısı eksi bir, küçük ızgaralarda en fazla 4; bkz. docs/BENCHMARKS.md, “Threads: what Auto does”). İlerleme kartı aşamayı, zaman adımını, işlem hızını, durdurma ölçütüne göre alan enerjisini, geçen ve tahmini kalan süreyi, canlı yakınsama grafiğini ve günlüğü gösterir. openEMS enerjiyi yaklaşık 4 s aralıklarla bildirdiğinden kısa çalıştırmalarda bir örnek görünür veya hiç görünmez. İptal, tüm süreç grubunu durdurur.
- **Son çalıştırmalar**, önceki işleri durum, süre ve parametreleriyle listeler; paketini açmak için tamamlanan, izlemek için devam eden çalıştırmaya tıklayın. Taramalar gruplanır: sıralanabilir tabloyu (parametre değerleri → ilk bandın en iyi uyumu, min |S11|, Dmax, verimlilik; çok portlu modellerde ilk bant merkezinde veya girdiğiniz frekansta |S21|, en kötü |Sii| ve yalıtım), **Karşılaştır** (en fazla sekiz çalıştırmayı üst üste çizgilerle açar) veya **Taramayı iptal et** seçeneklerini görmek için grubu genişletin. Model ve duruma göre filtreleyin. Çöp kutusu simgesi çalıştırmayı geçmişten kaldırır; sonuç dosyası yalnızca “Sonuç dosyasını da sil” işaretlenirse silinir (yalnızca sonuçlar klasöründeki dosyalar). Geçmiş ve günlükler `.sim/jobs/<id>/` altında saklanır ve sunucu yeniden başlatıldığında korunur. Her işin ham openEMS çıktısı `.sim/runs/<id>/` altına gider ve çalıştırma geçmişten silinince kaldırılır; `fairbeam clean-sim`, hâlâ listelenen çalıştırmaların eski ham klasörlerini temizler (bkz. [CLI.md](CLI.md#raw-simulation-data-sim)).

### Eşzamanlı model düzenleme

Model ve tasarım kayıtları, eski düzenlemeleri saptamak için editörün gönderdiği dosya hash'ini
kullanır. Aynı işletim sistemi kullanıcısıyla çalışan, bu protokole uyan model yazıcıları her modelin
okuma/denetleme/geçmişe alma/yazma işlemini sıraya koyar; oluşturma ve silme de buna dahildir.
Bu koruma, ayrı iş klasörleri kullanırken model ve geçmiş klasörlerini paylaşan sunucuları ve
model dosyası API'sini doğrudan çağıran süreçleri kapsar. Eski bir kayıt isteği yeni dosyayı ezmek
yerine HTTP 409 döndürür. Farklı model kimlikleri ve çalışma alanları birbirini bekletmez.

Kilitler Windows'ta bayt aralığı kilidi, Unix'te `flock` kullanır. Kalıcı, boş kilit dosyaları
`~/.fairbeam/model-locks` altında tutulur; yalnızca model okumak için model klasörüne yazma izni
gerekmez. Fairbeam süreçleri çalışırken kilit dosyalarını silmeyin. Süreç kapanınca veya
sonlandırılınca işletim sistemi kilitleri serbest bırakır. Her işletim sistemi kilidi için bekleme
30 saniyeyi aşarsa HTTP 503 döner; yerel iş parçacığı kilidini bekleme süresi bu sınıra dahil değildir.
Kilit depolaması kullanılamıyorsa işlem korumasız devam etmez. Kullanıcının ev dizinindeki kilit
klasörü okumalar için de yazılabilir olmalıdır; kullanılamıyorsa istek çalışma alanını değiştirmeden
başarısız olur.

Bu, aynı kullanıcıya ait ve protokole uyan süreçler için dosya korumasıdır; sunucuların tamamını
birlikte yönetmez. Harici editörler, eski Fairbeam sürümleri ve başka kullanıcıların sunucuları
bu kilide katılmaz. Mevcut iş klasörü sahiplik kilidi, varsayılan ikinci masaüstü uygulaması dahil,
aynı iş klasörünü kullanan ikinci sunucuyu zaten reddeder. Ayrı iş klasörleri kullanan sunucuların
kuyrukları da ayrıdır; model kilidi bu süreçlerin simülasyonlarını, sonuç yazımlarını veya çalışma
alanı ayarlarını koordine etmez. Tek sunucunun istemcileri aşağıda anlatıldığı gibi aynı kuyruğu
paylaşır. Kütüphane kullanıcıları alt süreçleri yeni spawn/exec ile başlatmalıdır; işlem kilidi
tutulurken fork ile mevcut süreçten devam etmek, kilit durumu ve dosya tanımlayıcıları miras
alındığından desteklenmez.

Büyük/küçük harfe duyarsız Unix dosya sistemlerinde ayrı sunucular çalışma alanı yolunu aynı
yazımla kullanmalıdır. macOS'ta harf büyüklüğü ve Unicode bakımından farklı yol yazımları yerel
olarak henüz doğrulanmadı; aynı kilidi paylaşmaları garanti edilmez. Windows'ta harf büyüklüğü
farkı ve çözümlenen `..` yolları aynı kilit kimliğini kullanır.

### Başka yerden başlatılan çalıştırmalar ve kuyruk

Kuyruk pencereye değil sunucuya aittir: bir betik veya başka bir pencereden gönderilen çalıştırma (`POST /api/runs` ya da terminalden `fairbeam run --server`; bkz. [CLI.md](CLI.md#runs-the-app-shows---server)) aynı kuyrukta bekler ve saniyeler içinde açık uygulamada görünür. Uygulama görünürken her 5 s'de `/api/health` adresini kontrol eder (2 ms'lik istek); pencere öne geldiğinde bunu hemen yapar. Sağlık yanıtının `queue` alanı (`running`, `queued`, her değişimde artan `version` sayacı ve sunucu dışındaki `fairbeam run` süreçleri için `external`) değiştiğinde çalıştırma listesi, bir çalıştırma bitmişse sonuç dizini yeniden alınır. Sunucuyu meşgul eden çalıştırma, **Simülasyonu başlat** düğmesini **Simülasyonu kuyruğa al** olarak değiştirir ve öndeki çalıştırmayı belirtir. Tasarımcı, açık tasarım için başka bir istemcinin başlattığı çalıştırmayı izler; durum çubuğu sunucudaki diğer çalıştırmaları gösterir.

Uygulama bu güncellemelerde ve etkin bir tarama sırasında `/api/runs?summary=1` adresini
kullanır. Araştırma geçmişi `/api/research/runs?summary=1` adresinden alınır. İki özet de
işin üst verilerini korur, `result` alanını çıkarır; böylece her sorguda geçmiş araştırma
sonuçlarının tüm dizileri yeniden indirilmez. Bir araştırma çalıştırması seçildiğinde tam
sonuç, bütünlük denetimiyle birlikte `/api/research/runs/{id}` adresinden alınır.
Mevcut API istemcileri için `summary=1` içermeyen liste isteklerinin tam yanıtı ve
diskteki iş geçmişi değişmez.

- **Son çalıştırmalar**: bekleyen satırda **Sıradan çıkar** (×), çalışan satırda **Durdur** (■) vardır; **Kuyruğu temizle** bekleyen tüm çalıştırmaları kaldırır (`POST /api/queue/clear`), çalışan devam eder.
- **Tasarımcı**: alt panelin **Kuyruk** sekmesi sunucunun kuyruğa alınmış veya çalışan tüm çalıştırmalarını (diğer modeller ve istemciler dahil) listeler; her birinde **İzle**, **Durdur** veya **Sıradan çıkar**, ayrıca **Kuyruğu temizle** bulunur. Alt panelde **Çalıştırmayı iptal et**, önce panelde gösterilen, yoksa pencerenin izlediği, o da yoksa sunucuda çalışan işi durdurur.
- Sunucusuz terminalden başlatılan çalıştırma (aynı simülasyon köküne yazan `fairbeam run`) kuyruğa girmez: ön kontrol ve Çalıştırma paneli CPU'yu kullandığını belirtir.

Yeni tasarımcı işleri, sunucuya gönderilmiş ve denetlenmiş `.design.json` dosyasını saklar. Kaynağı sonradan düzenlemek, zaten kabul edilmiş çalıştırmayı, taramayı, optimizasyonu veya yakınsama çalışmasını değiştirmez. İşe ait yerel kopya eksikse veya değiştirilmişse iş başlamadan başarısız olur. Python modelleri, içe aktarılan modüller ve eski işler özgün yollarını kullanmaya devam eder. Kaynak takibi ve ayrı istemci ön kontrolünün sınırlaması için [kabul edilen girdiler](QUEUED-DESIGN-INPUTS.md) sayfasına bakın.

### Mesh yakınsaması için isteğe bağlı ağ ölçütleri

`POST /api/convergence`, kayıtlı tasarım, yoğunluklar ve mevcut toleransların yanında isteğe bağlı `network_criteria` nesnesini kabul eder. Mevcut rezonans temelli davranış için alanı göndermeyin; `null`, kapatma değeri değildir. Örneğin fiziksel portları 1, 2 ve 3 olan bir tasarım şunu isteyebilir:

```json
{
  "model": "network_design",
  "densities": [15, 20, 30],
  "max_runs": 3,
  "network_criteria": {
    "frequency_ghz": 2.4,
    "metrics": ["coupling:2,1:0.2", "isolation:3,1:0.2", "phase:2,3,1:1"]
  }
}
```

Nesne tam olarak `frequency_ghz` (sonlu pozitif JSON sayısı) ve `metrics` (bir ile on iki dize) alanlarını gerektirir. Ölçüt dilbilgisi CLI'daki `KIND:PORTS:TOL` biçimidir: `coupling` ve `isolation`, alan ve sürülen portları; `directivity`, alan, referans çıkış ve sürülen portları alır. `phase` iki biçimi de kabul eder; `s11` tek fiziksel port numarası alır. Tolerans sonlu pozitif dB değişimidir; faz için derecedir. Geçersiz veya tekrarlanan ölçütler ve kabul edilen tasarımda bulunmayan portlar, hiçbir iş kuyruğa alınmadan `fields.network_criteria` ile 422 döndürür. [Büyüklük tanımlarına](DESIGNER.md#mesh-convergence) bakın.

Sunucu standartlaştırılmış ölçütleri çalışma üzerinde Hz cinsinden saklar, tamamlanan her sonucun değerlendirmesine geçirir ve seri iş zinciri boyunca `excite: "all"` değerini korur. Her iş, kayıtlı veya kabul edilmiş tasarımı değiştirmeden `--excite all` kullanır. API raporları standartlaştırılmış ölçütleri, her üyenin ağ ölçümlerini ve her adımın denetimlerini içerir. Önbellekte başarılı görünen ağ çalışmasını yeniden açmak, ölçülen değerleri istenen ölçütlerle yeniden denetler; eksik/tutarsız kanıt, yoğunluğu uygulamaya izin vermez. Saklanan geçmiş değişmez. Design şeması veya çözücü fiziği değişmez; ağ denetimleri mevcut rezonans, enerji ve yerel mesh denetimlerine ek olarak kalır.

## Çalıştırma hazır ayarları

Tasarımcının Simülasyon ayarlarında **Çalıştırma ayarları**, Hızlı deneme (dalga boyu başına 10 hücre, -40 dB), Dengeli (20, -40 dB) ve Mesh inceltme kontrolü (30, -60 dB) sunar. Bir hazır ayarı seçmek tasarımı düzenlemez: **Ayarları uygula**, otomatik mesh çözünürlüğünü ve enerji durdurma ölçütünü tek bir geri alınabilir işlemle değiştirir. **İptal**, pencere açıldığındaki taslağı ve geçmişini geri getirir. Geometri, frekans bandı, sınırlar, monitör ayarları ve zaman adımı sınırı korunur. Bu hazır ayarlar elle tanımlanmış mesh'i değiştirmez. İyileştirme ayarı, yakınsama denetimleri için bir başlangıçtır; anten performansının doğrulaması değildir.

Çalıştırma alt paneli, erken bir süre öngörüsünü son öngörülerin aralığından ayırır. Bu aralık, istatistiksel güven aralığı değil, sınırlandırılmış bir gösterim aralığıdır. Kötüleşen tahminler hemen gösterilir; iyileşenler küçük ve sınırlı gecikmeyle yumuşatılır. Ham tahminler, dayanak, güven, örnek sayısı, geçerli port ve tüm iş öngörüleri teknik ayrıntılarda kalır. Zaman adımı sınırına kalan süre, yakınsama süresinden ayrıdır. Son işlem ve dışa aktarma, eski bir çözücü bitiş tahminini korumak yerine kendi aşamasını gösterir.

Bellek uygunluğu mesh oluşturulduktan sonra, her çözücü başlamadan hemen önce yeniden kontrol edilir; kuyruktaki çalıştırmalar, taramalar ve optimizasyon değerlendirmeleri de buna dahildir. Yalnızca önceki önizleme yerine o anki boş bellek kullanılır. CUDA VRAM kullanılabilirliği bilinmez; tahmin sıcaklık veya güç sınırı değildir. Windows'ta CPU kullanılabilirliği, olağan tek gruplu sistemlerde süreç işlemci ilişkilendirme maskesini gözetir; okunamadığında taşınabilir bir yedek yöntem kullanır.

## Python betiğinden tasarım

`{source, model?}` ile `POST /api/design/from-python`, Python model betiğini (`MODEL`, `PARAMS`, `build`) kaydetmeden veya çözücüyü çalıştırmadan tasarıma dönüştürür; tasarımcının Python paneli **Uygula** düğmesinde bu uç noktayı çağırır. Yanıt `{design, python, normalized, output}` biçimindedir: tasarım (`fairbeam.design/1`), bundan yeniden yazılmış betik (`design.to_python`; başında açık tasarımın adı, kimliği ve açıklamasını içeren `model` bulunur), betiğin gönderilenden farklı tasarım üretip üretmediği (panel bu durumda betiği gösterir) ve betiğin yazdırdığı çıktı (son 4000 karakter). Hata durumunda `{error, line?, timeout?}` içeren 422 yanıtı döner; `line`, istisnanın oluştuğu betik satırının 1 tabanlı numarasıdır (sözdizimi hatasında da bulunur).

Dönüştürme, örnek dönüştürücüsünü (`example_design.convert_example`) kullanan `python/fairbeam/python_design.py` ile yapılır: betik alt süreçte (`python -m fairbeam.python_design`, sunucuyla aynı Python) varsayılan parametrelerle oluşturulur, CSXCAD geometrisi geri okunur ve ifadeler uydurulur. `openEMS`, `Run` çağrısı istisna üreten bir alt sınıfla değiştirilir; `Simulation.run` da istisna üretir, böylece çözücü hiç başlamaz. Sınırlar: 20 s (alt süreç ve başlattığı süreçler sonlandırılır, `timeout: true`), 512 KB kaynak, aynı anda bir betik (başka bir betik uygulanırken 429). Bu bir korumalı yürütme ortamı değildir: kullanıcının Python betiği sunucunun yetkileriyle çalışır.

## Malzemelerim

`GET /api/materials/user`, `{materials, skipped, file}` döndürür: tasarımcının kişisel malzeme kütüphanesi (**Malzemelerim**), `models/` klasörünün üst dizinindeki `<workspace>/materials.json` dosyasından okunur (masaüstünde `~/Documents/Fairbeam`), dolayısıyla yeniden kurulumda korunur. Dosya yoksa liste boştur; bozuk dosya yok sayılır ve `skipped` alanında bildirilir. `{materials: [...]}` ile `PUT /api/materials/user`, listeyi doğrulayıp dosyayı atomik olarak yazar. GET gibi, korunan girdileri döndürür; `skipped`, elenen her girdi için bir satır içerir (`materials` liste değilse `422`). Girdi `{id, name, kind, eps_r?, tan_d?, tan_d_freq?, conductivity?, thickness?, color?}` biçimindedir: `kind`, `metal` veya `dielectric`; sayılar normal sayıdır (`tan_d_freq` GHz, `conductivity` S/m, `thickness` mm); `color`, `#rrggbb` biçimindedir; kimlikler ve adlar benzersizdir. Tasarımlar dosyaya başvurmaz: tasarımcı girdiyi tasarıma kopyalar. Çalıştırma sunucusu yoksa liste tarayıcının localStorage alanında tutulur. Uygulama: `python/fairbeam/usermaterials.py`.

## Optimizasyon

Çalıştırma bölümünün **Optimizasyon** modu, bir ila üç parametreyi hedeflere göre ayarlar: rezonansı bir frekansa getirme, uyum (bir frekansta |S11|), en az bant genişliği veya yönlülük; çok portlu modellerde ayrıca tüm portların uyumu, en fazla yalıtım / kuplaj (|S_ij|) veya en az iletim. Çok portlu değerlendirme, uyarılan her port için openEMS'i bir kez çalıştırır; varsayılan olarak yalnızca hedeflerin gerektirdiği portlar uyarılır ve süre tahmini bunları sayar. Her değerlendirme tam bir simülasyondur (sunucunun Python kurulumunda varsa GPU motorunda). Kart, her değerlendirmenin maliyetini logaritmik ölçekte, en iyisi vurgulanmış sıralanabilir değerlendirme tablosunu ve tamamlandığında **En iyiyi aç** ile **En iyiyi başlangıçla karşılaştır** seçeneklerini gösterir. Aynı optimizasyon aracı komut satırından (`fairbeam optimize`) çalışır. Hedefler, algoritmalar ve simülasyon örnekleri için [OPTIMIZE.md](OPTIMIZE.md) sayfasına bakın (dipolde f0'ın 2 değerlendirmede 2,40 GHz'e ayarlanması; yamada 15 değerlendirmede f0 = 2,45 GHz ve |S11| < −25 dB; Wilkinson yalıtım direncinin 4 tek portlu değerlendirmede 73 Ω'a, S23'ün −37,9 dB'ye getirilmesi).

Çok portlu modeller openEMS'i uyarılan her port için bir kez çalıştırır; ilerleme kartı çözücü aşamasını “FDTD · port 2/3” olarak etiketler, geçerli portun enerji çizgisini çizer ve tüm işin süresini tahmin eder.

Uzak alan gerektirmeyen S-parametresi ve rezonans hedeflerinde optimizasyon değerlendirmeleri, çözümden önce kullanılmayan NF2FF E/H kayıt özelliklerini kaldırır. Böylece hem gereksiz alan dosyası yazımı hem sonraki dönüşüm önlenir. İstenen uzak alan, yönlülük hedefi veya verimlilik monitörü varsa kayıtlar korunur. Diğer alan monitörleri, mesh ve durdurma ölçütleri değişmez. Özellik silmeyi desteklemeyen eski CSXCAD bağlayıcılarında kayıt yükü sürer ve bu uyumluluk sınırlaması bildirilir. Bu tüm platformlarda geçerlidir; varsayılan iş parçacığı sayısını değiştirmez veya sabit bir hızlanma vadetmez.

## Sonuçları karşılaştırma

Örnekler görüntüleyicisinde alt panel çubuğunun **Karşılaştır** düğmesi, açık sonucun yanına en fazla yedi başka sonuç sabitler (çalıştırma sunucusu olmadan da çalışır). Tasarımcıda en fazla sekiz çalıştırmayı karşılaştırmak için gezinti ağacında Ctrl/⌘ basılıyken tıklayın veya alt panelin Çalıştırmalar sekmesinden seçin. Yansıma, Empedans (Re veya Im) ve Örüntü (φ = 0° veya 90° kesiti, her sonucun seçili frekansa en yakın uzak alan frekansında), sabit seri renkleriyle her sonuç için bir çizgi gösterir; açıklama, doğrudan etiketler ve imleç altındaki frekansta tüm sonuçları listeleyen ipucu bulunur. Farklı frekans ızgaraları ortak bir ızgaraya enterpole edilir. Uyumlu bant gölgelemesi ve uzak alan işaretçileri açık sonuca ait kalır. Tablo görünümü her sonuç için bir sütun grubu gösterir.

Sunucu yalnızca 127.0.0.1 adresine bağlanır, yalnızca yerel `Host`/`Origin` başlıklarını ve JSON POST gövdelerini kabul eder; GET isteklerinin yan etkisi yoktur. Seçenekler: `--port` (veya `FAIRBEAM_API_PORT`, varsayılan 5320), `--projects`, `--models`, `--jobs`, `--sim-root` (ham openEMS çıktısı, varsayılan `.sim`), işleri ve önizlemeleri çalıştıran Python için `--python` (veya `FAIRBEAM_PYTHON`), `--ui DIR` (derlenmiş görüntüleyiciyi, `dist/`, `/` yolunda da sunar) ve `--exit-with-parent` (başlatan süreç sonlanınca durur). Uç noktalar `python/fairbeam/server.py` başında listelenir. Görüntüleyici başka porttaki sunucuya bağlanacaksa `FAIRBEAM_API=http://127.0.0.1:<port> npm run dev` ile başlatın. Sunucu yokken görüntüleyici eskisi gibi çalışır; Çalıştırma paneli yalnızca sunucuyu nasıl başlatacağınızı gösterir.

**Sunucu sonlandırılırsa** (SIGKILL, çökme), çalışan işin süreç grubu çalışmaya devam eder. Sonraki açılışta iş `interrupted` olarak işaretlenir; kayıtlı pid hâlâ yaşıyor *ve* aynı süreçse (`job.json` içindeki başlangıç zamanı ve komut satırı eşleşiyorsa), yeni iş başlamadan önce tüm süreç grubu durdurulur (SIGTERM, bekleme süresinden sonra SIGKILL); günlüğe not yazılır. Böyle eşleştirilemeyen pid'ye dokunulmaz. (Windows'ta işler, sunucu sonlandığında tüm süreç ağacını da sonlandıran bir iş nesnesinde çalışır; bu nedenle söz konusu kontrol orada yedek önlemdir. Eşleştirme süreç oluşturulma zamanı ve komut satırını kullanır; eşleşen ağaç `taskkill /T /F` ile durdurulur. Bkz. [WINDOWS.md](WINDOWS.md).)

**Bellek.** Çalışan iş tüm olaylarını bellekte tutar; tamamlanan iş son 500 olayın yanı sıra durum, aşama, bilgi, istatistik, sonuç ve optimizasyon olaylarını saklar. `events.jsonl` her zaman eksiksizdir; daha eski olayları isteyen SSE istemcisine (`Last-Event-ID` veya `?after=`) bunlar dosyadan okunarak gönderilir.
