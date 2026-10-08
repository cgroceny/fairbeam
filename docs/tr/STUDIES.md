# Taramalar, yakınsama çalışmaları ve Touchstone dışa aktarma

Üç CLI komutu `fairbeam run` üzerine kuruludur: `sweep`, `converge` ve `touchstone`. Kod `python/fairbeam/study.py` ve `python/fairbeam/touchstone.py` içindedir.

## `fairbeam sweep`

```bash
fairbeam sweep python/models/dipole.py --param length=50,58,66 --threads 4
fairbeam sweep python/models/inset_patch.py --param inset=6,8,10 --param feed_w=2.6,3.0 --set f_max=3.5
```

- Her `--param KEY=V1,V2,...` bir eksen ekler. Birden fazla eksen, son ekseni en hızlı değişen **Kartezyen** bir ızgara oluşturur.
- `--set KEY=VALUE`, diğer parametreleri tüm noktalarda sabitler.
- Her nokta, çözücü zamanı harcanmadan **önce** modelin `PARAMS` tanımına (tür, min, maks) göre doğrulanır.
- Noktalar **sırayla**, aynı anda tek openEMS süreciyle çalışır. `--threads` varsayılanı 4'tür.
- Her nokta, `<out>/studies/<name>/<slug>.json` dosyasına yazılan normal bir pakettir.
- Çalışma özeti `<out>/studies/<name>.json` dosyasına yazılır. `<out>` varsayılanı `public/projects`, `<name>` varsayılanı `<model-id>--sweep--<axes>` biçimindedir.
- Üye paketler galeri dizinine (`public/projects/index.json`) **eklenmez**; böylece 20 noktalı tarama galeriyi doldurmaz. Bir üyeyi doğrudan açın veya çalışma dosyasını yükleyin.

| Seçenek | Varsayılan | Anlamı |
| --- | --- | --- |
| `--param KEY=V1,V2,...` | zorunlu | Tarama ekseni (yinelenebilir) |
| `--set KEY=VALUE` | | Sabit değer (yinelenebilir) |
| `--name NAME` | türetilir | Çalışma adı |
| `--out DIR` | `public/projects` | Sonuçlar klasörü; çalışma `DIR/studies` altına gider |
| `--sim-root DIR` | `.sim` | Ham openEMS çıktısı (`.sim/<study>/<slug>`) |
| `--threads N` | `4` | FDTD iş parçacıkları |
| `--points N` | `801` | Frekans noktaları |
| `--pattern "2.4,5.8"` | bant merkezleri | GHz cinsinden uzak alan frekansları |
| `--end-db DB` | model varsayılanı | Enerji durdurma ölçütü, örneğin `-60` |
| `--no-exact` | kapalı | Durdurma ölçütünü her Nyquist periyodu yerine gerçek zamanda yaklaşık 4 s'de bir kontrol eder. Kesin denetim (bilgisayardan bağımsız durdurma; openEMS `--exact-endcriteria`) varsayılandır; eski `--exact` bayrağı kabul edilir ancak etkisizdir |
| `--engine cpu\|gpu` | `cpu` (veya `$FAIRBEAM_ENGINE`) | FDTD motoru |
| `--excite all\|1,3` | port sayısı <= 4 ise tümü, aksi halde 1 | Çok portlu modellerde her noktada uyarılan portlar (her biri ayrı çalıştırma) |
| `--verbose` | kapalı | openEMS çıktısını gösterir |

### RunHistory tarama CSV'si

Çalıştır panelinde bir parametre taramasını genişletin ve **Tümünü karşılaştır**, ardından **CSV olarak dışa aktar** veya **Veriyi kopyala** seçeneğini kullanın. İkisi de aynı uzun tabloyu kullanır; tamamlanmamış ve başarısız işler dahil her iş için bir satır vardır. Sütunlar `run_index`, `sequence_index`, `sequence_name`, `status`, tarama parametre anahtarları, `band_lo_ghz`, `band_hi_ghz`, `band_center_ghz`, `band_best_ghz`, `s11_min_db`, `dmax_dbi` ve `radiation_efficiency_pct` sütunlarıdır. Bant değerleri ilk eşleşen bandı, uzak alan değerleri ilk uzak alan frekansını anlatır. Bulunmayan değerler boş bırakılır.

`band_center_ghz` bant sınırlarının ortasıdır, `(band_lo_ghz + band_hi_ghz) / 2`; `band_best_ghz` ise minimum |S11| frekansıdır. Daha önce `band_center_ghz` bu minimumu tutuyordu. İki sınırı da olmayan eski iş istatistiklerinde merkez boş kalır, en iyi uyum frekansı korunur. RunHistory tablosu, minimum frekans sütununu **En iyi uyum** olarak adlandırır. Bu CSV sütunları, aşağıdaki CLI çalışma JSON biçiminden ayrıdır; o biçimde `f_center` minimum frekans olarak kalır.

## `fairbeam converge`

### Tasarım: mesh yoğunluğu

```bash
fairbeam converge python/models/my_patch.design.json --densities 15,20,30,40 --max-runs 4 --engine gpu
```

`.design.json` ile `--param` verilmezse tasarım her otomatik mesh yoğunluğunda sırayla çalışır (`mesh.cells_per_wavelength`; Otomatik modda `cells_per_wavelength` alan ayarı). Her çalıştırmadan sonra rezonansı (S11 minimumu), oradaki |S11|'i, Dmax'ı (uzak alan varsa) ve giriş empedansını önceki çalıştırmayla karşılaştırır. Değişikliklerin tümünün `--tol-f` (%0,5), `--tol-s11` (1 dB) ve `--tol-dmax` (0,2 dB) değerlerinin kesin olarak altında kaldığı ilk adımda veya `--max-runs` (4) çalıştırmadan sonra durur. Kod `python/fairbeam/convergence.py`, seçenekler [CLI.md](CLI.md) içindedir. Çıktı:

```
 cells/λ      cells   f_res GHz     df %   S11 dB    dS11  Dmax dBi   dD dB           Zin ohm   time s  ok
      15      55104      2.4495        -   -42.35       -      6.76       -         49.7-0.4j      1.1
      20     101088      2.4538    0.173   -41.34    1.02      6.75  -0.003         49.8-0.5j      1.2  no
      30     250800      2.4559    0.088   -40.68    0.66      6.75  -0.002         49.3-0.1j      1.9  yes
tolerances: |df| < 0.5 %, |dS11| < 1 dB, |dDmax| < 0.2 dB
converged at 20 cells/λ
```

Tasarımcının Mesh yakınsaması… penceresi aynı çalışmayı çalıştırma sunucusu üzerinden yürütür (`POST /api/convergence`; her yoğunluk için bir çalıştırma işi, sonraki yalnızca kural devam etmeyi söylüyorsa kuyruğa alınır; `GET /api/convergence/{id}` aşağıdaki çalışma dosyasını döndürür, `POST /api/sweeps/{id}/cancel` durdurur). Bkz. [DESIGNER.md](DESIGNER.md#mesh-convergence).

Çalışma dosyasında `kind: "mesh-convergence"` bulunur; `axes` çalıştırılan yoğunlukları listeler, `convergence` kuralın durumunu tutar:

```json
{
  "schema": "fairbeam.study/1", "kind": "mesh-convergence", "id": "cv-20260928-101500-ab12",
  "name": "Patch · mesh convergence",
  "axes": [{"key": "mesh.cells_per_wavelength", "values": [15, 20, 30]}],
  "members": [
    {"density": 15, "status": "done", "file": "patch--mesh-15.json",
     "metrics": {"f_res": 2.4495e9, "s11_db": -42.35, "dmax_dbi": 6.756, "zin_re": 49.7, "zin_im": -0.4,
                 "matched": true, "cells": 55104, "timesteps": 14016, "wall_time_s": 1.1}, "summary": {"...": "..."}}
  ],
  "convergence": {
    "tolerances": {"f_pct": 0.5, "s11_db": 1.0, "dmax_db": 0.2}, "densities": [15, 20, 30], "max_runs": 3,
    "steps": [{"from": 15, "to": 20, "df_pct": 0.173, "ds11_db": 1.02, "ddmax_db": -0.003, "dzin_ohm": 0.14,
               "ok": {"f": true, "s11": false, "dmax": true}, "converged": false}],
    "converged": true, "converged_at": 20, "done": true, "reason": "converged",
    "verdict": "converged at 20 cells/λ", "next": null
  }
}
```

- `converged_at`, ilk yakınsayan adımın daha kaba yoğunluğudur; daha ince çalıştırma bunu doğrular.
- `reason`: `converged`, `exhausted` (yoğunluk kalmadı: “yakınsamadı: daha da inceltin veya modeli kontrol edin”), `failed`, `cancelled` veya `running` (bu durumda `next`, sıradaki yoğunluktur).
- Daha önce başarılı sayılmış, enerji ve yerel mesh denetimleri doğrulanmamış Design raporu açıldığında
  `reason: "unverified"` döner; önerilen yoğunluk kaldırılır, eski hüküm `recorded_verdict`
  alanında tutulur. Kayıt dosyası korunur; güncel kanıt için çalışmayı yeniden çalıştırın.
- Çalıştırmada uzak alan yoksa `ok.dmax`, `null` olur; Dmax hesaba katılmaz.
- Rezonans frekans örnekleri arasında iyileştirilir (S11 minimumu ve dB cinsinden komşularından geçen parabol); böylece ızgara aralığı %0,5 toleransa baskın olmaz.

### Python modeli: mesh parametresi

```bash
fairbeam converge python/models/dipole.py --param mesh_div=10,15,20,30 --end-db -60
fairbeam converge python/models/sierpinski_monopole.py --set iterations=2 --param cell=0.8,0.6,0.45
```

Bu, `sweep` komutunun tam bir eksenli ve değerlerini **kabadan inceye** sıraladığınız bir sarmalayıcısıdır. Ardışık inceltmeler arasında şunları bildirir:

- **ilk rezonansın** değişimi: −10 dB altındaki ilk bandın merkezi (S11 minimumu), uyumlu bant yoksa global S11 minimumu
- bu rezonansa en yakın uzak alan frekansındaki **Dmax** değişimi
- `--param` ile başlatılan çalışmalar dahil, bu rezonanstaki **S11 derinliği** değişimi

|Δf| < `--tol-f` (varsayılan %0,5), |ΔS11| < `--tol-s11` (varsayılan 1 dB) ve varsa
|ΔDmax| < `--tol-d` (varsayılan 0,1 dB) olduğunda adım yakınsamış sayılır. İki koşu da enerji
sönümü ölçütünü sağlamalı; hiçbirinde yetersiz ince ayrıntı bildirilmemelidir. S11 derinliği
eksikse denetim geçmez. Çalışma, **son** adımı yakınsamışsa yakınsamıştır. Global mesh parametresi
değişirken port hücreleri sabit kalıyorsa, bu denetimler iki ek yerel inceltmenin yerini tutmaz.

Aşağıdaki tarihsel çıktı S11 derinliği denetiminden öncedir; güncel tablo ayrıca `dS11 dB` gösterir:

```
  mesh_div      cells   f_res GHz      df %  Dmax dBi    dD dB  ok
        15      50544      2.4100         -      6.80        -
        20      97152      2.4325     0.934      6.81    0.010  no
        30     263568      2.4525     0.822      6.79   -0.021  no
        40     535920      2.4550     0.102      6.79   -0.002  yes
converged (last step |df| < 0.5 %, |dD| < 0.1 dB): YES
```

Yalnızca global hücre boyutunu değil, metal üzerindeki mesh'i kontrol eden parametreyi (`mesh_div`, `cell`, ...) inceltin. Bkz. [VALIDATION.md](VALIDATION.md#5-recommended-settings).

### Besleme inceltmesini global mesh'ten ayırın

Patch örneği varsayılan olarak özgün ideal çizgi beslemesini korur (`feed_width=0`).
**Farklı, açıkça sonlu bir kaynak modeli** için `feed_width` değerini mm cinsinden belirleyin;
fiziksel kare ayak izini sabit tutup `feed_cells` değerini artırın. Bu, dağıtılmış ayrık kaynaktır;
koaksiyel konektör modeli değildir. Alttaş boyunca `sub_cells` değerini de artırın. Küçülen
hücreler kararlı zaman adımını düşürdüğünde `max_timesteps` sınırını yükseltin. Fiziksel ayak
izi, malzeme, sınırlar ve kaynak aynı kalmalıdır.

`python/` klasöründen aşağıdaki isteğe bağlı deney, 1 × 1 mm ayak iziyle besleme ve alttaş
boyunca 2, 4, 8, 16 hücre kullanarak dört CPU çözümünü sırayla çalıştırır:

```bash
python -m tests.patch_feed_study --out /path/to/new-patch-study
```

Ham karmaşık S11, minimum çevresinde sık frekans örnekleri, mesh çizgileri, çözücü günlükleri
ve ardışık iki inceltmenin denetimini kaydeder. Yalnızca frekans testini geçmek, eşleşme
derinliğinin kararlı olduğunu göstermez. İdeal çizgi beslemeli örnek Design'a dönüştürülürken
`feed_width` sabit tutulur; çizgiden alana geçiş yeni mesh çizgileri gerektirir. Design'da
düzenlenebilir sonlu ayak izi için örneği pozitif genişlik değeriyle dönüştürün.

8 Ekim 2026 Windows CPU kontrolünde dört düzeyin tümü −60 dB enerji sönümüne ulaştı:

| Besleme / altlık hücresi | S11 minimumu (GHz) | Derinlik (dB) | Derinlik değişimi (dB) | En büyük karmaşık S11 değişimi |
| --- | --- | --- | --- | --- |
| 2 | 2.44700 | −35.630 | — | — |
| 4 | 2.45395 | −33.521 | 2.109 | 0.11322 |
| 8 | 2.45580 | −32.885 | 0.636 | 0.03220 |
| 16 | 2.45645 | −32.564 | 0.321 | 0.01084 |

Son frekans değişimi %0,0265 olsa da tüm banttaki karmaşık değişim, önceden belirlenen 0,01
sınırını aştı. Frekans ve minimum derinliği son iki adımda kendi eşiklerini sağladı;
**üç ölçütün tamamını** geçen ardışık iki adım elde edilmedi. Sonlu kaynak açık bir modelleme
seçeneğidir; çizgi beslemenin doğrulanmış yerine geçmez ve başka antenler için bir düzeltme
sayılmaz. Özet girdiler, ölçütler ve ölçümler `python/tests/fixtures/patch_finite_feed_20261008.json`
dosyasında korunur; yukarıdaki komut ham verileri yeniden üretir.

### Bıçak: mesh kararından önce kaynağı tanımlayın

Bıçak, ölçülmüş anteni veya belirtilmiş konnektörü olmayan sayısal bir galeri geometrisidir.
İdeal çizgi port ve sonlu genişlikli düzlemsel aralık kaynağı farklı modellerdir. S11 eğrilerinin
farklı olması tek başına fiziksel doğruluğu göstermez. Mesh'i inceltirken genişliği sabit tutun;
kaynak duyarlılığını gizlemek için geometriyi ayarlamayın.

8 Ekim 2026 denetiminde PEC bıçak, toprak, bant, 50 Ω referans ve tam hassasiyetli iç mesh sabit
tutuldu. PML kutusunu her yönde 8 ve ardından 16 kenar genişliğinde hücreyle uzatma, iki ardışık
denetimi geçti (en büyük karmaşık S11 değişimleri 0,000504 ve 0,000389).
Ayrı besleme çalışması x/y ±4 mm, z −2 ile 6 mm aralığına iki kez yerel orta noktalar ekledi.
Yalnızca ikinci kaynak modeli portu mevcut 4 mm dilin tamamına yayar; koaksiyel pim içermez.

| Kaynak | İnceltme seviyesi | S11 minimumu (GHz) | Minimum (dB) | 867 MHz'de S11 (dB) | En büyük ardışık karmaşık değişim |
| --- | --- | --- | --- | --- | --- |
| İdeal çizgi | 0 | 0.919597 | -14.768 | -14.036 | — |
| İdeal çizgi | 1 | 0.919972 | -13.982 | -13.308 | 0.030059 |
| İdeal çizgi | 2 | 0.920203 | -13.315 | -12.689 | 0.028877 |
| 4 mm düzlemsel | 0 | 0.916355 | -17.316 | -16.427 | — |
| 4 mm düzlemsel | 1 | 0.916450 | -17.137 | -16.266 | 0.004309 |
| 4 mm düzlemsel | 2 | 0.916494 | -17.038 | -16.177 | 0.002567 |

Çizgi kaynak denetimi geçmedi. Sabit genişlikli kaynak iki ardışık yerel denetimi de **geçti**.
Her adımda frekans değişimi %0,5'in; minimum derinliği ve 867 MHz değişimleri 0,5 dB'nin;
0,7–1,05 GHz boyunca en büyük karmaşık S11 farkı 0,01'in altında olmalıdır. Bütün koşular ayrıca
−60 dB enerji sönümüne ulaşmalı, 1,001 yansıyan güç sınırını geçmemeli ve minimumu sabit
0,85–1,00 GHz izleme aralığında tutmalıdır. Yalnızca frekansın uyuşması yeterli değildir.

`python/` içinden, yeni çıktı klasörleri kullanarak çalışmaları tek tek çalıştırın:

```bash
python -m tests.blade_feed_study --phase boundary --width 0 --threads 12 --out /path/to/new-blade-boundary
python -m tests.blade_feed_study --phase feed --width 0 --threads 12 --out /path/to/new-blade-line
python -m tests.blade_feed_study --phase feed --width 4 --threads 12 --out /path/to/new-blade-planar
python -m tests.blade_feed_study --phase auto --width 4 --threads 12 --out /path/to/new-blade-auto
python -m tests.blade_feed_study --phase auto --width 4 --densities 40 50 60 --threads 12 --out /path/to/new-blade-fine
python -m tests.blade_feed_study --phase auto --width 4 --densities 40 60 80 --air-density 20 --threads 12 --out /path/to/new-blade-fixed-air
python -m tests.blade_feed_study --phase auto --width 4 --densities 60 80 100 --air-density 20 --threads 12 --out /path/to/new-blade-final
python -m tests.blade_feed_study --phase auto --width 4 --densities 20 30 40 --air-density 20 --threads 12 --out /path/to/new-blade-footprint
```

Sabit kaynak `python/tests/fixtures/blade_feed_base.design.json` dosyasındadır. `--phase auto`,
dalga boyu başına 20, 30 ve 40 hücreyle otomatik mesh oluşturur; yalnızca sabit ızgarayı değil,
türetilen dış kutu dahil bu ayarı denetler. Her koşu en çok sekiz milyon hücre ve 5.400 saniyeyle
sınırlıdır. Sonuçlar tam girdiyi, ham gerilim/akım kayıtlarını, karmaşık S11 CSV'sini, mesh'i,
enerjiyi ve kabul kayıtlarını içerir. Komutun bitmesi yakınsama kanıtı değildir:
iki ardışık geçiş için `comparison.json` dosyasını inceleyin.

`--densities`, önceden seçilen üç seviyeli diziyi belirler. `--air-density 20`, özellik meshi
inceltilirken dış hava yoğunluğunu sabit tutar; bu seçenek yoksa iki yoğunluk birlikte değişir.
20/30/40 ve 40/50/60 dizileri iki ardışık geçiş sağlamadı: en büyük karmaşık değişimleri
0,01767 ve 0,01448 oldu. Hava yoğunluğu 20'de sabitken 40→60 değişimi 0,01014 oldu
(değiştirilmeyen 0,01 sınırının üzerinde); 60→80 adımı 0,00448 ile geçti. Başarısız adımların
tamamı kanıtlarda korunur; minimum frekansının kararlı olması bu sonuçları geçersiz kılmaz.
Sonraki 80→100 değişimi de geçmedi (0,01521). Tarihsel otomatik kontroller, kaynak genişliği
düzeltmesinden önceki `be2e5d1` commit'iyle tekrarlanabilir; son komutu güncel kodda çalıştırın.

İncelemede ayrı bir mesh raporlama hatası bulundu: 4 mm genişlikli kaynak, enine tek 4 mm hücreye
düştüğü halde yalnızca sıfır genişlikli enine eksen denetlendiğinden yeterli sayılıyordu.
Düzeltilen kontrol ve inceltme, kaynağın kapladığı alanın tamamını kapsar. Geometrik regresyon
testleri geçti; sonraki 20→30→40 testinin ilk adımı geçti (0,00567), ikinci adımı geçmedi
(karmaşık S11 farkı 0,02866; minimum derinliği değişimi 0,689 dB). Bu, **tam S11 yakınsama
çözümü değildir**. Galeri bu yüzden ideal çizgi varsayılanını korur, `feed_fraction` seçeneğini
deneysel olarak sunar ve empedans uyumu sonuçlarını mesh duyarlı olarak işaretler.

Ölçülen özetler, girdi/çıktı özet değerleri ve sınırlar
`python/tests/fixtures/blade_source_study_20261008.json` dosyasındadır. Windows 11 üzerinde
Ryzen 9 7900X, 32 GiB RAM, openEMS 0.37.0rc3 ve CSXCAD 0.7.0rc3 kullanıldı; yeni koşular
12 CPU iş parçacığıyla çalıştı. Tekrar kullanılan çizgi kaynak yarım mesh koşusu dört iş
parçacığı kullandı: normalize girdiler birebir eşleşti, dört/on iki iş parçacıklı başlangıç
yanıtlarının farkı sıfırdı. Süreler hız kıyaslaması değildir. Bu yerel testler fiziksel doğruluğu,
uzak alan yakınsamasını veya GPU eşliğini göstermez.

### Ayrı kurulmuş openEMS CLI ile karşılaştırma

```bash
python -m tests.native_gallery_study --native /path/to/openEMS --out /path/to/new-control --timeout 15000
```

Bu isteğe bağlı uzun kontrol Python örneklerini, kayıtlı örnek Design'ları ve sıfır yinelemeli
Sierpinski varyantını kapsar. Alt küme için `--models dipole,blade_867` kullanın. Her portu iki
yolda da sırayla, dört CPU iş parçacığıyla, aynı tam hassasiyetli CSXCAD geometrisi, mesh ve
−60 dB enerji ölçütüyle çalıştırır; modelin adım sınırı yerine 300.000 adımlık üst sınır kullanır.
Ham dalgaları, tam S matrislerini, çözücü girdisini, model
kaynağını, özetleri ve günlükleri korur. Düzlemsel kaynakların CSXCAD XML yazımı sırasında
mesh'ten kaymaması için ilkel koordinatları 17 anlamlı basamakla aktarılır.

Tüm galeri saatler sürebilir. Komut, büyük örnekler için native çözüm başına zaman aşımını
900'den 15.000 saniyeye çıkarır; bir çift için bunun iki katı artı 50 saniye ayrılır.
`--threads N`, fiziksel girdiyi değiştirmeden iki yoldaki CPU iş parçacığı sayısını ayarlar.
Her denemede yeni çıktı klasörü kullanın; yarıda kesilen koşuların çıktıları korunur.

Kontroller aynı girdinin eşdeğerliğini, enerji sönümünü, matris pasifliğini, S matrisi hesabını
ve sonuç saklama yuvarlamasını ayrı değerlendirir. Uzak alanı kapsamaz; mesh yakınsaması veya
fiziksel doğruluk kanıtı değildir. Ayrı arşivden çıkarılmış çalıştırılabilir dosya, uygulamayla
aynı upstream çözücü ikilisini içerebilir; kütüphane özetini karşılaştırıp bu durumu kaydedin.

8 Ekim 2026 Windows CPU kontrolünde 21 galeri örneği/varyantı, sırayla 64 çözücü koşusunda
tamamlandı. Çiftlerin iki tarafında aynı olmak üzere dört veya 12 iş parçacığı kullanıldı.
Ham karmaşık S matrisleri birebir aynıydı; bağımsız matris hesabındaki en büyük fark 5.58e-16,
paket yuvarlamasındaki en büyük fark 7.05e-6 oldu. Tüm örnekler enerji ve matris pasifliği
sınırlarını sağladı. 136 gerilim/akım probu çifti de kayıt hassasiyetinde aynıydı. Uygulama ve
resmi arşiv aynı openEMS DLL'ini içeriyordu: bu sonuç iki çalıştırma yolunun uyumunu gösterir;
bağımsız bir çözücü veya fiziksel ölçümlerle uyum kanıtı değildir. CPU girdileri, ikili/kaynak
özetleri, ölçütler ve örnek bazındaki sonuçlar
`python/tests/fixtures/native_gallery_control_20261008.json` dosyasındadır.
Tam galeri kaydı, önceki çizgi kaynaklı Blade modelini kullanır; kaynak özetleri kanıtın parçasıdır.
Bu kayıt, sonradan düzenlenmiş bir kaynağın tekrar çalıştırılması gibi sunulmamalıdır.
Bu kontrolde GPU çalıştırması ve uzak alanlar test edilmedi.

Yenilenen Blade kaynağı, 9 Ekim'de iki yolda da 12 CPU iş parçacığıyla, aynı −60 dB/300.000
adım kontrolüyle ve uzak alan hesabı olmadan yeniden sınandı. Ham karmaşık S11 ile kayıtlı
gerilim/akım verileri birebir aynıydı; paket yuvarlamasındaki en büyük fark 6.87e-6 oldu.
Enerji ve pasiflik kontrolleri geçti. Kaynak özeti ve ölçümler,
`python/tests/fixtures/blade_source_study_20261008.json` dosyasındaki
`new_gallery_native_control` alanındadır. Bu, aynı upstream DLL ile çalıştırma eşliğidir;
Blade mesh yakınsamasının kanıtı değildir.

## Çalışma dosyası: `fairbeam.study/1`

```json
{
  "schema": "fairbeam.study/1",
  "kind": "sweep | convergence | mesh-convergence",
  "name": "patch-mesh-convergence",
  "created": "2026-09-24T23:20:11+0300",
  "model": {"id": "patch-antenna", "name": "Rectangular patch antenna", "file": "patch_antenna.py"},
  "axes": [{"key": "mesh_div", "values": [15, 20, 30, 40]}],
  "fixed": {},
  "threads": 4, "end_criteria_db": -60, "exact_endcriteria": true, "wall_time_s": 43.0,
  "members": [
    {"file": "studies/patch-mesh-convergence/patch-antenna--mesh_div-15.json",
     "params": {"mesh_div": "15"},
     "summary": {
       "bands": [{"f_lo": 2.39e9, "f_hi": 2.43e9, "f_center": 2.41e9, "s11_min_db": -37.2, "edge_lo": false, "edge_hi": false}],
       "first_resonance": {"f": 2.41e9, "s11_db": -37.2, "matched": true},
       "reactance_zeros": [{"f": 2.53e9, "r": 2.36}],
       "farfield": [{"f": 2.41e9, "dmax_dbi": 6.799, "dmax_pattern_dbi": 6.812, "rad_efficiency": 0.948, "gain_dbi": 6.57, "realized_gain_dbi": 6.57}],
       "dmax_dbi": 6.799, "rad_efficiency": 0.948,
       "cells": 50544, "min_cell": 0.38, "max_cell": 6.66, "timesteps": 12750, "wall_time_s": 6.4, "converged": true}}
  ],
  "convergence": {"tol_f_pct": 0.5, "tol_d_db": 0.1, "converged": true,
                  "steps": [{"df_pct": 0.934, "d_dmax_db": 0.01, "converged": false}]}
}
```

- `members[].file`, sonuçlar klasörüne görelidir; böylece görüntüleyici `/projects/<file>` adresini alabilir.
- `members[].params`, taranan değerleri komut satırında verildiği gibi (dize olarak) tutar.
- Frekanslar Hz cinsindedir.
- `summary.converged`, çalıştırmanın **çözücü** durdurma ölçütü durumudur. `convergence`, mesh çalışmasının sonucudur.
- `sparams` (yalnızca çok portlu modeller), ilk rezonans frekansında `{f, db: {"i,j": |S_ij| in dB}, reciprocity_max, passive}` veya `null` olur.
- `reactance_zeros`, Im(Zin)'in sıfırı yukarı yönde kestiği frekansları (seri rezonansları) o noktadaki Re(Zin) ile listeler. Port referans empedansından bağımsız oldukları için diğer çözücülerle karşılaştırılabilecek en uygun değerlerdir.
- `convergence`, `kind: "convergence"` (`--param` ile inceltme) ve farklı düzenle (yukarıya bakın) `kind: "mesh-convergence"` için bulunur. Ardışık her üye çifti için bir adım içerir.
- Yalnızca isteğe bağlı `--network-metric` / `--network-frequency` ölçütleriyle (bkz. [CLI.md](CLI.md)): çalışmada `network_criteria` bulunur; her üyenin `summary.network` (`--param`) veya `metrics.network` (tasarım) alanı sabit frekans değerlerini tutar. Her yakınsama adımı, sonucu kendi `converged` değeriyle mantıksal VE işlemine giren `network` nesnesi içerir. Seçenekler yoksa alanlar bulunmaz ve sonuçlar değişmez.

## `fairbeam touchstone`

```bash
fairbeam touchstone public/projects/patch-antenna.json              # -> public/projects/patch-antenna.s1p
fairbeam touchstone public/projects/dipole.json -o dipole.s1p --ref 0   # keep the 73 ohm port reference
```

Tek portlu pakette veya `--port N` ile `# GHz S RI R 50` başlıklı Touchstone v1 `.s1p` dosyası yazılır. Çok portlu pakette tam matris `.s<N>p` olarak yazılır; bunun için her portun uyarılmış olması gerekir (`--excite all`, en fazla 4 port için varsayılan). İki portlu dosya, v1 biçiminin gerektirdiği gibi her frekansta tek satırda sütun sırasıyla (S11 S21 S12 S22) yazılır; N ≥ 3 için satır başına en fazla dört karmaşık çift olacak şekilde satır satır yazılır. Farklı referans empedanslı portlar `--ref` değerine tam olarak yeniden normalize edilir. openEMS, S11'i ayrık portun kendi direncine göre ölçer. Tek portta yansıma katsayısı giriş empedansı üzerinden herhangi bir referansa **tam olarak** yeniden normalize edilir: `S' = (Zin − Z) / (Zin + Z)`. Varsayılan 50 Ω'dur; böylece dosya ADS veya scikit-rf'e beklendiği gibi aktarılır. `--ref 0`, portun özgün referansını korur. `--port N` bir port seçer; varsayılan uyarılan porttur.

Python'da Touchstone dosyalarını okumak için `fairbeam.touchstone.read_snp(path)` (`(f_hz, S, z0)` döndürür) veya uyarıları da döndüren `read_touchstone(path)` kullanın. v1 ve v2 dosyaları okunur. Y/Z verileri S'ye dönüştürülür, port başına v2 referansları tek empedansa yeniden normalize edilir ve gürültü blokları atlanır. Görüntüleyicinin içe aktarıcısıyla aynı kuralları kullanır.
