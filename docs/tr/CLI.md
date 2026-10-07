# CLI başvurusu

CLI'yi hem `openEMS` hem de `CSXCAD` içe aktarabilen Python ortamıyla çalıştırın. Platform kurulum kılavuzları bu ortamı oluşturur veya yapılandırır: [macOS kaynak koddan kurulum](FROM-SOURCE.md), [Windows](WINDOWS.md) ve [Linux kaynak koddan kurulum](LINUX.md). Aşağıdaki örnekler depo kökünde başlar.

## Hızlı başlangıç

macOS ve Linux'ta kaynak kurulum betikleri `fairbeam` giriş noktasını openEMS venv ortamına yerleştirir:


```bash
CLI="$HOME/opt/openEMS/venv/bin/fairbeam"
"$CLI" params python/models/patch_antenna.py
"$CLI" geometry python/models/patch_antenna.py --out public/projects
"$CLI" run python/models/patch_antenna.py --set patch_l=39 --threads 4 --engine cpu
```

Windows'ta [Windows kurulumunun](WINDOWS.md) oluşturduğu depo venv ortamını kullanın:


```powershell
$env:OPENEMS_INSTALL_PATH = 'C:\opt\openEMS'  # folder containing openEMS.exe and the DLLs
$env:CSXCAD_INSTALL_PATH = $env:OPENEMS_INSTALL_PATH
$Python = '.\.venv\Scripts\python.exe'
& $Python -m fairbeam params .\python\models\patch_antenna.py
& $Python -m fairbeam geometry .\python\models\patch_antenna.py --out .\public\projects
& $Python -m fairbeam run .\python\models\patch_antenna.py --set patch_l=39 --threads 4 --engine cpu
```

`params`, modelin parametrelerini ve varsayılanlarını yazdırır. `geometry`, modeli ve mesh'i kurup yalnızca geometri içeren paket yazar; çözücüyü başlatmaz. `run`, simülasyonu gerçekleştirip sonuç paketi yazar. Üç komut da Python modeli (`.py`) veya tasarımcı dosyası (`.design.json`) kabul eder. Parametreyi değiştirmek için `run` veya `geometry` ile `--set key=value` kullanın; CLI adı ve tanımlı sınırları kontrol eder.

## Uygulamada görünen çalıştırmalar (`--server`)

`fairbeam run` kendi sürecinde çözer: açık uygulama bunu listelemez, uygulama kuyruğu beklemez (ön kontrol ve Çalıştır paneli yalnızca terminal çalıştırmasının CPU kullandığını bildirir); paket `--out` klasörüne gider. Uygulamada görünen, diğer çalıştırmaların arkasında sıraya giren ve çalışma klasörüne yazılan bir çalıştırma için işi uygulamanın çalıştırma sunucusuna gönderin:


```bash
fairbeam run patch_antenna --server                   # the desktop app's server (found from its record)
fairbeam run patch_antenna --set patch_l=39 --server http://127.0.0.1:5320 --label "Patch 39 mm"
fairbeam run patch_antenna --server 5320 --detach     # return once it is queued
```

`MODEL`, sunucunun modeller klasöründeki modeldir: adı (`.py` veya `.design.json` uzantısız dosya adı) ya da dosyanın kendisi. `--set`, `--threads`, `--engine`, `--end-db`, `--points`, `--label`/`--name` aktarılır; yerel klasör veya çıktı seçen seçenekler (`--out`, `--sim-root`, `--pattern`, `--fields`, ...) reddedilir. Komut, iş bitene kadar günlüğü yazdırır (tamamlanırsa çıkış kodu 0, değilse 1). Ctrl+C izlemeyi durdurur; çalıştırma sunucuda sürer. Uygulamada (Son çalıştırmalar, tasarımcı alt panelinin Kuyruk sekmesi) veya `POST /api/runs/<id>/cancel` ile durdurun.

Betikler de aynı API'yi doğrudan çağırabilir:


```bash
curl -s -H 'Content-Type: application/json' -d '{"model":"patch_antenna","params":{"patch_l":39},"threads":"auto"}' http://127.0.0.1:5320/api/runs
# -> the job: {"id": ..., "status": "queued", ...}
curl -s http://127.0.0.1:5320/api/runs                              # the history, newest first
curl -s -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:5320/api/runs/<id>/cancel
curl -s -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:5320/api/queue/clear
```

**Varsayılan klasörler.** Kaynak kod kopyasında `--out` ve `--sim-root`, her zamanki gibi `public/projects` ve `.sim` olur. Paketlenmiş uygulamanın ortamı `fairbeam` modülünü çalışma ortamı klasöründen içe aktarır; bu varsayılanlar orayı gösterirse uygulamada hiçbir şey görünmez. Bu nedenle masaüstü uygulamasının başlattığı sunucu, adresini ve çalışma klasörlerini uygulama veri klasöründeki `server.json` dosyasına kaydeder (Windows `%LOCALAPPDATA%\org.fairbeam.desktop`, macOS `~/Library/Application Support/org.fairbeam.desktop`, Linux `~/.local/share/org.fairbeam.desktop`; `FAIRBEAM_STATE_DIR` ile değiştirilebilir). Kaynak kopyası dışında CLI, bu çalışma klasörünün `projects` ve `.sim` klasörlerini varsayılan alır ve bunu bildirir; kayıt yoksa sonucun çalışma ortamında kalacağı uyarısını verir. Tek başına `--server`, aynı kayıttan uygulamanın sunucusunu bulur. Hata ayıklama için `tauri dev` kabuğu, kaynak kopyasındaki sunucuyu depo klasörleriyle çalıştırır; kaydı bunu belirtir (`"checkout": true`) ve paketlenmiş CLI bu klasörleri varsayılan olarak almaz.

**Uygulamanın çalışma klasöründe hiçbir sonuç değiştirilmez.** CLI'nin ürettiği adda dosya (model kimliği ve `--set` değerleri; örneğin `sierpinski-monopole--iterations-3.json`) çoğunlukla uygulamanın kopyaladığı örnek veya aynı parametrelerle ilk çalıştırmasıdır (sunucu da aynı adlandırmayı kullanır). Bu nedenle `--name` olmadan `fairbeam run` ve `fairbeam geometry`, yanına sunucunun adlandırmasıyla `<name>-<date>-<time>.json` (ardından `-2`, `-3`, ...) yazar ve bildirir. Sunucuda sürmekte olan çalıştırmanın adı için de aynı davranır; sunucu bitince paketini o adla yazar. `--name`, dosya adını seçer ve aynı adlı dosyanın üzerine yazar; kaynak kopyasında aynı komut önceki sonucunun üzerine yazmayı sürdürür.

`--sim-root` olmadan `fairbeam clean-sim`, aynı çalışma klasörünün `.sim` alanını temizler; uygulama çalıştırmalarının `--older-than` gününden eski ham klasörlerini de (`.sim/runs/<job id>/`) kaldırır (bkz. [Ham simülasyon verileri](#raw-simulation-data-sim)). Sonuç paketleri ve geçmiş kalır.

## CPU ve GPU motorları

`FAIRBEAM_ENGINE` başka bir değer seçmedikçe varsayılan motor CPU'dur. Açıkça seçmek için `--engine cpu` kullanın. `--engine gpu`, GPU destekli openEMS derlemesi ve onunla kurulmuş Python ortamı gerektirir. İsteğe bağlı desteklenen kurulumlar [Apple silicon üzerinde Metal](GPU.md#gpu-engine-optional-apple-silicon-nvidia-on-windows) ve [Windows üzerinde CUDA](GPU.md#windows-with-an-nvidia-gpu-cuda) şeklindedir; bu depo Linux GPU kurulum betiği sağlamaz.

macOS'te CPU motoru, openEMS paketinin varsayılan açık yerel CPU yamalarıyla çalışır (bit düzeyinde aynı sonuçlar, 1,3–1,7 kat hız; [CPU-OPTIMIZATION.md](CPU-OPTIMIZATION.md#macos-shipped-and-on-by-default)). `FAIRBEAM_NATIVE_CPU=0` kapatır. Windows ve Linux etkilenmez.


```bash
# macOS, after installing the optional GPU build
"$HOME/opt/openEMS-gpu/venv/bin/fairbeam" run python/models/patch_antenna.py --engine gpu
```


```powershell
# Windows, after installing the optional CUDA build
$env:OPENEMS_INSTALL_PATH = 'C:\opt\openEMS-gpu'
$env:CSXCAD_INSTALL_PATH = $env:OPENEMS_INSTALL_PATH
& 'C:\opt\openEMS-gpu\venv\Scripts\python.exe' -m fairbeam run .\python\models\patch_antenna.py --engine gpu
```

`--threads auto`, sistem ve kurulmuş mesh'e göre sınırlı sayıda iş parçacığı seçer; `--threads N` sayıyı sabitler, `--threads 0` ayarı openEMS'e bırakır. GPU motorunu sağlayamayan GPU derlemesi CPU'ya dönebilir; sonuç kaydederken günlüğü veya paketteki `run.engine` değerini kontrol edin. Kurulum ve motora özgü sınırlar için [GPU.md](GPU.md) sayfasına bakın.

## Mevcut geometriyi içe aktarma

CST uyumlu VBA makrosunu veya geçmiş listesini tasarımcı dosyasına dönüştürün:

Metin biçiminde `.bas`, `.mcs` veya `.txt` çıktısı kullanın ([DESIGNER.md](DESIGNER.md#importing-a-vba-macro)).


```text
fairbeam import-cst legacy-model.bas --out imported.design.json
```

DXF, Gerber bakır/dış çizgi katmanları ve isteğe bağlı Excellon delik dosyalarından PCB çizimini dönüştürün:


```text
fairbeam import-pcb top.gtl bottom.gbl board.gko holes.drl --layer-map "TOP=top_copper,BOT=bottom_copper,EDGE=outline" --substrate FR4 --thickness 1.6 --units mm --out board.design.json
```

İki komut da içe aktarma raporu yazdırır. Katman eşlemesini ve raporu inceleyin; üretilen `.design.json` dosyasını tasarımcıda açın veya `params`, `geometry`, `run` komutlarına verin. Desteklenen girdiler ve dönüştürme ayrıntıları için [VBA makrosu içe aktarma](DESIGNER.md#importing-a-vba-macro) ve [PCB çizimi içe aktarma](DESIGNER.md#importing-pcb-artwork-dxfgerber) sayfalarına bakın.

| Komut | Amaç |
| --- | --- |
| `fairbeam run <model.py or design.json>` | Python modeli veya tasarımcı dosyasını (`*.design.json`, ör. `examples/designs/`) simüle edip paket dışa aktarma |
| `fairbeam params <model.py or design.json>` | Model parametrelerini ve varsayılanlarını listeleme |
| `fairbeam geometry <model.py or design.json>` | Simülasyon olmadan geometri ve mesh dışa aktarma (`<slug>--geometry.json`) |
| `fairbeam index [folder]` | Paket klasörü için `index.json` dosyasını yeniden oluşturma |
| `fairbeam serve` | Uygulamanın simülasyon için kullandığı yerel çalıştırma sunucusu (yalnızca 127.0.0.1); seçenekler [RUN-SERVER.md](RUN-SERVER.md) içinde |
| `fairbeam app [--port N] [--ui DIR] [--no-browser]` | Derlenmiş görüntüleyiciyi (`npm run build` çıktısı `dist/`) ve çalıştırma sunucusunu tek portta (varsayılan: boş bir port) sunma, tarayıcıyı açma |
| `fairbeam sweep <model.py> --param k=v1,v2 [--param ...]` | Kartezyen parametre taraması; nokta başına paket ve `public/projects/studies/` içinde inceleme dosyası ([STUDIES.md](STUDIES.md)) |
| `fairbeam converge <design.json> [--densities 15,20,30,40] [--tol-f 0.5] [--tol-s11 1] [--tol-dmax 0.2] [--max-runs 4]` | Tasarımda mesh yakınsaması: otomatik mesh yoğunluğunu artırır; rezonans, oradaki \|S11\| ve Dmax değişimleri toleranstan küçükse durur (aşağıya ve [STUDIES.md](STUDIES.md#fairbeam-converge) sayfasına bakın) |
| `fairbeam converge <model.py> --param mesh_div=10,20,30` | Model parametresiyle sıklaştırma incelemesi; ilk rezonans ve Dmax değişimini, yakınsamayı (< %0,5 / < 0,1 dB) bildirir |
| `fairbeam optimize <model.py or design.json> --vary k=min:max --goal f0=2.45` | Sınırlı parametreleri hedeflere ayarlama (f0, f'de \|S11\|, bant genişliği, Dmax; çok portlu \|S_ij\| üst/alt sınırı, tüm \|S_ii\| üst sınırı); `--method` auto (tek parametre ve f0 hedefinde sekant, diğerlerinde Nelder–Mead), bayesian, cma-es, particle-swarm, genetic veya trust-region; sonuçlar `public/projects/optimizations/` içinde ([OPTIMIZE.md](OPTIMIZE.md)) |
| `fairbeam clean-sim [--older-than DAYS] [--dry-run]` | `.sim/` altında DAYS gündür yazılmayan ham openEMS klasörlerini kaldırma (varsayılan 7), açılan alanı bildirme (aşağıya bakın) |
| `fairbeam import-cst <macro.bas> [--out F] [--id ID] [--name N]` | CST uyumlu VBA makrosunu/geçmiş listesini (`.bas`, `.mcs`, `.txt`) tasarıma dönüştürme ve rapor yazdırma ([DESIGNER.md](DESIGNER.md#importing-a-vba-macro)) |
| `fairbeam import-pcb <files...> [--out F] [--layer-map TOP=top_copper,BOT=bottom_copper] [--substrate FR4 --thickness 1.6 --eps-r 4.3 --tan-d 0.02] [--units auto\|mm\|inch] [--chord-tol 0.02] [--margin 2] [--f0 2.45] [--origin center\|keep] [--id ID] [--name N]` | PCB çizimini (DXF, Gerber RS-274X, Excellon delik) tasarıma dönüştürme: her bakır katmanı, kart dış çizgisi üzerindeki alttaş kutusunda çokgen levhalardan oluşan katı olur; rapor yazdırılır, port eklenmez ([DESIGNER.md](DESIGNER.md#importing-pcb-artwork-dxfgerber)) |
| `fairbeam touchstone <bundle.json> [-o FILE] [--port N] [--ref OHM]` | S-parametrelerini Touchstone v1 olarak yazma (`.s1p`, `.s2p`, `.s3p`, ...; `# GHz S RI R 50`) ([STUDIES.md](STUDIES.md#fairbeam-touchstone)) |
| `fairbeam material-cell <model.py> [--set K=V] [--out DIR] [--tol DS]` | Normal gelişli düzlem dalga hücresi veya TE10 dalga kılavuzu düzeneği: boş ve numuneli hücreyi çalıştırır, S11, S21, \|R\|², \|T\|² ve soğurmayı `<slug>.cell.json` dosyasına yazar (aşağıya bakın) |
| `fairbeam debye-fit <cell.json\|csv> \| --datasheet F:EPS:TAN --f-min F --f-max F [-o FILE]` | `Simulation.dispersive` için εr(f) verisine kutup modeli uydurma (veri sayfasından Djordjevic-Sarkar laminatı, ölçülmüş veya NRW ile çıkarılmış dielektrik sabiti; aşağıya bakın) |

`run` seçenekleri (`geometry` ilk üçünü kabul eder):

| Seçenek | Varsayılan | Anlamı |
| --- | --- | --- |
| `--set KEY=VALUE` | | Model parametresini değiştirme (tekrarlanabilir, min/max kontrol edilir) |
| `--name NAME` | Model kimliği ve değiştirilmiş değerlerden türetilir | `.json` uzantısız paket adı |
| `--out DIR` | `public/projects` | Paket çıktı klasörü |
| `--threads N` veya `--threads auto` | `auto` (sistem ve kurulmuş mesh) | FDTD iş parçacıkları. Otomatik seçim, sunucuyla aynı fiziksel çekirdek/ızgara boyutu politikasını kullanır. Pozitif sayı sabitler. `0`, bir iş parçacığıyla başlayıp ilerleme aralıklarında ayarlayan openEMS otomatik ayarını kullanır. |
| `--sim-root DIR` | `.sim` | Ham openEMS çıktısı |
| `--points N` | `801` | Frekans noktası sayısı |
| `--pattern "3.3,6.2"` | Bant merkezleri | GHz cinsinden uzak alan frekansları |
| `--quiet` | | openEMS çıktısını tekrar yazdırmaz |
| `--engine cpu\|gpu` | `cpu` (veya `FAIRBEAM_ENGINE`) | FDTD motoru; GPU ayrı isteğe bağlı derleme ve eşleşen venv gerektirir ([GPU.md](GPU.md)) |
| `--end-db DB` | Modelin değeri (başka değer belirtilmezse -60) | dB cinsinden enerji durdurma ölçütü |
| `--no-exact` | | Durdurma ölçütünü her Nyquist dönemi (varsayılan) yerine yaklaşık 4 s duvar saati aralığında denetler |
| `--excite all\|1,3` | Port sayısı <= 4 ise tümü, değilse 1 | Uyarılacak portlar, her biri için bir openEMS çalıştırması ([Çok portlu yapılar](MULTIPORT.md)) |
| `--element-patterns on\|off` | Birden çok port uyarıldığında açık | Karmaşık gömülü eleman örüntülerini kaydetme (anten dizileri) |
| `--fields [GHz,...]` | Kapalı | Her metal levha düzleminde yüzey akımı haritası kaydeder (verilen frekanslarda; yoksa `--pattern`; o da yoksa yaklaşık %0,5 ızgarasında uzak alan frekansına en yakın noktada). Görüntüleyicinin "Yüzey akımı" katmanında görünür; [BUNDLE.md](BUNDLE.md#fields) |
| `--field-plane Q NORMAL MM GHZ[,GHZ...]` | Kapalı (tekrarlanabilir) | Kesit düzleminde E veya H alanı kaydeder: `Q`, `E`/`H` (üç bileşenin büyüklüğü) veya tek bileşen (`Ex`, `Hz`, ...); `NORMAL`, `x`/`y`/`z`; `MM`, düzlem konumu (en yakın mesh çizgisine oturur; bölge dışı konum uyarıyla sınırda kaydedilir); `GHZ`, frekanslar. Ör. `--field-plane E z 2.5 2.45 --field-plane H y 0 2.45`. Harita düzlemdeki tüm bölgeyi kapsar; değerler uyarılan porta gelen 1 W güç için tepe fazör genlikleridir. Tasarımın `monitors.field_planes` alanı aynı işi yapar; bayraklar bunların yerini alır. [BUNDLE.md](BUNDLE.md#field_planes) |
| `--efficiency [N]` | Kapalı (sayı verilmezse `N` = 21) | `f_min`–`f_max` arasında eşit aralıklı N frekansta (3–201) Prad / Pacc ışıma verimliliği; `results.efficiency` içinde uyarılan port başına kayıt ([BUNDLE.md](BUNDLE.md#efficiency)). NF2FF kutusu zaman alanı dökümleri kaydeder; bu işlem çözücü süresi değil, çalıştırma sonrası son işlemdir (yama örneğinde 21 frekans için bir saniyeden çok kısa). Kutusu olmayan modele NF2FF ekler. Tasarımda `monitors.efficiency` aynı işi bayraksız yapar; bayrak N değerini değiştirir. Rezonans dışı değerler düşük durdurma ölçütü (−50 dB veya altı) gerektirir |
| `--mesh-density CELLS` | Tasarımın değeri | Tasarım dosyaları: bu otomatik mesh yoğunluğunda çalıştırır (f max'ta dalga boyu başına hücre; Otomatik mod ayarını değiştirir). Elle mesh çizgileri reddedilir. Sunucu, mesh yakınsamasının her çalıştırması için iletir |

Tasarım dosyasıyla `converge` seçenekleri (ayrıca `sweep` seçeneklerini kabul eder: `--set`, `--name`, `--out`, `--sim-root`, `--threads` (varsayılan 4), `--points`, `--pattern`, `--excite`, `--end-db`, `--no-exact`, `--engine`, `--verbose`):

| Seçenek | Varsayılan | Anlamı |
| --- | --- | --- |
| `--densities C1,C2,...` | `15,20,30,40` | Artan sırayla dalga boyu başına hücre cinsinden otomatik mesh yoğunlukları (2–12 adet, 4–200 aralığında) |
| `--tol-f PCT` | `0.5` | % cinsinden rezonans toleransı |
| `--tol-s11 DB` | `1` | Rezonansta \|S11\| toleransı, dB |
| `--tol-dmax DB` | `0.2` | Dmax toleransı, dB (uzak alan yoksa yok sayılır). `--tol-d` aynı seçenektir; `--param` ile varsayılanı 0,1 kalır |
| `--max-runs N` | `4` | N çalıştırmadan sonra durur |
| `--max-density C` | | C üzerindeki yoğunlukları dışarıda bırakır |

Tüm değişimler toleranslarından kesin olarak küçükse adım yakınsamıştır. İnceleme ilk böyle adımda durur, tabloyu ve kararı yazdırır ("converged at 30 cells/λ", o adımın daha kaba yoğunluğu veya "not converged: refine further or check the model"). Her iki kararda çıkış kodu 0, çalıştırma başarısızsa 1'dir.

İsteğe bağlı mesh ölçütleri hem tasarım yoğunluğu hem `--param` incelemeleriyle çalışır. Mevcut rezonans/Dmax kontrollerine (tasarım yolunda S11'e de) eklenir; belirtilmezse mevcut davranış korunur. Bu seçenekler Tasarımcı'nın yakınsama penceresini değil CLI incelemesini etkiler.

| Seçenek | Varsayılan | Anlamı |
| --- | --- | --- |
| `--network-frequency GHZ` | Kapalı | Sabit karşılaştırma frekansı; `--network-metric` ile zorunlu, her çalıştırmanın örneklenmiş bandı içinde olmalı |
| `--network-metric KIND:PORTS:TOL` | Kapalı | Tekrarlanabilir ölçüt; dB veya faz için derece cinsinden pozitif tolerans. Port numaraları fiziksel kimliklerdir |

Türler ve port sırası: `coupling:OUT,IN:TOL` ve `isolation:OUT,IN:TOL`, −20 log10|Sout,in| değerini; `directivity:COUPLED,ISOLATED,IN:TOL`, 20 log10|Scoupled,in / Sisolated,in| değerini karşılaştırır. `phase:OUT,IN:TOL` iletim fazını, `phase:OUT1,OUT2,IN:TOL` iki çıkışın göreli fazını karşılaştırır. `s11:PORT:TOL`, sabit frekansta 20 log10|Sport,port| değerini karşılaştırır (`--param` ile de kullanılabilir). Faz değişimi en kısa dairesel uzaklığı kullanır; yalnızca ±180° sınırını geçmek büyük değişim anlamına gelmez.


```sh
fairbeam converge python/models/branchline_coupler.py --param cpw=12,20,30 --excite all \
  --network-frequency 2.4 --network-metric coupling:3,1:0.2 \
  --network-metric directivity:3,4,1:0.5 --network-metric isolation:4,1:0.5 \
  --network-metric phase:2,3,1:1
```

Seçilen tüm değişimler toleranstan kesin olarak küçük olmalı, iki çalıştırma da enerji durdurma ölçütünü sağlamalıdır. Karmaşık S-parametreleri sabit frekansta enterpole edilir; ekstrapolasyon reddedilir. Eksik port/sütun, sonlu olmayan örnek veya genliği 1e-4 ve altında yanıt kullanılamaz ve yakınsamayı engeller. Beş ondalık basamaklı kayda karşı bu koruyucu sınır, ölçülmüş yalıtım sınırı değildir. Uygun portları `--excite` ile seçin. İnceleme JSON'u yalnızca istenirse `network_criteria`, çalıştırma başına `network` değerleri ve adım başına `network` kontrolleri ekler; sonuç paketleri ve tasarım şemaları yeni alan almaz. Metin tablosu her ölçütün değişimini ve toleransını listeler. Sayısal yakınsama tek başına analitik uyumu kanıtlamaz; mevcut çıkış kodu sözleşmesi değişmez.

## `fairbeam material-cell`

Malzeme numunesini veya yüzeyi normal gelişte karakterize eder. Modelin `build(p)` işlevi numune çevresinde `fairbeam.material_cell.PlaneWaveCell` oluşturur: x'te PMC duvarları (H'ye dik), y'de PEC duvarları (E'ye dik), z'de PML olan TEM hücresi; kaynak olarak yumuşak E_y levhası ve her iki taraftaki referans düzleminde gerilim probu. Numune kesiti doldurmalı veya duvarlara göre simetrik olmalıdır. Komut, boş hücreyi (aynı mesh, kaynak, problar) ve numuneli hücreyi aynı zaman adımıyla çalıştırır: openEMS kurulumundan her birinin adımını okur ve küçüğünü kullanır (dispersif numune, örneğin Drude eps' < 1, vakumdan kısa adım gerektirebilir). Adım dispersif numunenin kutuplarını çözümlemiyorsa çalıştırmayı reddeder (`fairbeam.dispersion.resolution_problems`). S11 ve S21'i vakum dalga empedansı referansıyla numune yüzlerine taşır. Model `analytic_layers(p)` da tanımlıyorsa (önden arkaya `{thickness, eps_r, tan_d, tan_d_freq, mu_r}` veya frekansa bağlı katman için `{thickness, dispersion}` listesi), transfer matrisi levhasına (`fairbeam.analytic.slab_s`) göre sapmayı yazdırır. Örnekler `python/examples/slab_cell.py` (sabit malzemeler) ve `python/examples/dispersive_cell.py` (Debye, Lorentz, Drude, Djordjevic-Sarkar FR4); sonuçlar [VALIDATION.md](VALIDATION.md#15-plane-wave-material-cell-homogeneous-slab) içindedir.

| Seçenek | Varsayılan | Anlamı |
| --- | --- | --- |
| `--set`, `--name`, `--threads`, `--sim-root`, `--quiet`, `--engine`, `--end-db`, `--no-exact` | `run` ile aynı | |
| `--out DIR` | Geçerli klasör | `<slug>.cell.json` klasörü |
| `--points N` | `401` | `f_min`–`f_max` arası frekans noktaları |
| `--tol DS` | | Karmaşık S11 veya S21, analitik levhadan DS'den fazla farklıysa 1 durumuyla çıkar |
| `--nist` | Kapalı | Numuneyi manyetik olmayan olarak tanımlar: NIST yinelemeli yöntemiyle εr(f) de çıkarılır (μr = 1); NRW'nin çözümlendiği yerde birim-μ dalını seçmesine izin verir (opak bant üstünde gereklidir) |
| `--nrw-floor S` | `0.3` | NRW güvenilirlik ölçütü: ilk yarım dalgadan sonra \|sin(β′d)\| < S olan frekanslar güvenilmez işaretlenir |
| `--tol-material REL` | | Çıkarılan εr′ veya μr′ modelin tek analitik katmanından REL'den fazla (göreli), kayıp tanjantı REL'den fazla (mutlak) saparsa 1 durumuyla çıkar |

Sonuç dosyası (`"kind": "fairbeam.material-cell"`) bir sonuç paketi değildir; görüntüleyici henüz açmaz. `frequency`, `s11`, `s21` (`{re, im}`), `R2`, `T2`, `absorption`, hücre geometrisi (`cell`: yüzler, referans düzlemleri, kaynak düzlemi, sınırlar, üst mod kesim frekansları `f_higher_mode` ve `warnings`), iki çalıştırmanın `run_stats` bilgisi ve `analytic_layers` varsa analitik `s11`, `s21`, `deviation` içerir. Ham veriler `<sim-root>/<slug>/reference/` ve `.../sample/` klasörlerine gider.

`f_max`, referans düzlemlerinin artık yalnızca düzlem dalgayı görmediği bir üst moda ulaştığında komut uyarır: hücrenin merkez düzlemlerine göre ayna simetrisi olmayan numunede c / (2 max(a, b)), her yapılandırılmış numunede c / max(a, b) üstünde. Homojen levha böyle bir mod uyarmamaktadır.

### Malzeme parametreleri

Pozitif d kalınlıklı numunede (hücrenin `back - front` değeri) komut, S11 ve S21'den malzeme parametrelerini çıkarır (`fairbeam.nrw`), sonucun `material` bölümüne yazar. Levhada (`front == back`) çıkarılmaz.

- **NRW** (Nicolson-Ross-Weir, her zaman): εr(f), μr(f), dielektrik ve manyetik kayıp tanjantları, kırılma indisi. İletim teriminin logaritması çok değerlidir. Faz indisi grup indisi c·τ_g/d ile eşleşen dal seçilir (Weir). Opak frekanslar (\|S21\| < −60 dB; örneğin Lorentz soğurma çizgisi veya Drude metali) arasındaki her bant parçasında, düşük veya yüksek uçtan daha az dispersif olanında seçilir (`nrw.segments`). Opak bantta biriken faz kaybolur. Bu nedenle bandın en düşük frekansında başlamayan parça (opak bant üstünde veya başlangıçtaki opak bölgeden sonra), numune manyetik olmayan olarak belirtilmedikçe (`--nist`) ve birim-μ dalı çözümlenmedikçe güvenilmez işaretlenir: yalnızca bir dal, parça boyunca karmaşık μr değerini 1'in 0,1 yakınında tutmalıdır. `--nist` ile ilk parça da bu dalı kontrol eder: çözümlenirse grup gecikmesi dalıyla uyuşmalıdır, aksi halde parça güvenilmezdir (dar bantta kalın manyetik numunenin yanlış bir dalında μr ≈ 1 olabilir). Çözümlenmezse (manyetik numune) parça grup gecikmesi dalını korur. Opak ve yalıtılmış frekanslara değer verilmez; her yerde opak numune için malzeme parametresi çıkarılmaz (komut bildirir). Numune kalınlığı yarım dalga boyunun katıysa (β′d = mπ) NRW kötü koşulludur: düşük kayıplı numunede S11 kaybolur, S-parametresi hataları εr ve μr değerlerine yaklaşık 1/\|sin β′d\| oranıyla yansır. Bu frekanslar da `reliable: false` işaretlenir (`--nrw-floor`). Dal seçimi ve analitik katman karşılaştırması yalnızca güvenilir noktaları kullanır.
- **NIST** (`--nist`; Baker-Jarvis ve diğerleri, 1990): manyetik olmayan numune için εr(f). Her frekansta kapalı biçimli levha S11 ve S21 değerlerini simülasyona en iyi uyduran ε değerini bulur (en küçük kareler). En düşük güvenilir NRW değerinden başlar, her çözümden sonraki frekansa ilerler. Yarım dalga kararsızlığı olmadığından düşük kayıplı numunenin kayıp tanjantını NRW'den çok daha iyi verir. μr = 1 varsayar; manyetik numunede sonucu yanlıştır. NRW medyan μr′ değeri 1'den %5'ten fazla saparsa komut uyarır.

 e^{+jωt} düzeninde ε = ε′ − jε″ ve tan δ = ε″/ε′. `Simulation.dielectric` ile oluşturulan numunenin iletkenliği sabittir; kayıp tanjantı 1/f ile azalır, yalnızca `tan_d_freq` frekansında `tan_d` olur. Çıkarım bu eğriyi yeniden üretir; karşılaştırma aynı modeli kullanır (`fairbeam.analytic.layer_constants`). `material` bölümü şunları içerir:

- `thickness`;
- `nrw`: `eps_r`, `mu_r` (`{re, im}`), `tan_d`, `tan_d_mu`, `group_index`, `branch` (ilk parçanın dalı; yoksa `null`), `segments` (her parçanın `f_min`, `f_max`, `branch`, `misfit`, `after_opaque`, `method`, `branch_resolved` değerleri), `reliable`, `criterion`;
- `--nist` ile `nist`: `eps_r`, `tan_d`, `iterations`, `converged`, `residual`;
- Tek analitik katmanda `expected` ve `deviation`. Frekansa bağlı katmanda karmaşık göreli hataları `max_rel_eps`, `max_rel_mu` kullanın: ε′ sıfırdan geçerken (Lorentz, Drude), göreli ε′ hatası ve kayıp tanjantı anlamlı değildir. Bu durumda `--tol-material` yalnızca bu ikisini kullanır.

### Dalga kılavuzu düzeneği

`build(p)` işlevi `fairbeam.waveguide_fixture.WaveguideFixture` oluşturan model, dikdörtgen dalga kılavuzu iletim/yansıma düzeneğini çalıştırır: numune iki TE10 portu arasında a × b kesitini (varsayılan WR-90) doldurur; x ve y'de PEC duvarları, iki portun arkasında PML vardır. `Simulation(..., excitation="gauss")` kullanın: varsayılan Gauss türevi darbe DC'ye uzanır; dolu ve boş kılavuzun TE10 kesim frekansları arasındaki enerji, εr·μr > 1 numunede hapsolur (düzenek uyarır). Komut ardından:

- openEMS kurulumundan her çalıştırmanın zaman adımını okur, boş kılavuzu ve numuneyi küçük adımla çalıştırır; sonra port problarının zaman ekseninden ikisinin de bunu kullandığını denetler (düzlem dalga hücresi gibi, dispersif kutupları çözümlemeyen adım reddedilir);
- port dalgalarından S11 ve S21'i alır (referans: TE10 dalga empedansı η0·k0/β0), boş çalıştırmada iki referans düzlemi arasında benzetilen β0 ile numune yüzlerine taşır;
- kılavuzlu transfer matrisi levhasıyla (`slab_s(..., kc=π/a)`) `analytic_layers(p)` karşılaştırması yapar;
- benzetilen β0 kullanarak kılavuzlu NRW/NIST biçimleriyle εr ve μr çıkarır (β_s = j·ln T / d, μr = z·β_s/β0, εr·μr = (β_s² + kc²)/(β0² + kc²)).

Bant, boş kılavuzun TE10 kesim frekansı c/(2a) üstünde başlamalıdır (aksi halde hata); `f_max`, TE20 veya TE01 kesimine ulaşırsa komut uyarır. Dolu bölümün kesimleri (√(εr·μr) değerine bölünmüş) yalnızca raporlanır: kesiti dolduran homojen numune TE10'u bu modlara kuplajlamaz. Sonuç dosyasına `"setup": "waveguide"` (düzlem dalga hücresinde `"plane-wave"`), frekans başına `z_ref`, `beta0` (`measured`, `analytic`, `max_rel_difference`), `empty` altında boş çalıştırmanın `s11` ve yüzlere taşınmış `s21` değerleri, `cell` altında düzenek geometrisi ve kesimler (`cutoffs_empty`, `cutoffs_filled`) eklenir. Örnek `python/examples/wr90_fixture.py`; sonuçlar [VALIDATION.md](VALIDATION.md#17-waveguide-material-fixture-wr-90) içindedir.

**Hava aralığı.** Gerçek numune kılavuzu nadiren tam doldurur. `WaveguideFixture(..., gap_x=, gap_y=)`, numune ile her dar duvar (`gap_x`) ve geniş duvar (`gap_y`) arasında, iki tarafta eşit hava aralığı bırakır (varsayılan 0: numune kılavuzu doldurur). Numuneyi `fixture.sample_span(z0, z1)` üzerinde oluşturun. Örnek bunları `--set gap_x=` / `--set gap_y=` olarak alır (mm).

- **Mesh.** Her aralıkta en az iki hücre bulunur; hava çözünürlüğüne doğru kademelenir. Zaman adımı en küçük hücreye bağlıdır: 0,025 mm aralık, 20 hücre/λ'da dolu kılavuzun 41 katı zaman adımı gerektirir (30'da 27 katı).
- **Üst modlar.** Simetrik aralık TE30 (dar duvarlar) ve TE12 / TM12 (geniş duvarlar) uyarır. Düzenek, bunların f_max'ta referans düzlemlerinden önce 40 dB sönümlenmesini kontrol eder; sağlanmıyorsa uyarıyla düzlemleri uzaklaştırır. Kesimler ve sönümler `cell.air_gap.higher_modes` içindedir.
- **Düzeltme.** Çıkarılan εr görünür değerdir. Komut ayrıca hava aralığı düzeltilmiş εr verir (`fairbeam.waveguide_fixture.gap_correction`, NIST TN 1355-R, Ek C'ye göre):
  - E'nin aralıktan geçtiği geniş duvarlarda varsayılan, her frekansta çözülen kılavuz yüksekliği boyunca enine rezonanstır (`model="resonance"`, TN 1355-R C.1.1). Yarı statik seri kapasitör modeli (`model="capacitor"`, C.2.2) düşük frekans sınırıdır ve büyük aralıklarda aşırı düzeltir (WR-90'da her tarafta 0,2 mm için +%2,2; rezonans modelinde +%0,44);
  - dar duvarlarda her iki model TE10 ağırlıklı paralel katman modeli kullanır (birinci derece).

  Rezonansla düzeltilen değerler `material.gap_correction` içindedir (`nrw`, `nist`, analitik katman varsa `deviation`); kapasitör değerleri `material.gap_correction.capacitor` altındadır. `nrw` / `nist` bölümleri görünür değerleri korur. Aralık varsa `--tol-material` rezonansla düzeltilmiş sapmaları kontrol eder. Analitik levha karşılaştırması kılavuzu dolduran numune olmaya devam eder; böylece aralığın etkisini gösterir.

## `fairbeam debye-fit`

`Simulation.dispersive` için εr(f) verisine kutup modeli uydurur (`fairbeam.debye_fit`). Model ε∞ + Σ aşırı sönümlü Lorentz kutuplarıdır; her biri Debye benzeri gevşemedir. openEMS 0.37.0rc3'ün DebyeMaterial modeli 3B'de ΣΔε/ε∞ ≈ 0,3 (1B'de 0,6) üstünde ıraksadığından `LorentzMaterial` olarak yazılır ([VALIDATION.md §15c](VALIDATION.md#15c-dispersive-materials-debye-lorentz-drude-djordjevic-sarkar)). `Simulation.dispersive`, Debye kutupları için aynı uydurmayı kullanır; aynı malzemenin Lorentz ve Drude kutupları korunur (aşırı sönümlü kutuplar rezonansı veya ε′ < 1 durumunu temsil edemez). Gevşeme frekansları uydurma aralığında logaritmik aralıklıdır; kuvvetler gerçek ve sanal kısımların negatif olmayan en küçük kareler çözümünden gelir. Sonuç pasif ve nedenseldir; openEMS tam olarak uydurulan işlevi simüle eder. Her kutup FDTD zaman adımıyla sınırlıdır: kutup ve plazma frekanslarında dt/τ ≤ 0,5, ω·dt ≤ 0,5 (`fairbeam.dispersion.resolution_problems`). Böylece en yüksek gevşeme frekansı yaklaşık 0,08/dt ile sınırlanır.


```bash
fairbeam debye-fit --datasheet 1e9:4.4:0.02 --f-min 1e9 --f-max 10e9 -o fr4.dispersion.json
fairbeam debye-fit result.cell.json --method nist -o measured.dispersion.json
fairbeam debye-fit measured.csv --kappa --dt 1e-12
```

| Seçenek | Varsayılan | Anlamı |
| --- | --- | --- |
| `INPUT` | | `.cell.json` (`material.nist` veya `material.nrw`) ya da başlıklı CSV: `f` (Hz), `eps_re`, `eps_im` (ε′ − jε″; kayıplı numunede `eps_im` ≤ 0), veya `f`, `eps_r`, `tan_d`. Yalnızca geçerli ölçümler kullanılır (aşağıya bakın) |
| `--datasheet F:EPS:TAN` | | Girdi yerine Djordjevic-Sarkar laminatı için veri sayfası değerleri (tekrarlanabilir), ε(ω) = ε∞ + Δε/(m2 − m1)·log10((ω2 + jω)/(ω1 + jω)). Tek noktaya tam, birden fazlasına en küçük karelerle uyum. Laminat f_min/10–10·f_max aralığında uydurulur |
| `--m1`, `--m2` | `4`, `12` | Djordjevic-Sarkar köşe frekansları ω1 = 10^m1, ω2 = 10^m2 rad/s |
| `--f-min`, `--f-max` | Veri aralığı | Hz cinsinden uydurma aralığı (`--datasheet` ile simülasyon bandıdır ve zorunludur) |
| `--method auto\|nist\|nrw` | `auto` | `.cell.json` içindeki hangi çıkarımın kullanılacağı (varsa NIST) |
| `--poles N` | Dekad başına 4, en az 5 | Aday kutuplar; NNLS'nin gerek duymadıkları çıkarılır |
| `--dt S` | Malzemede f_max'ta 20 hücre/λ küp mesh'in CFL adımı | Kutupları çözümlemesi gereken zaman adımı. Biliniyorsa gerçek değeri verin |
| `--kappa` | Kapalı | Statik iletkenlik de uydurulur (DC kayıplı ölçüm verileri) |
| `-o FILE` | `<input>.dispersion.json` | Çıktı (`"kind": "fairbeam.dispersion"`); `fairbeam.dispersion.Dispersion.load(path)` okur |

Komut, `.cell.json` dosyasından geçerli ölçüm olmayan her frekansı dışarıda bırakır:
- Sonlu olmayan değerler;
- \|S21\| değeri −60 dB altında frekanslar (fazı ölçülemeyen opak numune);
- NIST için yinelemenin yakınsamadığı noktalar (`nist.converged`);
- NRW için `reliable` maskesinin reddettikleri: yarım dalga rezonansları ve opak bant üstünde dalı açıkça belirlenemeyen parçalar.

CSV'de sonlu olmayan satırlar çıkarılır. Kayıtlı maskenin uzunluğu veya türü frekanslarla uyuşmuyorsa hatadır. Komut kullanılan ve çıkarılan frekans sayılarını nedenleriyle yazdırır, çıktının `source.samples` alanına kaydeder. Kalan geçerli frekans sayısı bilinmeyenlerden (ε∞, aday kutuplar, `--kappa` ile κ) azsa eksik belirlenmiş model uydurmak yerine hatayla durur. Bu durumda `--poles` değerini azaltın.

Komut uydurmanın en büyük εr′ (göreli) ve tan δ (mutlak) hatalarını yazdırır, zaman adımının çözümlemediği kutuplar için uyarır. `Simulation.dispersive(name, DjordjevicSarkar(...))`, kurulum sırasında mesh'in CFL adımıyla sınırlı aynı uydurmayı yapar (`Simulation.cfl_timestep`); bu nedenle önce mesh'i oluşturun. Çalıştırma kutupları gerçek zaman adımına göre kontrol eder (`run_stats["dispersion_problems"]`).

JSON olarak yazılmış model (`to_dict()`, `.dispersion.json`, paketin `material.dispersion` veya `source` alanı), `fairbeam.dispersion.model_from_dict` ile okunur. Sözlüğün `model` değerine göre `DjordjevicSarkar` veya `Dispersion` döndürür; başka modeli frekans bağımlılığını kaybetmek yerine reddeder. `Simulation.dispersive` ve `analytic.slab_s` katmanları bu sözlüğü doğrudan kabul eder. Tasarım dosyasında henüz dispersif dielektrik yoktur; böyle bir Python modelini Tasarım olarak açmak, bant merkezi değerlerini yazmak yerine hatayla durur.

## Ham simülasyon verileri (`.sim/`)

Her openEMS çalıştırması `--sim-root` (varsayılan `.sim/`) altında ham çıktı klasörü yazar (prob zaman serileri, NF2FF ve alan dökümleri; çoğu kez yüzlerce MB). Asıl çıktı pakettir; ham klasör yalnızca paket yazılana kadar gereklidir. Kaldırma yolları:

- **Çalıştırma sunucusu işleri**, `.sim/runs/<job id>/` klasörüne yazar; Son çalıştırmalar listesinden çalıştırmayı silmek bu klasörü de kaldırır (yalnızca simülasyon kökü içindeyse, sembolik bağlantılar çözülerek).
- **Optimizasyonlar**, her değerlendirmenin ham klasörünü paket yazılınca kaldırır. Korumak için `fairbeam optimize --keep-sim` veya `FAIRBEAM_KEEP_SIM=1` kullanın.
- **`fairbeam clean-sim`**, en yeni dosyası `--older-than` gününden eski (varsayılan 7, tümü için `0`) çalıştırma klasörlerini (`et`, `port_ut*`, `nf2ff*.h5` gibi openEMS çıktıları içerenler) kaldırır, boş kalan klasörleri temizler ve açılan bayt sayısını yazdırır; `--dry-run` yalnızca listeler. `.sim/jobs/` (çalıştırma geçmişi), `.sim/model-history/`, simülasyon kökü dışı veya içine sembolik bağlantıyla bağlı öğeler, çalışan işin kullandığı klasör (yanında etkin PID'li `.<name>.fairbeam-running` işareti; `fairbeam run`, taramalar ve optimizasyonlar yazar) ve son 10 dakikada yazılmış klasörlere dokunmaz.
