# Otomatik mesh oluşturma

FDTD mesh'ini elle yazmak (`mesh.AddLine(...)` + `smooth_mesh()`), yeni modellerde hataların en sık ortaya çıktığı adımdır: mesh çizgisi üzerindeki bir kenar, tek hücre genişliğinde bir şerit, yetersiz hava payı veya zaman adımını yarıya indiren çok ince bir hücre. `Simulation.auto_mesh()` mesh'i geometriden oluşturur:

```python
sim = Simulation(f_min, f_max, boundaries=["PML_8"] * 6)
... sim.metal(...).AddBox(...), sim.dielectric(...), sim.lumped_port(...) ...
sim.auto_mesh()                       # after geometry and ports
sim.add_nf2ff_box(center=[0, 0, 0])   # after the mesh: the NF2FF box is placed on the grid
```

Tüm düzenleyici şablonları (`python/templates/*.py`) bu yöntemi kullanır. Dipol ve yama modelleri, elle ayarlanmış mesh'leriyle karşılaştırma için `--set mesh=auto` seçeneğini kabul eder.

## Seçenekler

`sim.auto_mesh(**kw)`, `fairbeam.automesh.generate(sim, ...)` işlevine aktarır:

| Seçenek | Varsayılan | Anlamı |
| --- | --- | --- |
| `f_max` | simülasyonun değeri | Dalga boyunu belirleyen frekans |
| `cells_per_wavelength` | 20 | Geometrik ayrıntı ve dielektrik çözünürlüğü: λ(f_max) / hücre sayısı; dielektrik içinde sqrt(ε_r)'ye bölünür |
| `air_cells_per_wavelength` | `cells_per_wavelength` ile aynı | Dış havada isteğe bağlı daha kaba en büyük hücre. Metal kenarı yerleşimi ve dielektrik çözünürlüğü yine `cells_per_wavelength` kullanır. Pozitif olmalı ve bu değeri aşmamalıdır |
| `edge_rule` | `"thirds"` | `"thirds"`: serbest metal kenarlarının 1/3 içerisine ve 2/3 dışına çizgi; `"edge"`: kenarın üzerine çizgi |
| `edge_res` | yerel en büyük hücrenin yarısı | Üçte bir kuralının kenar hücresi d ve eğik çokgenlerin dolgusu |
| `metal_cells` | 6 | Dar metal boyunca en az hücre sayısı (genişliği 2 yerel hücreyi aşmayan şerit, kol veya direk) |
| `dielectric_cells` | 4 | İnce dielektrik katman boyunca hücre sayısı |
| `max_ratio` | 1,4 | Kademeli dolguda komşu hücreler arasındaki en büyük oran |
| `min_cell` | istenen en ince hücrenin 0,45 katı | Bundan yakın çizgiler birleştirilir (aşağıya bakın) |
| `pad` | λ(f_min) / 4 | Yapı ile emici sınırlar arasındaki hava (PML hücreleri buna eklenir). Tek sayı veya altı değer (x-, x+, y-, y+, z-, z+); 0, PML'e uzanan besleme dalga kılavuzunda (`pyramidal_horn.py`) o yüzü yapı üzerinde bırakır ve PML hücresi eklemez |
| `refine_features` | `False` | Dar boşluk, çentik, ince veya eğik şerit gibi ince ayrıntıların çevresinde mesh'i yerel olarak sıklaştırır. Varsayılan olarak kapalıdır; aşağıya bakın. `mesh.refine_features` içermeyen tasarım JSON'u da `false` kullanır |
| `keep_existing` | `True` | Izgaradaki mevcut çizgiler (modelin ekledikleri) sabit çizgi olarak korunur |
| `verbose` | `False` | Raporu yazdırır |

Tasarım dosyasında Simülasyon › Mesh ayarları penceresi *Otomatik* (`mesh.mode: "design"`, aşağıda açıklanır) ve *Otomatik (eski)* (`"auto"`; `mode` içermeyen tasarımın kullandığı mod da budur) modlarını sunar. `"manual"` çizgili tasarımda *Elle girilen çizgiler* görünür. Eski `auto` modundaki tasarım JSON'u, mevcut dalga boyu başına hücre ve hava payı alanlarının yanında `mesh.edge_rule`, `mesh.max_ratio` ve `mesh.air_cells_per_wavelength` ayarlayabilir. Bunları belirtmemek önceki mesh'i korur. İnce ayrıntıların sıklaştırılması ayrıca `mesh.refine_features` ile denetlenir. Tasarımcının hücre ve süre tahminleri dönen mesh çizgilerini ve zaman adımını kullanır; böylece önizleme üretildikten sonra seçilen seçenekleri kapsar.

Simülasyon ayarları › Mesh altındaki **İnce ayrıntıları sıklaştırın**, iki otomatik modda da tasarım düzeyindeki `mesh.refine_features` mantıksal değerini denetler. **Varsayılan olarak kapalıdır**: yeni tasarımlarda (`"refine_features": false`), bu alanı içermeyen kayıtlı tasarımlarda ve Python API'sinde (`refine_features=False`). Bir tasarımı açmak veya dışa aktarmak ayarı hiçbir zaman açmaz; bu yüzden bir güncelleme mesh'inizi korur. Elle girilen mesh çizgileri hiçbir zaman sıklaştırılmaz. Tasarımdan üretilen Python her zaman tasarımın geçerli değerini açıkça yazar.

Ne zaman açılmalı: tasarımda otomatik mesh'in üç hücreden azıyla (eğik şeritte tek hücreyle) kapladığı dar boşluklar, çentikler, besleme aralıkları veya eğik ince şeritler varsa. Ayar kapalıyken mesh değişmez; yine de Denetimler listesi bu tür ayrıntıları `mesh-fine-feature` olarak bildirir (sayıyı ve en kötü genişlikleri içeren bir bilgi) ve ayarı açmanızı önerir. Ayarı açtıktan sonra önizlemeyi yeniden oluşturun, hücre sayısını ve denetimleri karşılaştırın.

Maliyet ve doğruluk uyarısı: sıklaştırma hücre ve zaman adımı sayısını, dolayısıyla çalışma süresini artırır; paketlenmiş örneklerde hücre sayısı yaklaşık 2 katına kadar, bıçak anteninde hücre × zaman adımı maliyeti 7,5 katına kadar çıkar (aşağıdaki tablolara bakın). Ayrıca besleme çevresindeki ızgarayı değiştirir; bu da tel antenlerin giriş empedansını kaydırabilir: aşağıdaki kaba helis denetiminde giriş direnci %27,7 değişmiştir. Geometrik çözünürlük, elektromanyetik yakınsama demek değildir; bu yüzden empedansa güvenmeden önce ayar açıkken ve kapalıyken birer çalıştırmayı karşılaştırın veya [yakınsama çalışmasını](#convergence-study) yapın. Paketlenmiş İHA bıçak anteni örneği (`blade_867`) ayar açık olarak gelir.

Uyarlamalı *Otomatik* modu `mesh: {"mode":"design", "overrides": {...}}` kullanır. İnce desenli metal levhalar için yaklaşık 30 hücre/λ ve tam levha kenarlarını, diğer durumlarda 24 hücre/λ ve üçte bir kuralını seçer. Hava çözünürlüğü şekil sayısıyla azalır (8 ile geometrik ayrıntı çözünürlüğü arasında sınırlıdır), varsa dielektrik katmanlar en az beş alt bölüme ayrılır ve kademelenme oranı 1,4'tür. Hava payı uzak alan hesaplanmıyorsa λ(f_min)/8, hesaplanıyorsa λ(f_min)/4'tür. NF2FF kutusu mesh çizgilerinden oluşturulur; openEMS, `Simulation.add_nf2ff_box` içinde asgari açıklık şartı getirmez. Daha büyük çeyrek dalga payı, ışıma sınırı için temkinli seçimdir. Alan değerleri `overrides` altında sabitlenebilir; bu değerler aynen raporlanır ve notları elle belirlenen ayarı gösterir. Uyarlamalı değerler oluşturma sırasında hesaplanır, tasarım JSON'una geri yazılmaz. Eksik mod ve `mode: auto` eski seçimleri korur.

Yama, dipol ve mikroşerit tasarımlarındaki GPU karşılaştırması sonucunda bu mod, mevcut dosyalar için isteğe bağlı bırakılmıştır. Tam kenarlı 45 hücre/λ openEMS referansına göre uyarlamalı S11 MAE değeri, eski mesh'ten biraz daha yüksektir: yamada 0,724 ve 0,696 dB, dipolde 2,864 ve 2,852 dB, mikroşeritte 2,823 ve 2,596 dB. Bunlar tekil çalıştırmalardır; daha ince referans, yakınsaması garanti edilmiş çözüm değil sayısal karşılaştırmadır. Raporlanan seçimleri inceleyin ve tasarımınıza uygun alan ayarlarını kullanın.

## Kurallar

Mesh oluşturucu tüm CSXCAD şekillerini (box, polygon, linpoly, cylinder, cylindrical shell, sphere, polyhedron, curve, wire; diğer türler ve dönüştürülmüş şekiller için sınırlayıcı kutuyu), `Simulation` port ve toplu eleman kayıtlarını ve sınır koşullarını okur. Her eksen için:

1. **Sabit çizgiler**: sıfır kalınlıklı levha ve çokgen düzlemleri, dielektrik yüzleri, her port/toplu eleman aralığının kendi yönündeki ve düz eksenindeki iki ucu, bölge sınırları ve kullanıcı çizgileri.
2. **Metal kenarları**, *üçte bir kuralı*: eksene paralel her serbest metal kenarında bir çizgi metalin d/3 içine, biri 2d/3 dışına konur; kenarın üzerine konmaz. Mesh çizgisi üzerindeki kenar yaklaşık yarım hücre daha uzun görünür (VALIDATION.md, bölüm 1c: λ/20'de dipol bu nedenle %8 daha düşük frekansta rezonansa girer). Başka ayrıntı d'den yakınsa, örneğin dar şeridin karşı kenarı, yarık, port düzlemi veya çakışan dielektrik yüzü varsa çizgi tam kenara yerleştirilir. Ayrı şekillerin aynı doğrultudaki kenarları (dizinin yamaları) komşu değil tek kenar çizgisi sayılır. İki metal şeklin birleştiği yerde (bir kutunun diğerini sürdürmesi) kenar ve çizgi yoktur. Eğik çokgen kenarlarında köşe koordinatlarına çizgiler ve çokgen boyunca d hücreli düzgün dolgu eklenir. **Çokyüzlü** tüm köşe koordinatlarında çizgi alır (yüzler eğik olduğundan üçte bir kuralı uygulanmaz). **Eğri veya tel**, uzanımı boyunca yerel hücrenin yarısı kadar düzgün dolgu alır: FDTD ince teli en yakın mesh kenarlarına yerleştirir; ince dolgu bu basamaklandırmayı eğriye yakın tutar (helis, VALIDATION.md bölüm 14). Silindir ve kürelerin sınırlarına çizgiler konur; **boruda** (silindirik kabuk) iç yüzlere de konur ve iki yerel hücreden ince duvar boyunca en az iki hücre kullanılır.
3. **Dar metal**: genişliği iki yerel hücreyi aşmayan şerit, kol veya direkte en az `metal_cells` hücre kullanılır (tam kenar çizgileri, üçte bir kuralı yok). Sıfır kalınlıklı levhaysa normale doğru her iki tarafında bu boyutta iki hücre daha bulunur. Bunlar olmazsa kaba normal mesh içindeki şerit çok daha kalın iletken gibi davranır; dipol böyle %2 düşük frekansta rezonansa girmiştir. Tasarımda mesh'e göre çok ince metal kutular (PCB bakırı), varsayılan olarak sıfır kalınlıklı levha oluşturulur (`mesh.thin_metal`, [DESIGNER.md](DESIGNER.md#simulation-settings)). Kaba mesh'in iletkenin elektriksel boyutunu değiştirmesini iki ek kural önler:
   - **Serbest uçlar.** İnce kolun ucu (en fazla iki yerel hücre genişliğinde, uzunluğu genişliğinin en az iki katı olan ve ucunun ilerisinde metal bulunmayan silindir veya kutu), kol genişliğinde hücreler alır; bunlar `max_ratio` oranıyla büyür. İki adet 1 mm yarıçaplı telden oluşan yarım dalga dipol (156 mm uzunluk, 900 MHz), her uçtan sonraki hücre 14 mm iken 20 hücre/λ'da 0,844 GHz, 80 hücre/λ'da 0,884 GHz rezonans vermiştir. Uç hücreleriyle 20, 30, 40 ve 60 hücre/λ için 0,888 GHz'dir (Re Zin 70,6 Ω).
   - **Levhalar.** Diğer sıfır kalınlıklı levhaların (bıçak anten, toprak düzlemi, geniş yama) yanında normal hücreler yerel en büyük hücrenin yarısıdır; dielektrik içinde boyutu katmanlar belirler. İHA bıçak anteninin levhasının iki yanını λ/20 hücreler kaplarken 20 hücre/λ'da rezonansı 0,843 GHz olmuş, ancak 50'den itibaren 0,908 GHz'e yakınsamıştır; artık 20 hücre/λ'da 0,904 GHz'dir.
4. **Dielektrikler**: kalınlığı `dielectric_cells` yerel hücreden az olan katmanda `dielectric_cells` hücre kullanılır. Dielektriğin bir eksendeki uzanımı içinde en büyük hücre λ/(hücre sayısı · sqrt(ε_r)) olur.
5. **Bölge**: tüm geometri ve portların sınırlayıcı kutusu, emici sınırlara doğru `pad` (λ(f_min)/4) ve `PML_8` için 8 hücre (PML bölgenin içinde kalır). PEC/PMC sınırlarına doğru ekleme yapılmaz: bunlar yapının temas ettiği simetri veya toprak düzlemidir.
6. **Çok ince hücreler**: birbirine göreli olarak 10⁻⁶'dan yakın sabit çizgiler tek çizgi sayılır. CSXCAD çokyüzlü köşelerini tek hassasiyetle döndürdüğünden, aksi halde 11,43'teki kutu kenarının yanında 11,4300003'teki köşe 3·10⁻⁷ boşluk bırakırdı. Sabit çizgiye kendi aralığının 0,4 katından yakın isteğe bağlı çizgi (dolgu, levha normalinde inceltme) kaldırılır. `min_cell` değerinden yakın iki sabit çizgiden düşük öncelikli olan kaldırılır (öncelik: bölge > kesin geometri > metal kenarı > üçte bir > port yanı). Bu kadar yakın iki kesin çizgi de korunur ve raporlanır; çünkü birini taşımak geometriyi değiştirir.
7. **Kademelenme**: her j çizgisine yerel h_j boyutu atanır (komşu aralıkların küçüğü, yerel en büyük hücreyle sınırlı). Sınırlandırılmış s(x) = min_j (h_j + g·|x − x_j|) boyut alanı her ayrıntıdan uzaklaştıkça doğrusal büyür; bu, oranı ≈ 1 + g olan geometrik hücre dizisidir (g = 0,85 · (max_ratio − 1)). Her boşluk, integralin eşit adımlarında n = ceil(∫dx/s) hücre alır. Hücreler boyut alanını izler ve tam sabit çizgilere ulaşır. Boşluğu n hücreye bölmek uç çizgisinin yanındaki hücreyi h_j'den küçültür; bu nedenle boşluklar, uç çizgilerinin diğer tarafına gerçekten yerleştirilmiş hücreden kademelenerek sabit noktaya kadar yeniden doldurulur. Yerel boyutu en fazla %10 aşan boşluk tek hücre kalır (aksi halde iki yarım boyutlu ince hücre oluşur ve komşu boşluklara yayılır). Böyle boşluklarda hücreler üst sınırı %10'a kadar aşabilir. CSXCAD'in `SmoothMeshLines` işlevi kullanılmaz; çünkü yalıtılmış küçük hücreyi (besleme aralığını) λ/20 hücrelerin yanında bırakır (elle mesh oluşturulan dipolde oran 3,7).

## Rapor

`auto_mesh`, `sim.mesh_report` içinde tutulan ve pakete `mesh.auto` olarak yazılan bir rapor döndürür:

| Alan | Anlamı |
| --- | --- |
| `settings` | Kullanılan seçenekler |
| `cells`, `total_cells` | Her eksendeki ve toplam hücre sayısı |
| `min_cell`, `max_cell` | En küçük ve en büyük hücre (çizim birimiyle) |
| `max_neighbour_ratio` | En büyük komşu hücre oranı (sabit çizgi kümeleri `max_ratio` değerini biraz aşabilir) |
| `res_air`, `res_dielectric` | Havadaki ve en yoğun dielektrikteki en büyük hücre |
| `timestep_s`, `timesteps_per_ns` | En küçük hücrelerden CFL zaman adımı tahmini |
| `memory_mb_estimate` | Hücre başına yaklaşık 90 bayt (alanlar ve operatör) |
| `warnings` | Örneğin `min_cell` değerinden yakın iki kesin çizgi |
| `fine_features` | Algılanan ince ayrıntılar: tür, genişlik, etkilenen eksenler ve sınırlar, gereken hücre sayısı (eğik şeritlerde 1, diğerlerinde 3), ölçülen `cells_across` ve `resolved` |
| `fine_feature_refinement` | Hücre sayısı etkisi: yerel sıklaştırmadan önceki `baseline_cells`, son `total_cells`, `added_cells` ve son/başlangıç `ratio` oranı. Sınır koruması ayrıca `skipped_cell_limit`, `cell_limit`, `required_cells_lower_bound`, `dropped_features` ve `retained_features` bildirir; `enabled` ayarın durumunu kaydeder |

İnce ayrıntının enine hücre sayısı temkinli bir değerdir: ayrıntının genişliği, her eksendeki kesişen en geniş hücre genişliklerinin toplamına bölünür ve ayrıntının genişlik yönüne izdüşürülür. Bu, geometrik çözünürlüğü ölçer; elektromanyetik yakınsamayı değil. Ayrıntılar ayar kapalıyken de ölçülür. Önizleme üretildikten sonra, bildirilen bir ayrıntı gereken çözünürlüğün altındaysa tasarım denetimleri `mesh-fine-feature` bildirir: ayar kapalıysa ayarı açmanızı öneren bir bilgi, ayar açıkken hücre sınırı yüzünden bir ayrıntı yetersiz kalmışsa bir uyarı. Rapor ve hücre sayısı karşılaştırması işlem içi mesh önizlemesini kullanır; çözücüyü çalıştırmaz. Elle girilen mesh'te veya bu raporu içermeyen eski bir önizlemede ince ayrıntı değerlendirmesi yoktur. Sıklaştırma hücre eklediğinde Denetimler listesi başlangıç ve sıklaştırılmış toplamları, eklenen hücreleri ve oranı gösterir. Sıklaştırma her koordinat ekseni boyunca yereldir; Kartezyen mesh çizgileri bölge boyunca uzandığından uzun bir eğik şeridi sıklaştırmak yine de çok sayıda hücre ekleyebilir.

## İnce ayrıntı mesh regresyonu

Aşağıdaki tablolar belirtilen eski sürümlerde, beslemenin enine denetiminden önce ölçülmüştür.
Ayar açıldığında artık dallı kuplör, kademeli alçak geçiren süzgeç, dikdörtgen patch ve dört
elemanlı patch dizisinde daha önce atlanan besleme çevreleri de sıklaştırılır.

Yeniden üretilebilir işlem içi karşılaştırma, `63e3550cbb5f07b92dd3c18dd22833ab6366251d` ana dal sürümünü ve gözden geçirilmiş sıklaştırma algoritmasını kullanır. Ayar varsayılan olarak kapalı olsa ve yalnızca bıçak örneği açık gelse de, kayıtlı her örnek karşılaştırma için açıkça açılmıştır. Tüm değerler `python/tests/fixtures/automesh_fine_features_comparison.json` dosyasındadır. Bunlar mesh ölçümleridir, elektriksel yakınsama ölçümleri değildir.

Yapay bıçak test tasarımında üç adet 1 mm çentik, 0,4 mm eğik bir şerit ve 1,35 mm bir besleme vardır.

| Ölçüm | Ana dal | Gözden geçirilmiş sıklaştırma |
| --- | --- | --- |
| Hücreler (x × y × z) | 106 × 28 × 72 | 206 × 50 × 263 |
| Toplam hücre | 213.696 | 2.708.900 |
| En küçük hücre (mm) | 0,19635 | 0,1788 |
| En büyük komşu oranı | 1,4 | 1,398 |
| Her 1 mm çentiğin enine hücre sayısı | 1,0, 1,0, 1,0 | 5,0, 5,0, 5,0 |
| Beslemenin enine hücre sayısı | 1,0 | 4,0 |
| Şeridin enine izdüşüm hücre sayısı | 0,12023 | 1,21603 |
| Şerit orta noktası basamak bileşenleri | 9 | 1 |
| Hücre × zaman adımı/ns (milyar) | 0,337 | 7,002 |

Bağlantı, elektrik kenarı orta noktası şeridin içindeyse düğümleri birleştirir. Bu, geometrik bir basamak denetimidir. Gözden geçirilmiş test tasarımı 3 M hücrenin altındadır (önceki üç hücreli şerit hedefi 14.250.600 hücre üretmişti). Üç çentik ve besleme en az üç hücre korur.

21 paketlenmiş değişken için maliyet sütunu, milyar cinsinden **hücre × tahmini zaman adımı/ns** değeridir ve ardından sonra/önce oranı gelir. CFL tahminini kullanarak eşit fiziksel süreleri karşılaştırır; duvar saatini veya yakınsama tahminini göstermez. On mesh aynı kalır. 25 mm üzerindeki helis z çizgileri başlangıçla birebir aynı kalır; beslemenin küçük hücreleri artık 200 mm'lik telin tamamına yayılmaz. Mevcut başlangıç kademelenme ihlalleri dokunulmamış bölgelerde kalabilir; bu örneklerin hiçbirinde en büyük komşu oranı daha kötü değildir.

| Örnek | Hücre, ana dal → sıklaştırılmış | En küçük hücre (mm), ana dal → sıklaştırılmış | Maliyet (milyar), ana dal → sıklaştırılmış; oran |
| --- | --- | --- | --- |
| `branchline-coupler` | 81.090 → 81.090 | 0,14417 → 0,14417 | 0,205 → 0,205; 1,00× |
| `dipole` | 240.120 → 295.200 | 0,16667 → 0,16667 | 0,615 → 0,830; 1,35× |
| `helix-axial` | 1.360.800 → 1.535.960 | 1,33449 → 0,75000 | 0,463 → 0,984; 2,12× |
| `inset-patch` | 240.786 → 304.668 | 0,31144 → 0,25000 | 0,290 → 0,495; 1,71× |
| `lowpass-stepped` | 133.000 → 133.000 | 0,07811 → 0,07811 | 0,724 → 0,724; 1,00× |
| `microstrip-line` | 3.106.880 → 3.106.880 | 0,13797 → 0,13797 | 7,398 → 7,398; 1,00× |
| `minkowski-patch` | 143.640 → 143.640 | 0,32354 → 0,32354 | 0,157 → 0,157; 1,00× |
| `patch-antenna` | 167.040 → 167.040 | 0,33969 → 0,33969 | 0,157 → 0,157; 1,00× |
| `patch-array-2x1` | 115.872 → 115.872 | 0,33967 → 0,33967 | 0,109 → 0,109; 1,00× |
| `patch-array-4x1` | 451.200 → 451.200 | 0,33963 → 0,33963 | 0,424 → 0,424; 1,00× |
| `pyramidal-horn` | 1.103.856 → 1.103.856 | 0,20819 → 0,20819 | 2,121 → 2,121; 1,00× |
| `sierpinski-monopole--iterations-0` | 9.687.972 → 9.900.352 | 0,18543 → 0,18543 | 22,963 → 24,070; 1,05× |
| `sierpinski-monopole--iterations-3` | 28.387.072 → 28.908.000 | 0,03289 → 0,03289 | 334,632 → 340,773; 1,02× |
| `wilkinson-divider` | 756.276 → 756.276 | 0,13046 → 0,13046 | 2,754 → 2,754; 1,00× |
| `blade-867` | 136.500 → 269.040 | 1,40492 → 0,43767 | 0,038 → 0,283; 7,53× |
| `collinear-867` | 3.516.544 → 3.713.820 | 0,08953 → 0,08953 | 13,352 → 14,120; 1,06× |
| `meander-dipole-867` | 976.472 → 1.073.856 | 0,25599 → 0,25599 | 1,782 → 1,960; 1,10× |
| `sleeve-dipole-867` | 442.800 → 509.733 | 0,26078 → 0,23791 | 0,758 → 0,918; 1,21× |
| `ux-inset-patch-2-4-ghz` | 123.420 → 166.870 | 0,40000 → 0,25000 | 0,131 → 0,274; 2,09× |
| `wideband-dipole-867` | 830.576 → 1.112.832 | 0,40000 → 0,40000 | 0,855 → 1,263; 1,48× |
| `yagi-867` | 714.840 → 714.840 | 0,36511 → 0,36511 | 0,845 → 0,845; 1,00× |

Yapay yoğun PCB'de 20 mm uzunluğunda, 0,4 mm genişliğinde eş düzlemli izler ve 0,2 mm aralıklar, 1–3 GHz bant, MUR sınırları ve 20 hücre/λ vardır. Bitişik tüm aralıklar üç hücre hedefini karşılar. Hücre sayıları, sıklaştırmanın tüm bölge boyunca yayılan Kartezyen maliyetini içerir.

| İz sayısı | Hücre, ana dal → sıklaştırılmış | En küçük hücre (mm), ana dal → sıklaştırılmış | Maliyet (milyar), ana dal → sıklaştırılmış; oran |
| --- | --- | --- | --- |
| 20 | 692.496 → 876.960 | 0,06200 → 0,04660 | 4,602 → 7,238; 1,57× |
| 60 | 1.781.136 → 2.306.080 | 0,06200 → 0,04994 | 11,837 → 18,270; 1,54× |
| 120 | 3.414.096 → 4.449.760 | 0,06200 → 0,04660 | 22,689 → 36,725; 1,62× |

Algılayıcı zamanlaması, aynı genişlik ve aralıkla 100 mm uzunluğunda 20 parçalı dikdörtgen iz dış çizgisi kullanır; `max_width=0.25 mm`. Bu, algılamayı mesh oluşturmadan ayırır. Önceki algılayıcı `efbbcfa` sürümüdür. Tekil çalıştırma süreleri iş yüküne özeldir, genel başarım garantisi değildir.

| Kenar | Ön süzgeçten önce (s) | Ön süzgeçle (s) | Özellikler, her iki sürüm |
| --- | --- | --- | --- |
| 3.200 | 3,062 | 0,185 | 1.501 |
| 10.000 | 27,611 | 0,661 | 4.731 |

`python/` klasöründen, openEMS Python ortamıyla yeniden üretin:

```bash
nice -n 15 python -m tests.mesh_feature_measurements --examples --dense-pcb --detection
nice -n 15 python -m tests.mesh_feature_measurements --examples --dense-pcb --reference-revision 63e3550cbb5f07b92dd3c18dd22833ab6366251d
nice -n 15 python -m tests.mesh_feature_measurements --detection --detector-revision efbbcfa
```

Dipol ve yama kendi otomatik seçeneğini seçer; yalnızca elle mesh'li örnekler geometriden otomatik varsayılanlarla yeniden oluşturulur. Bu, iki tarafta da aynı girdileri bilerek ölçer.

### Kaba helis alan doğrulaması

Helis mesh'i değiştiği için, CPU üzerinde dört iş parçacığıyla, 20 hücre/λ, −30 dB durdurma ölçütü ve 60.000 adım sınırıyla ardışık olarak da çalıştırılmıştır. İkisi de durdurma ölçütüne ulaşmıştır. Örüntüler 2,4 GHz'de 5° teta ve 10° faz adımları kullanmıştır. Geçici çözücü çıktısı her çalıştırmadan sonra silinmiştir. Karşılaştırma betiği yalnızca ölçümleri ve çalıştırma ayarlarını bildirir.

| 2,4 GHz'de | Ana dal | Sıklaştırılmış | Fark |
| --- | --- | --- | --- |
| Dmax | 12,100 | 11,996 | -0,104 dB |
| Eksen yönünde eksenel oran | 1,120 | 0,834 | -0,286 dB |
| Giriş direnci | 156,344 | 199,676 | +43,332 Ω |

Giriş direnci değişimi büyüktür (yaklaşık %27,7); ayarın varsayılan olarak kapalı olmasının nedeni budur. Bu, çözülmemiş bir yakınsama sorusudur, elektriksel eşdeğerlik kanıtı değildir. İnce telin etkin yarıçapı basamaklı mesh'ine bağlıdır ve besleme sıklaştırması bu mesh'i yerel olarak değiştirir. Bu kaba denetimde Dmax ve eksenel oran birbirine yakındır. Ana çalıştırma ayrıca %100,2 ham ışıma verimi bildirmiştir; bu, küçük bir sayısal güç dengesi hatasıyla uyumludur. Bu çalıştırmalar değişen diğer örnekleri doğrulamaz ve yakınsamış empedans belirlemez.

```bash
nice -n 10 env OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=1 python -m tests.helix_mesh_sanity --reference-revision 63e3550cbb5f07b92dd3c18dd22833ab6366251d
```
## Doğrulama

Bu bölümdeki alan sonuçları yerel ince ayrıntı sıklaştırmasından öncesine aittir; tarihsel doğrulama sonuçlarıdır. Yukarıdaki kaba helis denetimi bu sürümdeki tek yeni alan karşılaştırmasıdır; geri kalan mesh tablosu alan doğruluğunu belirlemez. Yalnızca mesh çözünürlüğüne bakan bir denetim, elektromanyetik yakınsamayı belirlemez.

GPU motoru, −60 dB durdurma ölçütü. VALIDATION.md'deki yakınsamış, elle ayarlanmış sonuçlarla karşılaştırma:

| Model | Mesh | Hücre | Rezonans | Yakınsamış değere göre | Dmax (dBi) |
| --- | --- | --- | --- | --- | --- |
| Dipol (PML) | elle, mesh_div 40 (yakınsamış) | 810 k | 2,4198 GHz (X = 0) | | 2,133 |
| Dipol (PML) | elle, mesh_div 20 (eski varsayılan) | 166 k | 2,4147 GHz | −0,21 % | 2,163 |
| Dipol (PML) | **otomatik, 20 hücre/λ** | 219 k | **2,4182 GHz** | **−0,07 %** | 2,159 |
| Yama (MUR) | elle, mesh_div 40 (yakınsamış) | 536 k | 2,4550 GHz (S11 min) | | 6,786 |
| Yama (MUR) | elle, mesh_div 30 (varsayılan) | 264 k | 2,4525 GHz | −0,10 % | 6,788 |
| Yama (MUR) | **otomatik, 20 hücre/λ** | 153 k | **2,4525 GHz** | **−0,10 %** | 6,886 |
| Yama (MUR) | otomatik, 30 hücre/λ | 390 k | 2,4525 GHz | −0,10 % | 6,869 |

- Rezonanslar yakınsamış değerlerin %0,1'i içindedir. Hücre sayıları elle hazırlanan mesh'lere benzer; yamada aynı doğruluğu sağlayan elle hazırlanmış mesh'ten düşüktür (153 k ve 264 k), çünkü ince hücreler her yere değil kuralların gerektirdiği yerlere konur.
- Yama Dmax değeri, hem 20 hem 30 hücre/λ otomatik mesh'te ve daha büyük hava payında (0,75 GHz'de λ/4 ile 6,876 dBi) elle mesh'ten 0,1 dB yüksektir. Fark, VALIDATION.md bölüm 1c'deki MUR sınırı duyarlılığı kadardır: otomatik mesh bölgesinde MUR duvarlarında λ/20, elle mesh'te λ/30 hücre bulunur. Dmax için 0,1 dB önemliyse PML sınırları kullanın.
- Monopol şablonu (PEC toprak sınırı, bölge z = 0'da başlar) otomatik mesh ile çalışır: 180 k hücre, 25 mm tel için 2,66 GHz rezonans (X = 0).

## Yakınsama çalışması

Kararlı bir sonuç çifti ancak iki koşu da enerji sönümü ölçütünü sağladığında (çok portlu bir
çalışmada uyarılan bütün portlar dahil) ve otomatik mesh'lerin hiçbirinde yetersiz ince ayrıntı
bildirilmediğinde kabul edilir. Enerji durumu eksikse denetim geçmez. Rapor bunu rezonans
değişiminden ayrı belirtir. Beslemelerde `cells_across`, aralık genişliğinin eksen yönündeki ve
sıfır genişlikli enine yönlerdeki hücre boyutlarına oranlarının en küçüğüdür;
`axial_cells_across` ve `transverse_cells_across` bu değerleri ayrı kaydeder.
Enine denetim, besleme çizgisinin iki yanındaki hücreleri de kapsar. Bunlar geometrik alt
sınırlardır; doğruluk belgesi değildir. Besleme çevresinde en az iki ek sıklaştırma yapın ve
S11 çukurunun derinliği önemliyse sınır uzaklığını ayrıca denetleyin. Yalnızca dalga boyu başına
hücre sayısını artırmak besleme ve dielektrik kalınlığı hücrelerini değiştirmeyebilir.

Bağımsız yerel geometri denetimi için `python/` klasöründen
`FAIRBEAM_TEST_FDTD=1 python -m unittest discover -s tests -p test_native_geometry_parity.py -v`
çalıştırılabilir (PowerShell'de önce `$env:FAIRBEAM_TEST_FDTD='1'` ayarlayın, sonra `python -m unittest ...`
komutunu çalıştırın). Denetim bıçak antenini doğrudan openEMS/CSXCAD ile kurar; aynı mesh, kaynak,
sınırlar ve port üzerinde tasarım oluşturucusuyla karşılaştırır. Kurulu çözücüyle geometri
aktarımını ve S11 hesabını denetler; fiziksel doğruluğu veya farklı çözücü derlemelerinin
eşdeğerliğini kanıtlamaz.

Kontrollü dikdörtgen patch çalışmasını yinelemek için `python/` klasöründen
`python -m tests.feed_resolution_study --out <yeni-klasör>` çalıştırın. Betik girdileri, ham port
verilerini, tam karmaşık S11/Zin değerlerini, günlükleri ve manifestleri saklar; dört CPU iş
parçacığıyla aynı anda yalnızca bir çözüm çalıştırır. Önce eski, yalnızca eksen boyunca yapılan
denetimi yeni denetimle karşılaştırır; ardından besleme merkezi çevresindeki sabit 3 mm bölgede
hücreleri iki kez yarıya indirir. Geometri, malzemeler, dış bölge, MUR sınırları, kaynak,
50 ohm referansı ve −60 dB enerji eşiği sabit kalır. Her koşu için 15 dakika zaman sınırı vardır;
başarısız veya durdurulan koşular çıktı klasöründe korunur.

Windows ve openEMS 0.37.0-rc3 ile 20 hücre/λ otomatik dikdörtgen patch, eski denetimde 167.040,
yeni denetimde 266.400 hücre kullandı. İki ek yerel sıklaştırmada 427.056 ve 912.288 hücre oluştu.
S11 minimumları sırasıyla −40,08, −34,01, −26,70 ve −23,11 dB idi (801 noktalı tam banda ek olarak,
kaydedilen port verileri 2,43–2,49 GHz arasında 50 kHz adımla değerlendirildi).
Dört koşu da enerji eşiğini sağladı, ancak çukur derinliği değişmeye devam etti:
**bu çalışma besleme mesh'inin yakınsadığını kanıtlamaz**. Düzeltme, atlanan çözünürlük denetimini
tamamlar; üç hücre hedefi bir başlangıçtır, önerilen son mesh değildir. Özellikle bu kadar derin
ve dar çukurlarda örneklenen minimum, frekans adımına da bağlıdır.

Mesh'in yeterince ince olup olmadığını, sonuçlar değişmeyene kadar incelterek belirleyebilirsiniz. Tasarım dosyasında bunun için tek komut (veya tasarımcının Mesh yakınsaması… penceresi, [DESIGNER.md](DESIGNER.md#mesh-convergence)) yeterlidir:

```bash
fairbeam converge my.design.json --densities 15,20,30,40 --max-runs 4 --engine gpu
```

Tasarım sırayla her `cells_per_wavelength` değeriyle çalıştırılır (Otomatik modda alan ayarı, eski modda `mesh.cells_per_wavelength`; açıkça verilen hava yoğunluğu bununla ölçeklenir). Rezonansın %0,5'ten, rezonanstaki |S11|'in 1 dB'den, Dmax'ın 0,2 dB'den az değiştiği ilk adımda durur (o adımın daha kaba yoğunluğunda “yakınsadı”). Elle mesh çizgileri kabul edilmez. Çalışmanın her çalıştırması tasarım üzerinde `fairbeam run --mesh-density CELLS` komutudur. Yama anten şablonu (`template: patch`, 2,45 GHz, MUR, −60 dB), GPU motoru, 2026-09-28:

| Hücre/λ | Hücre | Rezonans | Δf | \|S11\| | Δ\|S11\| | Dmax | Zin | Toplam süre |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 15 | 55 k | 2,4495 GHz | | −42,35 dB | | 6,76 dBi | 49,7 − j0,4 Ω | 1,1 s |
| 20 | 101 k | 2,4538 GHz | +0,173 % | −41,34 dB | +1,02 dB | 6,75 dBi | 49,8 − j0,5 Ω | 1,2 s |
| 30 | 251 k | 2,4559 GHz | +0,088 % | −40,68 dB | +0,66 dB | 6,75 dBi | 49,3 − j0,1 Ω | 1,9 s |

Sonuç: 20 hücre/λ'da yakınsadı (20 → 30 tüm toleransların içinde; 15 → 20, |S11| toleransını 0,02 dB aştı). Bu kadar derin uyumda (−40 dB) dB cinsinden |S11| çok duyarlıdır: burada 1 dB, yansıma katsayısında yaklaşık 0,001 değişimdir. Böyle tasarımlarda `--tol-s11` toleransını gevşetin veya rezonans ve Dmax'ı değerlendirin.

## Sınırlamalar

- Çizgiler globaldir (FDTD): ince bir ayrıntı tüm satırını ve sütununu inceltir. Boyut alanı diğer iki yönde etkiyi yerel tutar; yine de büyük karta dağılmış çok sayıda küçük ayrıntı hücre sayısını artırır.
- Eğik ve eğri kenarlar basamaklandırılır. Köşe çizgileri ve d boyutlu dolgu yardımcı olur ancak yakınsama denetimlerinin yerini tutmaz (tasarım için [Yakınsama çalışması](#convergence-study); Python modeli için `fairbeam converge ... --param auto_cpw=15,20,30` veya kendi mesh parametreniz).
- Döndürülmüş veya dönüştürülmüş şekillerin mesh'i sınırlayıcı kutularından oluşturulur.
- Bölünmüş boşlukların yanındaki kademelenme (kural 7) düzeltilmiştir. Önceden böyle çizginin karşısındaki boşluk, bölünmemiş boşluğa göre kademeleniyordu; bu yüzden dal hatlı kuplör, alçak geçiren filtre, mikroşerit şablonu ve heliste komşuluk oranı 2,1'e kadar çıkıyordu. Mesh'leri değişir (dal hatlı kuplör 69 k → 76 k hücre, alçak geçiren 100 k → 126 k); dipol, yama, diziler ve diğer şablonlar değişmez. Dal hatlı kuplör ve alçak geçiren filtre paketleri düzeltmeyle 2026-09-25'te yeniden çalıştırılmıştır: kuplör merkezi 2,406'dan 2,414 GHz'e, filtrenin −3 dB noktası 2,349'dan 2,356 GHz'e kaymıştır (VALIDATION.md bölüm 10); bu, sonuçların mesh duyarlılığıdır.
- Dielektrik üst sınırları, her dielektriğin her eksendeki uzanımını (1B izdüşüm) kullanır; dolayısıyla alttaş, uzandığı yönlerde üstündeki ve yanındaki havayı da inceltir.
