# Sonuçlar nasıl hesaplanır?

- **Uyarım.** Varsayılan, `f_max` değerinde -20 dB olan, DC bileşeni içermeyen Gauss türevi darbesidir. openEMS'in modüle edilmiş Gauss darbesi, `f_min/f_max` küçükken (örneğin 0,5–8 GHz) DC bileşeni taşır. Geride bıraktığı statik alan enerjiyi durdurma ölçütünün üzerinde tutar; çalıştırma zaman adımı sınırına kadar sürer. S-parametreleri etkilenmez ancak süre yaklaşık 10 kat artar. Sierpinski modelinde türev darbesi süreyi yaklaşık 150 s'den (yakınsamamış) 13 s'ye (-47 ile -61 dB arasında yakınsamış) indirmiştir. `Simulation(..., excitation="gauss")` openEMS'in darbesini geri getirir.
- **Durdurma ölçütü.** Alan enerjisi durdurma ölçütüne düştüğünde çalıştırma durur; **varsayılan −60 dB'dir**. Her Nyquist döneminde değerlendirilir (`exact_endcriteria`; durma noktası bilgisayar hızına bağlı değildir. `--no-exact`, openEMS'in yaklaşık 4 s duvar saati aralıklı kontrolünü geri getirir). Rezonans frekansı ve Dmax, −40 dB'de oturur; yüksek Q'lu yapıların S11 derinliği ve ışıma verimliliği henüz oturmaz: yama antende −40 dB için |S11| −24 dB ve η 0,86; −60 dB için −37 dB ve 0,95; −70 dB için −39 dB ve 0,96 elde edilir (henüz ışımamış sönüm enerjisi P_acc değerini bozar). Çalıştırma başına `--end-db` ile değiştirin.
- **S11 ve Zin**, uyarılan ayrık porttan hesaplanır: S11 = u_ref / u_inc ve Zin = u_tot / i_tot. `f_min` ile `f_max` arasındaki `--points` adet frekansta değerlendirilir.
- **Bantlar**, |S11| < -10 dB olan kesintisiz frekans aralıklarıdır. Her bant; sınırlarını, minimum S11 frekansını (pakette `f_center`), bağıl bant genişliğini ve simülasyon aralığının sınırına değip değmediğini bildirir. Uygulamanın bant tablolarında (Özet, S-parametreleri yan paneli, Örnekler paneli) iki frekans adı vardır: **Merkez**, sınırların ortalaması (f_lo + f_hi) / 2; **En iyi uyum** ise minimum S11 frekansıdır. Gösterilen bağıl bant genişliği ve Özet'teki Bant genişliği (%), genişliğin bu merkeze bölümüdür; paketteki `fractional_bw`, `f_center` değerine böler. CSV/TSV dışa aktarımları tabloların tanımlarını kullanır: `f_center_GHz` bant ortasıdır, `f_best_GHz` en iyi uyumdur ve dışa aktarılan `fractional_bw` ortaya bölünür ([CSV sütunları ve açık bant bayrakları](EXPORTS.md#matched-band-csv-columns)). Simülasyon aralığının sınırına değen bant bunun ötesine devam eder: açık ucu ≤ veya ≥ ile işaretlenir, genişliği alt sınırdır; örnek seçici tek frekans yerine aralığı gösterir ("≥ 8–12 GHz").
- **Uzak alan.** openEMS, alanları bir yakın alan kutusunda kaydeder ve bant merkezlerinde (veya `--pattern` frekanslarında) NF2FF dönüşümünü uygular. Izgara θ için 0–180° aralığında 3°, φ için 0–360° aralığında 5° adımlıdır; faz merkezi `nf2ff_center` konumundadır. PEC veya PMC sınırlarında openEMS kayıt yüzeyini aynalar ve görüntü bölgesinde de integral alır. Fairbeam bu nedenle Prad değerini 2^m'ye böler, Dmax değerini 2^m ile çarpar; m, PEC/PMC sınır sayısıdır. Böylece yönlülük, örneğin sonsuz toprak düzlemi üzerindeki monopol için fiziksel yarı uzaya aittir.
- **Işıma verimliliği** = Prad / P_acc. P_acc = ½·Re(u·i*), portun kabul ettiği güçtür. Uzak alan frekanslarında; ayrıca `--efficiency [N]` (tasarımda `monitors.efficiency`) ile bant boyunca N frekansta, frekans başına güvenilirlik işaretiyle kaydedilir ([BUNDLE.md](BUNDLE.md#efficiency)). Kayıpsız olarak tanımlanan bir model (`sim.lossless = True`), Prad / P_acc değeri 1'in %5 yakınındayken 1 bildirir ([BUNDLE.md](BUNDLE.md#results)).
- **Kazanç** = verimlilik · Dmax. **Gerçekleşen kazanç** = kazanç · (1 − |S11|²).

## Açılmış faz ve grup gecikmesi

S-parametreleri sonuç görünümünde veya Örnekler yansıma görünümünde veri biçimi
seçicisinden **Açılmış faz** ya da **Grup gecikmesi** seçin. İkisi de seçili karmaşık
S-parametrelerini kullanır; yalnızca genlik içeren referanslar faz sağlayamaz.
Faz derece ve frekans GHz olduğunda `τg = −dφ/df / 360` grup gecikmesini ns cinsinden
verir. **Açıklık** denetimi 3, 5, 11 veya 21 örnek üzerinde yerel en küçük kareler
doğrusal faz uyumunu seçer. Daha geniş açıklık gürültüyü azaltırken dar dispersif
özellikleri de yumuşatır. Uç noktalarda tek taraflı pencere kullanılır; kısa geçerli
bölümde eldeki tüm örnekler (en az iki) kullanılır. Açıklığı değiştirmek açılmış fazı
veya kaydedilmiş sonuçları değiştirmez.

Her özgün frekans ızgarası sonlu, negatif olmayan ve kesin artan değerler içermelidir;
geçersiz ızgaralar sıralanmak veya yinelenen değerleri ayıklanmak yerine reddedilir.
Sıfır karmaşık genlik, sonlu olmayan örnekler ve tam 180° olan belirsiz adım boşluk
bırakır. Ne ara değerleme ne de türev boşluğu aşar. Faz açma her boşluktan sonra
bağımsız başlar; mutlak faz dalı tam turlar kadar belirsizdir. Gözlenen faz sarımı
veya 180° adım uyarısı örtüşmenin kanıtı değildir: gerçek gecikmeyi bulmak, komşu
gerçek faz artışlarının 180° altında olmasını varsayar. Ek tam turlar örneklenmiş
karmaşık veriden ayırt edilemez. Bu varsayım belirsizse frekans örneklemesini sıklaştırın.
Karmaşık genlik sıfır olmasa bile derin yansıma sıfırları yakınında gecikme gürültülü olabilir.

Karşılaştırmalar her çalıştırmanın fazını özgün ızgarasında açar, sürekli fazı ortak
frekans ızgarasına ara değerler ve türevi orada hesaplar. Açıklık bu nedenle her özgün
ızgaranın değil, gösterilen karşılaştırma ızgarasının örneklerini sayar; geçerli bir
karşılaştırma eklemek yumuşatma bant genişliğini değiştirebilir. Çalıştırmanın aralığı
dışına değer üretilmez; geçersiz frekans ızgaraları ve yalnızca genlik içeren
çalıştırmalar ortak ızgaraya nokta eklemez. Veri kopyalama ve CSV, grafikle aynı ızgara,
birimler, açıklık ve gösterim için seyreltilmemiş sayısal değerleri kullanır; eksik
değerler boş hücrelerdir. Örnekler veri tablosu da bu değerleri kullanır (uzun tablolar
gösterim için seyreltilmiş olabilir). Yalnızca genlik içeren referanstan faz isteyen
dışa aktarımlar açıkça reddedilir. Mevcut **Tümü** biçimi genlik, sarılmış faz ve
gerçek/sanal görünümleri olarak kalır. Bunlar yalnızca görüntüleme analizidir;
TDR veya zaman alanı sonuçları eklemez.

## İdeal eşleme tahmini

Tasarımcının tek çalıştırmalı **Empedans** ve **Smith** görünümleri isteğe bağlı ideal
eşleme devresi sunar. Mevcut bir frekans örneğini ve uygun L bölümlerinden birini
(kaynak tarafında seri veya paralel, iki cebirsel işaretten biriyle) seçin. Reaktif
yükler dört çözüme izin verebilir. Değerler nH cinsinden pozitif endüktanslar veya
pF cinsinden pozitif kapasitanslardır; sıfır elemanlar atlanır. Gösterilen sıra
kaynaktan yüke doğrudur. Salt dirençli yük ayrıca `Zt = sqrt(Rload * Zref)` olan
kayıpsız 90 derecelik dönüştürücüye izin verir. Elektriksel uzunluk frekansla doğrusal
değişir; altlık, dispersiyon veya fiziksel hat uzunluğu çıkarılmaz.

Özgün ve ideal eşlenmiş |S11| eğrileri, sabit ideal eleman değerleriyle her frekansta
kaydedilmiş yük empedansını kullanır. Smith ayrıca ideal yansıma eğrisini gösterir.
Bu bir devre varsayımıdır; yeniden simüle edilmiş veya ölçülmüş eşlenmiş anten
**değildir**: kayıplar, parazitler ve yerleşim yoktur. Özgün paket, model ve dışa
aktarılan CSV/Touchstone verileri değişmez. Sonuç veya görünüm değişince tahmin
sıfırlanır. Eşleme mevcut kaydedilmiş referans düzlemini kullanır; besleme hattını
çıkarmaz veya Tasarıma eleman eklemez.

Gerçek referans değişimi veya ideal besleme gecikmesi kaldırma dahil her oturum
port son işlemesi bu tahmini kapatır. Önce **Port son işlemesi** bölümünde
**Özgün sonucu göster** seçilmelidir; eşleme aracı başka bir düzleme sessizce dönmez.
Açılmış faz ve grup gecikmesi grafikleri ile CSV ise etkin işlenmiş matrisi kullanır
ve port son işlemesi köken bilgisini korur.

Yalnızca sabit pozitif gerçek referanslı tek portlu karmaşık veri desteklenir.
Yalnızca genlik içeren referanslar, karmaşık veya frekansa bağlı referanslar, çok portlu
veri ve çalıştırma karşılaştırmasında eşleme kullanılamaz. Eksik veya pasif olmayan
yük örnekleri boşluk olarak kalır. Sentez, bilinmeyen yükü ara değerlemeden veya
kaydedilmiş bant dışına değer üretmeden seçili kaydedilmiş örneği kullanır.
Analitik devre denetimleri denklemleri doğrular; elektromanyetik veya üretim
doğruluğunu kanıtlamaz.

## Doğruluk notları

- openEMS basamaklı (Yee) FDTD mesh kullanır. Eğik ve eğri kenarlar mesh çizgilerine oturur; sıfır kalınlıklı levhalar ızgara düzlemlerine yerleşir. Metal kenarlarında mesh yeterince sık değilse rezonanslar birkaç yüzde kayabilir.
- Bir sayıya güvenmeden önce mesh yakınsamasını kontrol edin. Tasarım dosyasında `fairbeam converge <design.json>` (veya tasarımcıda Simülasyon › Mesh yakınsaması…), dalga boyu başına 15, 20, 30, 40 hücreyle yeniden çalıştırır; rezonans, |S11| ve Dmax oturduğunda durur ([STUDIES.md](STUDIES.md#fairbeam-converge)). Python modelinde `fairbeam converge <model> --param mesh_div=15,20,30` kullanın (Sierpinski için `cell=0.8,0.6,0.45`); bant merkezlerinin toleransınızdan daha az kaydığını doğrulayın. Metal kenarları ve sıfır kalınlıklı levhalardaki mesh, genel hücre boyutundan daha önemlidir: [VALIDATION.md](VALIDATION.md). En küçük hücre tüm bölgenin zaman adımını belirlediğinden çok ince hücrelerden kaçının (`fairbeam.mesh.merge_lines`).
- İletken kaybı: tasarım metalinde `conductivity` (S/m) belirtilmedikçe veya model `sim.metal(..., conductivity=)` kullanmadıkça metaller mükemmel iletkendir. Belirtilirse levhalar verilen kalınlıkta (varsayılan 0,035 mm) openEMS iletken levhaları olur; verimlilik bakır kaybını içerir ([MODELS.md](MODELS.md)).
- Literatür kontrolü, Sierpinski monopol, 3. yineleme, 48 mm: simülasyon bantları 3,303 ve 6,219 GHz'dedir. Puente ve diğerleri (1998), 89 mm'lik yapı ölçmüştür; 48 mm'ye ölçeklendiğinde bantları 3,226 ve 6,508 GHz'e gelir. +%2,4 ve −%4,4 sapmalar, basamaklı mesh, temas köprüleri ve idealleştirilmiş sonsuz toprak dikkate alındığında makuldür.
- Yama anten: yakınsamış rezonans 2,455 GHz'dir (mesh_div 30–40). İletim hattı modeli (`fairbeam.analytic.patch_resonance`: Hammerstad ε_eff ve ΔL), 2,513 GHz verir (-%2,3). Basitleştirilmiş formül sonlu toprak ve sondayı ihmal ettiğinden bu uyum beklenen doğruluk içindedir.
- Yarım dalga dipol: rezonans, kapalı biçimli indüklenmiş EMK rezonansının %1,3–1,4 altındadır; R_in 72–73 Ω, Dmax 2,13–2,15 dBi ve verimlilik 0,999'dur. Tam tablolar, durdurma ölçütü incelemesi ve önerilen ayarlar [VALIDATION.md](VALIDATION.md) sayfasındadır.

[RunHistory tarama CSV'si](STUDIES.md#runhistory-sweep-csv) aynı bant tanımlarını küçük harfli sütun adlarıyla izler: `band_lo_ghz` ve `band_hi_ghz` sınırlar, `band_center_ghz` bunların ortası, `band_best_ghz` ise |S11| minimumunun frekansıdır. Her işin ilk bandını kullanır; sınırlardan biri eksikse merkez boş kalır. RunHistory, minimum frekans sütununu **En iyi uyum** olarak adlandırır.

## Tasarımcıda port son işlemesi

Bir Tasarım sonucunun S-parametreleri, empedans, VSWR, Smith, tablo veya özet sekmesinde
**Port son işlemesi** bölümünü açın. Ortak `R + jX` referansını ohm cinsinden (`R > 0`),
her fiziksel portun kaldırılacak tek yönlü gecikmesini pikosaniye cinsinden girin.
**Bu sonuca uygula** görünümü değiştirir; **Özgün sonucu göster** o yüklenmiş nesneyi
sıfırlar. Ayarlar yalnızca oturumda tutulur; dosyaya, tasarıma veya eniyileyiciye yazılmaz.

Önce özgün referansa uyumlu ideal kayıpsız besleme hattı kaldırılır, sonra tam matris
yeniden normalleştirilir. `exp(+jωt)` için `S'_ij = S_ij exp(+j 2π f (τ_i+τ_j))`;
pozitif gecikme aygıta doğru hat kaldırır, negatif gecikme hat ekler. Yansımaya iki kat
tek yönlü faz uygulanır. Malzeme, uzunluk veya dispersiyon çıkarılmaz; bant boyunca
1.000.000 radyanı aşan faz reddedilir. Tekil veya eksik örnekler sıfırla doldurulmaz.

Karmaşık hedefte Kurokawa güç dalgaları kullanılır:
`Gamma = (Zin - conj(Zref))/(Zin + Zref)` ve
`Zin = Re(Zref)(1+Gamma)/(1-Gamma) - j Im(Zref)`.
Diğer portlar hedef referansla sonlandırılır. Eşlenik uyum sıfır güç yansıması verir;
kısa devrede Gamma genel olarak −1 değildir. Fiziksel VSWR ve standart Smith empedans
ızgarası burada geçerli olmadığından bu görünümler açıklamayla kapatılır. S ve Z ile
CSV örnekleri korunur. Karmaşık referans Touchstone alanıyla kodlanamadığından o dışa
aktarım reddedilir; gerçek referans seçilerek veya CSV kullanılarak ilerlenebilir.

Diferansiyel/ortak mod için `7,19; 2,5` gibi ayrık **fiziksel port** çiftleri girin;
ilk sayı pozitif kutuptur. Kanal sırası tüm diferansiyel, tüm ortak ve eşleşmemiş tek
uçlu kanallardır. Referanslar sırasıyla `2Z`, `Z/2`, `Z`; güç dalgaları
`aD=(ap-an)/sqrt(2)`, `aC=(ap+an)/sqrt(2)` ve aynı biçimde b'dir. Bantlar, empedans,
tablo ve özet açıkça etiketlenmiş ilk diferansiyel çift Sdd11'i kullanır. S/Smith
seçicileri diğer kanalları açar. Farklı referans/düzlem/mod ayarları arasında ağ
ölçütlerinin iyileşme farkları gösterilmez. Özgün fiziksel port ışıması ve güçleri değişmez.

Gerçek referanslı mod verisi `.ts` uzantısıyla Touchstone 2.0 olarak yazılır.
`[Mixed-Mode Order]` özgün tek uçlu matris indislerini, yorumlar fiziksel port eşlemesini
taşır; `[Reference]` tek uçlu dirençleri içerir (`2R` veya `R/2` değil). Bu değişiklik
karma mod içe aktarma desteği eklemez. Özgün veride fazı bilinen tam matris ve sabit
pozitif gerçek referanslar gerekir; yerel karmaşık veya frekansa bağlı/dalga kılavuzu
referansları reddedilir. Geçiş/TRL kalibrasyonu veya dispersif hat modeli uygulanmaz.
Uzak alan, verim, güç, çözücü QA'sı, çalışma listesi ve eniyileyici özgün veride kalır.
Yeni görünümde eski pasiflik/karşılıklılık QA değerleri yeniden ölçülmüş gibi sunulmaz.
Örnekler görüntüleyicisi özgün veriyi gösterir.
