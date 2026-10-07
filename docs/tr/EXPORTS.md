# Çizimler, şekiller, dışa aktarma paketi ve üretim dosyaları

## Geçerli görünümü dışa aktarın

Üst bölümdeki **Dışa aktar** menüsü görünür çalışma alanını izler. **Ekran görüntüsü**, etkin görünümü yakalar; görünüm boşsa veya kullanılamıyorsa yakalama devre dışıdır ve nedeni gösterilir. İptal ve hatalar dahil dışa aktarım sonuçları genel bildirimde görünür.

| Görünür çalışma alanı | Kullanılabilir dışa aktarımlar |
| --- | --- |
| Tasarım 3B | Geometri, geçerli tasarım JSON'u ve Python kaynağı, ekran görüntüsü |
| Tasarım sonuç sekmesi | Etkin sonuç grafiğinin desteklediği veriler ve şekiller |
| Örnekler 3B | Geometri ve mevcut sonuç verileri/şekilleri |
| Örnekler Çizim | Çizim SVG, PDF ve PNG |

Geometri dışa aktarımı ikili STL, GLB, Blender render paketi ve CST uyumlu VBA makrolarını (`.bas`) destekler. Birimler, dönüşümler ve biçim sınırları için [Blender ve mesh dışa aktarımı](BLENDER.md) sayfasına bakın. Geometri ve JSON çıktıları kaydedilmemiş düzenlemeler dahil geçerli taslağı kullanır; Python çıktısı önce düzenlemeleri kaydeder, kayıt başarısız olursa veya çakışırsa durur. Boş geometriden mesh üretilemez ancak tasarım kaynağı dışa aktarılabilir. Görünüm değiştiğinde menü kapanır; böylece önceki grafik veya tuval yanlışlıkla yakalanmaz.

### VBA makrosu dışa aktarımında parametreler

Bir tasarımda Dışa aktar penceresi açıldığında VBA makrosu **parametriktir**: her tasarım parametresi değeri ve açıklamasıyla bir makro parametresi olur. Bunları kullanan ifadeler VBA ifadesi olarak yazılır; parametre değiştiğinde model de değişir:

- Kutu sınırları, silindir yarıçapı/aralığı/merkezi, küre merkezi ve yarıçapı, çokgen noktaları, yüksekliği ve uzatma uzunluğu, ayrık port uçları ve empedansı, dielektriğin bağıl dielektrik sabiti ve frekans bandı;
- türetilmiş parametreler ifade olarak kalır (`W*2`, `Sqr(W*L)/10 + (299.792458/f_min)/100`). Fairbeam işlevleri VBA karşılıklarına çevrilir (`sqrt` → `Sqr`, `atan` → `Atn`, `floor` → `Int`, `wavelength(f)` → mm cinsinden `299.792458/f`; `log10`, `radians`, `degrees`, `//` ve `%` açık ifadelerle yazılır); `atan2` ve `round(x, digits)` için VBA karşılığı yoktur;
- adların harfleri, rakamları ve `_` korunur; makro dilinin kabul etmediği adlara (`sin`, `pi`, `Name`, `eps0` ...) veya yalnızca harf büyüklüğüyle ayrılan adlara ek getirilir. Makro, tasarım parametresi ile makro parametresi eşleşmesini belirtir;
- `.bas` içindeki parametreler `MakeSureParameterExists` komutlarıdır (geçmiş yeniden oluşturulurken `StoreParameter` reddedilir).

Sayı olarak kalanlar pencerede ("Sayı olarak yazılanlar") ve makronun üst yorumlarında listelenir: dönüşüm, kesik veya Boolean sonucu içeren katılar (paket ifadeyi değil sonucu tutar); kutu, çokgen, silindir ve küre dışındaki şekiller; dalga kılavuzu portları ve toplu elemanlar; ifadesi dışa aktarılan değeri vermeyen alanlar; VBA karşılığı bulunmayan ifadeler; model mm dışında birimle dışa aktarılıyorsa her şey. Tasarım olmadan (görüntüleme için açılmış örnek, dışa aktarma paketi) çıktı önceki gibi sayısaldır.

## Çizimler, şekiller ve dışa aktarma paketi

- **Teknik çizim.** Örnekler görüntüleyicisinde (Ana ekran › Örnekler) görünüm üstündeki *3B | Çizim* seçimi, tasarımı tam geometrik şekillerinden üretilen siyah beyaz mühendislik çizimi olarak gösterir: üst, ön, yan (varsayılan üçüncü açı, isteğe bağlı birinci açı) ve izometrik görünüş; ISO 128 çizgi kalınlıkları; kenardan görülen dielektriklerde 45° kesit taraması; kenardan görülen PEC levhalarda dolu siyah çizgi; sonsuz PEC yarı uzayı için toprak simgesi; ayrık port simgesi ve otomatik ölçüler (boyutlar, alttaş kalınlığı, besleme kayması ve aralığı, çentikler ve içeri besleme yarıkları, besleme hattı genişliği ve uzunluğu, Sierpinski yapısındaki 60° gibi tepe açıları; aynı konturlar bir kez ölçülür ve belirtilir). *Diğer* ile parametre etiketleri ("patch_w = 32", şekil modunda varsayılan açık), izometrik görünüşte kesikli gizli kenarlar, çizgi türü açıklaması ve görünüş başına ölçülendirme seçimi eklenir. Sayfalar: antetli A4 veya A3 (parametreler, malzemeler, ölçek, izdüşüm simgesi) ya da LaTeX/Word için *Şekil* (16 cm genişlikte, sayfasız). SVG, vektör PDF (gömülü IBM Plex Sans) veya 300 dpi PNG olarak dışa aktarın. Kod: `src/drawing/` (saf TypeScript, paket → SVG).
- **Yayın şekilleri.** Örnekler görüntüleyicisinin alt panel çubuğundaki *Şekil*, siyah beyaz |S11|, Zin, Smith abağı ve kutupsal örüntü grafiklerini 8,8 cm (tek sütun) veya 18 cm (çift sütun) genişlikte SVG/PDF olarak aktarır.
- **Dışa aktarma paketi.** Üst bölümdeki *Paketi dışa aktar* (tasarımcıda ayrıca Son işlem › Rapor ve dışa aktarma › **Paket**), `<model-id>_<yyyymmdd-hhmm>.zip` indirir. İçeriği: `project.json`, `README.md` raporu (kurulum, çalıştırma, sonuçlar, yeniden üretme komutu), `data/s11.s1p` (Touchstone v1, `# GHz S RI R 50`), CSV verileri, çizimler, şekiller, VBA makrosu, 3B görünüm PNG'si ve `report.pdf`.
- **PDF raporu.** Paket penceresindeki *Raporu dışa aktar (PDF)* (tasarımcıda ayrıca Son işlem › Rapor ve dışa aktarma › **PDF raporu**) çok sayfalı A4 vektör PDF oluşturur: temel sonuçlarla özet, ölçülü çizim, parametre/çözücü/mesh/çalıştırma tabloları, |S11|, Zin, Smith abağı, her uzak alan frekansı için örüntü sayfası ve yeniden üretme komutu. Sayfalar SVG olarak oluşturulur, `src/drawing/svgpdf.ts` tarafından jsPDF ile çizilir; aynı kod Node'da da çalışır.
- `npm run check:exports` bunları örnek paketlerde doğrular ve [examples/drawings/](../examples/drawings/) ile [examples/reports/patch-antenna.pdf](../examples/reports/patch-antenna.pdf) çıktılarını yazar.

## Eşleşen bant CSV sütunları

Dışa aktarma paketindeki `data/bands.csv` dosyasında her eşleşen bant için bir satır vardır; sütunlar şu sırayladır:

| Sütun | Anlamı |
| --- | --- |
| `f_lo_GHz`, `f_hi_GHz` | GHz cinsinden bant sınırları |
| `f_center_GHz` | Sınırların ortası, `(f_lo + f_hi) / 2`, GHz cinsinden |
| `f_best_GHz` | Bant içindeki minimum S11 frekansı, GHz cinsinden |
| `s11_min_dB` | dB cinsinden minimum S11 |
| `fractional_bw` | Genişliğin bant ortasına bölümü; yüzde değil, kesir olarak |
| `bandwidth_MHz` | MHz cinsinden bant genişliği |
| `edge_lo`, `edge_hi` | O uç simülasyon aralığına değiyorsa `true`, değilse `false` |

Açık bantta `edge_lo=true`, alt ucun bir üst sınır (≤), `edge_hi=true` ise üst ucun bir alt sınır (≥) olduğu anlamına gelir. İki bayraktan biri, tablolarda olduğu gibi bant genişliğini ve bağıl bant genişliğini alt sınır yapar. Yalnızca alt uç açıksa merkez bir üst sınırdır, yalnızca üst uç açıksa bir alt sınırdır; iki uç da açıksa merkezin yönlü bir sınırı yoktur. Tüm frekans ve bant genişliği hücreleri sayısal kalır.

Özet sekmesinin CSV dışa aktarımı ve kopyalanan TSV, bant başına sütunlarında aynı tanımları kullanır: `Band low (GHz)`, `Band high (GHz)`, `Band center (GHz)`, `Band best match (GHz)`, `Band bandwidth (MHz)`, `Band fractional BW`, `Band edge low` ve `Band edge high`. Uç bayrakları sayısal `1` (açık) veya `0` (kapalı) olarak yazılır; eksik bantlar boş hücre bırakır. Birden çok bantta her grup numaralanır (`Band 1 low (GHz)` gibi). Başlıktaki `Bandwidth (%)`, en derin bandın bağıl bant genişliğinin 100 katıdır.

**Uyumluluk:** `f_center_GHz` daha önce minimum |S11| frekansını tutuyordu; bu değere ihtiyaç duyanlar artık `f_best_GHz` sütununu okumalıdır. Paket JSON'ı en iyi uyum için hâlâ `f_center` kullanır ve saklanan `fractional_bw` değeri bu frekansa böler ([BUNDLE.md](BUNDLE.md#results)).

## Üretim dosyalarını dışa aktarma (önizleme)

Dışa aktarma paketindeki *Üretim dosyaları*, baskı devre tasarımlarına (yama antenler, mikroşerit hat, Wilkinson bölücü, dal hat kuplörü, alçak geçiren filtre, 2×1 ve 4×1 diziler) `fab/` klasörü ekler:

- **Gerber X2** (X2 öznitelikli RS-274X, mm, 4.6 biçimi): bakır katmanı başına dosya (`<id>-F_Cu.gbr`, `<id>-B_Cu.gbr`, varsa iç katmanlar); bakır bölgelerle çizilir, kart dış çizgisi `<id>-Edge_Cuts.gbr` olarak yazılır (alttaşın izi). Katmandaki çakışan şekiller temiz konturlarda birleştirilir (dik açılı şekillerde tam; eğik şekiller ayrı çakışan bölgeler olarak kalır, Gerber görüntüleyici bunları birleşim olarak gösterir).
- **Excellon delik** (`<id>-PTH.drl`), takım tablosuyla. Sonda beslemesi, toprakta 4,2 mm açıklık halkası olan 1,3 mm metalize deliğe dönüşür (SMA için boyutlandırılmıştır; varsayılanlar `src/fab/layers.ts` içindedir). Kenar portları delinmez: `README.txt`, bunları kenar konnektör konumu, toplu elemanları (Wilkinson yalıtım direnci) yerleştirme notu olarak listeler.
- Mekanik CAD veya lazer/freze iş akışları için katman başına **DXF R12** (adlandırılmış katmanlarda kapalı çoklu çizgiler, açıklık halkaları ve delikler daire olarak).
- **`fab/README.txt`**: katman yapısı (εr, tan δ, kalınlık), kart boyutu, katman başına bakır, delikler, konnektörler, notlar.

Baskı devre olmayan tasarımlar (serbest uzaydaki dipol, sonsuz PEC toprak üzerindeki Sierpinski monopol) için üretim çıktısı yoktur; pencere nedenini belirtir. Sonsuz PEC toprakla simüle edilen tasarım alt bakır olmadan ve bir notla dışa aktarılır.

Sınırlar: simülasyon sıfır kalınlıklı mükemmel iletken kullandığından README'deki 35 µm bakır, simülasyon sonucu değil varsayımdır. Lehim maskesi, baskı yazısı veya pasta katmanı yazılmaz. Açıklıkları, minimum hat ve aralıkları, toleransları ve konnektör ayak izini üreticinizin kurallarıyla kontrol edin. Siparişten önce her dosyayı KiCad GerbView gibi bir Gerber görüntüleyicide açın. `npm run check:fab` (`check:exports` kapsamındadır), Gerber, delik ve DXF dosyalarını geri okur; bakır alanlarını, sınırlayıcı kutuları ve delik konumlarını paket geometrisiyle 1 µm içinde karşılaştırır. Yama anten ve Wilkinson bölücü için [examples/fab/](../examples/fab/) yazar; her birinde okunan dosyalardan çizilen `render.svg` bulunur.
