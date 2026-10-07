# Sonuç paketi: `fairbeam.project/1`

Paket, tek simülasyonu tanımlayan JSON dosyasıdır: model ve parametre değerleri, çözücü ayarları, tam geometri, mesh, çalıştırma istatistikleri ve son işlem sonuçları. `Simulation.to_bundle()` (`python/fairbeam/simulation.py`) yazar; görüntüleyici (`src/types.ts` içindeki türlerle) ve VBA makro dışa aktarıcısı (`src/export/cst.ts`) okur.

Dosyalar `public/projects/<slug>.json` konumundadır. Her yazma işlemi `public/projects/index.json` dosyasını da yeniden oluşturur (bkz. [Dizin dosyası](#index-file)).

## Kurallar

| Büyüklük | Birim |
| --- | --- |
| Uzunluklar ve koordinatlar | `units.length` / `units.length_m` ile verilen çizim birimleri. Varsayılan **mm** (`length_m = 0.001`) |
| Frekanslar | Paketin her yerinde **Hz**. Dizin dosyası GHz kullanır |
| Açılar (`theta`, `phi`) | Derece. θ, +z'den; φ, +x'ten +y'ye doğru ölçülür |
| Yönlülük ve kazanç | dBi |
| Güç | W |
| Empedans ve direnç | Ω |
| Zaman | `time_ns` ns, `dt_s` s cinsinden |
| İletkenlik (`kappa`) | S/m |

- Koordinatlar `[x, y, z]` üçlüleridir (`Vec3`). Eksen indisleri `0 = x`, `1 = y`, `2 = z` şeklindedir.
- Sınırlayıcı kutular `[[xmin, ymin, zmin], [xmax, ymax, zmax]]` biçimindedir.
- JSON, `allow_nan=False` ile sıkıştırılmış yazılır; `NaN` veya `Infinity` içermez.
- Dosyalar atomik yazılır: yazıcı `<slug>.json.tmp` oluşturup yeniden adlandırır.
- Yuvarlama: mesh çizgileri 4, geometri 6, S11 5, Zin 3, uzak alan açıları ve yönlülük 2 ondalık basamak.

## Üst düzey

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `schema` | string | Daima `"fairbeam.project/1"`. Okuyucular `fairbeam.project/` önekini kontrol etmelidir |
| `generator` | object | Bkz. [generator](#generator) |
| `created` | string | `%Y-%m-%dT%H:%M:%S%z` biçiminde yerel saat; ör. `2026-09-24T22:24:15+0300` (saat farkında iki nokta yoktur) |
| `name` | string | Görünen ad: model adı ve değiştirilen değerler; ör. `Sierpinski gasket monopole · iterations=3`. `fairbeam geometry`, ` (geometry only)` ekler |
| `model` | object | Bkz. [model](#model) |
| `units` | object | Bkz. [units](#units) |
| `solver` | object | Bkz. [solver](#solver) |
| `parts` | Part[] | Fiziksel yapı. Bkz. [parts](#parts) |
| `ports` | Port[] | Bkz. [ports](#ports) |
| `lumped_elements` | LumpedElement[]? | Port olmayan toplu devre elemanları (ör. yalıtım direnci). Yoksa alan bulunmaz. Bkz. [lumped_elements](#lumped_elements) |
| `half_space` | object \| null | Sınırdan gelen sonsuz PEC toprak. Bkz. [Yarı uzay ve ayna düzlemleri](#half-space-and-mirror-planes) |
| `mesh` | object | Bkz. [mesh](#mesh) |
| `domain` | `{min: Vec3, max: Vec3}` | Simülasyon bölgesi: her eksendeki ilk ve son mesh çizgisi |
| `nf2ff_box` | `{min, max, faces?}` \| null | NF2FF kayıt yüzeyleri olan `DumpBox` yardımcı şekillerinin sınırlayıcı kutusu (Fairbeam'in kendi alan dökümleri, `fairbeam_J_*` yüzey akımları ve `fairbeam_F_*` alan düzlemleri dışarıda bırakılır). Yoksa `null`. Model `add_nf2ff_box(directions=…)` ile yüz atlamışsa (ör. besleme dalga kılavuzunun geçtiği yüz) `faces` bulunur (6 boolean: x-, x+, y-, y+, z-, z+); `false` = kaydedilmedi |
| `nf2ff_center` | Vec3 \| null | NF2FF dönüşümünün faz merkezi. `add_nf2ff_box(center=…)` değeri; yoksa `focus` merkezi, o da yoksa orijin. NF2FF kutusu yoksa `null` |
| `focus` | `{min, max}` \| null | Görüntüleyicinin varsayılan kadraj bölgesi (`Simulation.set_focus`) |
| `run` | object \| null | Çözücü istatistikleri. Yalnızca geometri paketlerinde `null`. Bkz. [run](#run) |
| `results` | object \| null | Son işlem sonuçları. Yalnızca geometri paketlerinde `null`. Bkz. [results](#results) |
| `fields` | object? | İsteğe bağlı yüzey akımı haritaları (`fairbeam run --fields`). Bkz. [fields](#fields) |
| `field_planes` | FieldPlaneMap[]? | Kesit düzlemlerinde isteğe bağlı E/H haritaları (`fairbeam run --field-plane`, tasarımın `monitors.field_planes` alanı). Bkz. [field_planes](#field_planes) |

### generator

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `name` | string | `"fairbeam"` |
| `version` | string | Fairbeam paket sürümü |
| `openems` | string \| null | `openEMS.__version__` |
| `csxcad` | string \| null | Modül sunuyorsa `CSXCAD.__version__` |
| `python` | string | Python sürümü |

### model

Model dosyasının `MODEL` sözlüğü (`id`, `name`, `description`, isteğe bağlı `reference`) nesneye yayılır; ayrıca:

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `params` | Param[] | Tanım sırasıyla her `PARAMS` öğesi için bir kayıt |

Her Param, `dataclasses.asdict(Param)` ve çözülmüş değerden oluşur:

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `key` | string | `--set` ile kullanılan parametre anahtarı |
| `default` | number \| string | Varsayılan değer |
| `value` | number \| string | Bu çalıştırmada kullanılan değer |
| `label` | string | Okunabilir etiket |
| `unit` | string | Görüntüleme birimi; ör. `"mm"`, `"GHz"` veya `""`. Paketin değil modelin kendi birimidir |
| `description` | string | Ayrıntılı açıklama (boş olabilir) |
| `minimum`, `maximum` | number \| null | İzin verilen aralık |

### units

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `length` | string | Çizim birimi 1e-3 m ise `"mm"`; değilse `"<unit> m"` (ör. `"0.0001 m"`) |
| `length_m` | number | Metre cinsinden çizim birimi |
| `frequency` | string | Daima `"Hz"` |

### solver

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `engine` | string | `"openEMS"` |
| `method` | string | `"FDTD (Yee, staircase)"` |
| `excitation` | object | Aşağıya bakın |
| `boundaries` | object | Anahtarlar `x-`, `x+`, `y-`, `y+`, `z-`, `z+`. Değerler openEMS sınır adlarıdır: `"MUR"`, `"PEC"`, `"PMC"`, `"PML_8"`, … |
| `end_criteria_db` | number | dB cinsinden enerji durdurma ölçütü; ör. `-40` |
| `max_timesteps` | number | Zaman adımı sınırı |

`excitation` iki biçimden biridir:

- **Varsayılan** `{"type": "gaussian-derivative", "f_min", "f_max", "expression", "dc_free": true}`. `expression`, openEMS özel uyarımına verilen `t` (saniye) değişkenli fparser formülüdür. Darbenin tepe değeri birimdir; `f_max` değerinde -20 dB'dir.
- **openEMS Gauss** `{"type": "gaussian", "f0", "fc", "f_min", "f_max", "dc_free": false}`; `f0 = (f_min + f_max) / 2`, `fc = (f_max - f_min) / 2`.

## parts

Şekilleriyle birlikte fiziksel CSXCAD özellikleri, ilk görünme sırasındadır. Yardımcı özellikler (`DumpBox`, `ProbeBox`, `Excitation`) ve portların oluşturduğu `LumpedElement` özellikleri dışarıda bırakılır. Portlar `ports` içinde listelenir.

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `name` | string | CSXCAD özellik adı (benzersiz) |
| `label` | string? | `sim.metal(..., label=)` veya `sim.dielectric(..., label=)` ile verilen etiket |
| `type` | string | CSXCAD özellik türü: `"Metal"`, `"Material"`, `"ConductingSheet"`, … |
| `color` | string? | Modelin kaydettiği isteğe bağlı renk |
| `material` | object? | Yalnızca `type == "Material"` için bulunur. Aşağıya bakın |
| `conductor` | object? | Sonlu iletkenlikli metal (tasarım malzemesinin `conductivity` alanı, `sim.metal(..., conductivity=)`): S/m cinsinden `conductivity`; `"ConductingSheet"` (openEMS `AddConductingSheet`) için mm cinsinden modellenmiş levha kalınlığı `thickness`. Hacimde `null`; hacim, aynı iletkenlikte `"Material"` olur ve hâlâ metaldir. Mükemmel iletkende bulunmaz |
| `void` | boolean? | Vakum oyucu (Boolean Çıkar boşluğu) için `true`: içindeki düşük öncelikli malzemeyi siler. Görüntüleyici bunu hayalet görünümde çizmeli veya gizlemelidir; diğer durumlarda bulunmaz. Eski okuyucular sıradan `eps_r` 1 katısı olarak gösterir |
| `primitives` | Primitive[] | Geometri; aşağıya bakın |
| `bbox` | [Vec3, Vec3] | Şekillerin sınırlayıcı kutularının birleşimi |

`material`:

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `eps_r` | number | Bağıl dielektrik sabiti (anizotropikse x bileşeni) |
| `mu_r` | number | Bağıl manyetik geçirgenlik |
| `kappa` | number | S/m cinsinden elektriksel iletkenlik. openEMS dielektrik kaybını sabit iletkenlikle modeller |
| `tan_d` | number \| null | Modelin istediği kayıp tanjantı (özellik doğrudan CSXCAD ile oluşturulduysa `null`) |
| `tan_d_freq` | number \| null | `kappa` değerinin `tan_d` değerini tam verdiği frekans, Hz (`kappa = tan_d · 2π f · ε0 · eps_r`). Varsayılan bant merkezi |
| `isotropic` | boolean | Epsilon veya kappa eksenler arasında farklıysa `false` |
| `dispersion` | object? | **İsteğe bağlı.** Frekansa bağlı dielektrik (`Simulation.dispersive`, `fairbeam.dispersion`). CSXCAD özelliği bu durumda `LorentzMaterial` olur; görüntüleyiciler/dışa aktarıcılar dielektrik olarak işlesin diye `type: "Material"` ile aktarılır. `eps_r`, `mu_r`, `tan_d`, bant merkezi `tan_d_freq` değerleridir. `kappa`, oradaki toplam kaybı veren iletkenliktir (`kappa = tan_d · 2π f · ε0 · eps_r`, sabit malzeme gibi); kaybı iletkenlik olarak okuyan tüketici bant merkezi kaybını korur. Statik iletkenlik `dispersion.kappa` içindedir. Sabit malzemelerde bulunmaz; mevcut paketler değişmez |

`material.dispersion`, simüle edilen modeldir; frekanslar Hz, zamanlar s cinsindendir ve openEMS düzenini (e^{+jωt}) kullanır:

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `model` | string | `"lorentz"`: ε∞·[1 − Σ ωp²/(ω² − ωL² − jω/τ)]; Drude için ωL = 0. openEMS 0.37.0rc3 DebyeMaterial, 3B'de ΣΔε/ε∞ ≈ 0,3 (1B'de 0,6) üstünde ıraksar; Debye kutupları ve laminatlar uydurulmuş Lorentz kutuplarıyla simüle edilir, paket bunları kaydeder. `"debye"` (ε∞ + Σ Δε/(1 + jωτ)) yalnızca `source` içinde veya modelin doğrudan CSXCAD ile oluşturduğu DebyeMaterial için görünür |
| `eps_inf` | number | ε∞ |
| `kappa` | number | Statik iletkenlik, S/m (−jκ/(ωε0) ekler) |
| `eps_poles` | object[] | `{"type": "lorentz", "f_plasma", "f_pole", "tau"}` (`source` içinde ayrıca `{"type": "debye", "delta", "tau"}`) |
| `mu_inf`, `mu_poles` | number, object[] | Manyetik Lorentz/Drude dispersiyonu. Yalnızca μ∞ ≠ 1 veya kutuplar varsa bulunur |
| `source` | object? | Kutupların uydurulduğu model ve uydurma bilgisi. Djordjevic-Sarkar laminatı: `{"model": "djordjevic-sarkar", eps_inf, delta, m1, m2, fit: {f_min, f_max, span}, report: {...}}`. Debye kutupları: istenen Dispersion (`"model": "debye"`, kutupları), `fit` ve `report` ile. Rapor banttaki uydurma hatalarını ve kutupları sınırlayan `dt` zaman adımını tutar |

### Şekiller

Her şekilde şu alanlar vardır:

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `kind` | string | `"box"`, `"polygon"`, `"linpoly"`, `"cylinder"`, `"cylindricalshell"`, `"sphere"`, `"rotpoly"`, `"curve"`, `"wire"`, `"polyhedron"`, `"transformed"` veya `"bbox"` |
| `priority` | number | CSXCAD önceliği. Şekiller çakıştığında yüksek öncelik geçerlidir |
| `bbox` | [Vec3, Vec3] | Sınırlayıcı kutu |
| `exact` | boolean | Şekil tam yeniden üretiliyorsa `true`, sınırlayıcı kutu yaklaşımında `false` |

Diğer alanlar `kind` değerine bağlıdır:

- **`box`**: karşılıklı köşeler `start`, `stop` (Vec3). Bir eksende uzanımı sıfır kutu levhadır; örneğin yama veya toprak düzlemi.
- **`polygon`**: düzlemsel çokgen (sıfır kalınlık).
  - `normal`, normal eksen indisi `n` (0, 1 veya 2).
  - `elevation`, düzlemin `n` eksenindeki koordinatı.
  - `points`, düzlemde `[a, b]` çiftleri listesi.
- **`linpoly`**: `polygon` alanları ve `length`. Çokgen, normal boyunca `elevation` değerinden `elevation + length` değerine uzatılır (`length` negatif olabilir).
- **`cylinder`**: `start`, `stop` (Vec3), eksen uçları; `radius`, yarıçap.
- **`cylindricalshell`**: boru (CSXCAD `CylindricalShell`). `start`, `stop`, `cylinder` ile aynıdır; `radius` duvar ortasının yarıçapı, `shell_width` duvar kalınlığıdır. Boru `radius - shell_width / 2` ile `radius + shell_width / 2` arasındadır.
- **`sphere`**: `center` (Vec3) ve `radius` (CSXCAD `Sphere`).
- **`rotpoly`**: dönel katı (tam tur döndürülen CSXCAD `RotPoly`; tasarımcının konisi ve torusu). `points`, `origin` (Vec3) üzerinden `axis` ekseninde (0, 1 veya 2) geçen doğru çevresinde döndürülen kapalı konturun `[radial, axial]` çiftleridir. Noktanın doğruya uzaklığı ve `origin` çıkarılmış eksen koordinatı kontur içindeyse nokta içeridedir. Radyal değerler negatif olamaz. Dışa aktarıcı `bbox` değerini kendisi hesaplar (CSXCAD dönmeyi yok sayar), eksenden geçen düzlemde tam turlar yazar; ek yerel afin dönüşüm `transformed` sarmalayıcısıyla gösterilir.
- **`curve`**: çoklu çizgi boyunca ince tel (CSXCAD `Curve`). `points`, Vec3 listesidir. Yarıçapı yoktur: openEMS en yakın mesh kenarlarına yerleştirir, etkin yarıçapı hücrenin bir kesridir. Görüntüleyiciler nominal yarıçaplı boru olarak çizer.
- **`wire`**: `radius` içeren aynı yapı (CSXCAD `Wire`), hacim olarak rasterleştirilir.
- **`polyhedron`**: kapalı katı (CSXCAD `Polyhedron`). `vertices`, Vec3 listesi; `faces`, köşe indisi listeleri listesidir (üçgenler; CSXCAD yalnızca üçgen yüzleri doğru rasterleştirir). Fairbeam modellerinde yüzler dışa yöneliktir; okuyucular buna güvenmemelidir.
- **`transformed`**: desteklenen şeklin tam afin örneği. `primitive`, tam yerel şekli; `matrix`, sütun vektörlerini yerelden dünya koordinatlarına eşleyen satır öncelikli 4×4 homojen matrisi; `bbox`, dünya uzayında eksenlere paralel sınırı içerir. Eski okuyucuların yerel koordinatları dünya geometrisi sanmaması için ayrı türdür. Sarmalayıcıyı desteklemeyen okuyucular `bbox` değerini açıkça yaklaşık alternatif olarak kullanmalıdır.
- **`bbox`**: Fairbeam'in tam aktaramadığı CSXCAD şekil türleri için alternatif. `source_kind`, CSXCAD tür adını tutar; şekli yalnızca `bbox` tanımlar. Yerel tür biliniyor ancak tam yerel geometri bilinmiyorsa sınır dünya koordinatlarına dönüştürülür, `transformed: true` ayarlanır.

Sonradan geriye uyumlu eklenenler: `curve`, `wire`, `polyhedron`. Eski okuyucular yeni türleri bilinmeyen sayar ve `bbox` kullanmalıdır. Çizim, çokyüzlüleri dış sınır ve belirgin kenarlarla, telleri çoklu çizgilerle gösterir.

Tasarımcının tam, keyfî açılı dönüşümleriyle geriye uyumlu eklenen: `transformed`. Eski okuyucular sarmalayıcıyı bilinmeyen sayar ve dünya uzayı `bbox` değerini kullanmalıdır. Yerel simülasyon CSXCAD şeklini korur, afin matrisini uygular. Sıfır kalınlıklı metal levhalar çözücü koordinat düzlemlerine paralel kalmalıdır; openEMS teğetsel kaybı yerel CSXCAD sınırlarından seçtiği için kayıplı levhaların yerel normali de korunmalıdır. VBA makro dışa aktarıcısı dönüştürülmüş geometriyi uyarıyla atlar.

Tasarımcının silindir kabuk ve küre şekilleriyle geriye uyumlu eklenenler: `cylindricalshell`, `sphere`. Görüntüleyici, çizim ve VBA makro dışa aktarıcısı (iç yarıçaplı Cylinder, Sphere) tam yeniden oluşturur. Üretim çıktısı, alttaştan dik geçen boruyu dış çapında metalize via olarak işler; küreleri uyarıyla atlar.

Tasarımcının koni ve toruslarıyla geriye uyumlu eklenen: `rotpoly`. Görüntüleyici konturu tam döndürür (torna); çizim eksen yönünden daire, yandan siluet gösterir. VBA makro dışa aktarıcısı uygun konturda Cone (eşit yarıçaplarda Cylinder) veya Torus yazar; diğerlerini uyarıyla atlar. Üretim çıktısı uyarıyla atlar.

**Düzlem içi koordinat düzeni (polygon ve linpoly).** CSXCAD düzenini izler. Normal eksen `n` için:

- Her noktanın ilk koordinatı `(n + 1) % 3` eksenindedir.
- İkinci koordinatı `(n + 2) % 3` eksenindedir.

| normal | `points[i][0]` | `points[i][1]` |
| --- | --- | --- |
| 0 (x) | y | z |
| 1 (y) | z | x |
| 2 (z) | x | y |

y normaline dikkat edin: noktalar `(x, z)` değil `(z, x)` biçimindedir. `[a, b]` noktasının 3B konumu:


```
p[n] = elevation;  p[(n+1)%3] = a;  p[(n+2)%3] = b
```

## ports

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `number` | number | Port numarası. `results.ports` anahtarı olarak da kullanılır (dize) |
| `type` | string | `"lumped"` (openEMS `LumpedPort`) veya `"waveguide"` (openEMS `RectWGPort`) |
| `R` | number | Port (referans) direnci, Ω. Dalga kılavuzu portlarında bant merkezindeki TE dalga empedansı (aşağıya bakın) |
| `direction` | string | `"x"`, `"y"` veya `"z"`: besleme akımı ve gerilimin yönü (dalga kılavuzunda yapıya doğru yayılma yönü) |
| `start`, `stop` | Vec3 | Port kutusu köşeleri. Dalga kılavuzunda kesitin karşılıklı köşeleri; `direction` boyunca uyarım düzlemi `start`, mod probları `stop` konumunda |
| `mode`, `a`, `b`, `f_cutoff` | string, number, number, number | Yalnızca dalga kılavuzu portu: mod (`"TE10"`), çizim biriminde (n+1)%3 eksenindeki geniş duvar `a`, (n+2)%3 eksenindeki dar duvar `b` ve Hz cinsinden mod kesimi |
| `eps_r`, `mu_r` | number? | Yalnızca dolu kılavuz referanslı portlar (Python modelinde `waveguide_port(..., eps_r=, mu_r=)`, aşağıya bakın); hava referansında yok |
| `excite` | boolean | Model tanımına göre port uyarılıyor mu? Çok portlu çalıştırmalar modeli uyarılan port başına yeniden kurar ve bunu değiştirir ([Çok portlu çalıştırmalar](#multi-port-runs)); paket ilk çalıştırmanın kurulumunu kaydeder |
| `group` | object, isteğe bağlı | Yalnızca ayrık portlar: `connection` (`"parallel"` veya `"series"`), `members` (1–15 ek `{start, stop, direction, polarity?}` besleme), isteğe bağlı negatif olmayan tam sayı `priority` (varsayılan 5). Üye polaritesi +1 (varsayılan) veya −1; ana port ilk pozitif beslemedir |

**Gruplu portlar.** Bu ek alan, N fiziksel dirençli beslemeye sahip tek mantıksal portu korur. `R` ve sonuç anahtarı mantıksal moda aittir. İşaretli üye sinyalleri sᵢUᵢ, sᵢIᵢ için Paralel, N·R üye direnciyle U = ΣsᵢUᵢ/N ve I = ΣsᵢIᵢ; Seri, R/N üye direnciyle U = ΣsᵢUᵢ ve I = ΣsᵢIᵢ/N bildirir. Kaynaklar seçilen portun tüm üyelerini işaret ve boşluk uzunluğu normalizasyonuyla uyarır. Mevcut gelen/yansıyan dalga ve S-matrisi alanları bu modal sinyalleri kullanır. Dik modlar modal güce dahil değildir; üyeler dengesizse fiziksel güç toplamı farklı olabilir. `group` yoksa olağan port davranışı korunur. Hatalı gruplar yeniden açılışta üye kaybetmek yerine reddedilir.

**Dalga kılavuzu portları.** Port, analitik alan profiliyle bir TE_mn modunu uyarır; prob düzleminde E ve H'yi mod işlevlerine izdüşürerek mod gerilimi ve akımını ölçer. Referans, frekansa bağlı TE dalga empedansıdır: Z_TE = η0 k / β = η0 / √(1 − (f_c/f)²). Böylece `u_inc`, `u_ref` prob sinyallerini ileri/geri dalgalara ayırır; S11 = u_ref / u_inc yansıyan/gelen mod genliği oranıdır. `results.ports[k].z_ref`, bant merkezindeki Z_TE; `z_ref_f`, frekans başına değeridir. Zaman `signals` alanı yoktur (skaler referans gerektirir). Geri dalganın soğurulması için kılavuzu portun arkasında PML ile sonlandırın (sınırdan geçirin, `auto_mesh(pad=[…, 0, …])`). `python/examples/waveguide_thru.py` uygulamayı kontrol eder (docs/VALIDATION.md bölüm 13). Gerçek, dispersif olmayan ε_r, μ_r ile homojen dolu kılavuzun Python modeli bunları `Simulation.waveguide_port(..., eps_r=, mu_r=)` ile verebilir. Port β = √(k0² ε_r μ_r − k_c²), Z_TE = η0 μ_r k0 / β kullanır; `R`, `f_cutoff`, `z_ref`, `z_ref_f` dolu kılavuza ait olur; port kaydı `eps_r`, `mu_r` içerir (hava referansında ikisi de yoktur). Tasarımlar daima hava referansı kullanır.

**Dalga kılavuzu port gücü.** openEMS mod eşleme probları, kılavuz duvarlarının yanındaki mesh hücresi boyutuna bağlı olarak mod gücünü düşük okur (boyutta birinci derece: horn WR-90 beslemesinde 20 hücre/λ için %4,3; 30 için %8,6; tüm frekanslarda aynı). Şablon tam düğüm alanlarına göre normalize edilir ancak PEC duvar düğümü hava alanının yarısını taşır. `Simulation.evaluate`, eksikliği mesh çizgilerinden hesaplar (`fairbeam.wgport`, Yee ızgarasındaki ideal moda uygulanan prob izdüşümü); port U ve I değerlerini katsayının kareköküyle çarpar. Böylece `pacc_w`, gelen/yansıyan güç ve verimlilik mod gücüne aittir. S11, Z_in ve S-parametreleri (oranlar) değişmez; ancak çok portlu çalıştırmada farklı duvar hücrelerine sahip portların genlikleri kendi katsayılarını taşır. Katsayı `results.ports[k].probe_power_factor` içinde saklanır; `sim.wg_probe_correction = False` kapatır. TE10 için kılavuzdan geçen tam akıyla doğrulanmıştır; prob kutusu kapalı kılavuz tanımlamıyorsa (katsayı 0,9–1,3 dışında) uygulanmaz.

**Ortak duvarlı kılavuzlar.** İki kılavuz yalnızca sıfır kalınlıklı PEC levhayla ayrılıyorsa (ör. dal kılavuzlu kuplör) levhadaki prob düğümleri iki kılavuzun alanlarını enterpole eder; komşu kılavuz portun U ve I değerlerine sızar. `fairbeam.wgport.inset_mode_probes(port, cells=1)` (isteğe bağlı, Kartezyen mesh'te dikdörtgen TE10 portlar), yalnızca E/H prob kutularını iki geniş duvardan `cells` mesh aralığı içeri taşır. Uyarım, mod orijini, port köşeleri ve ölçüm düzlemi yerinde kalır; yukarıdaki güç katsayısı içeri alınmış problar için hesaplanır (TE10, b boyunca düzgündür). Mesh son hâlini aldıktan sonra S-matrisinin her portunda çağırın. Kullanılmazsa problar önceki gibi tüm kılavuzu kapsar.

## lumped_elements

`Simulation.lumped_element(...)` ve kısayolları `lumped_resistor(...)`, `lumped_inductor(...)`, `lumped_capacitor(...)` yazar (Tasarım dirençleri/RLC yükleri aynı çağrıyı kullanır). Eleman, `start`..`stop` kutusuna yayılmış, akımı `direction` boyunca olan openEMS `LumpedElement` öğesidir. Katı değildir (`parts` dışında tutulur), port da değildir.

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `name` | string | CSXCAD özellik adı |
| `label` | string | Görünen etiket |
| `type` | string | `"resistor"` (yalnızca R) veya `"rlc"` (tek L/C dahil L veya C içeren her eleman) |
| `R`, `L`, `C` | number? | Ω cinsinden direnç, H cinsinden endüktans, F cinsinden kapasitans; yalnızca verilen kollar bulunur |
| `topology` | string | `"parallel"` (yerel LEtype 0) veya `"series"` (LEtype 1); `lumped_resistor`, `lumped_inductor`, `lumped_capacitor`, `"parallel"` yazar |
| `direction` | string | `"x"`, `"y"` veya `"z"` |
| `start`, `stop` | Vec3 | Kutu köşeleri (genellikle boşluğu köprüleyen levha) |

Birleşik yerel seri eleman ideal devre kontrolünü geçmemiştir ([rf-rlc-workflows](benchmarks/rf-rlc-workflows/README.md)). Alternatif olarak ayrı `lumped_inductor` ve `lumped_capacitor` geometrik olarak seri bağlanarak seri LC oluşturulabilir.

## Yarı uzay ve ayna düzlemleri

**`half_space`.** `z-` sınırı PEC olduğunda paket şunu içerir:


```json
{"axis": "z", "side": "min", "position": <first z mesh line>, "kind": "PEC"}
```

Fiziksel problem, **sonsuz** PEC toprak düzlemi üzerindeki `z ≥ position` yarı uzayıdır (görüntü teorisi). Toprak, `parts` içinde katı değildir. Görüntüleyici toprak düzlemi olarak çizer. Toprağın altındaki yönler fiziksel olarak bulunmadığından uzak alan yüzeyi ve kutupsal kesitler yalnızca θ ≤ 90° gösterir. Diğer sınır düzenlerinde `half_space`, `null` olur. Burada şu anda yalnızca `z-` PEC durumu kodlanır.

**`mirror_planes`** (uzak alan kaydı başına), herhangi bir yüzdeki PEC veya PMC sınırlarının sayısıdır. openEMS bu sınırlarda NF2FF kayıt yüzeyini aynalar ve görüntünün de integralini alır. Ham `Prad` tüm görüntü uzayını kapsar; bundan türetilen `Dmax` aynı katsayı kadar düşük olur. Fairbeam ikisini `2^mirror_planes` ile düzeltir:


```
prad_w   = Prad_openEMS / 2^m
Dmax     = Dmax_openEMS · 2^m
```

Böylece yönlülük, verimlilik ve kazanç fiziksel yarı uzaya (m = 2 ise çeyrek uzaya vb.) aittir.

## mesh

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `x`, `y`, `z` | number[] | Çizim biriminde sıralı mesh çizgisi koordinatları |
| `cells` | [nx, ny, nz] | Eksen başına hücreler (çizgi sayısı − 1) |
| `total_cells` | number | nx · ny · nz |
| `min_cell`, `max_cell` | number | Tüm eksenlerde en küçük/en büyük hücre genişliği. En küçük hücre FDTD zaman adımını belirler |
| `auto` | object? | Model `Simulation.auto_mesh()` kullandıysa bulunur: ayarlar ve rapor (hücreler, min/max hücre, komşu oranı, zaman adımı/bellek tahminleri, uyarılar). [MESHING.md](MESHING.md#report) |

## run

openEMS'in yakalanan stdout/stderr çıktısından ayrıştırılan istatistikler. Model simüle edilmediyse `null`. Günlükte karşılığı bulunmayan `?` işaretli alanlar bulunmaz.

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `grid` | Vec3? | openEMS'in bildirdiği FDTD ızgara boyutu |
| `timesteps` | number? | Çalıştırılan zaman adımı sayısı |
| `solver_time_s` | number? | openEMS'in bildirdiği çözücü süresi, s |
| `timestep_s` | number? | openEMS'in bildirdiği FDTD zaman adımı, s |
| `excitation_timesteps` | number? | Özel (Gauss türevi) uyarım darbesinin sürdüğü zaman adımları: darbe bitmeden çalıştırma yakınsayamaz |
| `wall_time_s` | number | Kurulum dahil `Simulation.run` duvar saati süresi |
| `speed_mcells_s` | number? | MCells/s cinsinden işlem hızı |
| `energy_trace` | `{timestep, db}[]` | Çalıştırmada yazdırılan, maksimumuna göre alan enerjisi; dB (≤ 0) |
| `final_energy_db` | number? | `energy_trace` son değeri, örnek son enerjiyi temsil ediyorsa (son zaman adımında kaydedilmiş, ölçütte/altında veya çalıştırma zaman adımı sınırına ulaşmış) |
| `final_energy_bound_db` | number? | Son enerji satırı (varsa) durmadan önceye ait olan yakınsamış çalıştırmada `final_energy_db` yerine bulunur: openEMS yaklaşık 4 s duvar saati aralığında (GPU birkaç bin zaman adımında) yazar; `max_timesteps` öncesinde durma, enerjinin ölçüte ulaşması nedeniyledir. Son enerji en fazla bu değer, yani ölçüttür. Bu durum desteklenmeden önceki paketler eski örneği `final_energy_db` olarak taşıyabilir; görüntüleyici bunu tanır (`energy_trace`, `timesteps` öncesinde ve ölçüt üstünde biter) |
| `hit_timestep_limit` | boolean | `timesteps ≥ max_timesteps` (veya openEMS sınır uyarısı yazdırdı; bunu yalnızca kendi Gauss uyarımında yapar) |
| `converged` | boolean | `timesteps < max_timesteps`: çalıştırma yalnızca enerji ölçütüyle erken durabilir |
| `threads` | number | İstenen iş parçacığı sayısı (0 = tüm çekirdekler) |
| `engine`, `engine_requested` | `"cpu"` \| `"gpu"` | Çalışan ve istenen motor (`--engine`). openEMS derlemesinde GPU yoksa farklıdır. CPU kullanan eski paketlerde bulunmaz |
| `engine_warning` | string? | GPU istendiği hâlde CPU kullanıldıysa bulunur |
| `exact_endcriteria` | boolean? | Durdurma ölçütü yaklaşık 4 s duvar saati (`--no-exact`) yerine her Nyquist döneminde (varsayılan) denetlendi mi? |
| `host` | `{os, machine, cpu}` | Platform bilgisi. `cpu`, `null` olabilir |
| `log_tail` | string[] | openEMS günlüğünün son 12 satırı |
| `port_runs` | PortRun[]? | Yalnızca çok portlu çalıştırmalar: uyarılan port başına `{port, timesteps, solver_time_s, wall_time_s, final_energy_db, converged, engine}` (ayarlanmışsa `final_energy_bound_db` de). Diğer `run` alanları ilk çalıştırmayı tanımlar; `converged` yalnızca hepsi yakınsamışsa true olur |
| `wall_time_total_s` | number? | Çok portlu simülasyonun tüm çalıştırmalarının duvar saati süresi, s |
| `efficiency_time_s` | number? | Bant boyunca verimlilik son işlem süresi (ilk çalıştırma), s. Yalnızca `results.efficiency` ile bulunur |

## results

Model simüle edilmediyse `null`.

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `frequency` | number[] | `f_min`–`f_max` arasında doğrusal `--points` frekans (varsayılan 801), Hz |
| `ports` | object | Dize port numarasıyla (`"1"`) anahtarlanır. Aşağıya bakın |
| `bands` | Band[] | Uyarılan portun uyumlu bantları |
| `farfield` | FarField[] | Örüntü frekansı başına kayıt |
| `signals` | object | Uyarılan portun zaman sinyalleri veya `{}` |
| `sparams` | object? | N portlu S-matrisi. Bkz. [sparams](#sparams) |
| `element_patterns` | object? | Çok portlu antenlerin karmaşık gömülü eleman örüntüleri. Bkz. [element_patterns](#element_patterns) |
| `efficiency` | EfficiencySweep[]? | Bant boyunca ışıma verimliliği (`fairbeam run --efficiency`, tasarımın `monitors.efficiency` alanı). Bkz. [efficiency](#efficiency) |

Hiçbir port uyarılmıyorsa `bands` ve `farfield` boş, `signals` ise `{}` olur. Çok portlu çalıştırmalarda `ports`, `bands` ve `signals` ilk uyarılan porta aittir. `ports` yalnızca uyarılan portları içerir; her biri kendi uyarıldığı çalıştırmadaki yansımasını taşır.

**`ports[k]`.** Tüm diziler `frequency` ile hizalıdır.

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `s11_re`, `s11_im` | number[] | Yansıma katsayısı `u_ref / u_inc` (karmaşık, doğrusal) |
| `zin_re`, `zin_im` | number[] | Giriş empedansı `u_tot / i_tot`, Ω |
| `z_ref` | number | Referans empedansı, Ω (dalga kılavuzunda bant merkezi Z_TE) |
| `z_ref_f` | number[]? | Yalnızca dalga kılavuzu: S11'in referans aldığı frekansa bağlı empedans, Ω |
| `probe_power_factor` | number? | Yalnızca dalga kılavuzu: portun gelen, yansıyan ve kabul edilen gücüne uygulanan katsayı ([Dalga kılavuzu port gücü](#ports)); uygulanmadıysa bulunmaz |

**Band.** Bant, 20·log10|S11| < -10 dB olan ardışık frekans örnekleridir.

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `f_lo`, `f_hi` | number | Eşik altındaki ilk/son örnek, Hz |
| `f_center` | number | Bant içindeki minimum S11 frekansı, Hz. Uygulama "En iyi uyum" olarak gösterir; bant "Merkez" değeri (f_lo + f_hi) / 2'dir ([RESULTS.md](RESULTS.md)) |
| `s11_min_db` | number | Minimum S11, dB |
| `fractional_bw` | number | `(f_hi − f_lo) / f_center` |
| `edge_lo`, `edge_hi` | boolean | Bant simülasyon aralığının başına/sonuna değer; gerçek sınırı aralık dışındadır |

JSON bant alanları özgün anlamlarını korur. [CSV dışa aktarımında](EXPORTS.md#matched-band-csv-columns) `f_center_GHz` sınırların ortasıdır, `f_best_GHz` JSON'daki `f_center` değeridir ve `fractional_bw` ortaya bölünür; `edge_lo` ve `edge_hi` açık uç bayraklarını korur.

**FarField.** Örüntü frekansları, bantların `f_center` değerleri, yani her banttaki minimum S11 frekanslarıdır (en fazla 4). Bant yoksa minimum S11 frekansı kullanılır. Model kendisi seçebilir (`sim.pattern_freqs`; ör. geniş bantlı horn için bant kenarları ve merkezi). `--pattern` hepsinin yerine geçer.

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `f` | number | Frekans, Hz |
| `theta` | number[] | Derece cinsinden θ: 0–180, 3° adım (61 değer) |
| `phi` | number[] | Derece cinsinden φ: 0–355, 5° adım (72 değer; 360 tekrarlanmaz) |
| `directivity_dbi` | number[][] | dBi cinsinden yönlülük, **`[theta][phi]`** indisli (`len(theta) × len(phi)`). Alt sınır `dmax_dbi − 60` |
| `dmax_dbi` | number | Maksimum yönlülük, dBi, ayna düzeltmeli |
| `dmax_pattern_dbi` | number? | Yalnızca örüntüden maksimum yönlülük: θ/φ ızgarasında `4π·U_max / ∮U dΩ`, ayna düzeltmeli. openEMS `dmax_dbi`, NF2FF kutusundan geçen güce böler. İkisi yaklaşık 0,1 dB içinde uyuşmalıdır; daha büyük fark sınır yansımalarını (MUR çok yakın) veya kaba NF2FF yüzeyini düşündürür. Eski paketlerde yok |
| `prad_w` | number | Işınan güç, W, ayna düzeltmeli |
| `pacc_w` | number | Portta kabul edilen güç: `f` frekansında enterpole edilmiş `½·Re(u·i*)`, W |
| `rad_efficiency` | number \| null | `prad_w / pacc_w`. `pacc_w ≤ 0` ise `null`. Pasif antende 1 üstü fiziksel değildir (iki güç bağımsız sayısal ölçümlerdir); değer korunur ve `qa_warnings` içinde işaretlenir. Kayıpsız modelde (aşağıya bakın), `prad_w / pacc_w`, 1'in %5 yakınındayken 1 |
| `rad_efficiency_raw` | number \| null? | Yalnızca kayıpsız modeller: benzetilen `prad_w / pacc_w`, iki sayısal ölçümün güç dengesi |
| `qa_warnings` | string[]? | Kayıt için dışa aktarıcı kalite kontrol notları; ör. %100 üstü ışıma verimliliği (kazanç Dmax'ı aynı katsayıyla aşar) veya kayıpsız modelin güç dengesi |
| `gain_dbi` | number? | `10·log10(efficiency · Dmax)`. Yalnızca verimlilik > 0 ise |
| `realized_gain_dbi` | number? | `10·log10(efficiency · Dmax · (1 − \|S11\|²))`. Yalnızca verimlilik > 0 ise |
| `mirror_planes` | number | Düzeltmede kullanılan PEC/PMC sınır sayısı. Yukarıya bakın |
| `port` | number? | Bu kayıt için uyarılan port (çok port desteğinden sonraki paketler). Çok portlu çalıştırmalarda her uyarılan port/örüntü frekansı için kayıt, hepsi aynı frekanslarda |
| `cp` | object? | `sim.cp_outputs = True` modellerinde dairesel polarizasyon. Aşağıya bakın |

**cp.** IEEE düzeni ve openEMS'in e^{jωt} fazörleriyle, uzak alanın sağ/sol dairesel bileşenleri E_R = (E_θ + jE_φ)/√2 ve E_L = (E_θ − jE_φ)/√2'dir (+z yönlü dalgada RHCP, x'ten y'ye döner). Izgaralar `directivity_dbi` gibi `[theta][phi]` indislenir.

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `rhcp_dbi`, `lhcp_dbi` | number[][] | dBi cinsinden kısmi yönlülükler D·\|E_R\|²/\|E\|² ve D·\|E_L\|²/\|E\|² (doğrusal toplamları `directivity_dbi`); alt sınır `dmax_dbi − 60` |
| `axial_ratio_db` | number[][] | Eksenel oran (\|E_R\| + \|E_L\|) / \|\|E_R\| − \|E_L\|\|, dB: 0 = dairesel, üst sınır 60 dB (doğrusal polarizasyon) |
| `peak` | object | Yönlülük maksimumunda `{theta, phi, rhcp_dbi, lhcp_dbi, axial_ratio_db}` |
| `boresight` | object | θ = 0'da `{theta: 0, rhcp_dbi, lhcp_dbi, axial_ratio_db}` |

Örüntü CSV çıktısı `rhcp_dBi`, `lhcp_dBi`, `axial_ratio_dB` sütunlarını; uzak alan CSV'si ana eksen değerlerini ekler.

`prad_w` ve `pacc_w`, birim genlikli uyarım için mutlak değerlerdir. Genellikle çok küçüktürler; yalnızca oranları anlamlıdır.

**Kayıpsız modeller.** Hiç kayıp mekanizması olmayan model (PEC metaller, kayıpsız malzemeler, direnç yok) kabul ettiği gücün tamamını ışır; ışıma verimliliği 1'dir. `prad_w / pacc_w` yalnızca iki sayısal gücün uyumunu ölçer. Python modeli bunu `sim.lossless = True` ile bildirir (piramidal horn böyle yapar). `evaluate()` iddiayı kontrol eder (kayıplı malzeme/direnç varsa uyarıyla geçersiz kılar); benzetilen oran 1'in %5 yakınındayken `rad_efficiency` 1, kazanç = yönlülük bildirir, ölçümü `rad_efficiency_raw` ve notta saklar. %5 dışında benzetilen değer uyarıyla bildirilir. `prad_w`, `pacc_w` asla değiştirilmez. Horn, cpw 20'de Prad / Pacc 1,037, cpw 30'da 1,08 vermiştir. Sebep NF2FF kutusu değildir: besleme kılavuzu, beş yüzlü kutu ve horn kesit düzlemlerinden geçen tam Poynting akısı (Yee ızgarasında ham E/H) %0,1–0,4 içinde uyuşurken dalga kılavuzu mod eşleme probları gücü %4,3 (cpw 20), %8,6 (cpw 30) düşük okumuştur. Önceki "besleme akısına göre kutu +%2,4 / +%5,8" sonucu, metal duvarlarda aynı eksikliğe sahip düğüm enterpolasyonlu akıyla karşılaştırmaydı. `Simulation.evaluate` artık dalga kılavuzu portunu kalibre eder (`probe_power_factor`); horn Prad / Pacc değeri cpw 20'de 0,992–0,995, cpw 30'da 0,995–0,998'dir. Yukarıdaki %5 kuralı koruyucu olarak kalır. Tanı sırasında mesh hatası da bulunmuştur: CSXCAD'in tek hassasiyetle sakladığı çokyüzlü köşeleri, 5,08 duvarı yerine y = 5,0799999 konumuna mesh çizgisi koymuştur; üzerindeki kenarlar metal olmamış, kılavuz bir hücre fazla yükselmiştir (kılavuzda E_z, E_y'nin %6'sı; fairbeam.automesh artık bu koordinatları geri oturtur).

### efficiency

**EfficiencySweep.** İsteğe bağlıdır (istenmezse bulunmaz): frekansa bağlı 1B ışıma verimliliği sonucu. NF2FF kutusu zaman alanı dökümleri kaydeder; çalıştırma sonrası openEMS bunları `f_min`–`f_max` arasında eşit aralıklı `N` frekansta dönüştürür (varsayılan 21, aralık 3–201). Yalnızca güçler tutulur, örüntüler tutulmaz. Uyarılan port başına bir kayıt; `port`, `farfield[].port` ile aynı şekilde ayarlanır (tek portlu çalıştırmada tek kayıt).

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `port` | number? | Uyarılan port |
| `f` | number[] | Frekanslar, Hz; `linspace(f_min, f_max, N)` |
| `prad_w` | number[] | Işınan güç, W; `farfield` gibi ayna düzeltmeli (2^`mirror_planes` değerine bölünür) |
| `pacc_w` | number[] | Portta kabul edilen güç, her `f` değerinde enterpole edilmiş `½·Re(u·i*)`, W |
| `rad_efficiency` | (number \| null)[] | `prad_w / pacc_w`, 4 ondalık; `pacc_w ≤ 0` ise `null`. 1 üstü değerler `farfield` gibi korunur; kayıpsız model aynı %5 aralığında 1 bildirir |
| `rad_efficiency_raw` | (number \| null)[]? | Yalnızca kayıpsız modeller: benzetilen `prad_w / pacc_w` |
| `pacc_error` | (number \| null)[]? | Çalıştırmanın durma noktasından kaynaklanan tahmini `pacc_w` göreli hatası (aşağıda). `pacc_w ≤ 0` ise `null` |
| `reliable` | boolean[]? | `pacc_error` 0,1'i (%10) aşarsa veya `pacc_w ≤ 0` ise `false`: değer korunur ancak güvenilir değildir. Görüntüleyici bunları eğriden çıkarır, işaretli nokta olarak çizer. Eski paketlerde yoktur (tüm değerler güvenilir sayılır) |
| `mirror_planes` | number | Düzeltmede kullanılan PEC/PMC sınırları |
| `theta_step`, `phi_step` | number | Dönüşümün açısal ızgarası, derece (90 ve 180: θ 0/90/180, φ 0/180). openEMS Prad, NF2FF kutusu yüzeyinden geçen Poynting akısıdır; bu ızgaraya bağlı değildir (yama örneğinde 3°/5° ile 90°/180° arasında, ayrıca yama şablonunun bandındaki 11 frekansta bit düzeyinde aynı). Bu nedenle en kaba ızgara kullanılır; yalnızca maliyeti belirler |
| `qa_warnings` | string[]? | Özet notları: güvenilmez frekanslar ve güvenilir olduğu hâlde verimliliği 1'i aşanlar |

Toplam verimlilik `rad_efficiency · (1 − |S11|²)` olur; S11, `ports[port]` içinden `f` frekansında (`frequency` üzerinde enterpolasyonla) alınır. Örüntü frekansında taramanın Prad değeri `farfield[].prad_w` ile aynıdır.

**Güvenilirlik.** Uyumdan uzak frekanslarda port gelen gücün neredeyse tamamını yansıtır; `pacc_w` = P_inc (1 − |S11|²), iki büyük sayının küçük farkıdır. Durdurma ölçütünde durmak port sinyallerinin sönüm kuyruğunu keser; her frekansta yaklaşık aynı mutlak büyüklükte hata bırakır. Küçük `pacc_w` değerine göre bu hata büyüktür; oran zikzak yapar. `pacc_error`, uyarım darbesi sonrasındaki sönümün son onda biri DFT dışında bırakıldığında ½·Re(U·I*) değişimini hesaplayarak tahmin eder. Sinyaller sönerken kaydedilmeyen bölüm bu mertebede veya daha küçüktür. Yama şablonunda ölçüm (11 frekans, 1,47–3,19 GHz, GPU):

| Durdurma ölçütü | Bant boyunca ışıma verimliliği | Güvenilir |
| --- | --- | --- |
| −50 dB | 15, 33, 44, 52, 68, 62, 69, 61, **85, 53, 69** % | 11'den 7'si (son 4 değil) |
| −60 dB | 17, 32, 46, 56, 63, 66, 68, 70, **71, 70, 68** % | 11'den 8'i |
| −70 dB | 17, 31, 44, 55, 61, 66, 67, 66, 67, 65, 63 % | 11'in tamamı |

Üç çalıştırma arasında Prad en fazla birkaç yüzde, `pacc_w` rezonans üstünde %33'e kadar değişmiştir (burada 1 − |S11|², %3–4'tür; uyarım spektrumu en zayıftır). −50 dB'de tahmin %2–51, gerçek %0,4–24; −60 dB'de tahmin %0,2–20, gerçek %0,1–7'dir (gerçek değer −70 dB çalıştırmasına göre). Böylece tahmin güvenli tarafta kalır. Sebep NF2FF açısal ızgarası (90°/180° ve 5°/10° aynı Prad) veya döküm örneklemesi değildir (port probları gibi her Nyquist/4 = 37 zaman adımında; `f_max` değerinde dönem başına 8 örnek). Prad'ın kesilme hatası (birkaç yüzde) dahil değildir.

**signals.** Sabit adımla seyreltilerek en fazla yaklaşık 1500 noktaya indirilen port zaman sinyalleri.

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `time_ns` | number[] | Zaman, ns |
| `u_inc`, `u_ref`, `u_tot` | number[] | Gelen, yansıyan ve toplam port gerilimi, V |
| `i_tot_scaled` | number[] | Gerilim eksenini paylaşması için `z_ref` ile çarpılmış toplam port akımı, V |
| `dt_s` | number \| null | **Özgün** (seyreltilmemiş) sinyalin zaman adımı, s |
| `samples` | number | Özgün sinyalin örnek sayısı |

## Çok portlu çalıştırmalar

`fairbeam run` (ve `sweep`/`converge`), `fairbeam.simulation.excite_only(n)` içinde uyarılan port başına modeli bir kez kurar. O çalıştırma n portunu uyarır; diğerleri yerinde, dirençleriyle sonlandırılmış kalır. Varsayılan: dört porta kadar tüm portlar, diğerlerinde port 1. `--excite all|1,3` ile değiştirin. Tek portlu model önceki gibi çalışır; paketine ayrıca 1 × 1 `sparams` eklenir.

### sparams

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `ports` | number[] | Matris sırasıyla (model port sırası) 1..N indisleri |
| `z_ref` | number[] | Her portun referans empedansı, Ω (ayrık port direnci) |
| `excited` | number[] | Uyarılan portların indisleri; bilinen sütunlar |
| `complete` | boolean | Her port uyarılmıştır; tam matris bilinir |
| `method` | string | `"B A^-1"` (tam) veya `"b_i / a_j"` (kısmi) |
| `s` | object | `"i,j"` anahtarları = S_ij: j portuna giren dalga başına i portundan çıkan dalga. Her değer, `frequency` ile hizalı, 5 ondalığa yuvarlanmış `{re: number[], im: number[]}`. Yalnızca `excited` içindeki j sütunları bulunur |
| `qa` | object | Aşağıya bakın |
| `port_numbers` | number[]? | Yalnızca modelin port numaraları 1..N değilse bulunur; k indisi `port_numbers[k-1]` portuna karşılık gelir |

**Tanım.** Gerçek referansı Z_i olan i portunda U_i ve I_i, frekans alanı port gerilimi ve akımıdır (akım yapıya doğru). Güç dalgaları `a_i = (U_i + Z_i I_i) / (2 sqrt(Z_i))`, `b_i = (U_i − Z_i I_i) / (2 sqrt(Z_i))` olur; openEMS'in `uf_inc` ve `uf_ref` değerlerinin sqrt(Z_i)'ye bölümüdür. j portunu uyaran çalıştırmanın dalgaları A ve B matrislerinin j sütunu olduğunda her frekansta tam matris `S = B A^-1` olur. Sonlandırılmış FDTD portunda küçük, sıfır olmayan gelen dalga olsa da bu tanım tamdır. Kısmi uyarımda bilinen sütunlar `S_ij = b_i / a_j` olur. Z_i değerleri eşitse olağan S-parametreleridir; değilse her portun kendi Z_i değerine referanslı güç dalgası S-parametreleridir. Uyarılan her k portunda `results.ports[k].s11_*`, `S_kk` değerine eşittir.

**`qa`.**

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `reciprocity_max` | number \| null | Frekanslar/çiftler boyunca maksimum \|S_ij − S_ji\| (iki sütun da biliniyor), doğrusal. FDTD tipik olarak 1e-4..1e-2 verir |
| `reciprocity_pairs` | object | Çift başına aynı değer; i < j olacak şekilde `"i,j"` anahtarları |
| `column_power_max`, `column_power_min` | object | Uyarılan j portu başına (`"j"` anahtarı): frekans boyunca Σ_i \|S_ij\|² maksimum/minimumu. 1 − sütun gücü, kaybolan veya ışınan paydır |
| `passivity_max` | number \| null | En büyük sütun gücü. Pasif yapıda ≤ 1 olmalıdır |
| `passive` | boolean | `passivity_max ≤ 1 + passive_tol` |
| `passive_tol` | number | Tolerans, 0,01 |

### element_patterns

Antenlerde (NF2FF kutulu modeller), birden fazla port uyarıldığında veya `--element-patterns on` verildiğinde bulunur. Diğer tüm portlar sonlandırılmışken her uyarılan portun birim gelen dalga başına karmaşık uzak alanını tutar; karşılıklı kuplaj dahildir. Birleştirme için [ARRAYS.md](ARRAYS.md) sayfasına bakın.

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `normalization` | string | Okunabilir normalizasyon notu |
| `radius_m` | number | Kayıtlı E değerlerinin uzak alan yarıçapı, m (1) |
| `encoding` | string | `"i16le-base64-scaled"` (bu değişiklikten beri yazılır) veya `"f32le-base64"` (eski paketler). Okuyucular ikisini de kabul eder; bkz. [Kodlamalar](#element-pattern-encodings) |
| `shape` | [number, number] | `[n_theta, n_phi]` |
| `theta`, `phi` | number[] | Derece cinsinden ızgara (uzak alan ızgarası, seyreltilmiş olabilir) |
| `frequencies` | number[] | Hz cinsinden frekanslar; uzak alan kayıtlarıyla aynı |
| `decimation` | number | Açısal seyreltme katsayısı (1 = tam uzak alan ızgarası). θ = 180° daima korunur |
| `mirror_planes` | number | PEC/PMC sınırları. Alanlar görüntü uzayını kapsar; küre integrallerini 2^m'ye bölün |
| `phase_center` | Vec3 | Tüm portların ortak faz merkezi (çizim birimleri) |
| `ports` | object[] | Uyarılan port başına `{port, position, fields}`. `position`, yönlendirmede eleman konumu olarak kullanılan port merkezi (çizim birimleri). `fields`, frekans başına `{f, scale, e_theta_re, e_theta_im, e_phi_re, e_phi_im}` (`scale` yalnızca `"i16le-base64-scaled"` ile) |

Birimler: a = U_inc / sqrt(Z_ref) = 1 sqrt(W) gelen güç dalgası için `radius_m` uzaklıkta E, V/m (tepe fazörü). Işıma şiddeti `U = r² (|E_θ|² + |E_φ|²) / (2 η0)`, gelen güç `½ |a|²`. w_j ağırlıkları için dizi alanı `Σ w_j E_j`.

#### Eleman örüntüsü kodlamaları

`e_theta_re`, `e_theta_im`, `e_phi_re`, `e_phi_im` alanlarının her biri, satır öncelikli `[theta][phi]` düzeninde n_θ · n_φ little-endian değerden oluşan base64 dizesidir.

- `"i16le-base64-scaled"` (yazıcının varsayılanı, `python/fairbeam/multiport.py`): işaretli int16 q = round(v / `scale` · 32767), v = q · `scale` / 32767. `scale`, her `fields` kaydındaki sayıdır: o kaydın dört dizisindeki en büyük |değer| (port/frekans başına tek ölçek; E_θ ve E_φ paylaşır; `scale` 0 tüm değerlerin sıfır olduğunu belirtir). Nicemleme adımı tepe bileşenin 1/32767'si, yaklaşık −90 dB'dir. 2×1 ve 4×1 yama dizilerinde düzgün, yönlendirilmiş (0°, 30°, 60°) ve genliği kademeli ağırlıklarda, D > Dmax − 50 dB bölgesindeki sentezlenmiş yönlülüğü en fazla 0,01 dB değiştirir; hüzme yönü aynı kalır, HPBW farkı 0,003° içindedir.
- `"f32le-base64"` (önce yazılan paketler): float32, `scale` yoktur. İki kat boyut; float32 gürültüsü çok az sıkışır, bu yüzden gzip iki biçimde de neredeyse kazanç sağlamaz.

Görüntüleyici (`src/lib/sparams.ts`) ve `fairbeam.array` ikisini de okur. Sonlu olmayan uzak alanlar `"f32le-base64"` olarak yazılır. `fairbeam.multiport.reencode_element_patterns(bundle)`, eski paketi başka alanına dokunmadan yerinde dönüştürür.

## fields

İsteğe bağlı; yalnızca `fairbeam run --fields` çalıştırmalarında bulunur (`python/fairbeam/fields.py`). Sıfır kalınlıklı metal içeren her düzlemde (kutu levhası veya çokgen; en fazla 4 düzlem, küçükten başlayarak) openEMS tam levhanın mesh düzleminde frekans alanı **rot(H)** dökümü kaydeder. PEC levhada düzlem içi bileşenler, yüzey akımı yoğunluğunun sabit normal ikili hücre genişliğine bölümüdür; bu nedenle harita düzlem başına sabit katsayı farkıyla **yüzey akımı büyüklüğü |J_s|** olur. FDTD mesh'inden düzenli ızgaraya yeniden örneklenir, düzlem/frekans başına normalize edilir.

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `quantity` | string | `"surface_current"` |
| `definition` | string | Okunabilir tanım |
| `units` | string | Normalizasyon notu: 1000 = o frekansta düzlemdeki metal üzerindeki maksimum, -1 = metal yok |
| `phase_version` | number | `1`, aşağıda açıklanan isteğe bağlı işaretli int8 karmaşık akım biçimini tanımlar. Eski okuyucular ek `phasors` alanını yok sayabilir; `phase_version` olmayan paketlerin yalnızca büyüklük anlamı korunur |
| `port` | number? | Haritaları kaydeden çalıştırmada uyarılan port numarası. Haritalar **tek** uyarımdandır: çok portlu çalıştırmada (uyarılan port başına bir openEMS çalıştırması) yalnızca ilk uyarılan portun çalıştırmasında, diğerleri sonlandırılmışken kaydedilir; port başına harita yoktur. Tek uyarılan port bilinmiyorsa veya alan eklenmeden önceki paketlerde bulunmaz. Görüntüleyici `ports` içinde `excite` işaretli tek porta döner (liste haritaları kaydeden aynı kurulumdan gelir); aksi halde uyarımı bilinmiyor gösterir, asla port 1 varsaymaz |
| `planes` | FieldPlane[] | Aşağıya bakın |

**FieldPlane**

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `name` | string | Döküm adı (`fairbeam_J_<axis><i>`) |
| `parts` | string[] | Bu düzlemde levhası olan metal katılar |
| `axis`, `position` | number | Normal eksen indisi ve düzlem koordinatı (çizim birimleri) |
| `u_axis`, `v_axis` | number | Düzlem içi eksenler, `(axis + 1) % 3` ve `(axis + 2) % 3` (çokgenlerle aynı düzen) |
| `u_range`, `v_range` | [number, number] | Düzlemde metalin uzanımı; ilk/son örnekler bu değerlerdedir |
| `nu`, `nv` | number | u/v boyunca örnek sayısı (uzun kenarda en fazla 100) |
| `frequencies` | FieldFrequency[] | Uzak alan frekansı başına kayıt |

**FieldFrequency**

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `f` | number | Gerçekte dökümü alınan frekans (Hz). Açık `--fields` frekansları yoksa yaklaşık %0,5 adımlı ızgara kaydedilir, en yakın örnek kullanılır |
| `f_target` | number | Haritanın ait olduğu uzak alan frekansı (Hz) |
| `values` | number[] | v satır indisi olacak şekilde satır öncelikli `nv · nu` tam sayı (`values[j * nu + i]`, `u_range[0] + i·Δu`, `v_range[0] + j·Δv` konumundadır). 0..1000 = \|J_s\| / max (doğrusal, fazör büyüklüğü); -1 = metal dışı (basamaklı mesh değil, tam şekiller) |
| `phasors` | string | `phase_version: 1` ile piksel başına `[Ju.re, Ju.im, Jv.re, Jv.im]` sıralı dört işaretli int8 örneğin base64 baytları. Pikseller `values` ile aynı v-satır/u-sütun sırasını ve düzlem eksenlerini kullanır. Her bileşen, nicemlemeden önce gerçek/sanal skaler olarak çift doğrusal yeniden örneklenir. Her frekansta `peak`, `values` için kullanılan yeniden örneklenmiş vektör büyüklüğünün metal üzerindeki maksimumudur; bileşen `round(127 · component / peak)` ile [-128, 127] aralığına kırpılır. Tam metal maskesi dışında dört bayt da sıfırdır. Değerler `peak` değerine göredir; bu değer mutlak akım yoğunluğu olarak saklanmaz. Faz düzeni `Re{J exp(+j phase)} = re cos(phase) - im sin(phase)`; +90°'de gerçek akım `-im` olur. Alan geriye uyumlu ektir: yalnızca büyüklük kullananlar `values` ile devam edip `phasors` alanını yok sayabilir |

Tepe metal kenarlarındadır; burada akım tekildir ve yalnızca mesh'in izin verdiği kadar çözümlenir. Mutlak tepe yerine şekilleri ve göreli seviyeleri karşılaştırın.

## field_planes

İsteğe bağlı; yalnızca alan düzlemli çalıştırmalarda bulunur (`fairbeam run --field-plane`, tasarımın `monitors.field_planes` alanı; `python/fairbeam/field_planes.py`). Düzlem/frekans başına bir kayıt. openEMS her düzlemde, istenen konuma en yakın mesh çizgisinde, düzlemdeki tüm simülasyon bölgesi boyunca düğüm enterpolasyonlu frekans alanı **E** (döküm türü 10) veya **H** (tür 11) kaydeder. Kaydedilen harita fazör büyüklüğüdür; FDTD mesh'inden düzenli ızgaraya çift doğrusal yeniden örneklenir (düzlemdeki en ince hücrenin adımıyla, uzun kenarda en fazla 200 örnek), 3 anlamlı basamağa yuvarlanır. Karmaşık bileşenler yanında isteğe bağlı 8 bit `phasor` olarak saklanır.

**Normalizasyon.** openEMS frekans alanı dökümleri, port gerilimleriyle aynı tek taraflı Fourier dönüşümüdür: `2 Δt Σ f(t) e^(−jωt)`. Uyarılan portun `P_inc = |u_inc|² / (2 Re Z_ref)` değeriyle `sqrt(1 W / P_inc(f))` ölçeklemesi uygulanınca **uyarılan porta gelen (uyarım) 1 W güç için tepe fazör genliği** olur. Tek uyarılan port yoksa ham dönüşüm kalır (`unit: "arb."`, `normalization: "none"`). [fields](#fields) gibi haritalar tek uyarımdandır: çok portlu çalıştırmada yalnızca ilk uyarılan portun çalıştırmasında kaydedilir.

**FieldPlaneMap**

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `quantity` | string | `"E"` veya `"H"` |
| `component` | string | `"abs"`: sqrt(\|Fx\|² + \|Fy\|² + \|Fz\|²); `"x"`, `"y"`, `"z"`: ilgili bileşenin büyüklüğü |
| `normal`, `axis` | string, number | Düzlem normali (`"x"`, `"y"`, `"z"`) ve eksen indisi |
| `u_axis`, `v_axis` | number | Düzlem içi eksenler, `(axis + 1) % 3`, `(axis + 2) % 3` ([fields](#fields) gibi) |
| `position_mm` | number | Haritanın kaydedildiği mesh çizgisinin koordinatı (çizim birimleri) |
| `requested_mm` | number | İstenen konum; bölge dışındaysa sınırda kaydedilir |
| `f` | number | Frekans (Hz) |
| `u_range`, `v_range` | [number, number] | Uzanım (düzlemdeki bölge); ilk/son örnekler bu değerlerdedir |
| `nu`, `nv` | number | u/v boyunca örnek sayısı |
| `unit` | string | Normalize ise `"V/m"` (E) veya `"A/m"` (H), değilse `"arb."` |
| `normalization` | string | Okunabilir normalizasyon; uyarılan port yoksa `"none"` |
| `max` | number | Haritanın en büyük değeri (4 anlamlı basamak) |
| `magnitude` | number[][] | `nu` değerli `nv` satır: `magnitude[j][i]`, `u_range[0] + i·Δu`, `v_range[0] + j·Δv` konumundadır |
| `port` | number? | Uyarılan port numarası (bilinmiyorsa yok) |
| `phasor` | FieldPlanePhasor? | Haritanın fazı ve bir dönem boyunca alanı için karmaşık bileşenler. Alan eklenmeden önceki paketlerde veya sıfır alanda bulunmaz; görüntüleyici yalnızca büyüklüğü gösterir |

**FieldPlanePhasor** (isteğe bağlı). Aynı yeniden örneklenmiş `nu × nv` ızgaranın karmaşık bileşenleri; görüntüleyici fazı ve bir dönem boyunca anlık `Re{F e^(jωt)}` alanını gösterebilir (tasarımcının 2B alan haritası sekmesi ve 3B görünüm animasyon yapar).

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `components` | string[] | `component: "abs"` için `["x","y","z"]`; diğer durumda kayıtlı tek bileşen, ör. `["z"]` |
| `peak` | number | Kayıtlı bileşenlerin en büyük büyüklüğü (4 anlamlı basamak), haritanın `unit` biriminde; int8 tam ölçeği |
| `data` | string | İşaretli 8 bit tam sayıların base64 kodlaması, v satır olacak şekilde satır öncelikli: `[v][u][component][re, im]`, `nv · nu · len(components) · 2` bayt. Değer = `int / 127 · peak`; çözünürlük `peak / 127` (tepenin %0,8'i), `magnitude` değerinden kabadır. Faz yalnızca büyüklük bu adımın çok üstündeyken anlamlıdır |

Değerler `magnitude` gibi ölçeklenir (1 W gelen güç); uyarılan port varsa gelen gerilim dalgasının fazıyla döndürülür (`× conj(u_inc) / |u_inc|`). Faz 0, uyarım darbesinin keyfî zaman başlangıcı değil, bu dalganın `t = 0` anıdır. Uyarılan port yoksa (`normalization: "none"`) faz ham dönüşüme aittir, fiziksel referansı yoktur. Zaman düzeni `e^(+jωt)`; `φ` fazında alan `Re{F e^(jφ)}` olur.

Boyut: 106 × 106 harita başına yaklaşık 80 kB JSON, 200 örnek sınırında yaklaşık 150 kB; tasarım sınırlarıyla (4 düzlem × 4 frekans) en fazla yaklaşık 2,5 MB. Fazör, `abs` haritalarında piksel başına 6 bayt (tek bileşende 2), base64 olarak ekler: 106 × 106 (`abs`) için yaklaşık 90 kB, 200 × 200 için 320 kB; 16 tam boy `abs` haritasında en fazla yaklaşık 5 MB ek. Notlar: düğüm enterpolasyonu, tam metal levhada veya dielektrik arayüzde normal E bileşenini komşu iki hücre üzerinden ortalar; temiz saçak alanları için düzlemi bir hücre uzağa koyun. PML sınırının dış hücrelerinde soğurulmuş, fiziksel olmayan alanlar bulunur.

## Dizin dosyası

`public/projects/index.json`, her yazmada veya `fairbeam index [folder]` ile yeniden oluşturulur. Klasörde (kendisi hariç) `schema` değeri `fairbeam.project/` ile başlayan tüm `*.json` dosyalarını kapsar. Kayıtlar önce model kimliğine, sonra ada göre sıralanır.


```json
{
  "projects": [
    {"file": "patch-antenna.json", "name": "Rectangular patch antenna", "model": "patch-antenna",
     "created": "2026-09-24T22:24:15+0300", "simulated": true, "bands": [2.433], "cells": 97152}
  ],
  "updated": "2026-09-24T22:25:42+0300"
}
```

| Alan | Tür | Açıklama |
| --- | --- | --- |
| `file` | string | Dizine göre paket dosya adı |
| `name`, `model`, `created` | string | Paketten kopyalanır (`model`, `model.id` değeridir) |
| `simulated` | boolean | `results` bulunuyor |
| `bands` | number[] | Her bandın `f_center` değeri (minimum S11 frekansı), **GHz**, 3 ondalık |
| `band_ranges` | object[]? | Her bandın **GHz** cinsinden sınırları (4 ondalık) ve simülasyon aralığına değip değmediği: `{lo, hi, edge_lo, edge_hi}`. Örnek seçici bandı sınırların ortasıyla, simülasyon sınırına değiyorsa aralığıyla gösterir. Bant yoksa ve eski dizinlerde bulunmaz (seçici o zaman `bands` gösterir) |
| `cells` | number | `mesh.total_cells` |
| `engine` | string? | `"CPU"`, `"Metal"`, `"CUDA"` veya `"GPU"`: simülasyonu çalıştıran motor (`run.engine` ve günlükten). Çalıştırma yoksa bulunmaz |
| `params` | object? | Varsayılandan farklı ayarlanmış model parametreleri, `{key: value}`. Yoksa bulunmaz |

## Sürümleme

İsteğe bağlı alan eklemek şema kimliğini değiştirmez: `lumped_elements`, `results.sparams`, `results.element_patterns`, `farfield[].port`, `run.port_runs`, `fields.port`, `results.efficiency`, `run.efficiency_time_s`, `run.engine` / `engine_requested` / `exact_endcriteria`, `field_planes`, `efficiency[].pacc_error` / `reliable`, `rad_efficiency_raw`, `parts[].conductor`, `parts[].void` bu şekilde eklenmiştir. Alan kaldırmak/yeniden adlandırmak, birim veya indis düzenini değiştirmek sürümü `fairbeam.project/2` yapar. Şema değiştiğinde `src/types.ts` aynı commit'te değişir.
