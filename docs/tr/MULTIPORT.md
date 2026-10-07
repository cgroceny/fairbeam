# Çok portlu yapılar ve diziler

## Çok portlu çalıştırmalar

Modeller; filtre, güç bölücü veya dizi gibi yapılarda birden fazla ayrık port tanımlayabilir.
`fairbeam run`, diğer tüm portları dirençleriyle sonlandırılmış olarak yerinde tutup her uyarılan port için openEMS'i bir kez çalıştırır. Güç dalgalarından S-matrisini oluşturur (`S = B A^-1`, her portun kendi referans empedansıyla). Pakete şunlar eklenir:

- `results.sparams`: tüm S_ij değerleri ve kalite kontrol ölçütleri. Karşılıklılık max |S_ij − S_ji|; pasiflik ise ≤ 1 olması gereken Σ_i |S_ij|² sütun gücüdür.
- Antenler için `results.element_patterns`: karmaşık gömülü eleman örüntüleri. Böylece karşılıklı kuplaj ve aktif yansıma katsayıları dahil her uyarım veya hüzme yönlendirme durumu daha sonra `fairbeam.array.combine` ile hesaplanabilir.


```bash
fairbeam run python/models/microstrip_line.py --engine gpu       # 2-port through line
fairbeam run python/models/wilkinson_divider.py --engine gpu     # 3-port Wilkinson divider (2.4 GHz)
fairbeam run python/models/patch_array_2x1.py --engine gpu       # 2-element patch array
fairbeam run python/models/patch_array_4x1.py --engine gpu       # 4-element patch array (PML, automesh)
fairbeam run python/models/branchline_coupler.py --engine gpu    # 4-port 90 degree hybrid (2.4 GHz)
fairbeam run python/models/lowpass_stepped.py --engine gpu       # 5th-order stepped-impedance low-pass
fairbeam run python/examples/waveguide_thru.py --engine gpu      # WR-90 guide between two TE10 waveguide ports
fairbeam run python/models/wilkinson_divider.py --excite 1       # only port 1 driven (first column)
fairbeam touchstone public/projects/wilkinson-divider.json       # -> wilkinson-divider.s3p
```

Tasarım dosyasında portlar (ayrık veya TE10 dalga kılavuzu) ve toplu dirençler Simülasyon şeridinin Portlar grubundan eklenir. `fairbeam run <design.json>` aynı `--excite` kuralını uygular; mikroşerit hat şablonu iki portludur. `Simulation.lumped_resistor(name, R, start, stop, direction)`, Wilkinson yalıtım direnci gibi port olmayan bir direnç ekler; bu direnç VBA makrosuna toplu eleman olarak aktarılır. Tanımlar [BUNDLE.md](BUNDLE.md#multi-port-runs), dizi hesapları ve 2×1 gösterimi [ARRAYS.md](ARRAYS.md), mikroşerit ve Wilkinson doğrulaması ise [VALIDATION.md](VALIDATION.md#7-microstrip-line-two-port-reference) sayfasındadır.

Çevrimdışı karşılaştırmalarda `fairbeam.network` (yalnızca NumPy gerektirir, açıkça içe aktarılır; çalıştırmayı, paketi veya tasarımcıyı değiştirmez) ideal devre referansları sağlar: kayıpsız TEM hatları ve düğümler arasındaki toplu admitans/empedanslar için `network_s`, ayrıca ideal `wilkinson_s` ve `branchline_s`. İki uyumlu düz hat kontrolünden düzgün bir hattın yayılma sabitini de çıkarır (`two_line_calibration`) ve referans düzlemlerini verilen uzaklıklarla kaydırır (`shift_reference_planes`). Model ve sınırları (tam bir TRL kalibrasyonu değildir) [python/README.md](../python/README.md#offline-planar-feed-calibration) sayfasındadır.

## Görüntüleyicide

Tasarımcıda, çok portlu çalıştırmanın S-parametreleri sekmesinde (Son işlem › S-parametreleri şeridi veya gezinti ağacındaki çalıştırma) aynı S_ij seçicisi (en fazla üç çift, dB veya faz) ve Smith portu seçimi bulunur. Aşağıdaki açıklama, Dizi sekmesini de içeren Örnekler görüntüleyicisinin alt paneline aittir.

- **Çok portlu yapılar ve diziler.** İki veya daha fazla port içeren paketler *Yansıma* yerine *S-parametreleri* sekmesini gösterir. En fazla üç S_ij çifti (tablo kayıtlı tüm çiftleri listeler), dB veya faz ve port başına Smith abağı seçin. Sonuçlar karşılaştırılırken her birinin seçilen S_ij değerleri üst üste çizilir (sonucun rengi ve her çift için farklı kesik çizgi; kaydedilmemiş çiftler o sonuç için gösterilmez). Smith abağı her sonucun seçilen portunu gösterir. Veri kopyalama ve CSV, seçilen çiftleri, dB/faz seçimini ve Smith portunu izler. Gömülü eleman örüntüleri içeren paketlerde *Dizi* sekmesi vardır: port başına genlik ve faz ile besleme fazörü, xz veya yz düzleminde canlı tarama açısı kaydırıcısı (port merkezlerinden kademeli fazlar; varsayılan düzlem dizi eksenidir), ana hüzme, HPBW, Dmax ve her portun aktif yansıması. Dizi örüntüsü gösterilirken 3B port etiketlerinde besleme görünür (`P2 · 0.0 dB ∠ −90°`). *Dizi / Eleman Pn* seçimi, 3B görünümde geçerli beslemeye sahip diziyi veya uzak alan seçiminde belirtilen portun gömülü eleman örüntüsünü gösterir. Örüntü sekmesi diziyi ve bu elemanı aynı kesit düzleminde üst üste gösterir (tarama düzlemine göre φ 0° veya 90°). Paket ve PDF raporu geçerli ağırlıklarla dizi örüntüsünü içerir. Alan eşlemesi `src/lib/sparams.ts`, hesaplar `src/lib/array.ts` içindedir. `npm run check:array`, bunları `examples/synthetic/array2x1.json` sentetik paketiyle analitik durumlara karşı sınar (simülasyon değil, test verisidir; *Aç* ile veya sürükleyip bırakarak açın).

Dizi hesapları, normalizasyon ve 2×1 ile 4×1 gösterimleri [ARRAYS.md](ARRAYS.md) sayfasındadır.
