# Optimizasyon aracı

`fairbeam optimize`, Python modelinin veya `.design.json` tasarımının sınırlandırılmış sürekli parametrelerini betik üzerinden hedeflere göre ayarlar. Her değerlendirme normal bir `fairbeam run` çalıştırmasıdır (aynı model dosyası, motor, iş parçacıkları ve durdurma ölçütü). Arama, `python/fairbeam/optimize.py` içinde sade Python ile yapılır (standart kütüphane ve numpy; scipy yok).

```bash
fairbeam optimize python/models/dipole.py --vary length=50:66 --goal f0=2.40 --engine gpu
fairbeam optimize python/models/patch_antenna.py \
    --vary patch_w=30:34:33.5 --vary feed_x=-12:-2:-3 \
    --goal f0=2.45 --goal "s11_max=-25@2.45" --engine gpu --max-evals 15
fairbeam optimize python/models/wilkinson_divider.py --vary r_iso=40:160:100 \
    --goal "match_all=-20@2.4" --goal "sij_max=-25@2.4:2,3" --engine gpu
```

Tasarımcıda **Optimizasyon** şerit sekmesi › **Optimize et** seçeneğini (veya Çalıştır penceresinde **Optimize et…**) kullanın; *Tasarımı optimize et* penceresi açılır. Python modeli için Çalıştırma panelinin **Optimizasyon** modunu kullanın. İkisinin girdileri aynıdır (en fazla dört hedef, yöntem, değerlendirme sınırı); canlı maliyet grafiği, değerlendirme tablosu ve en iyi sonucu açma veya başlangıçla karşılaştırma düğmeleri bulunur. Çok portlu modellerde S-matrisi hedefleri de sunulur ve her değerlendirmenin hangi portları uyardığı gösterilir.

## Parametreler

`--vary KEY=MIN:MAX[:START[:RESOLUTION]]`, yinelenebilir (her parametre bir kez).

- Sınırlar, parametrenin kendi `minimum`/`maximum` aralığında olmalıdır.
- START varsayılanı modelin sınırlar içine kırpılmış değeridir. Uygulama geçerli parametre değerini kullanır.
- Değerler RESOLUTION'a yuvarlanır. Varsayılan, aralığın yaklaşık 1/1000'i olan bir on kuvvetidir; tam sayı parametreler 1'e yuvarlanır. Yuvarlanmış değerler demeti önbellek anahtarıdır, böylece bir nokta iki kez simüle edilmez.

## Hedefler

Hedefler toplanarak birleştirilir. Ağırlık `*w` olarak yazılır; örneğin `s11_max=-25@2.45*2`.

| Hedef | Sözdizimi | Ölçüt | Maliyet (boyutsuz) | Sağlanma koşulu |
| --- | --- | --- | --- | --- |
| Rezonans | `f0=<GHz>` | ilk rezonans: ilk −10 dB bandının merkezi; yoksa Im(Zin)'in ilk yukarı yönlü sıfır geçişi; o da yoksa \|S11\| minimumu | (100 · Δf/f / 1 %)² | \|Δf/f\| ≤ `--f0-tol` (varsayılan %0.25) |
| Uyum | `s11_max=<dB>@<GHz>` | frekanstaki \|S11\| | (aşım / 3 dB)² | \|S11\| ≤ hedef |
| Bant genişliği | `bw_min=<MHz>` | f0 çevresindeki bandın (yoksa ilk bandın) −10 dB bant genişliği | (eksik oran / 10 %)² | ≥ hedef |
| Yönlülük | `dmax_min=<dBi>@<GHz>` | frekanstaki Dmax (en yakın uzak alan örneği) | (eksik değer / 0.5 dB)² | ≥ hedef |
| Yalıtım / kuplaj | `sij_max=<dB>@<GHz>:<i>,<j>` | frekanstaki \|S_ij\| (i alıcı, j uyarılan port) | (aşım / 3 dB)² | ≤ hedef |
| İletim | `sij_min=<dB>@<GHz>:<i>,<j>` | frekanstaki \|S_ij\| | (eksik değer / 0.5 dB)² | ≥ hedef |
| Tüm portlarda uyum | `match_all=<dB>@<GHz>` | tüm portların en kötü \|S_ii\| değeri | (aşım / 3 dB)² | ≤ hedef |

Değerlendirilemeyen hedefin maliyeti 10⁴ olur; örneğin simüle edilen bantta rezonans yoksa. Tüm hedefler sağlanınca, `--max-evals` tükenince veya arama yakınsayınca çalıştırma durur.

### Tasarım denetimlerinin reddettiği adaylar

Tasarımda (`.design.json`) her aday, openEMS çalışmadan önce tasarım denetimlerinden ([DESIGNER.md](DESIGNER.md#checks)) geçer. Şu durumlarda aday simüle edilmez, **atlanır**:

- denetim hataları varsa (örneğin minimumu maksimumunun üzerine çıkan kutu), veya
- değerleri metali alttaşından taşırıyorsa ya da havada bırakıyorsa (`metal-overhang`, `metal-floating`); ancak tasarım kendi değerlerinde zaten aynı uyarıyı içeriyorsa bu durum kabul edilir (bilerek böyle çizilmiş katı).

Atlanan aday, başarısız aday gibi değerlendirme sayılır. Kaydı `"skipped": "<reason>"` ve `skipped:` ile başlayan `error` taşır; günlük satırı ve değerlendirme tablosu nedeni belirtir (**Atlandı** durumu; örneğin “'patch', 'substrate' üzerinden 1.2 mm taşıyor (x+)”). Denetim hatasının maliyeti 10⁴'tür. Yanlış yerleşmiş metalin maliyeti 10⁴ artı her mm taşma veya boşluk için %10'dur (en fazla 10⁵); böylece bu noktalardan başlayan arama uygulanabilir bölgeye yönelir. Arama ardından devam eder. `--no-precheck` her adayı simüle eder. Python modelleri denetlenmez; taramalar her noktayı olduğu gibi çalıştırır.

Yakın alandan uzak alana dönüşüm yalnızca Dmax hedefi gerektiriyorsa (veya `--farfield` ile) yapılır; bu her değerlendirmenin son işlem süresinin büyük kısmını azaltır.

Her değerlendirmenin ham openEMS klasörü (`<sim-root>/optimizations/<name>/<slug>/`), paketi yazılır yazılmaz kaldırılır; korumak için `--keep-sim` kullanın (veya `FAIRBEAM_KEEP_SIM=1` ayarlayın).

### Çok portlu hedefler ve uyarılan portlar

Son üç hedef, `results.sparams` içindeki S-matrisini okur (`fairbeam run` ile aynı `multiport.s_from_section`). Port numaraları modelin kendi numaralarıdır. Wilkinson bölücü örnekleri: `sij_max=-25@2.4:2,3` (yalıtım S23 ≤ −25 dB), `sij_min=-3.2@2.4:2,1` (|S21| ≥ −3.2 dB), `match_all=-20@2.4` (S11, S22 ve S33'ün tümü ≤ −20 dB). |S_ij|, en yakın iki frekans noktası arasında genlik üzerinden enterpole edilir.

openEMS uyarılan her port için bir kez çalışır; değerlendirmenin süresi, uyarılan port sayısıyla tek çalıştırma süresinin çarpımıdır. Uyarılacak portları `--excite` belirler:

- `auto` (varsayılan), yalnızca hedeflerin gerektirdiği portları uyarır.
  - j portu uyarılınca S_·j sütunu bilinir.
  - Devre karşılıklı olduğundan (S_ij = S_ji), S_ij aynı zamanda i sütunundan bilinir.
  - `match_all`, her S_ii'yi, dolayısıyla tüm portları gerektirir.
  - Anten hedefleri (`f0`, `s11_max`, ...) ilk portu kullanır.
  - Üç portlu örnekler: S21 ve S11 yalnızca port 1'i; S23 yalnızca port 3'ü; S21 ve S23 port 1 ve 3'ü; `match_all` üçünü de uyarır.
- `all`, tüm portları uyarır.
- `1,3` gibi açık liste, bu portları uyarır.

Matris girdisi hesaplanmamış hedefin (sütunu uyarılmamışsa) maliyeti 10⁴'tür ve hedef hiçbir zaman sağlanmış sayılmaz.

**Daha az portu uyarmak S-matrisi yöntemini değiştirir.** Tüm portlar uyarıldığında Fairbeam güç dalgalarından tam S = B A⁻¹ hesaplar. Portların bir kısmı uyarıldığında yalnızca S_ij = b_i / a_j hesaplayabilir; bu, diğer portların kusursuz uyumlu sonlandırma olduğunu varsayar. Wilkinson bölücüde iki yöntem yaklaşık 2 dB'ye kadar farklılaşır (aşağıdaki gösterime bakın). Ön eleme için yeterlidir; ancak son noktayı tüm portlar uyarılmışken, örneğin tek bir `fairbeam run` ile doğrulayın.

Uygulama aynı kuralı izler. **Uyarılan portlar**, *Gerekenler* veya *Tümü* sunar; panel sonuçta seçilen portları ve değerlendirme başına çalıştırmaları gösterir. Süre tahmini: değerlendirmeler × uyarılan portlar × modelin son tamamlanmış çalıştırmasının port başına süresi (süresi, uyardığı port sayısına bölünür). Başlat düğmesi değerlendirmeleri değil openEMS çalıştırmalarını sayar.

## Algoritmalar

`--method` aramayı seçer (varsayılan `auto`); uygulamada aynı **Yöntem** listesi bulunur. `--seed` (varsayılan 0) rastlantısal yöntemlerin tohumudur; `--max-evals` (varsayılan 12; komut satırında 1–200, uygulamada en fazla 40) değerlendirme sınırını belirler.

- **secant**, yalnızca f0 hedefli tek parametrenin varsayılanıdır (`auto`).
  - İkinci nokta, rezonans uzunlukları için geçerli olan f0 ∝ 1/x ilişkisini varsayar.
  - Ardından f0(x) − hedef üzerinde sekant uygular; hedef iki nokta arasına alınınca Illinois yanlış konum yöntemine geçer.
  - Hedef sınırların dışındaysa veya çözünürlüğe ulaşılırsa durur.
  - İlerleme olmadan geçen üç adımdan sonra Nelder–Mead'e devreder.
- **nelder-mead**, diğer tüm durumların varsayılanıdır.
  - [0, 1] aralığına ölçeklenmiş parametrelerde çalışır. Kutu dışındaki noktalar kırpılır; başlangıç simpleksi her aralığın %15'i kadar adım kullanır.
  - Simpleks durakladığında en iyi noktanın çevresinde yarım adımla yeniden başlar (iki kez).
- **bayesian** (Gauss süreciyle beklenen iyileşme), **cma-es**, **particle-swarm** ve **genetic** (popülasyon aramaları), ayrıca **trust-region** (sınırlı sonlu fark yerel araması) `--method` ile seçilebilir. Aynı [0, 1] ölçekli kutuda çalışırlar; aşağıdaki ölçülmüş örnekler yalnızca sekant ve Nelder–Mead kullanır.

## Çıktı

- Her değerlendirme, `public/projects/optimizations/<name>/<model>--<k>-<v>.json` dosyasına paket olarak yazılır. Bu paketler ana sonuç dizinine girmez.
- Çalışmanın kendisi `fairbeam.optimization/1` şemasıyla `public/projects/optimizations/<name>.json` dosyasına kaydedilir. Model, değişen parametreler, hedefler, sabit parametreler, motor, her değerlendirme (parametreler, ölçütler, hedef başına maliyet ve sağlanma bayrağı, paket dosyası, toplam süre), en iyi nokta, başlangıç noktası, durma nedeni ve toplam süreyi içerir.
- Dosya her değerlendirmeden sonra yeniden yazılır; böylece iptal edilen çalışma geçmişini korur.
- İlerleme stdout'a `fairbeam: optimize start|eval|done {json}` satırları olarak gider. Çalıştırma sunucusu (`POST /api/optimizations`) bunları canlı olaylara dönüştürür.

## Gösterim (GPU motoru)

İki çalıştırma da Apple M5 Pro üzerinde Metal GPU sürümünü (`~/opt/openEMS-gpu/venv/bin/python`, `--engine gpu --threads 2`) ve modellerin varsayılan mesh'lerini kullanmıştır. Toplam süreler her paketin oluşturulması, çözülmesi, son işlemleri ve yazılmasını kapsar.

### Dipol: ilk bant merkezini 2.40 GHz'e ayarlama (1 parametre)

`fairbeam optimize python/models/dipole.py --vary length=50:66 --goal f0=2.40 --engine gpu --threads 2 --max-evals 10`

| # | length (mm) | f0 (GHz) | \|S11\|(f0) (dB) | maliyet | çözücü süresi |
| --- | --- | --- | --- | --- | --- |
| 1 | 58.00 (başlangıç) | 2.4150 | −56.9 | 0.39 | 0.95 s |
| 2 | 58.36 | 2.4000 | −55.4 | 0 (hedef sağlandı) | 1.01 s |

Yöntem: sekant. İkinci nokta f0 ∝ 1/L ilişkisinden gelir: 58 × 2.415 / 2.40 = 58.36 mm. Hedef **2.0 s'de 2 değerlendirme** sonunda sağlanmıştır.

f0 çözünürlüğü frekans ızgarasıdır: 1.5–3.5 GHz üzerinde 801 nokta, yaklaşık %0.1 olan 2.5 MHz verir.

### Yama: f0 = 2.45 GHz ve 2.45 GHz'de |S11| < −25 dB (2 parametre)

`fairbeam optimize python/models/patch_antenna.py --vary patch_w=30:34:33.5 --vary feed_x=-12:-2:-3 --goal f0=2.45 --goal "s11_max=-25@2.45" --engine gpu --threads 2 --max-evals 15`

Modelin varsayılanları (patch_w 32 mm, feed_x −6 mm) zaten 2.4525 GHz'de −36 dB ile rezonans verir. Bu nedenle varsayılanlardan başlayan çalıştırma ilk değerlendirmede (1.8 s) iki hedefi de sağlamıştır. Buradaki çalıştırma bilerek ayarı bozulmuş bir noktadan başlar.

| # | patch_w (mm) | feed_x (mm) | f0 (GHz) | \|S11\| @ 2.45 GHz (dB) | maliyet |
| --- | --- | --- | --- | --- | --- |
| 1 | 33.500 (başlangıç) | −3.000 (başlangıç) | 2.3400 | −0.3 | 88.0 |
| 5 | 32.600 | −5.250 | 2.4050 | −3.3 | 55.7 |
| 8 | 31.700 | −6.000 | 2.4725 | −8.9 | 29.5 |
| 12 | 31.924 | −7.315 | 2.4600 | −13.4 | 15.1 |
| 15 | **32.018** | **−5.860** | **2.4500** | **−32.4** | 0 (hedefler sağlandı) |

Yöntem: Nelder–Mead. Her iki hedef **15 değerlendirmenin 15'incisinde, 28.7 s'de** sağlanmıştır (değerlendirme başına 1.3–2.6 s). Sonuç f0 = 2.4500 GHz ve 2.45 GHz'de |S11| = −32.4 dB'dir.

Maliyet yüzeyi düzensizdir ve arama hızını sınırlar:

- Sabit frekanstaki |S11|, patch_w değerindeki milimetre altı değişimlerde onlarca dB değişir.
- feed_x = −9.1 mm ilk bandı tamamen kaybettirmiştir: ilk rezonans 2.67 GHz'e sıçramıştır (değerlendirme 13).

Burada 15 değerlendirmelik sınır ancak yeterli olmuştur. Beklenen çözüm çevresinde daha dar sınırlar veya önce f0'ı, ardından uyumu ayarlamak daha az değerlendirmeyle yakınsar.

### Wilkinson bölücü: uyumlu ve yalıtılmış çıkışlar için yalıtım direnci (çok portlu hedefler)

`python/models/wilkinson_divider.py`, ders kitabındaki R = 100 Ω (`r_iso` parametresi) ile 2.4 GHz'de S22 = −18.4 dB ve S23 = −22.0 dB'de kalır ([VALIDATION.md §8](VALIDATION.md#8-wilkinson-power-divider)). Optimizasyon aracına o bölümdeki görev verilmiştir: 2.4 GHz'de tüm portlarda −20 dB uyum ve ≤ −25 dB yalıtım.

`fairbeam optimize python/models/wilkinson_divider.py --vary r_iso=40:160:100 --goal "match_all=-20@2.4" --goal "sij_max=-25@2.4:2,3" --engine gpu --threads 2 --max-evals 5`

`match_all`, her S_ii'yi gerektirdiğinden her değerlendirmede üç port da uyarılmıştır (tam S = B A⁻¹, 3 openEMS çalıştırması, yaklaşık 2.5 s):

| # | r_iso (Ω) | S11 | S22 | S33 | maks \|S_ii\| | S23 | maliyet |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 100 (başlangıç) | −24.27 | −18.40 | −18.38 | −18.38 | −22.03 | 1.27 |
| 2 | 118 | −24.27 | −16.09 | −16.09 | −16.09 | −18.59 | 6.27 |
| 3 | **82** | −24.27 | −22.14 | −22.14 | **−22.14** | **−29.93** | 0 (hedefler sağlandı) |

Tüm değerler 2.4 GHz'de dB cinsindedir. Yöntem: Nelder–Mead. Her iki hedef **7.6 s'de 3 değerlendirme (9 openEMS çalıştırması)** sonunda sağlanmıştır. Port 1 uyarıldığında dirençten akım akmadığından S11 dirence bağlı değildir.

Optimizasyon aracı, tüm hedefleri sağlayan ilk noktada durur; dolayısıyla 82 Ω yalnızca hedeflerin uygulanabilir olduğunu gösterir. En iyi direnci bulmak için 82 Ω'dan başlayarak S22 ≤ −20 dB korunurken yalıtım hedefi −35 dB'ye sıkılaştırılmıştır:

`fairbeam optimize python/models/wilkinson_divider.py --vary r_iso=40:160:82 --goal "sij_max=-20@2.4:2,2" --goal "sij_max=-35@2.4:2,3" --engine gpu --threads 2 --max-evals 5`

İki hedef de 2. sütundadır (S22 doğrudan, S23 karşılıklılık yoluyla); bu nedenle `--excite auto` yalnızca port 2'yi uyarmıştır. Bu, değerlendirme başına yaklaşık 0.9 s süren 1 çalıştırmadır. Simetri gereği S33 = S22'dir.

| # | r_iso (Ω) | S22 | S23 | maliyet |
| --- | --- | --- | --- | --- |
| 1 | 82 (başlangıç) | −21.24 | −33.54 | 0.24 |
| 2 | 100 | −17.72 | −23.39 | 15.5 |
| 3 | 64 | −26.64 | −27.26 | 6.66 |
| 4 | **73** | −23.89 | **−37.89** | 0 (hedefler sağlandı) |

Bu değerler kısmi uyarımdan (b_i / a_j) elde edilmiştir. Arama **3.6 s'de 4 değerlendirmeden sonra 73 Ω'a** yakınsamıştır.

**VALIDATION §8'deki direnç taramasıyla karşılaştırma.** Bu tarama en iyi yalıtımı 70 Ω'da bulmuştur: 2.4 GHz'de S23 = −37.3 dB, 2.444 GHz'de −41.9 dB ve S22 = −25.6 dB. Optimizasyon, tüm portları uyaran dört noktalı tarama yerine 4 tek portlu değerlendirmeyle bunun 3 Ω yakınına gelmiştir. Çalıştırma paneli, çok portlu tarama özetini kullanarak tüm portların uyarıldığı r_iso = 73 ve 100 Ω taramasıyla sonucu doğrulamıştır:

| r_iso | \|S21\| | S11 | S22 | S33 | S23 |
| --- | --- | --- | --- | --- | --- |
| 73 Ω (tam) | −3.09 | −24.27 | −24.78 | −24.82 | −39.92 |
| 100 Ω (tam) | −3.09 | −24.27 | −18.40 | −18.38 | −22.03 |

Tüm portlar uyarıldığında 73 Ω, `match_all ≤ −20 dB` hedefini sağlar (en kötü port −24.3 dB ile S11) ve S23 = −39.9 dB verir. İkinci çalıştırmanın kısmi uyarım değerleri S22 için bunların 0.9 dB, S23 için 2.0 dB yakınındadır. 100 Ω satırı VALIDATION §8 ile 0.03 dB içinde eşleşir.

Kol empedansı (genişlik) optimize edilmemiştir. Direnç tek başına iki hedefi de sağlamıştır; ikinci parametre çalıştırma sayısını üçe katlardı. VALIDATION §8'de açıklanan tek mod davranışı, bu yerleşimde en iyi direncin ders kitabındaki 2·Z0 = 100 Ω yerine yaklaşık 70 Ω olması demektir.

## Sınırlamalar ve sonraki adımlar

- **Kısmi uyarım.** Yalnızca gereken portları uyarmak hızlıdır ancak b_i / a_j kullanır (diğer portlar uyumlu varsayılır). Derin sıfırlar yakınında tam matristen yaklaşık 2 dB farklılaşabilir. Son değerlendirmede `--excite all` kullanın veya bir çalıştırmayla doğrulayın.
- **İlk uygulanabilir nokta.** Tüm hedefler sağlanınca arama durur. Uygulanabilir nokta yerine en iyi noktayı bulmak için hedefleri sıkılaştırın.
- **Nelder–Mead yereldir.** Farklı başlangıç farklı uyuma ulaşabilir. Diğer `--method` seçenekleri (bayesian, cma-es, particle-swarm, genetic, trust-region) bu belgede ölçülmemiştir.
- **Kaba ölçütler.** Ölçütler 801 frekans noktasından gelir; f0 bu ızgaradan daha ince çözünürlükle belirlenemez.
