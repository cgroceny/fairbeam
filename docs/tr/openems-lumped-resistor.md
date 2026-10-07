# openEMS toplu dirençleri: doğruluk denetimi (openEMS geliştiricileri için tekrarlama)

**Sonuç: openEMS toplu dirençleri doğrudur.** Doğrudan elemanda ölçüldüğünde, 0,5–6 GHz arasında direncin gerçek kısmındaki hata %0,1'den küçüktür. Küçük paralel reaktans prob kutusundan kaynaklanır. Sonuç; direnç değerinden (30–300 Ω), akım doğrultusundaki veya ona dik hücre sayısından (1–8), `caps` ayarından ve elemanın sıradan bir `LumpedElement` ya da pasif bir `LumpedPort` olmasından bağımsızdır. Aynı dirence sahip kayıplı bir malzeme bloğu da aynı davranışı gösterir.

Test düzeneği üzerinden gözlenen, frekansa bağlı gibi görünen hata, düzenek etkisini giderme işleminin (de-embedding) bir artefaktıdır. Düzenek uzunluğuyla ölçeklenir; R'den, eleman türünden ve mesh'ten bağımsızdır. Daha önce belirtilen “2,4 GHz'de +%10” tahmini, mikroşerit test hattının farklı bir mesh'e sahip referans hatla düzeltilmesinden kaynaklanıyordu ve yanlıştı. Üst projeye hata olarak bildirilecek bir durum yoktur. Buradaki betik ve veriler, kontrol etmek isteyen herkes içindir.

## Tekrarlama

`python/examples/lumped_resistor_test.py` yalnızca openEMS, CSXCAD ve numpy kullanır:

```bash
python python/examples/lumped_resistor_test.py --kind lumped --R 100               # upstream openEMS (CPU)
python python/examples/lumped_resistor_test.py --kind port --R 50 --engine gpu     # openEMS GPU fork
```

**Düzenek.** İki PEC levha (uzunluk a, genişlik w), MUR sınır koşullarına sahip serbest uzayda z doğrultusunda g aralıkla yerleştirilir. x = 0'da 50 Ω'luk bir ayrık port aralığı uyarır; test edilen eleman (DUT), x = a'da bu aralığı birleştirir. DUT türleri:

- `lumped` ve `lumped-nocaps`: `AddLumpedElement(ny=2, caps=True/False, R=R)`
- `port`: `excite=0` olan pasif bir `LumpedPort`
- `material`: κ = g / (R w t) olan bir blok

Her durum üç çalıştırma gerektirir: açık devre (DUT yok), kısa devre (DUT yerine metal) ve DUT. DUT empedansı, açık-kısa devre de-embedding işlemiyle elde edilir:

```
Y'_m = 1/Z_m − 1/Z_open,   Y'_s = 1/Z_short − 1/Z_open,   Z_dut = 1/Y'_m − 1/Y'_s
```

DUT olarak pasif port kullanıldığında betik, **doğrudan DUT üzerinde ölçülen −U/I değerini** de raporlar. Bunlar, arada düzenek olmadan elemanın kendi problarından alınan gerilim ve akımdır. Uyarım, DC içermeyen bir Gauss türevidir; durdurma ölçütü −60 dB'dir. Aşağıdaki tablonun 14 durumunun tamamı openEMS Metal GPU türevinde 8 s'de çalıştırılmıştır. CPU motoru aynı değerleri daha uzun sürede verir.

## Veriler (Z_dut / R, a = w = g = 1 mm; aksi belirtilmedikçe 4 × 4 hücre)

| Durum | 1 GHz | 2,4 GHz | 4 GHz | 6 GHz |
| --- | --- | --- | --- | --- |
| **Pasif port, elemanda −U/I**, R = 100 Ω | 1,000 | **1,000 − 0,007j** | | **0,999 − 0,017j** |
| Pasif port, elemanda −U/I, R = 50 Ω | 1,000 | 1,000 − 0,008j | | 0,998 − 0,020j |
| Toplu eleman (caps), düzenek etkisi giderilmiş, R = 30 / 100 / 300 Ω | 0,999 | 0,993 | 0,981 | 0,959 |
| Toplu eleman, 2 × 2 hücre | 0,999 | 0,993 | 0,979 | 0,954 |
| Toplu eleman, 8 × 8 hücre | 0,999 | 0,994 | 0,982 | 0,961 |
| Toplu eleman, akım doğrultusunda 1 hücre | 0,998 | 0,990 | 0,972 | 0,937 |
| Toplu eleman, akım doğrultusunda 8 hücre | 0,999 | 0,994 | 0,983 | 0,962 |
| Toplu eleman, enine 1 hücre | 0,999 | 0,994 | 0,983 | 0,962 |
| Toplu eleman, `caps=False` | 0,999 | 0,993 | 0,981 | 0,959 |
| DUT olarak pasif port (düzenek etkisi giderilmiş) | 0,999 | 0,993 | 0,981 | 0,959 |
| Kayıplı malzeme bloğu (κ) | 0,999 | 0,993 − 0,002j | 0,981 − 0,004j | 0,958 − 0,005j |
| Düzenek aralığı 2 mm | 0,998 | 0,990 | 0,972 | 0,937 |
| Düzenek levhaları a = 0,5 mm | 1,000 | 0,997 | 0,992 | 0,983 |

**Tablonun yorumu.**

- Düzenek etkisi giderilen değer, tüm R değerleri, eleman türleri (caps bulunan veya bulunmayan toplu eleman, port, kayıplı malzeme) ve mesh'ler için aynı olan 1 − k f² çarpanını gösterir. Bu çarpan yalnızca düzenek boyutuyla değişir: 6 GHz'de a = 0,5 mm için 0,983, a = 1 mm için 0,959 ve 2 mm aralık için 0,937 elde edilir. Bu, açık-kısa devre modelinin toplu eleman varsayımının kısa bir iletim hattı olan düzeneğe uygulanamamasının göstergesidir. Dirençle ilgisi yoktur.
- Elemanda ölçüldüğünde gerçek kısım doğrudur. Sanal kısım (2,4 GHz'de R'nin −%0,7'si, 6 GHz'de −%1,7'si), prob kutusundan kaynaklanan yaklaşık 5 fF'lık paralel kapasitansa karşılık gelir.

## Fairbeam açısından sonuçlar

- **Telafi gerekmez;** bu nedenle `Simulation.lumped_resistor(..., compensate=...)` eklenmemiştir.
- **Sonlandırılmış portlar doğru sonlandırmalardır.** Her durumda Fairbeam'in S-matrisi bunlara bağımlı değildir: her port uyarıldığında `S = B A^-1` olarak oluşturulur ve bu ifade her sonlandırma için doğrudur. Yalnızca kısmi uyarım (`b_i/a_j`) uyumlu sonlandırmalar varsayar.
- **Wilkinson çıkış uyumundaki artık fark** (VALIDATION.md, bölüm 8), dolayısıyla bir direnç modelleme hatası değildir. Aynı yerleşimde toplu eleman yerine kayıplı malzemeden direnç gövdesi kullanılması aynı tek-mod empedansını verir: 34,1 + j3 Ω'a karşılık 34,2 + j3 Ω.
