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
| `keep_existing` | `True` | Izgaradaki mevcut çizgiler (modelin ekledikleri) sabit çizgi olarak korunur |
| `verbose` | `False` | Raporu yazdırır |

Tasarım dosyasında Simülasyon › Mesh ayarları penceresi *Otomatik* (`mesh.mode: "design"`, aşağıda açıklanır) ve *Otomatik (eski)* (`"auto"`; `mode` içermeyen tasarımın kullandığı mod da budur) modlarını sunar. `"manual"` çizgili tasarımda *Elle girilen çizgiler* görünür. Eski `auto` modundaki tasarım JSON'u, mevcut dalga boyu başına hücre ve hava payı alanlarının yanında `mesh.edge_rule`, `mesh.max_ratio` ve `mesh.air_cells_per_wavelength` ayarlayabilir. Bunları belirtmemek önceki mesh'i korur. Tasarımcının hücre ve süre tahminleri dönen mesh çizgilerini ve zaman adımını kullanır; böylece önizleme üretildikten sonra seçilen seçenekleri kapsar.

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

## Doğrulama

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
