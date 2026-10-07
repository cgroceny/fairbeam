# Tasarımcı

Tasarımcı, Fairbeam'in görsel modelleme çalışma alanıdır: 3B görünümün üzerinde tek satırlık şerit, solda gezinti ağacı, sağda seçimin özellikleri, altta denetimler, parametreler ve çalıştırma ilerlemesini içeren alt panel ile durum çubuğu bulunur. Çalıştırma sonuçları 3B görünümün yanında sekmelerde açılır. Modelden ayrılmadan şekiller çizebilir veya ekleyebilir, malzeme atayabilir, port yerleştirebilir, simülasyonu ayarlayıp openEMS'i çalıştırabilir ve sonuçları inceleyebilirsiniz.

Tasarım Python değil, `<name>.design.json` adlı veri dosyasıdır. Fairbeam'in diğer bölümleri (CLI, taramalar, optimizasyon aracı, Çalıştırma paneli) tasarımı herhangi bir model gibi işler; tasarımı dilediğiniz zaman Python model dosyası olarak dışa aktarabilirsiniz.

Tasarımcı çalıştırma sunucusunu gerektirir (`fairbeam serve`, bkz. [RUN-SERVER.md](RUN-SERVER.md)). Masaüstü uygulaması ([DESKTOP.md](DESKTOP.md)) bunu sizin için başlatır. Herkese açık demo salt okunurdur ve tasarımcı içermez.

## Ana ekran

![Ana ekran: yeni tasarım, tasarımlarınız, Python modelleri ve örnekler](designer/start.png)

Çalıştırma sunucusuna erişilebildiğinde ana ekran açılır. Üç bölümü vardır:

- **Yeni tasarım**: ad (siz yazana kadar şablondan doldurulur) ve şablon. Dosya adı tasarım adından türetilir (`Dual-band patch` → `dual_band_patch.design.json`). “Boş tasarım”, frekans bandı (f0 × 0,6–1,4, MUR sınırları, −50 dB durdurma ölçütü), bakır ve boş geometri verir. Dielektrik içermez; alttaş gerektiğinde Malzemeler › Dielektrik ekle, FR4 veya başka kütüphane malzemesini kopyalar. Şablonlar Temel antenler, Baskılı ve Devreler gruplarındaki küçük parametrik tasarımlardır (aşağıdaki [Şablonlar](#starters) bölümüne bakın). **Oluştur ve tasarımcıyı aç**, dosyayı oluşturup açar. **VBA makrosunu içe aktar…**, CST uyumlu VBA makrosudan veya geçmiş listesinden (`.bas`, `.mcs`, `.txt`) tasarım oluşturur (bkz. [VBA makrosu içe aktarma](#importing-a-vba-macro)); **PCB çizimini içe aktar…** ise DXF veya Gerber dosyalarını kullanır (bkz. [PCB çizimi içe aktarma](#importing-pcb-artwork-dxfgerber)).
- **Tasarımlarınız**: ada, kimliğe veya dosya adına göre arayın, ada veya son değişikliğe göre sıralayın ve sık kullanılan tasarımları yıldızlayın. Favoriler önce görünür; favori filtresi ve sıralama tercihi bu tarayıcıda hatırlanır. Değişiklik zamanı olmayan eski girdilerde ad kullanılır. Bir tasarımı tasarımcıda açın. Kayıtlı tasarıma sağ tıklayarak (veya satır odaktayken Shift+F10 ile) görünen adını **Yeniden adlandır** seçeneğiyle değiştirin ya da masaüstü uygulamasında **Dosya Gezgini'nde göster** seçeneğini kullanın. Yeniden adlandırma dosyayı, kimliği ve mevcut sonuçları korur; Ana ekranda **Geri Al** sunar. Açık tasarımın değişikliklerini önce kaydedin. Çöp kutusu simgesi onaydan sonra tasarımı siler; dosya model geçmişi klasörüne taşınır ve geri getirilebilir. Açılamayan tasarım dosyası (bozuk veya daha yeni Fairbeam ile oluşturulmuş) nedeni belirtilerek soluk renkle listede kalır.
- **Python modelleri** ve **Örnekler**: modeli Çalıştırma panelinde, örneği sonuçlarıyla birlikte Örnekler modunda açın. Örneğin yanındaki **Yeni tasarım olarak aç…**, bundan size ait düzenlenebilir tasarım oluşturur. Tasarımlarınızın çalıştırmaları burada listelenmez; tasarımın altında açılır (bkz. [Çalıştırma ve sonuçlar](#running-and-results)).

Alt bilgideki **Geri bildirim gönder** bağlantıları tarayıcınızda herkese açık sorun takip sayfasını açar; bkz. [Geri bildirim](#feedback).

Ana ekran önce kendi Python modellerinizi, sonra *örnek, salt okunur* işaretli yerleşik örnek modellerini listeler. Tıklamak Çalıştırma panelinde açar (yerleşik model kopyalamayı veya olduğu gibi çalıştırmayı sorar); kopyalama düğmesi düzenlenebilir tasarım oluşturur. Ana ekranda üst çubuğun **Python modeli çalıştır…** düğmesi bu listeye kaydırır. Örnekler kartı, örnekleri bantları ve mesh boyutlarıyla üst çubuktaki seçici gibi gruplar. Yeni tasarımın dosya adı, adının ASCII biçimidir. Ad yerleşik örnek kimliğiyle aynıysa sayı eklenir (Patch antenna, `patch_antenna_2.design.json` olarak kaydedilir); Ad alanının altındaki satır bunu gösterir. **Farklı kaydet…** (Giriş şeridi › Tasarım, üst çubuğun Diğer menüsü, tarayıcının sayfaya bıraktığı yerde Shift+Ctrl+S veya ⇧⌘S, masaüstünde Dosya › Farklı Kaydet), açık tasarımın kopyasını yeni adla kaydeder.

Üst çubuğun **Ana ekran · Tasarım · Örnekler** seçicisi ana ekran, tasarımcı ve örnekler arasında geçiş yapar:

Üst çubuktaki **Diğer** menüsü ikincil işlemlere ok tuşları ve Escape ile erişim sağlar. **Sonuç veya tasarım dosyası aç…** burada ve masaüstünde **Dosya → Aç** yolunda bulunur: sonuç dosyası (çalıştırmanın `.json` dosyası) Örnekler'de açılır; tasarım dosyası (`.design.json`, örneğin bir çalışma arkadaşınızın Dışa aktar › Geçerli tasarım JSON'u çıktısı) çalışma klasöründe adından türetilmiş boş bir dosya adıyla yeni tasarım olarak oluşturulur ve Tasarım'da açılır. Dosyayı pencereye sürükleyip bırakmak aynı işlemi yapar. Tasarım açıldığında kayıtlı çalıştırmaları ağaçta **Sonuçlar** altında listelenir; elle dosya açmadan görüntülemek için çalıştırmayı seçin.
Dar pencerelerde ağaç ve özellikler panelleri aynı açılır alanı paylaşır; böylece tuvalin iki yanını aynı anda kapatmazlar. Pencere genişletildiğinde ayrı ayrı hatırlanan masaüstü panel tercihleri geri gelir. Genel Ayarlar ve Hakkında açıldığında odağı alır; iletişim kutuları Tab odağını içeride tutar, arka planı yalıtır ve kapanınca odağı geri verir. Bir iç kontrol önce işlemezse Escape en üstteki pencereyi kapatır.

- **Tasarım**, kendi çalıştırmalarını içerir. Gezinti ağacında Sonuçlar altında listelenip yerinde açılırlar: 3B görünüm, çalıştırmanın geometrisini örüntü veya yüzey akımlarıyla; alt panel grafiklerini gösterir.
- **Örnekler**, [README](../README.md) ve [RESULTS.md](RESULTS.md) içinde açıklanan görüntüleyicidir. Sonuçları hazır yerleşik örnekleri ve Python modellerinizin çalıştırmalarını gösterir. Üst çubuktaki aranabilir sonuç seçici (filtrelemek için yazın, modele göre grupludur) bunları listeler; tasarımlarınızın çalıştırmaları burada yer almaz. **Yeni tasarım olarak aç…** (seçicinin yanında ve model panelinde), açık örnekten düzenlenebilir tasarım oluşturur. Tasarım biçiminin temsil edemediği örnekte veya yerleşik örnek olmayan sonuçta devre dışıdır; nedeni ipucunda gösterilir. Sonuç kendi tasarımlarınızdan birinden simüle edilmişse model panelinde **Tasarımcıda aç** görünür. Çalıştırma sunucusu yokken (herkese açık demo) her sonuç örnektir ve Tasarım kullanılamaz.

  **Python örneğinin kopyası neleri içerir?** Penceredeki not bunları listeler. Örnek, açık sonucun değerleriyle (yerleşiklerde varsayılanlarıyla) oluşturulur; şekiller, malzemeler, portlar, bant, sınırlar ve kendi mesh çizgileri (1e-6 mm'ye yuvarlanmış) geri okunur. Aynı metaller tek malzeme paylaşır (katıların adları korunur). Örneğin **parametreleri** de aktarılır: Fairbeam her sayısal parametreyi biraz değiştirerek örneği yeniden oluşturur (parametre başına en fazla iki oluşturma, hiçbir şeyi değiştirmeyen parametrede bir). Parametrelerin tam doğrusal işlevi olan (1e-9 içinde) her koordinat veya değer ifade olarak yazılır: yama örneğinin kutusu `-patch_w/2, -patch_l/2, sub_h` ile `patch_w/2, patch_l/2, sub_h`, dielektrik sabiti `eps_r`, beslemesi `feed_x` olur. Böylece kopya bu parametrelerle kendi tasarımınız gibi taranabilir ve optimize edilebilir. Bu koordinatlarda duran mesh çizgileri onları izler; aradaki çizgiler oransal yerlerini korur, mesh geometriyle esner. Büyük geometri parametresi değişiminden sonra **Otomatik mesh'e geç** (Simülasyon ayarları) daha güvenlidir. Diğer sayılar sabit sayı kalır. Hiçbir ifadede görünmeyen parametre (yalnızca `mesh_div` gibi mesh'i veya fraktalın `iterations` değeri gibi model yapısını değiştiriyorsa) kopyaya eklenmez; açıklamada oluşturulduğu değerle listelenir. Aktarılan parametre *kısmen izleniyor* olarak işaretlenebilir: örnek başka boyutları bundan doğrusal olmayan kuralla türetiyorsa (`eps_r` üzerinden mikroşerit genişliği, `f0` üzerinden saplama uzunluğu), parametreyi değiştirdiğinizde bu geometri varsayılan boyutunda kalır. Örneğin sonuçları kopyaya dahil değildir; kendi sonuçlarınız için kopyayı çalıştırın.

### Şablonlar

Her şablonda tasarım frekansı `f0`, PML sınırları (8 hücre; yama hariç, onda MUR), dalga boyu başına 20 hücreli otomatik mesh, −60 dB durdurma ölçütü, antenlerde f0'da uzak alan ve f0'da tanımlı kayıp tanjantları vardır (openEMS, tan δ'yı sabit iletkenlik olarak uygular; dolayısıyla yalnızca bir frekansta tam doğrudur). Her biri saniyeler içinde simüle edilir ve denetim hatası veya uyarısı yoktur. Aşağıdaki sayılar her birinin varsayılanlarla tek çalıştırmasından alınmıştır (GPU motoru):

| Şablon | Yapısı | Varsayılanlarla sonuç |
| --- | --- | --- |
| Yarım dalga dipol | Serbest uzayda 1 mm PEC şerit; merkezde 1 mm aralığı geçen 50 Ω portla beslenir; uzunluğu f0'da `k` dalga boyudur (0,466; 2,4 GHz'de 58,2 mm) | 2,389 GHz'de S11 −15,0 dB, Dmax 2,17 dBi |
| Çeyrek dalga monopol | Sonlu kare toprak düzleminde (0,8 λ) yüksekliği `k` = 0,233 dalga boyu olan 1 mm şerit; tabanda 50 Ω sonda portuyla beslenir; 2,4 GHz | 2,393 GHz'de S11 −17,7 dB, Dmax 3,12 dBi (küçük toprak düzlemi hüzmeyi yukarı eğer) |
| Açık uçlu dalga kılavuzu | Açık ucundan ışıyan WR-90 kılavuz (22,86 × 10,16 mm, 50 mm uzunluk); arka kısa devreden çeyrek kılavuz dalga boyu öndeki TE10 portla beslenir; 10 GHz, bant 8-12 GHz | 10 GHz'de S11 −9,9 dB, 12 GHz'de −11,5 dB, Dmax 6,60 dBi |
| Yama anten şablonu | 60 mm toprak düzlemi üzerinde RO4003C benzeri alttaşta (tan δ 0,0027) sonda beslemeli yama, 2,45 GHz | 2,45 GHz'de −41 dB S11 ve yaklaşık %88 ışıma verimliliği (yama örneğinin %96,5 değeri daha düşük tan δ = 0,001'den gelir) |
| Baskılı kılıflı dipol | [examples/designs/sleeve_dipole_867.design.json](../examples/designs/sleeve_dipole_867.design.json), dosyadaki gibi parametrik: ince FR-4 şerit üzerinde, toprak düzlemsiz, İHA için koaksiyel beslemeli kılıflı dipol; ayarlandığı gibi dalga boyu başına 30 hücre, bant boyunca verimlilik | 0,877 GHz'de S11 −19,6 dB (radom için %1,1 yüksek), Dmax 2,10 dBi, bant boyunca ışıma verimliliği 0,977-0,990 |
| Mikroşerit hat (iki portlu) | 1,6 mm FR-4 (εr 4,3, tan δ 0,02) üzerinde 3,1 mm genişlikte, 40 mm uzunlukta hat; her ucunda 50 Ω port; parametreler Hammerstad Z0 (50,4 Ω) ve ε_eff gösterir. Tam S-matrisi için iki port ayrı ayrı uyarılır; uzak alan yoktur | 2,4 GHz'de S11 −29,7 dB ve S21 −0,3 dB |

Piramit huni anten şablonlar arasında değildir: genişleyen duvarları, eksenlere dik olmayan düzlemlerde levhalardır ve tasarım biçimi bunları temsil edemez (çokgenler eksen düzlemlerindedir; ızgara eksenleri dışına döndürülmüş sıfır kalınlıklı levha reddedilir, ancak katı herhangi bir açıyla döndürülebilir). Açık uçlu dalga kılavuzu aynı TE10 portunu kullanır; huni için `python/models/pyramidal_horn.py` Python modelini kullanın. Dalga kılavuzunda Prad/Pacc 1,11 okunur (huninin 1,04 değeri [VALIDATION.md](VALIDATION.md#13-pyramidal-horn-with-a-waveguide-port) içinde açık konudur); bu nedenle kazanç yerine yönlülüğü okuyun.

## Çalışma alanı

![Modelleme sekmesindeki tasarımcı: şerit, gezinti ağacı, 3B görünüm, özellikler, alt panel ve durum çubuğu](../landing/media/designer-modeling.jpg)

- **Şerit**: **Giriş**, **Modelleme**, **Dönüştür**, **Görünüm**, **Simülasyon**, **Optimizasyon** ve **Son işlem** adlı yedi sekmeden oluşan tek satır. Sekmelerin grupları:
  - Giriş:
    - Tasarım: Ana ekran, Makro içe aktar, PCB içe aktar, Kaydet, Kapat, Kısayollar.
    - Düzenle: Geçmiş (modelleme geçmişi), Geri Al, Yinele, Çoğalt, Sil.
  - Modelleme:
    - Araçlar: Boolean (Birleştir, Çıkar, Kesiştir, Ekle), Nokta seç, Ölç, Hizala, Yüz hizala, Yüzü uzat, Nokta düzenle.
    - Şekiller: Kutu, Silindir, Küre, Çokgen, Uzat, Koni, Torus, Tel.
    - Çalışma düzleminde çiz: Kutu, Daire, Çokgen.
    - WCS: Yüze hizala, WCS dönüştür…, Global ile hizala, WCS göster.
    - Malzemeler: Kütüphane, Dielektrik ekle, Metal ekle.
    - Parametreler: Parametre.
  - Dönüştür: Dönüştür…, seçili katı veya şeklin dönüşüm penceresini açar. Döndür, Ölçekle, Aynala ve Ötele kopyaları, ilgili işlem seçili olarak açar. Bkz. [Dönüşümler](#transforms).
  - Görünüm: kamera hazır ayarları, Sığdır ve Ekran görüntüsü, ardından geometri/katman görünürlük kontrolleri. Kılavuz ızgara hem referans ızgarasını hem etkin çizim düzlemi ızgarasını kontrol eder; yakalamayı kapatmaz. Toprak düzlemi yalnızca modelin PEC yarı uzay geometrisini kontrol eder. Mesh görünümü, Simülasyon › Mesh ile aynı anahtarı kullanır. Görünüm, kamerası ve katmanları ayarlanabilsin diye etkin 3B sonucu korur.
  - Simülasyon:
    - Frekans bandı ve yer varsa f min/f max alanları.
    - Sınırlar.
    - Mesh: yer varsa Hücre / λ alanı, Mesh ayarları, Mesh yakınsaması…, Mesh görünümü.
    - Portlar: Ayrık, Dalga kılavuzu, Toplu eleman ekle….
    - Monitörler: Uzak alan, Yüzey akımı, Verimlilik, Alan düzlemi.
    - Çözücü: Çözücü sınırları.
    - Çalıştır.
  - Optimizasyon: Parametre taraması, Optimizasyon aracı.
  - Son işlem: açılacak sonuç sekmeleri (Özet, S-parametreleri, Smith, Verimlilik, Örüntü, 3B örüntü, Akımlar, Alan düzlemi, Alan haritası), Uzak alan (örüntü niceliği, yalnızca örüntü gösterilirken) ve Rapor ve dışa aktarma (PDF raporu, Paket, Python).

  Şerit son sekmeyi hatırlar; katısı olmayan tasarım Modelleme'de açılır. Sonuç göstermek Son işlem'e geçirir; geometriye dönmek ayrıldığınız sekmeyi açar. Sekmeye çift tıklamak, sağdaki ok veya Ctrl+F1 (macOS'te ⌃F1) şeridi küçültür. Pencere daraldıkça düğmelerin etiketleri gizlenir (adları ipucunda kalır), ardından gruplar açılır düğmelere katlanır; tüm komutlara erişim korunur.
- **Gezinti ağacı** (sol): tasarım ve **Parametreler** satırı (alt panelin Parametreler sekmesini açar), ardından **Katılar**, **Malzemeler**, **Portlar**, **Toplu elemanlar** ve **Sonuçlar**. Kırmızı veya sarı işaret, bir denetimin bu öğeyi işaret ettiğini gösterir. Simülasyon ayarları ağaçta değil, şeridin Simülasyon sekmesindedir. Bkz. [Gezinti ağacı](#the-navigation-tree).
- **Ana alan**: **3B görünüm** ilk sekmedir ve kapanmaz; çalıştırmanın sonuç görünümleri (S-parametreleri, Empedans, VSWR, Smith, Verimlilik, Örüntü, Tablo) yanında ek sekmelerde açılır. Ctrl+Tab ve Ctrl+Shift+Tab sekme değiştirir; Delete veya orta tıklama sonuç sekmesini kapatır.
- **3B görünüm**: kaydedilmemiş değişikliklerinizden sunucunun oluşturduğu geometriyi gösterir; gördüğünüz, openEMS'in mesh oluşturacağı geometridir. Tarayıcı her düzenlemeyi hemen çizer; biraz sonra sunucunun sürümü yerini alır. Katıya tıklayarak seçin. Görünüm, yakınlaştırmayı veya bakış merkezini değiştirmeden kamerayı ayarlar (İzometrik, Üst, Ön, Sağ, Alt, Arka, Sol). Sığdır, mevcut yönelimi koruyarak modeli çerçeveler. Sayı tuşları: **1** en yakın eksene hizalar, **2** Alt, **3** Arka, **4** Sol, **5** Ön, **6** Sağ, **8** Üst, **0** İzometrik. Sayısal tuş takımını (Num Lock kapalıyken de) veya sayı satırını kullanın. Kamera kısayolları 3B görünürken çalışır; alanlarda, düzenleyicilerde, menülerde, pencerelerde veya etkin çizim aracında çalışmaz. 3B görünüm odaktayken oklar döndürür (Shift kaydırır), +/− yakınlaştırır, Boşluk veya F sığdırır. Hazır açıdan döndürerek ayrılmak düğmenin basılı durumunu kaldırır. Sayı satırı eşdeğerleri dizüstü klavyeler içindir.
- **Özellikler** (sağ): seçili öğenin alanları.
- **Alt panel**: **Denetimler** ve **Parametreler**; burada başlatılan çalıştırma için ayrıca **Çalıştırma** (canlı ilerleme), **Çalıştırmalar** (tasarımın çalıştırmaları, farklı parametreleriyle yan yana) ve **Günlük**. Tüm sekmeleri birlikte boyutlandırmak için üst kenarını sürükleyin; yükseklik 120 piksel ile merkez alanın %70'i arasındadır. Kenara odaklanıp ok tuşlarını kullanın (10 piksel, Shift ile 50); Home/End sınırları seçer. Yükseklik yerel depolamada hatırlanır ve duyarlı varsayılanların önüne geçer. Çift tıklama sıfırlar. Sol ve sağ panel kenarları Tasarım ve Sonuçlar'da boyutlandırılabilir (en az 180 piksel, en fazla çalışma alanının %35'i veya 600 piksel). Ok tuşları boyutlandırır, çift tıklama sıfırlar. Hatırlanan genişlikler duyarlı varsayılanların önüne geçer; panel anahtarları yine gizler (Ctrl+Shift+1, 2 ve 3 ağacı, alt paneli ve özellikleri katlar; macOS'te ⌃⇧1, 2 ve 3).
- **Durum çubuğu**, soldan sağa:
  - 3B görünümde imleç konumu (katı üzerindeyse orada, değilse toprak düzleminde);
  - çalışma düzlemi;
  - birimler: mm ve GHz;
  - önizleme mesh'inin hücre sayısı ve en küçük hücresi (tıklamak mesh görünümünü açıp kapatır);
  - denetim özeti (tıklamak Denetimler sekmesini açar);
  - devam eden çalıştırma (tıklamak Çalıştırma sekmesini açar);
  - önizleme süresi; tasarımda hata varken **Önizleme duraklatıldı: N hata** (tıklamak Denetimler'i açar), sunucu oluşturamadığında Yeniden dene düğmesiyle **Önizleme başarısız**;
  - çalıştırma sunucusu durumu (tıklamak sunucuyu yeniden arar; çubuk ayrıca her on saniyede kontrol eder).

Tasarım grubundaki **Kapat** (masaüstünde **Dosya › Tasarımı Kapat**) açık tasarımı bırakıp Ana ekrana döner. Kaydedilmemiş değişikliklerde **Kaydet**, **Kaydetme** veya **İptal** seçin. Kaydetme başarısızsa tasarım açık kalır ve sorun açıklanır. Kayıtlı tasarım **Tasarımlarınız** altında kalır ve yeniden açılabilir. Kapat, çalışan simülasyonu iptal etmez.

Masaüstünde Ctrl/Cmd+W tasarımı (açık tasarım yoksa pencereyi) kapatır. Tarayıcıda Kapat düğmesini kullanın; Ctrl/Cmd+W tarayıcı sekmesi kısayoludur.

Kısayollar: Ctrl/Cmd+S kaydeder, Ctrl/Cmd+Z geri alır, Shift+Ctrl/Cmd+Z veya Ctrl+Y yineler, Ctrl/Cmd+Enter çalıştırır, Delete seçimi siler, Escape seçimi temizler (veya çizimi durdurur). Giriş › Kısayollar (veya tasarımcıda ?) tümünü listeler.

### Gezinti ağacı

![Sonuçlar altında açılmış çalıştırmayla gezinti ağacı ve 3B görünümdeki örüntüsü](../landing/media/designer-pattern.jpg)

- **Parametreler**: parametre sayısını içeren tek satır; tıklamak alt panelin Parametreler sekmesini açar.
- **Katılar**: katılar ve şekilleri, varsa bileşen klasörleri içinde. Taşımak için katıyı klasöre (veya üst düzey için Katılar başlığına) sürükleyin; menüsü için katıya veya şekle sağ tıklayın.
- **Malzemeler**, **Portlar** ve **Toplu elemanlar** (dirençler); başlıktaki + yeni öğe ekler.
- **Sonuçlar**: tasarımın her çalıştırması için en yenisi üstte olacak şekilde, adı, zamanı ve motoruyla etiketli bir düğüm. En yenisi açıktır. Çalıştırmanın altında:
  - **1B Sonuçlar**: S-parametreleri, empedans, VSWR, Smith abağı, verimlilik;
  - **Uzak alanlar**: her uzak alan frekansı için örüntü kesitleri (**Uzak alan (f = …)**) ve **3B örüntü (f = …)**;
  - **2B/3B Sonuçlar**: monitör frekansı başına yüzey akımı haritası ve her E/H alan düzlemi haritası için düğüm; örneğin “E alanı (z = 2,572 mm, 2,45 GHz)” (düzlemin kaydedildiği mesh çizgisi, girilen konumdan biraz farklı olabilir);
  - **Tablolar**: sayısal S-parametreleri ve empedans;
  - **Günlük**.

  Parametre taramasının çalıştırmaları tek **Tarama …** klasöründedir (**Tüm çalıştırmaları karşılaştır** için sağ tıklayın). Mesh yakınsama çalışmasının çalıştırmaları, ayrıntı satırında sonucu gösteren tek **Mesh yakınsaması** klasöründedir (“4 çalıştırmanın 3'ü · 30 hücre/λ'da yakınsadı”); ilk satır **Yakınsama raporu** raporu açar ([Mesh yakınsaması](#mesh-convergence)). Tamamlanmış optimizasyonun kendi düğümünde **Optimizasyon geçmişi**, **En iyiyi aç**, **En iyiyi çalıştırma olarak kaydet** ve **En iyi parametreleri tasarıma uygula** bulunur ([OPTIMIZE.md](OPTIMIZE.md)).

  Sonuç seçmek, çalıştırmayı 3B görünümde gösterir (uzak alanın 3B örüntüsü, yüzey akımı veya alan düzlemi haritası) veya grafiğini ana alanda sekme olarak açar. Geometri öğesi seçmek, tasarımı düzenlemek, Son işlem dışındaki şerit sekmesini seçmek veya tasarımcıdan ayrılmak, örüntüyü/haritayı 3B görünümden kaldırıp geometriye döner; ana alanın sonuç sekmeleri açık kalır. En fazla sekiz çalıştırmayı birer renkle karşılaştırmak için diğer çalıştırmalara **Ctrl/⌘ basılıyken tıklayın** (veya sonuç sekmesi araç çubuğundaki **Karşılaştır** altında işaretleyin ya da alt panelin **Çalıştırmalar** sekmesinde etiketlerine tıklayın). Sonuç sekmesi bunları birlikte çizer (S-parametreleri, empedans, VSWR, Smith, örüntü kesitleri, tablo). Çok portlu çalıştırmalarda S-parametresi seçici S_ij'yi (dB veya faz) seçer; her çalıştırma kendi renginde, seçilen her çift ayrı çizgi deseniyle çizilir. Smith abağı her çalıştırmanın seçili portunu gösterir. Alt panelin **Çalıştırmalar** sekmesi kısa etiketleri (açıklamalarda kullanılan A, B, …), farklı parametreleri işaretlenmiş olarak ve çözücü süresiyle listeler. Burada etikete tıklamak karşılaştırmaya ekler/çıkarır, ada tıklamak gösterir. Sonuç sekmesi araç çubuğundaki **Veriyi kopyala** (Ctrl/⌘+C) ve **CSV**, grafikte görüneni yazar: seçili S_ij dB veya faz, Smith portu ve açıklamadaki adlarıyla tüm karşılaştırılan çalıştırmalar. Yanındaki biçim menüsü Grafik gibi, dB, dB + faz, Re/Im, Doğrusal genlik + faz veya Tümü seçeneklerini sunar.

Üstteki **Filtrele** kutusu, adı veya ayrıntısı yazılan tüm sözcükleri içeren öğeleri üst klasörleriyle korur; Escape temizler. Ağaç klavyeyle çalışır: Yukarı/Aşağı taşır, Sağ açar veya içine girer, Sol kapatır veya üst öğeye gider, Home/End başa/sona gider, Enter seçer.
## Modelleme

### Parametreler ve ifadeler

Her uzunluk (mm) ve frekans (GHz) alanı sayı veya parametrelere bağlı ifade kabul eder: `W/2`, `h + 0.035`, `wavelength(f0) / 4`. Alan siz yazarken değeri gösterir (`= 16`) ve hesaplanamayan ifadeyi işaretler.

- **Bağımsız** parametrenin varsayılan değeri, birimi, isteğe bağlı aralığı ve etiketi vardır. Taramalar, optimizasyon aracı ve Çalıştırma panelinin formu bunu değiştirir.
- **Türetilmiş** parametre, kendisinden önceki parametrelere bağlı ifade içerir (örneğin `lam = wavelength(f0)`).
- İşleçler: `+ - * / // % **` ve parantezler. Sabitler: `pi`, `c0`, `eps0`, `mu0`. İşlevler: `sqrt`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `log`, `log10`, `abs`, `min`, `max`, `round`, `floor`, `ceil`, `radians`, `degrees` ve `wavelength(f_GHz)` (mm cinsinden serbest uzay dalga boyu). Python kuralları geçerlidir; çalıştırma sunucusunun değerlendiricisi belirleyicidir.
- İki tarafta da sayılar çift hassasiyetlidir (IEEE-754 binary64): JSON gibi en yakın double olarak okunur; ifadenin her adımı double'dır, böylece tarayıcı ve sunucu aynı değeri verir (`9007199254740993 - 9007199254740992`, `0` olur; Python'un kesin tam sayıları kullanılmaz). Sonlu olmayan sayı, ad veya adım, sonraki adım değeri sonluya getirecek olsa bile hatadır (`1e999`, `1 / (1e308 * 10)`). `round(x, n)`, `2.0` olarak yazılmış `n` kabul eder. `sin` veya `log` gibi işlevler iki tarafın matematik kütüphanesinden gelir; son basamakta (yaklaşık 1e-16) farklılaşabilir.
- İfadeler yalnızca ASCII kullanır: rakamlar, harfler, `_`, işleçler, parantezler, virgül ve boşluk. Tam sayı `0` ile başlayamaz (`07`); yorum (`#`) kabul edilmez.
- Parametre anahtarı ASCII harf, rakam ve `_` içerir; rakamla başlayamaz ve işlev, sabit veya Python anahtar sözcüğü (`in`, `lambda`, `True`, ...) olamaz. `__proto__`, `constructor` veya `match` gibi diğer adlar sıradan anahtarlardır. Parametreler alt paneli reddedilen anahtarı yazarken işaretler. Böyle anahtar içeren tasarım dosyası, anahtar dosyada yeniden adlandırılana kadar yüklenmez (sunucu hatası, geçersiz tasarım dosyalarında olduğu gibi anahtarı belirtir).

Şeritte Modelleme › Parametreler › Parametre veya Parametreler alt panelinde **Parametre ekle** ile parametre ekleyin: ilk boş p1, p2, … anahtarını alır ve birimsizdir (uzunluk veya frekansta birim hücresini doldurun; oran veya εr yalın sayı kalır). Tabloda her tuş anında uygulanır (3B görünüm izler); Anahtar hücresi hariç: yeni anahtar **Enter** veya hücreden ayrılınca uygulanır. Parametre kullanıldığı her yerde tek geri alma adımıyla yeniden adlandırılır: şekiller, dönüşümler, kesmeler, portlar, toplu elemanlar, malzemeler, mesh ve simülasyon alanları, diğer parametreler, Boolean sonucunun sakladığı işlenenler ve parametre taraması. Böylece `fw`, `feed_w` yapıldığında `fw` başvurusu kalmaz. Geçersiz veya kullanılan anahtar hücre altında hata gösterir ve uygulanmaz; Escape önceki anahtara döner. Bir alanın kullandığı parametre silinmez (çöp düğmesi, Giriş › Düzenle › Sil, Delete tuşu); kullanılan malzemede olduğu gibi kullanan yerler bildirilir. **Çoğalt**, `key_2` olarak kopyalar.
**Enter** hücreyi onaylayıp sonraki satırın aynı hücresine geçer; **Escape** yalnızca son onaydan beri yazılanı geri alır, önceden onaylanmış değeri almaz; hücreden ayrılmak (Tab, tıklama) onaylar.
Kompakt tablo Anahtar, İfade / değer, Hesaplanan değer, Birim ve Açıklama gösterir. Min ve Maks isteğe bağlıdır: **Aralıklar** bunları gösterir; Çalıştırma panelinde tarama veya optimizasyon açmak da gösterir. Mevcut sınırlar dosyada kalır; çalıştırma formları kendi aralıklarını kabul eder. Varsayılan için yalın sayı, türetilmiş parametre için ifade (`=` ile işaretli) girin. Açıklamalar yerinde düzenlenir; **Etiket** isteğe bağlı görüntüleme etiketini açar. Doğrulama alanlarda ve Denetimler'de sürer; ayrıntı için hücreye odaklanın veya üzerine gelin. Ok tuşları odaklı satırlar arasında geçer, Enter anahtarı düzenler, Escape hücreyi düzenleme öncesine döndürür. İfade alanındaki bilinmeyen adlar, Enter veya alandan ayrılınca satır içinde **Parametre oluştur** sunar. Yeni değer, `lam/4` gibi önceki parametrelere bağlı ifade olabilir.

### Malzemeler ve katılar

**Malzeme**, metal veya εr, kayıp tanjantı tan δ ve tan δ'nın geçerli olduğu frekansı (boşsa bant merkezi) içeren dielektriktir. Şeritte Modelleme › Malzemeler › Dielektrik veya Metal ile ekleyin. Tasarımda bant içinde `f0` parametresi varsa yeni dielektrik (kütüphaneden eklenen dahil) tan δ'yı `f0`'da tanımlar; yoksa veri sayfasındaki 1 veya 10 GHz yerine bant merkezinde (frekans boş bırakılır) tanımlar.

openEMS, tan δ'yı sabit iletkenlik olarak uygular; kayıp yalnızca belirtilen frekansta tam doğrudur, diğerlerinde f_ref / f ile ölçeklenir. 10 GHz'deki veri sayfası değerini 2,45 GHz'de kullanmak dört kat kayıp verir. Tasarımın çalıştığı frekansı girin (örneğin `f0`); bant dışındaysa denetim uyarır. (10 GHz'den alınan değerin 2,45 GHz'de kullanılması yama şablonunun ışıma verimliliğini %88 yerine %65 yapmıştı; şablon artık kendi frekansındaki değeri kullanır.)

Özellikler'de **İletkenlik** verilmedikçe metal mükemmel iletkendir (PEC). Birim S/m; hazır değerler Bakır 5.8e7, Alüminyum 3.5e7, Altın 4.1e7, PEC = boş. Kayıplı metalin levhaları **Levha kalınlığı** ile openEMS iletken levhalarına dönüşür (ince iletkenin yüzey empedansı modeli, `AddConductingSheet`; mm, boşsa 0,035 = 1 oz bakır; levha yapılan ince kutu çizilmiş kalınlığını korur). Hacimler bu iletkenlikte malzemeye dönüşür; yalnızca mesh deri kalınlığını çözdüğünde doğrudur (2,45 GHz'de bakır için yaklaşık 1,3 µm; anten mesh'inde hiçbir zaman, dolayısıyla kalın kayıplı hacim neredeyse PEC gibi davranır). Teller mükemmel iletken kalır. Yama şablonunda (kaba, GPU), PEC yerine bakır 2,45 GHz'deki ışıma verimliliğini %88,2'den %86,5'e, kazancı 6,21'den 6,12 dBi'ye düşürür. Makronun “Lossy metal” tanımı iletkenliğiyle içe aktarılır; makro dışa aktarımı da bunu yazar.

Modelleme › Malzemeler › **Kütüphane**, yaygın anten malzemelerini nominal değerleri ve kaynaklarıyla listeler: PEC (bakır), FR4, Rogers RO4003C, RO4350B ve RT/duroid 5880, Taconic TLY-5, alümina, PTFE ve hava. **Ekle**, değerleri tasarıma yeni malzeme olarak kopyalar; tasarım dosyası böylece kendi kendine yeterli kalır. Kopyayı Özellikler'de düzenleyin.

**Malzemelerim.** Kütüphane penceresinde **Yerleşik** ve **Malzemelerim** grupları vardır. Tasarımdaki malzemeyi, ağaçta sağ tıklayıp **Malzemelerime kaydet** veya Özellikler'in altındaki düğmeyle kaydedin. Dielektrik εr, tan δ ve frekansı; metal iletkenlik ve levha kalınlığını; ikisi de rengi korur. Aynı adla yeniden kaydetmek girdiyi günceller. Parametre ifadesi olan değerler kaydedilemez (kütüphane yalın sayılar tutar). Malzemelerim satırındaki **Ekle**, yerleşik girdi gibi değerleri tasarıma kopyalar; tasarım dosyası kullandığı her malzemenin tam kopyasını taşır ve biçimi değişmez. Malzemelerim dielektrikleri PCB içe aktarmada alttaş olarak da sunulur. Kütüphane penceresindeki **Malzemelerim…**, yeniden adlandırma, düzenleme (εr, tan δ, iletkenlik, kalınlık), silme, JSON dosyasına (`{"version": 1, "materials": [...]}`) **Dışa aktar** ve bir çalışma arkadaşınızın dosyasını **İçe aktar** işlemleri için listeyi açar. Bozuk girdiler uyarıyla atlanır; kullanılan ada sayı eklenir. Sunucu bağlıyken liste çalışma klasörünün `materials.json` dosyasındadır (bkz. [RUN-SERVER.md](RUN-SERVER.md#my-materials)); değilse tarayıcının localStorage alanındadır.

**Katı**, tek malzeme ve bir veya daha fazla şekilden oluşur; openEMS'te tek CSXCAD özelliğidir. Katılar çakışırsa yüksek öncelik kazanır (varsayılan metal 10, dielektrik 0; şekil kendi önceliğini ayarlayabilir). Adını veya malzemesini değiştirmek, bileşen klasörüne koymak, şekil, kesme veya dönüşüm eklemek için katıyı seçin.

**Bileşenler.** Katının Bileşen alanı `antenna/feed` gibi klasör yoludur; ağaç buna göre katıları gruplar. Oluşturma bunu dikkate almaz (dışa aktarılan Python yorumda adlandırır). Bileşensiz tasarım değişmeden yüklenir; tüm katılar üst düzeydedir. Bileşen oluşturmak için katıda **Bileşene taşı ›** seçip yeni ad yazın (`/` alt klasör oluşturur) veya katıyı üst düzeydeki başka katıya sürükleyin. Bileşen klasörüne sağ tıklayarak **Bileşeni yeniden adlandır** (veya klasör satırında F2; alt klasörlerdeki katılar da izler), **Bileşen grubunu çöz** (katı ve alt klasörler bir düzey yukarı taşınır), **Bileşeni ve katılarını sil** seçeneklerini kullanın. **Katıları göster** ve **Katıları gizle** içerideki her şeye uygulanır. Her biri tek geri alma adımıdır.

Ağaçta veya 3B görünümde katı/şekle sağ tıklayarak Yeniden adlandır, Gizle, Dönüştür…, Renk…, Köşeleri yuvarla… (kutuda), Boolean ›, Bileşene taşı ›, Buraya ayrık port ekle (seçilen metal yüz destekliyorsa), Çoğalt ve Sil seçeneklerine ulaşın. Yeniden adlandır, görünen etiketi ağaçta yerinde düzenler; şeklin etiketi geometrisini değiştirmeden tasarıma kaydedilir. Bileşene taşı mevcut klasörleri ve yeni klasör alanını yerinde listeler. 3B görünümde **Buraya ayrık port ekle**, seçilen noktadan başlar ve yüzün baskın eksenini kullanır; arkasındaki ve önündeki metalleri (yamanın toprak düzlemi gibi) diğer uç olarak sunar. Eklemeden önce uçları inceleyin. Shift+F10 veya Menü tuşu odaklı ağaç öğesinin ya da seçili görünüm katısının menüsünü açar. Yukarı/Aşağı, Home/End gezinir; Escape kapatıp odağı geri verir. Boş görünüm alanında tarayıcı menüsü korunur.

**Eklediğinizi görmek.** Yeni, çizilmiş veya uzatılmış şekil, çoğaltma, yeni port veya direnç seçilir; 3B görünüm bakış yönünüzü koruyarak bir kez bunlara sığdırılır. Port/direnç, beslemenin yerini görebilmeniz için temas ettiği en küçük metalle çerçevelenir. Sonraki seçim veya düzenlemeler kamerayı hareket ettirmez; Sığdır (3B görünümde F veya 0) tüm modeli gösterir.

### Şekiller

Modelleme sekmesinin Şekiller grubu şekil ekler:

- Kutu, Silindir, Küre, Çokgen ve Uzat, çalışma düzleminde uygun boyutlu şekille pencere açar. Her değer ifade kabul eder; siz düzenlerken 3B görünüm şeklin dış çizgisini gösterir. Yeni katı (adı ve malzemesiyle) veya ekleneceği mevcut katıyı seçin. Tamam tek geri alma adımıyla ekler; İptal eklemez. Tasarımda henüz katı yoksa malzeme dielektrikle başlar (basılı antende ilk kutu alttaştır); daha sonra bu tasarımda yeni katı için son kullandığınız malzeme, o da yoksa ilk metal kullanılır.
- Koni, Torus ve Tel tasarımın metalinden tek şekilli yeni katı ekler; Özellikler'de düzenleyin.

Katı/şekil eklemek veya çoğaltmak onu seçer ve bakış yönünü koruyarak 3B görünümü sınırlarına bir kez sığdırır. Hemen döndürebilir, kaydırabilir veya yakınlaştırabilirsiniz; sonraki düzenlemeler ve sunucu önizlemeleri kamerayı bıraktığınız yerde tutar.

Katı özelliklerinden aynı katıya başka şekiller ekleyebilirsiniz. Türler:

- **Kutu**: Xmin/Xmax, Ymin/Ymax, Zmin/Zmax. Bir eksende sıfır kalınlık levha oluşturur (yama, toprak düzlemi, iletken yol).
- **Silindir**: eksen, merkez, yarıçap, iç yarıçap (0'dan büyükse boru) ve eksen boyunca aralık. min = max olduğunda uzunluk yoktur: **düz daire** (iç yarıçap varsa halka), yani levha. Oluşturma bunu köşeleri çember üzerinde olan, her kenarı yaydan 0,01 mm içinde tutan ve en az 64 olan çift sayıda kenarlı düzgün çokgene çevirir. CSXCAD çokgenlerinde delik olmadığı için halka iki yarım halkadır. VBA makrosu tam daireyi örtülü Circle, halkayı çokgenler olarak aktarır.
- **Küre**: merkez ve yarıçap.
- **Çokgen**: düzlemde köşeleri bulunan düz levha (normal ve yükseklik).
- **Uzat**: normali boyunca bir uzunlukla uzatılmış çokgen. Şekil penceresinde yüksekliği 0'dan farklı çokgen uzatmaya dönüşür.
- **Koni**: eksen, merkez, alt ve üst yarıçap (0: sivri uç), eksen boyunca aralık.
- **Torus**: eksen, merkez, büyük yarıçap (eksenden boru merkezine), küçük yarıçap (boru). openEMS boruyu eksen etrafında döndürülmüş 64 kenarlı çokgen olarak alır.
- **Tel**: noktalardan oluşan kırık çizgi boyunca, yarıçapı olan ince tel. Otomatik mesh çevresine ince hücreler yerleştirir.
- **Çokyüzlü** (`{"kind": "polyhedron", "vertices": [[x, y, z], ...], "faces": [[i, j, k, ...], ...]}`): köşelerinden (ifadeler kabul edilir, en az 4) ve çokgen yüzlerinden (her biri en az 3 farklı, mevcut köşe indeksli en az 4 yüz) oluşan kapalı katı. Çizim aracı yoktur; örnekten (piramit huni) veya JSON'dan gelir. Özellikler köşe ve yüz sayılarını, köşeleri salt okunur gösterir. Oluşturma (CSXCAD `AddPolyhedron`) ve 3B görünüm her yüzü, kapalı hacme göre dışa yönlendirilmiş üçgenlere böler; aynalanmış kopya da oluşturulur. Katı dönüşümleri (taşıma, döndürme, ölçekleme, aynalama, kopyalar) köşelere uygulanır. VBA makro biçiminde çokyüzlü yoktur; makro bunu atlayıp uyarı listeler. Python aktarımı küçük yardımcıyla `add_polyhedron(...)` yazar. Denetimler sınırlayıcı kutuyu kullanır; geçersiz indeksleri (`polyhedron`) veya tüm köşelerin tek düzlemde olmasını (`polyhedron-flat`) reddeder.

### Çalışma düzleminde çizim

Modelleme sekmesinin Çalışma düzleminde çiz grubu, 3B görünümde fareyle çizim yapar:

- **Kutu**: karşılıklı iki köşeye tıklayın.
- **Daire**: merkeze, sonra çevrede bir noktaya tıklayın (silindir veya yükseklik 0 ise düz daire levha).
- **Çokgen**: köşelere tıklayın; kapatmak için ilk noktaya tekrar tıklayın, çift tıklayın veya Enter'a basın.

Şerit altındaki ipucu sıradaki tıklamayı ve yerleştirilen nokta sayısını söyler. Escape veya Backspace son noktayı kaldırır (ilk noktayı da; araçta kalır); nokta yokken Escape çizimi durdurur. Yeniden seçilen araç boş başlar. İlk tıklamadan önce Enter, varsayılan değerlerle şekil penceresini açar. Tamamlanan şekil, çizdiğiniz değerlerle pencereyi açar; grubun Seçenekler panelinde “Çizilen şekilleri pencerede onayla” kapalıysa doğrudan yeni katıya eklenir. Şekli tamamlamak çizim modundan çıkarır: pencerede Tamam'dan sonra yeni şekil seçilir ve iptal edilecek araç kalmaz. Çift tıklama veya Enter bitirir, Escape iptal eder.

**Yazılan koordinatlar.** Çizerken tıklamak yerine nokta girmek için yazmaya başlayın (rakam, `-`, `@`, `=` veya harf); Enter yerleştirir:

- `u, v`: çalışma düzleminde nokta; değerler ifade olabilir (`W/2, L/2`) ve şekilde ifade kalır.
- `@du, dv`: son noktaya göre göreli.
- Kutu, ikinci köşe: `w, h` boyuttur; `=u, v` köşenin kendisidir.
- Daire, çevre: tek değer yarıçaptır.

**Yakalama.** Noktalar çalışma düzlemi ızgarasına, imleç yakındaysa düzlemdeki mevcut geometrinin köşelerine, kenar orta noktalarına ve kenarlarına yakalanır (nokta işareti gösterilir). Grubun Seçenekler panelinde her türü açıp kapatabilirsiniz.

### Çalışma koordinat sistemi (WCS)

Çizim WCS üzerinde yapılır: başlangıçta global WCS vardır (u, v, w = x, y, z). Modelleme › WCS altındaki dört düğme bunu değiştirir:

- **Yüze hizala**: 3B görünümde katının yüzüne tıklayın. WCS orijini yüz merkezine, w dış normale yerleşir (u +x yönünde; x'e bakan yüzde +y). Yalnızca x, y veya z yönündeki yüzler seçilebilir. Orijin yüzün ifadesini korur: “Alttaş: üst” üzerindeki WCS z = h'de durur ve h değişince alttaşı izler.
- **WCS dönüştür…**: tek pencere. **Şu eksenler boyunca taşı** u, v, w, orijini mevcut WCS eksenlerinde kaydırır; **Şu eksenler çevresinde döndür** u, v, w, WCS'yi bu sırayla, her biri önceki dönüşün bıraktığı eksenler etrafında döndürür. Geometri eksen hizalı kaldığından dönüşler 90°'nin katıdır. Değerler ifade kabul eder (dönüş sayıya hesaplanır). Pencere sonuç orijini ve eksenleri gösterir. Nokta seç ile nokta seçiliyse “Orijini seçilen noktaya taşı” da sunulur.
- **Global ile hizala** her şeyi geri döndürür. Çizilmiş şekiller yerinde kalır; bitmemiş şeklin yerleştirilmiş noktaları kaldırılır.
- **WCS göster**, yerel WCS'nin u, v, w oklarını 3B görünümde gösterir/gizler.

Yerel WCS etkinken köşe eksen göstergesi, 3B imleç değerleri, durum çubuğu, çizim değerleri, koordinat giriş istemi ve şekil pencereleri x, y, z yerine u, v, w kullanır; çalışma düzlemi ızgarası u/v etiketlidir; durum çubuğunda **Yerel WCS** rozeti görünür. Buna veya **Global ile hizala** düğmesine tıklamak globale döner. Global WCS'de her şey x, y, z'dir.

Izgara yakalama, varsayılan yükseklik (çizilen kutu veya dairenin uzatılması; 0 levha çizer), imleç yakalama hedefleri (köşeler, orta noktalar, kenarlar), çizilen şekillerin pencerede onaylanması ve “Düzleme bak”, Çiz grubunun **Seçenekler** panelindedir.

Yerel WCS'de çizilen veya Şekiller paletinden oluşturulan şekiller onun koordinatlarıyla tanımlanır: pencereler bunları gösterir, yeni katı global koordinatlara yerleştiren normal sıralı döndürme/taşıma dönüşümleri taşır (parametre ifadeleri ifade kalır). Mevcut katılar değişmez; globale dönmek yalnızca sonraki çizimleri etkiler. -x, -y veya -z'ye bakan yüz, w'su ters yönlü WCS verir; katı ayrıca düzlem içindeki eksen etrafında yarım dönüş taşır.

**Tasarımla kaydedilir.** Global dışındaki WCS, tasarım dosyasında isteğe bağlı üst düzey `wcs` alanında saklanır (`normal`, üç ifade olarak `origin`, 90° adımlarla `angle`, w negatif eksendeyse `flip`); kaydedip yeniden açınca korunur. Alanı olmayan tasarım global WCS ile açılır; sunucu alanı yok sayar ve geometri buna bağımlı değildir. Her WCS değişikliği tek geri alma adımıdır. Çözülemeyen veya sonlu olmayan orijinler bildirilir; şekil penceresi veya fareyle çizim bunları onaylayamaz. Önce kendilerini veya parametrelerini düzeltin.

### Dönüşümler

Katıyı (veya şekillerinden birini) seçip Dönüştür sekmesinde **Dönüştür…**, bağlam menüsünde **Dönüştür…** veya masaüstünde Ctrl/Cmd+T kullanın. 3B görünümün yanındaki tek panelde **İşlem** olarak şunlar seçilir:

- **Ötele**, seçimi x, y, z adımıyla kaydırır. **Kopyala** kapalıysa mevcut geometriyi taşır (değerler ifade kabul eder). Bu sıralı, düzenlenebilir dönüşümdür: diziden sonra taşıma tüm diziyi dünya koordinatlarında taşır, aynalamadan önce taşıma aynalanmış sonucun konumunu değiştirir. **Kopyala** açıksa **Tekrar sayısı (eklenecek kopya)** kadar ek kopya oluşturulur; k'ncı kopya k × adım kadar kayar (özgün kalır). Değerler ifade olabilir; `copies = N - 1` ve `step = [d, 0, 0]` parametreleri izleyen dizi oluşturur. **Son iki seçili noktayı kullan**, Nokta seç ile seçilen iki noktadan adımı alır; **Referans noktası seç ve görünümde yerleştir**, katı üzerindeki tutma noktasına ve hedefe tıklayarak taşır.
- **Ölçekle**, orijin etrafında x, y, z katsayıları uygular. Yalnızca pozitif, tüm eksenlerde eşit katsayılar kabul edilir.
- **Döndür**, seçili merkezden geçen x, y veya z ekseni etrafında derece cinsinden döndürür. Pozitif açılar sağ el kuralını izler. Açılar ve merkez koordinatları ifade kabul eder. Kopyala kapalıyken (veya kopya sayısı sıfırken) özgün döner; pozitif sayıda özgün kalır ve açı, 2 × açı vb. konumlarında kopyalar görünür. Her açı desteklenir. Çeyrek dönüşler mevcut eksen eşleme yolunu kullanır; diğer açılar CSXCAD'de yerel şekle dönüşüm matrisi ekler. Çözücü sınırlayıcı kutuyu değil döndürülmüş şekli kullanır. Otomatik mesh dünya koordinatlarındaki sınırlarını kullanır. Keyfi yönelimli işlenenlerde Boolean işlemleri desteklenmez ve doğrulama hatası verir.
- **Aynala**, **Düzlem üzerindeki nokta** üzerinden geçen, **Düzlem normal ekseni** x, y veya z olan düzleme göre aynalar; **Orijinali koru (aynalanmış kopya ekle)** özgünün kalıp kalmayacağını belirler.

**Çoğalt** (Giriş › Düzenle veya Ctrl/Cmd+D), seçili katı, şekil, port, toplu eleman, parametre veya malzemeyi kopyalar. **Sil** seçimi kaldırır (malzeme/parametre yalnızca kullanılmıyorsa). Çoğaltılan katı bilerek özgünün üzerinde durur; çakışma istemi çıkarmaz. Başka katının içine taşımak veya düzenlemek çıkarır.

**3B görünümde seçim.** Seçili katı kırmızı ton, dış çizgi ve her şeyin üzerine çizilen saydam dolgu alır. Ağaçta katının bir şekli seçiliyse yalnızca o şekil tam vurgulanır, diğer şekiller hafif dış çizgi alır. Seçimi çevreleyen katılar (merkezi içlerinde kalıyorsa, örneğin via çevresindeki alttaş) seçim boyunca soluk çizilir; yalnızca dokunan katılar görünümlerini korur.

Dönüşümler katının özelliklerinde düzenlenebilir ve kaldırılabilir; model oluşturulurken tam olarak açılır. Çok şekilli katının tek şeklini dönüştürmek, malzemesini, kesmelerini ve önceki dönüşümlerini koruyarak bağımsız katı yapar; kardeşleri yerinde kalır. Portlar ve toplu dirençler şekillerle taşınmaz; dünya koordinatlarında kalırlar ve panel bunu belirtir. Dönüşüm özgünü yerinde bırakmıyorsa (taşıma, döndürme, ölçekleme veya özgünü korumadan aynalama) ve seçili metalde port varsa, panel belirgin uyarı verir, portları adlandırır ve her biri için **Port N seç** sunar. İki iletken arasındaki aralığı artık kapsamayan port yaklaşık 0 dB |S11| ve sıfır ışıma verir (denetimler `port-floating`, çalıştırma kalite sonucu bağlanmamış port olarak işaretler).
Panel yazarken sonucu 3B görünümde dış çizgiyle önizler. Görünüm etkileşimli kalır; kontrolleri kapatmadan döndürün, yakınlaştırın veya kamera değiştirin. **Dönüş düzleminden bak**, düzlemsel dönüşleri incelemek için seçili eksen boyunca bakar. Dar yerleşimde kontroller görünümün altındadır. **Önizleme** geçici dış çizgiyi yeniler; **Uygula** tek geri alma adımıyla bir kez onaylayıp paneli kapatır. İptal, tasarımı değiştirmeden dış çizgiyi kaldırır. Uygula yalnızca önizleme geçerli girdilerle eşleşirken kullanılabilir. İşlem değiştirmek Kopyala tercihini varsayılana döndürür. Tasarımı başka yerde düzenlemek, eski önizlemenin yeni düzenlemeyi ezmemesi için paneli kapatır. Eğik çokgenin yerel köşe koordinatları Özellikler'de düzenlenebilir; dünya eksenlerine hizalı çizim düzleminde sürüklenemez.

Tasarım ve Python aktarımı keyfi dönüşleri korur; VBA makrosu şekilden sonra `Transform` adımları yazar (aynalama, ölçekleme, x/y/z etrafında döndürme, öteleme; kayma dönüşümü matris olarak, uyarıyla). Üretim aktarımı XY içinde döndürülmüş kartları destekler; eğik alttaşı hatalı üretim dış çizgisine düzleştirmez. Sıfır kalınlıklı metal levhalar çözücünün koordinat düzlemlerinden birine paralel kalmalıdır; kayıplı levhalar afin dönüşümlerde yerel normal eksenlerini de korumalıdır. Kendi düzlemlerinde döndürülebilirler. Metali düzlem dışına eğmek için sonlu kalınlıkla modelleyin ve uygun mesh ile çözün. Bu denetimler, görünür önizlemenin desteklenmeyen ince levha çözücü davranışı izlenimi vermesini önler.

Bileşen klasörüne sağ tıklayıp **Bileşeni dönüştür** seçerek iç içe klasörler dahil tüm katıları ortak orijin/merkez/düzlem etrafında dönüştürün. Önizleme her üyeyi içerir; tek Geri Al hepsini geri getirir. Klasör taşıma yalnızca düzeni değiştirir: katı satırını (veya tek şekilli katının şekil satırını) bileşen klasörüne sürükleyin. Bağlam menüsündeki **Bileşene taşı** klavye eşdeğeridir. Katının malzemesi ve geometrisi değişmez.

### Boolean işlemleri, seçim ve hizalama

**Araçlar** grubu (Modelleme sekmesi), birden fazla katı veya seçilmiş geometri üzerinde çalışan komutları içerir:

- **Boolean**, A (korunan) ve B katılarını birleştirir: **Birleştir** (birleşim), **Çıkar** (A − B), **Kesiştir** ve **Ekle** (B korunarak A − B). A'yı seçip işlemi seçin (veya A, ardından B seçiliyken + − * / tuşlarını kullanın: 3B görünüm A işlem B'yi önizler; Enter veya aynı tuşa yeniden basmak uygular). A seçiliyken Araçlar › Boolean ve sağ tıklama › Boolean alt menüsü diğer katıları listeler: **Çıkar ›** (veya **Birleştir ›**, **Kesiştir ›**, **Ekle ›**); tek seçim işlemi tek geri alma adımıyla hemen uygular. Seçim yokken işlemi, ardından B'yi seçin. 3B görünüm işlenenleri renkli göstererek sonucu önizler; **Uygula** (Enter) korur, **A ↔ B değiştir** işlenenleri değiştirir, Escape iptal eder. Sonuç canlıdır: işlenenlerini saklar; parametreler değişince tarayıcıda ve oluşturma sırasında yeniden hesaplanır. Kutular, levhalar ve düzlemleri ortak normal taşıyan çokgenlerde kesindir (kutu ve çokgenlerin tam kırpılması); aşağıdaki gibi diğer şekillerde de çalışır. Farklı eksenlerdeki çokgenler ve reddedildiği belirtilen birleşimler gerekçeyle reddedilir. Boolean menüsünün **Geçmiş** seçeneği sonuçları listeler.

  | İşlem | Kutular, levhalar, çokgenler | Silindirler, borular, koniler, küreler, toruslar, teller, çokyüzlüler (tek başına veya diğerleriyle karışık) |
  | --- | --- | --- |
  | **Birleştir** | tam birleşim | kesin: şekiller birlikte tutulur (A ve B aynı malzeme/önceliği paylaştığından çakışma birleşimdir); kutu ve çokgenler birleştirilir |
  | **Ekle** | tam A − B | kesin: A bütün kalır, ayrı katı olan B yarım öncelik adımı üstüne çıkarılır |
  | **Çıkar** | tam A − B | kesin: B, A'nın boşaltıcısı olur (üstünde vakum şekli; aşağıdaki Boşaltıcılar'a bakın). Silindirden eş eksenli silindir/boru çıkarmak tam olarak borudur (kademeli delik: borular ve silindirler) |
  | **Kesiştir** | kesin | eş eksenli silindir/borular, ekseni boyunca kutuyla kırpılmış boru/koni, bütünü kutu içinde kalan şekil ve silindir ekseni boyunca kutu/çokgenle silindir için kesin (silindir 64 kenarlı prizma olarak kırpılır; halka değişmezse yerel silindir kalır, yoksa kırpılan kısım yarıçapın %0,12'si içinde 64 kenarlı prizmadır). Diğerleri (küre ∩ silindir, çapraz silindirler, çokyüzlüler, kutuyla kesilen küre) birleşim ve alternatif açıklanarak reddedilir: istemediğiniz kısmı çıkarın (örneğin her yanda bir kutu) veya ortak şekli uzatılmış çokgen/çokyüzlü çizin |

  Zaten boşaltıcı taşıyan işlenenden (Çıkar sonucu) yeniden çıkarma yapılabilir (boşaltıcılar birikir) veya Ekle uygulanabilir; ancak birleştirilemez, kesiştirilemez veya çıkarılan işlenen yapılamaz. Önce Geçmiş'ten işlenenleri geri yükleyin. Eğri şekil çakışması kutularla aynı istemi açar (sınırlayıcı kutular değil şekillerin kendileri sınanır). İşlenenlerin keyfi açılı dönüşleri, önceden olduğu gibi tüm şekillerde reddedilir.
- **Nokta seç**, 3B görünümde **Köşe**, **Mesh orta noktası** veya **Yüz / daire merkezi** seçer; **Ölç**, iki nokta arasındaki mesafeyi ve son üçünün iç açısını gösterir. Seçili nokta dönüşüm penceresinde koordinat doldurabilir ve WCS orijinini taşıyabilir.
- **Hizala**, taşınacak katıdaki noktayı, sonra hedefi seçer. **Yüz hizala**, katının düz yüzünü ve hedef yüzü seçer: gerektiğinde çeyrek dönüş yapıp yüzleri buluşturur (**Karşısına**, yüz yüze) veya aynı düzleme getirir (**Aynı düzlem**); isteğe bağlı olarak hedef yüzün merkezine yerleştirir. Yalnızca x/y/z yönündeki yüzler çalışır (kutu ve levha yüzleri, çokgen ve uzatma yüzleri, silindir/koni düz kapakları). Sonuç normal dönüşümdür.
- **Yüz ekstrüzyonu** (S tuşu), düz yüz seçip **Kalınlık**, **Malzeme**, **Ad** ve **Bileşen yolu** ister; yüzden kalınlaştırılmış yeni katı ekler. Kalınlığı yazarken 3B görünüm yeni katıyı kesikli geçici dış çizgiyle gösterir.
- **Nokta düzenle**, seçili çokgen/telin köşelerini 3B görünümde düzenler: taşımak için sürükleyin, + ekler, Delete kaldırır. Her değişiklik tek geri alma adımıdır.

### Boşaltıcılar (hacim oyan şekiller)

- Tanım: herhangi bir şekil `"void": true` taşıyabilir; katının `primitives` listesindedir, katının dönüşümleri uygulanır, levha `cuts` kesmeleri uygulanmaz. Eski okuyucular işareti yok sayar.
- Oluşturma: boşaltıcı vakuma dönüşür (eps_r 1, mu_r 1, kayıpsız; “<part> (cut)” adlı özellik). Öncelik açıkça verilmişse o, yoksa katının dolu şekillerinin en yüksek önceliği + 0,5 kullanılır (metal varsayılan 10, dielektrik 0); böylece içindeki tüm düşük öncelikli malzemeleri siler. Yalnızca tasarım böyle şekil içeriyorsa kesirli öncelikler tamsayılara sıralanır (sıra ve eşitlikler korunur; port/direnç 5'teki yerini korur).
- Uyarı: aynı veya daha düşük öncelikli başka katı boşaltıcı içindeyse `boolean-cut-erases` uyarır (o da silinir); boşaltıcı kendi katısının sıfır kalınlıklı levhasına ulaşmıyorsa veya kalınlığı yoksa ve hiçbir şey kaldırmıyorsa `boolean-cut-reach` uyarır.
- Eğri şekille Çıkar (veya levhayı kesen şekil) böyle saklanır: sonucun `primitives` alanında A'nın şekillerini `void` olarak B'nin şekilleri izler; yanında geçmiş (işlem, A, B) bulunur. Boşaltıcı yalnızca ulaştığı sıfır kalınlıklı levhayı (toprak düzlemi) kaldırır. openEMS 0.37 ile ölçümde (PEC kenar sayıları), levhayı geçen hacim ile yüzü tam üzerinde duran hacim aynı kesmeyi yapmış; boşluklu hacim ve düz (sıfır kalınlıklı) şekil hiçbir şey kesmemiştir. Bu yüzden levhaya yuvarlama hassasiyetinde yakın yüz tam üzerine getirilir; düz B reddedilir. Boşaltıcı içindeki eşit/düşük öncelikli her şeyi de siler (toprak deliğinden geçen pinin önceliği topraktan yüksek, örneğin 11 olmalı; delikteki alttaş daha yüksek öncelikli değilse silinir); denetim bunu söyler.
- 3B görünüm ve dışa aktarma: boşaltıcı, Boolean önizlemesi dahil, katının üzerinde Çıkar renginde kesikli yarı saydam şekil olarak çizilir (“delikli A”). VBA makrosu her ana şekilden vakum araç katısını gerçek `Solid.Subtract` ile çıkarır (tasarımcıdaki öncelikle Ekle için `Solid.Insert`); STL, GLB, Blender, üretim ve çizim aktarımları boşaltıcıları atlar. Paket vakum katısını `void: true` işaretler (docs/BUNDLE.md); diğer okuyucular sıradan eps_r 1 katı görür.

### Kesmeler (Boolean çıkarma)

Katı özelliklerinde **Kesim ekle**, **Yuvarlak delik ekle** ve **Çokgen kesim ekle** bulunur: aynı düzlemdeki düz levhalardan çıkarılan şekiller; yarıklar, U yarıklar, E biçimleri, içe girintiler ve açıklık delikleri içindir. Dikdörtgen kesme levha kutu gibi verilir (levha ekseninde min = max); yuvarlak delik düzlem (normal ve konum), merkez ve yarıçapla verilir, düz daire gibi düzgün çokgen oluşturulur; çokgen kesme düzlem ve noktalarla verilir. Değerler ifade kabul eder. Kesmeler katı dönüşümlerinden önce, aynı düzlemdeki tüm düz levhalara uygulanır: dikdörtgen levhalar, çokgenler ve düz daireler. CSXCAD çokgenleri delik içeremediğinden oluşturma, kesilen levhayı tam farkıyla değiştirir: dikdörtgen levhayı yalnızca dikdörtgenler kesiyorsa kutular, diğer durumlarda 2B kırpılmış çokgenler (delik çevresinde kenarları birleşen birkaç çokgen kalır).

Nedeni denetimle açıklanarak reddedilen durum: kesme hacim kaldırmaz. Kesme düzlemi aynı katının hacimli şeklini geçerse (kalın kutu, uzatma, gerçek silindir, küre, ...), şekil bütün kalır ve cut-unsupported bunu bildirir. Şekli levha yapın veya Boolean çıkarma ile oyun. Canlı kutu Boolean'ı, işlenen üzerinde yuvarlak/çokgen kesme kabul etmez (levhalar çokgene dönüşür); dikdörtgen kesme kullanın veya kesmeyi Boolean'dan önce uygulayın.

### Portlar ve dirençler

Şeritte Simülasyon › Portlar › **Ayrık** veya **Dalga kılavuzu** port ekler; özelliklerinde iki tür arasında geçiş yapılır.

- **Ayrık port**: numara, empedans, başlangıç/bitiş noktası ve akım yönü (x, y veya z). Sonda beslemesi toprak düzleminden yamaya uzanır; başlangıç ve bitiş yalnızca bu yönde farklıdır.
- **Dalga kılavuzu portu**: TE modlu (varsayılan TE10), yayılma yönüne dik a genişliği ve b yüksekliği olan dikdörtgen dalga kılavuzu portu (openEMS RectWGPort). Başlangıç/bitiş kılavuz kesitini kapsar: uyarım başlangıç, ölçüm sondaları bitiş düzlemindedir. Özellikler modun kesim frekansını gösterir; “Port kutusunu a × b'ye sığdır” başlangıçtan bitişi ayarlar. openEMS yalnızca TE modlarını uyarır. Geri dalganın emilmesi için kılavuzu portun arkasındaki PML sınırına uzatın.
- “Uyarılan port”, portun sürülüp sürülmeyeceğini seçer; birden fazla port seçilirse Fairbeam her biri için çalışır ve S-matrisini saklar ([MULTIPORT.md](MULTIPORT.md)).
- **Direnç** (Simülasyon › Portlar › Direnç): sonlandırma ve yükler için iki nokta arasında toplu direnç.

**Gruplanmış ayrık portlar (isteğe bağlı).** Ayrık port özelliklerinde **Grup beslemesi ekle**, tek mantıksal port numarası, uyarım seçimi ve referans empedansını koruyarak fiziksel besleme ekler. Çalıştırmadan önce eklenen beslemeyi taşıyın; başlangıçta ilkini kopyalar ve çakışma denetimi bu yinelenen aralığı engeller. Paralel veya Seri bağlantıyı ve ek beslemenin polaritesini (+1 veya −1) seçin; ilk besleme her zaman pozitiftir. Tüm koordinatlar ifade destekler. Son ek beslemeyi kaldırmak normal porta döndürür. Dalga kılavuzu portuna geçmeden önce ek beslemeleri kaldırın.

N besleme ve mantıksal R direnci için Paralel, fiziksel sonlandırma başına N·R kullanır, işaretli gerilimlerin ortalamasını ve akımların toplamını alır. Seri, sonlandırma başına R/N kullanır, işaretli gerilimleri toplar ve akımların ortalamasını alır. Bu işlemler mod seçer; tel eklemez veya katıları birleştirmez. Aynı geometrik yönelimli diferansiyel çiftte Seri ve ikinci beslemede −1 seçin. Ters yönlü topraktan şeride beslemeler, ikisinde de +1 ile Paralel kullanabilir. Kaynak güçleri her aralığın uzunluğunu hesaba katar; üye gerilim şiddetleri bu işaretleri izler.

Kaydetme/yeniden açma, Python Uygula/dışa aktarma, önizlemeler, mesh denetimleri, çizimler ve üretim besleme konumları tüm üyeleri korur. Resmî Python giriş noktası `sim.lumped_port(..., group={"connection": "parallel", "members": [...]})`; isteğe bağlı tamsayı `group.priority` varsayılanı 5'tir. Her üye `start`, `stop`, `direction` ve isteğe bağlı `polarity` içerir. 1–15 ek besleme olabilir. Özel ölçüm bağdaştırıcıları Python'dan Tasarımcı'ya dönüşümde desteklenmez. Dışa aktar penceresi gruplanmış elektriksel portlu VBA makrosunu reddeder; paket aktarımı bunun yerine yalnızca geometri makrosu yazar (port/toplu eleman yoktur; başlıkta belirtilir).

Raporlanan empedans, S-parametreleri ve kabul edilen güç seçili moda aittir. Dik üye modları dışarıda bırakılır; bu nedenle dengesiz alanda modal güç fiziksel üye güçlerinin toplamına eşit olmak zorunda değildir. Bu biçim ve normalizasyon testleri, Örnek 7.7 veya 7.8 için mesh yakınsaması gösterilmiş sonuç sağlamaz.

Tasarımlar otomatik mesh kullanır; elle hazırlanmış mesh için Python modeli gerekir ([MODELS.md](MODELS.md)).

## Denetimler

Alt paneldeki Denetimler listesi düzenleme sırasında tasarımı izler. Anlık denetimler tarayıcıda çalışır: ifadeler ve parametre aralıkları, ters/düz kutular, diğer şekillerin yarıçap/uzunlukları, çokgenler, boş katılar ve yinelenen adlar, kesmeler, portlar (uzunluk, çakışma, empedans, dalga kılavuzu modu/boyutu/kesimi), dirençler, malzemeler ve bant. Sunucu her önizlemede kendi denetimlerini ekler: tasarım oluşturulabilmeli, uzak alan/monitör frekansları bantta olmalı ve mesh denetlenmelidir. **Hatalar** çalıştırmayı durdurur, **uyarılar** durdurmaz; **notlar** (ⓘ) yalnızca oluşturmanın çizimde görünmeyen işlemlerini açıklar.

Sunucu denetimleri, yakınsayamayan veya çok az ışıyan çalıştırmaların nedenlerini kapsar:
- `excitation-too-long`: çok küçük hücre zaman adımını küçülttüğünden uyarım darbesi (f max = 3 GHz'de yaklaşık 2 ns) zaman adımı sınırının yarısından uzun sürer (uyarı). Sınıra ulaşıyor veya aşıyorsa çalıştırma hiç yakınsayamaz; hatadır ve mesh veya sınır değişene kadar çalıştırma reddedilir.
- `thin-metal` (not): 35 µm PCB bakırı gibi mesh'in çözebileceğinden çok ince metal kutu levha olarak oluşturulur (Simülasyon ayarlarında Mesh'e bakın).
- `port-in-metal`: metal hacmine uzanan ve böylece kısa devre olan ayrık port. Port, bir iletken yüzünden diğerine aralığı kapsar. Port ortasını geçen metal hatadır (çalıştırma reddedilir); yalnızca ucu metale giriyorsa uyarıdır.
- `port-at-null`: beslediği levhanın merkezindeki sonda. Yamada burası TM10/TM01 modlarının gerilim sıfırıdır; besleme yaklaşık 0 Ω görür. Merkezden rezonans uzunluğunun yaklaşık 0,15 katı uzaklaştırın.
- `metal-overhang`: dielektrik yüzünde (veya katman içinde) duran, dielektrik kenarından havaya taşan metal levha; örneğin alttaşından geniş yama. Mesaj miktarı ve tarafı belirtir (“1,2 mm (x+)”). Kenardan sonra başka metal gövdeye uzanan metal (konnektör) veya hiç dielektrik üzerinde olmayan metal (havadaki huni/tel anten) işaretlenmez.
- `metal-floating`: başka metal, dielektrik, port, direnç veya PEC sınırına dokunmayan ve açıkça yanlış yerleşmiş metal. Yapının hemen üzerinde asılıdır (kendi boyutunun %5'i içinde dielektrik veya bağlı metal vardır; örneğin inceltilen alttaşın üzerinde kalan yama), dielektrik yüzü düzlemindedir ama kenar dışındadır veya havada katı bloktur. Daha uzaktaki levha/şeritler (yönlendirici, yansıtıcı, hava aralıklı üst yama) parazitik eleman kabul edilir ve işaretlenmez.
- `air-pad`: açıkça verilen hava payı (Simülasyon ayarları › Mesh), otomatik değerin yarısından azdır; otomatik değer f min'de çeyrek dalga boyu, uzak alan yoksa sekizde birdir. Açık sınırlar ve uzak alan kutusu bu yüzden yapıya yakındır. Sıfır (yapı sınıra uzanır) ve tüm yüzleri PEC/PMC olan tasarımlara dokunulmaz.

**Tek tıklamayla düzeltmeler.** Çözüm belirsiz değilse denetim tek geri alma adımıyla tasarımı düzenleyen düğme taşır; uygulandığında tekrar denetlenir ve sorun kaybolur:

| Denetim | Düğme |
|---|---|
| `tan-d-band` | **tan δ'yı f0 frekansında ver** (bant içinde f0 yoksa bant merkezi) |
| `port-in-metal` (uç metale giriyorsa) | **Ucu 'gnd' yüzüne taşı**: metalin port tarafındaki kendi yüzü |
| `port-floating` | **Ucu en yakın metal yüzüne taşı**: port ekseni boyunca port uzunluğunun yarısı içinde metal yüzü |
| `no-port` (hiç port yok), `port-floating` | **Ayrık port ekle…**, ayrık port penceresini açar (varsa düzeltmenin yanındaki denetim düğmesi) |
| `no-port` | **'gnd' ile 'patch' arasına sonda portu ekle**; yalnızca tek toprak üzerinde tam bir yama ve başka metal yokken: toprak yüzünden yamaya, merkezden kısa kenarın 0,15 katı uzakta |
| `metal-overhang` | **Metali 'substrate' sınırına kırp**: çizildiği gibi duran kutuyu (dizi, kesme veya canlı Boolean yok) üzerinde durduğu yüzeye kırpar; porttan koparacaksa uygulanmaz |
| `air-pad` | **Hava payını λ/4 yap** (uzak alan yoksa λ/8) |
| `port-at-null`, `excitation-too-long` | beslemeyi merkezden uzaklaştırın, en fazla zaman adımını artırın |

Düzeltmeler doğru değeri veren tasarım ifadelerini kullanır (`h`'ye taşınan port ucu, `G/2`'ye kırpılan yama); böylece tasarım parametrik kalır. Öneri yoksa denetim belirsizdir: dizi, birden fazla yama veya metal gövdesi ortasında port gibi.

İki denetim de çözülmüş ve dönüştürülmüş geometriyi sınırlayıcı kutularla inceler; kutu, levha ve çeyrek dönüşlü kopyalarda bunlar kesindir. Yalnızca kutular ve çokgenler değerlendirilir; yuvarlak/bükülmüş şekiller yalnızca metalin dokunduğu nesne sayılır. Böylece yaklaşık kutu sorunu gizleyebilir ama var olmayan sorun üretmez. Tasarım hatalıyken atlanırlar. Diğer geometri denetimleri gibi tıklamak 3B'de katıyı seçip çerçeveler.

Zaman adımı sınırında duran çalıştırma nedenini Sonuçlar'da belirtir: uyarım darbesi sınırın çoğunu tüketmiştir (zaman adımı ve en küçük hücreyle) veya alanlar yavaş sönmüştür.

Açıklamayı genişletmek için denetime tıklayın (veya üzerinde Enter/Boşluk kullanın). Geometri denetimleri öğeyi 3B'de seçip çerçeveler; odak denetimde kalır. Yeniden çerçevelemek için **3B'de göster**, girdiye odaklanmak için **Alanı düzenle** kullanın. Geometri dışı denetimlerde de alana gitmek için **Alanı düzenle** gerekir. Değer değişirken açıklama açık kalır, sorun çözülünce kapanır. Alt panelin Denetimler sekmesi ve durum çubuğu sayıyı gösterir.

Kaydetmeye her zaman izin verilir: hatalı, tamamlanmamış tasarım diskte saklanabilir; kayıt mesajı hataları sayar. Çalıştırma sunucusu denetim hatalı tasarımı reddeder (listeyle HTTP 422); tasarımcıdan, Çalıştırma panelinden, taramadan veya optimizasyon aracından gelmesi fark etmez.

## Simülasyon ayarları

Simülasyon sekmesinin düğmeleri (Frekans bandı, Sınırlar, Mesh ayarları, Uzak alan, Yüzey akımı, Verimlilik, Alan düzlemi ve Çözücü sınırları), **Simülasyon ayarları** penceresini ilgili bölümde açar. Solda Frekans, Sınırlar, Mesh, Monitörler ve Çözücü listelenir. Pencere tasarımı anında düzenler (önizleme izler, Geri Al geri döndürür); **Tamam** değişiklikleri korur, **İptal** açılıştaki tasarımı geri alma geçmişiyle geri getirir (düzenleme yapıldıktan sonra düğme **Değişiklikleri at** olur). Simülasyon sekmesinde frekans ve dalga boyu başına hücre alanları doğrudan da bulunur; yaygın değerleri pencere açmadan değiştirebilirsiniz.

![Simülasyon ayarları: açılmış kutuda altı yüzün sınırları](designer/settings.png)

- **Frekans** (Frekans aralığı): uyarımın f min ve f max değerleri (GHz; ifade kabul edilir). Mesh f max'ı, model çevresindeki hava f min'i kullanır.
- **Sınırlar**: altı yüzü açılmış kutu (y− size bakar, z+ üsttedir). Yüze tıklayıp türünü seçin veya altısını birden ayarlayın:
  - **Açık (MUR)**: düşük maliyetli açık emici sınır; yama şablonu ve boş tasarım kullanır;
  - **Açık (PML, 8 hücre)**: 8 ek hücreyle daha iyi emen açık sınır; diğer şablonlar kullanır;
  - **Elektrik duvarı (PEC)**: toprak düzlemi veya elektrik simetri düzlemi;
  - **Manyetik duvar (PMC)**: manyetik simetri düzlemi.

  **Açık, boşluk ekle**, model ile açık yüzler arasındaki havadır (`mesh.pad`, mm; boşsa f min'de çeyrek dalga boyu).
- **Mesh**: **Mesh modu**, **Otomatik (önerilen)** (uyarlamalı mod; değerler sunucunun seçtiği değer ve gerekçeyle isteğe bağlı alan ayarları olarak görünür), **Klasik (eski)** (yalnızca dalga boyu başına hücre, kenar kuralı, hücre oranı ve hava yoğunluğu ayarlarını zaten kullanan tasarımda) veya **Elle girilen çizgiler** (yalnızca örnekten kopyalanan gibi bu çizgileri içeren tasarımda; **Otomatik mesh'e geç** değiştirir) olabilir. Bölüm önizleme mesh'ini, en küçük hücreyi ve tahmini çözücü süresini gösterir. Mesh oluşturucu [MESHING.md](MESHING.md) sayfasında açıklanır. Buradaki **Mesh yakınsaması…** (şeridin Mesh grubunda da var), mesh'in yeterince ince olup olmadığını kontrol eder ([Mesh yakınsaması](#mesh-convergence)); **Mesh görünümünü göster** görünümü açar.
  - **İnce metal** (`mesh.thin_metal`): “Levha olarak modelle” (varsayılan), en ince hedef hücrenin onda birinden ince metal kutuları sıfır kalınlıklı PEC levha olarak oluşturur (hedef: f max'taki λ / dalga boyu başına hücre / en yoğun dielektriğin √εr değeri). Levha alttaşa temas eden yüze, yoksa ortaya yerleştirilir; bakır içindeki port ve direnç uçları üzerine taşınır. Bakırı gerçek kalınlığıyla çizin: görünüm ve aktarımlar korur, yalnızca mesh yok sayar. 2,45 GHz'de bakırın deri kalınlığı yaklaşık 1,3 µm olduğundan 17–70 µm alanları çok az değiştirir; ama mesh oluşturmak zaman adımını yaklaşık 30 kat küçültür. “Kalınlığı mesh'le”, yalnızca en ince hücrenin en az 0,6 katı kalınlıktaki levhaları hacim olarak korur. Daha ince levhalar (35 µm bakır) burada da levha kalır; içlerinden geçen hücreler zaman adımını 30–60 kat küçültüp çalıştırmayı 5–25 dakikaya uzatır veya yakınsamayı engeller.
- **Monitörler**:
  - **Uzak alan** (açık/kapalı), frekansları (boşsa her uyumlu bandın |S11| minimumu) ve isteğe bağlı **Faz merkezini ayarla (mm)**. Tasarım dosyası ayrıca yakın alandan uzak alana kutusunun kayıt yapan yüzleri için altı true/false bayrağı (x−, x+, y−, y+, z−, z+) olan `far_field.faces` ayarlayabilir; piramit huni örneği gibi besleme dalga kılavuzunun geçtiği yüz dışarıda bırakılır. Henüz arayüz alanı yoktur.
  - **Yüzey akımı**: metal levhalarda harita kaydedilecek frekanslar; `fairbeam run --fields` gibi. Çalıştırmadan sonra ağaçta çalıştırmanın 2B/3B Sonuçlar bölümünde bulunur. Simülasyon › Monitörler › **Yüzey akımı** bu alanı açar; tasarımda henüz yoksa uzak alan frekanslarıyla (yoksa bant merkeziyle) başlatır, İptal geri alır. Yanındaki **Uzak alan** uzak alan ayarlarını açar.
  - **Bant boyunca verimlilik** (varsayılan kapalı): bantta eşit aralıklı N frekansta ışıma verimliliği (varsayılan 21; 3–201 arasında tam sayı); `monitors.efficiency: {"points": N}` ve paketin `results.efficiency` alanında saklanır. Toplam verimlilik portun S11'iyle hesaplanır. Çalıştırmadan sonra uzak alan kutusundan hesaplandığı için ek son işlem süresi gerektirir; uzak alan gerektirir. Uzak alan kapalı veya sayı 3–201 dışındaysa `monitor-efficiency` denetimi (tarayıcı ve sunucu) çalıştırmayı engelleyen hata verir. Simülasyon › Monitörler › **Verimlilik** açar (İptal geri alır) ve **Frekans sayısı** alanını gösterir.
  - **Alan düzlemleri**: en fazla 4 kesit düzlemi; her biri bant içindeki 1–4 frekansta E/H alanı genliğini kaydeder (|E| veya tek bileşen |Ex|, |Ey|, |Ez|; H için de aynı). Satırda nicelik, düzlem normali (x/y/z), o eksende mm konumu (`h + 1` gibi ifade) ve frekanslar ayarlanır. **Alan düzlemi ekle** ve **Kaldır** listeyi düzenler. `monitors.field_planes: [{"quantity": "E", "normal": "z", "position": "h + 1", "frequencies": ["f0"]}]` olarak saklanır (tek bileşende `"component": "x"`). openEMS, konuma en yakın mesh çizgisinde tüm bölge boyunca frekans alanı E/H kaydı yapar. Değerler, uyarılan portta 1 W gelen güç için V/m veya A/m cinsinden tepe fazör genlikleridir (yüzey akımı gibi tek uyarım). `field-plane` (tarayıcı ve sunucu), 4'ten fazla düzlemi, frekanssız veya 4'ten fazla frekanslı düzlemi ve bant dışı frekansı işaretler; `field-plane-position` (sunucu; önizleme bölgesi gerekir) bölge dışı konumu işaretler. Hepsi çalıştırmayı engelleyen hatadır. Simülasyon › Monitörler › **Alan düzlemi**, yoksa düzlem ekler (E, z normal, model üstünden 1 mm yukarıda, uzak alan frekansları veya bant merkezi; İptal geri alır) ve konumunu açar.
- **Çözücü**: durdurma ölçütü (çalıştırmayı durduran alan enerjisi sönümü: −40 dB hızlı, −60 dB doğru) ve zaman adımı sınırı. Ölçüt −10 ile −300 dB arasında sayıdır; alan, `end-criterion` denetimi (tarayıcı/sunucu) ve çalıştırma bu sınırları kullanır. Dışındaki değer (örneğin −5 dB) engelleyici hatadır. −10 dB, Fairbeam'in kullanılabilir sonuç sınırıdır (üstünde alanlar çok az sönmüştür), fiziksel sınır değildir; −300 dB kabul edilen en düşük değerdir. En fazla zaman adımı boşsa (“otomatik”) mesh'ten seçilir: en az 60,000, uyarım darbesi ve sönümü veya yaklaşık 1e11 hücre-adımın izin verdiği değer (en fazla 600,000), hangisi büyükse. Yakınsayan çalıştırma zaten önce durur. İnce düşük kayıplı alttaş (0,254 mm RT5880 yaklaşık 50 ns, 280,000 zaman adımı çınlar) bu paya ihtiyaç duyar; açıkça verilen sınır tahmini sönümden düşükse `slow-ringdown` uyarır.

## Mesh görünümü

Şeritte Simülasyon › **Mesh görünümü** (veya durum çubuğunda hücre sayısına tıklama), geçerli önizlemenin FDTD mesh çizgilerini tek düzlemde gösterir; çizgiler görünsün diye katıları soluklaştırır. Mesh, çalıştırmayla aynı oluşturucudan gelir. 3B görünüm üzerindeki panelde:

- düzlem kontrolleri: x/y/z ve mesh çizgileri arasında kaydırıcı;
- eksen başına çizgi, hücre sayısı, en küçük/en büyük hücre ve zaman adımı;
- **tahmini çözücü süresi** bulunur.

Tahmin, hücre × zaman adımı sayısının [BENCHMARKS.md](BENCHMARKS.md) içindeki temkinli işlem hızına bölümüdür: M5 Pro CPU motorunda 4 iş parçacığıyla 318–329 MCells/s ölçülmüş, 250 varsayılmıştır; küçük ızgaralarda daha düşüktür. GPU motoru 700 MCells/s varsayar. Zaman adımları bant merkezinin 15–80 periyodudur. Gerçek süre, ancak sonradan bilinen alan enerjisi sönüm hızına bağlıdır; bu nedenle aralığı kaba rehber olarak değerlendirin.

## Mesh yakınsaması

Simülasyon › Mesh › **Mesh yakınsaması…** (veya Simülasyon ayarları › Mesh'teki aynı düğme), mesh'in yeterince ince olup olmadığını kontrol eder. Tasarım artan otomatik mesh yoğunluklarında (f max'ta dalga boyu başına hücre) çalışır ve her çalıştırma öncekiyle karşılaştırılır:

- rezonans frekansı (ilk uyumlu bandın S11 minimumu, yoksa global minimum);
- rezonanstaki |S11| (dB);
- rezonansa en yakın uzak alan frekansında Dmax (yalnızca uzak alan açıkken);
- rezonanstaki giriş empedansı (gösterilir; durma kuralına dahil değildir).

Pencerenin ayarları:

| Alan | Varsayılan | Anlamı |
| --- | --- | --- |
| Yoğunluklar | 15, 20, 30, 40 | Kabadan inceye dalga boyu başına hücre |
| Rezonans değişimi sınırı | 0,5 % | Rezonans frekansı toleransı |
| \|S11\| değişimi sınırı | 1 dB | Rezonanstaki \|S11\| toleransı |
| Dmax değişimi sınırı | 0,2 dB | Dmax toleransı |
| Çalıştırma sınırı | 4 | Listedeki en fazla bu kadar yoğunluk çalışır (liste daha uzunsa not görünür) |
| Motor | Çalıştırma ayarları | Sunucuda ikisi de varsa CPU veya GPU |

Çalışma, tüm değişikliklerin toleransların kesin olarak altında kaldığı ilk adımda durur. Ardından **N hücre/λ'da yakınsadı** bildirir; N, o adımın daha kaba yoğunluğudur, daha ince çalıştırma doğrular. Önce yoğunluklar veya sınır tükenirse **Yakınsamadı** der, değişmeye devam eden niceliği belirtir (“30–40 hücre/λ arasında rezonans hâlâ %0,8 değişiyor; sınır %0,5”) ve daha ince yoğunluk veya modeli inceleme önerir. Başarısız/durdurulmuş çalıştırma da çalışmayı bitirir. Tablo **Tolerans içinde** sütununda her çalıştırmanın öncekinden değişiminin tüm toleranslarda olup olmadığını söyler.

Herhangi bir çalıştırmadan önce pencere her yoğunlukta geometri önizlemesi oluşturur (simülasyon yapılmaz); hücreleri, yoğunluk başına tahmini çözücü süresini ve tüm çalıştırmalar gerekirse toplamı gösterir. 10 dakika üzerinde uyarır ve düğme **Yine de başlat** olur. Tahmin [Mesh görünümü](#mesh-view) ile aynıdır.

**Başlat** tasarımı kaydeder (denetim hataları çalıştırmadaki gibi engeller), ilk yoğunluğu kuyruğa alır. Sonraki yoğunluk, ancak önceki bitmişse ve kural devam diyorsa kuyruğa alınır; erken yakınsayan çalışma ek çalıştırma tüketmez. Pencere ilerlemeyi (**Durdur** ile) ve çalıştırmalar bitince raporu gösterir: yoğunluk başına her nicelik/değişim tablosu; yoğunluğa karşı rezonans, |S11| ve Dmax grafikleri (yakınsanmış yoğunluk dolu işaretli); sonuç. **Tasarıma N hücre/λ uygula**, bu yoğunluğu ayarlar (`mesh.cells_per_wavelength` veya Otomatik modun `cells_per_wavelength` alan ayarı); Geri Al geri döndürür.

Çalışma iki otomatik modda da çalışır (Otomatik (önerilen), Klasik (eski)). Elle ayarlanan hava yoğunluğu yoğunlukla ölçeklenir. Elle mesh çizgili tasarım çalışma yapamaz; önce otomatik mesh'e geçin. Çalıştırmalar normal tasarım çalıştırmalarıdır (her birinin `<design>--mesh-<density>` adlı paketi vardır); tüm sonuç görünümleri ve karşılaştırma çalışır. Sunucu çalışmayı paketlerin yanındaki `studies/<id>.json` dosyasında tutar ([STUDIES.md](STUDIES.md)); aynı çalışma komut satırında `fairbeam converge <design>.design.json` ile çalışır.

## Çalıştırma ve sonuçlar

**Çalıştır** (Simülasyon sekmesi, üst çubuk veya Ctrl/Cmd+Enter), **Simülasyonu çalıştır** penceresini açar:

- **Motor**: **CPU (çok iş parçacıklı)** veya sunucuda ilgili sürüm varsa **GPU (Metal veya CUDA sürümü)** ([GPU.md](GPU.md)).
- CPU için **İş parçacığı** (4 iyi bir varsayılandır).
- **S-parametresi örnek noktaları**: banttaki örnekler (varsayılan 801; 11–20001).
- **Sonuç adı**: her çalıştırmada benzersiz paket için boş bırakın (model kimliği ve çalıştırma son eki). Çalıştırma öncekini değiştirmez; kullanılan ada kısa kimlik eklenir.

Pencere tahmini çözücü süresini de gösterir (birden fazla uyarılan portta her port için çalıştırma). **Çalıştır** düğmesi (kaydedilmemiş değişikliklerde **Kaydet ve çalıştır**) önce kaydeder. Denetimler'de hata varsa reddeder; pencerede hatalar listelenir, tıklamak alana gider. Düzeltmesi bilinen denetim burada da düğme sunar: örneğin uyarım darbesi tek başına sınırdan fazla zaman adımı gerektiriyorsa **En fazla zaman adımını N yap** sınırı artırır (süre 1.18e+03 fs değil, 1,18 ps gösterilir). Çalıştırma engelliyken süre tahmini gösterilmez. **Optimize et…** optimizasyon aracını açar.

![Tamamlanmış çalıştırma: 3B görünüm yanında işaretçili S-parametreleri sekmesi ve alt panelde Çalıştırmalar](../landing/media/designer-sparams.jpg)

İlerleme alt panelin **Çalıştırma** sekmesinde (durum çubuğunda “Çalışıyor %N”) görünür:

- aşamalar;
- zaman adımı, hız, durdurma ölçütüne göre alan enerjisi, geçen ve tahmini kalan süre;
- yakınsama grafiği;
- **İptal** düğmesi.

3B görünüm tasarımı göstermeye devam eder; düzenlemeyi sürdürebilirsiniz (çalıştırma kaydedilmiş dosyayı kullanır).

**Çalıştırma kalitesi.** Tamamlanan her çalıştırma bir sonuç alır (`src/lib/runQuality.ts`): *yakınsadı*, *yakınsamadı* (zaman adımı sınırında durdu; S11 ve uzak alan yanlış olabilir) veya *şüpheli* (0 dB üzerinde |S11|, %100 üzerinde ışıma verimliliği ya da bağlanmamış port: tüm bantta -0,5 dB veya üzerinde |S11| ve/veya her uzak alan girdisinde %2 altında toplam verimlilik; tipik olarak geometri döndürülünce aralığı artık kapsamayan besleme). “Yakınsadı” yalnızca alan enerjisinin durdurma ölçütüne ulaştığını söyler; uyum hakkında bir şey söylemez. Sorunlu çalıştırma, sonuç sekmeleri ve Çalıştırma sekmesinde nedeni ve değiştirilecek ayarı açıklayan sarı bant gösterir (en fazla zaman adımını artırın veya durdurma ölçütünü gevşetin; mesh'i inceltin, sınırları uzaklaştırın veya durdurma ölçütünü düşürün; verimlilik notuna bakın). Ağaçta ve Çalıştırmalar tablosunda uyarı rozeti bulunur. Yakınsamadan bitince alt panel Çalıştırma sekmesinde kalır.

Biten çalıştırma gezinti ağacında Sonuçlar altında görünür (Çalıştırma panelinde bitenler de). Sonuç düğümlerinden veya Son işlem sekmesinden görünümleri 3B yanında açılır. Alt panelde **Çalıştırmalar** tasarımın çalıştırmalarını, **Günlük** openEMS çıktısını tutar. Ağaçtaki her satır adının altında temel sayıları (rezonans, |S11| minimumu, Dmax) taşır; Çalıştırmalar tablosunda rezonans, |S11| minimumu, −10 dB bant genişliği, Dmax ve toplam verimlilik sütunları vardır (paketten; henüz okunmamış çalıştırmada dizinden bandın |S11| minimum frekansı gösterilir):

- **Özet** (ağaç: Tablolar › Özet veya Son işlem › Özet): çalıştırma kartı. Yakınsama bandı (sorunlu çalıştırmada üstünde kalite bandı), temel sayılar (rezonans, |S11| minimumu, −10 dB bant genişliği, rezonansa en yakın uzak alanda Dmax, gerçekleşen kazanç ve toplam verimlilik), uyumlu bantlar, uzak alan değerleri ve çözücünün işlemleri. Birden fazla çalıştırmada her çalıştırma için satır, farklı her parametre için sütun içeren tablo olur. **Referans çalıştırma** farkı değerin altında (Δ görünümünde üstünde) gösterilir. Varsayılan referans seçili en eski çalıştırmadır (seçiliyse A); tablonun üstünden değiştirilebilir. **Veriyi kopyala** ve **CSV**, aynı tabloyu İngilizce başlıklar, ondalık noktalar, referansa göre Δ sütunları ve son sütunda referans adıyla yazar. |S11| minimumu bant kenarında ve −10 dB altında hiçbir şey yoksa rezonans yoktur: Özet, tablo, ağaç ve Özellikler “bantta rezonans yok (minimum bant kenarında)” der; böyle çalıştırmaların mesh yakınsama çalışması adımları yakınsamış değil, karşılaştırılamaz bildirir.
- **S-parametreleri**: −10 dB bantlarıyla |S11| veya çok portta S-matrisinin uyarılmış sütunu. Yan panel her uyumlu bandın en iyi uyumunu (|S11| minimum frekansı), minimum |S11|'ini, merkezini (bant kenarlarının ortası), aralığını ve bant genişliğini listeler. Simülasyon aralığı dışına devam eden bant açık kenarında ≤ / ≥ ile işaretlenir; genişliği alt sınırdır.
- **Empedans**, **VSWR** ve **Smith**: giriş empedansı, VSWR (2:1 işaretli) ve Smith abağında yansıma.
- **Verimlilik**: bant boyunca 1 − |S11|² uyumsuzluk verimliliği (% veya dB); uzak alan frekanslarında nokta olarak ışıma ve toplam verimlilik (ışıma × uyumsuzluk). Nicelik başına veya çok portta uyarılan port başına ayrı renk. Işıma verimliliği yalnızca openEMS'in uzak alan hesapladığı yerde bilinir (Simülasyon › Monitörler › Uzak alan'dan frekans ekleyin); bant boyunca kaydeden çalıştırmada (`results.efficiency`) bu ve toplam verimlilik eğri çizilir. %100 üstü değerler fiziksel değildir ve işaretlenir. Port gelen gücün yalnızca birkaç yüzdesini kabul ediyorsa verimlilik, duruş anındaki sönüme bağlıdır. Kabul edilen gücü %10'dan fazla belirsiz değerler eğriden çıkarılıp notlu işaretli noktalar olarak çizilir. Daha düşük durdurma ölçütü (örneğin −70 dB) bandın daha fazlasını güvenilir yapar; ölçümler [BUNDLE.md](BUNDLE.md#efficiency) içindedir.
- **Örüntü** (uzak alan varsa): seçili niceliğin φ = 0°/90° kesitleri; Dmax, kazanç, gerçekleşen kazanç, ışıma/toplam verimlilik ve ana lob yönü; uzak alan frekansı başına etiket. Araç çubuğunda **3B'de göster** aynı uzak alanı 3B örüntü olarak çizer.
- **Yüzey akımı** (monitör varsa): frekans başına ağaç düğümü veya Son işlem › **Akımlar**; harita 3B görünümde çizilir.
- **Alan düzlemi** (varsa): her haritanın 2B/3B Sonuçlar altında **… · 2B harita** ve **… · 3B** düğümleri vardır. 3B düğümü (veya Son işlem › **Alan düzlemi**, çalıştırmanın ilk haritası) gerçek konumda yarı saydam ısı haritası düzlemi çizer. Sağ üst renk çubuğu haritayı ve uyarılan portu adlandırır; **dB** (0 dB = harita maksimumu, 40 dB aralık) ve **Doğrusal** (0–maksimum, V/m veya A/m) arasında geçer. Haritalar çalıştırmada kaydedilir; düzlem değiştirmek yeni çalıştırma gerektirir.
- **Alan haritası** (alan düzlemi varsa): **2B harita** veya Son işlem › **Alan haritası**, aynı haritayı ana alan sekmesinde açar: ortak ölçekte mm eksenleri, **dB** / **Doğrusal** renk çubuğu, model katılarının düzleme izdüşüm dış çizgileri (metal düz, dielektrik kesikli; **Yapı dış çizgisi** kapatır) ve imleç altı değer (harita odaktayken oklarla da; Shift on örnek ilerler, Escape temizler). **Harita** seçici çalıştırmanın haritaları arasında geçer; **3B'de göster** görünümde çizer. Veriyi kopyala/CSV örnek başına satır verir: mm cinsinden u/v, genlik; faz verisi varsa her saklanan bileşenin gerçek/sanal kısmı ve derece cinsinden fazı. Başlıklar İngilizce, ondalıklar noktadır. Faz verisi öncesi çalıştırmalar notla yalnızca genlik gösterir.
  - **Faz ve Canlandır** (2B sekme ve 3B renk çubuğu ortaktır): **Faz**, tek bileşenin fazını uyarılan portun gelen dalgasına göre renklendirir (döngüsel ölçek; alan faz belirlemek için çok zayıfsa gri; |E| haritasında en güçlü bileşen veya **Bileşen** altında Ex/Ey/Ez). **Canlandır**, bir periyotta anlık Re{F·e^(jωt)} gösterir: bileşen işaretli değer (mavi-açık-kırmızı), |E| haritası anlık genlik |E(t)| olur. **Oynat** periyodu 24 karede (döngü başına bir saniye) ilerletir; sayfa gizlenince veya sistem azaltılmış hareket isteyince duraklar (kaydırıcıyla gezilebilir). 3B aynı düzlemi her anda yeniden çizer. dB / Doğrusal yalnızca genliğe uygulanır.
  - **Örnekler**: alan düzlemli paket, Örnekler görüntüleyicisinde model panelinde **Alan düzlemi** altında listeler; seçili harita aynı renk çubuğu, faz ve canlandırmayla 3B'de çizilir.
- **Tablo**: frekans, |S11|, VSWR ve empedans.
- **Günlük** (alt panel): openEMS çıktısı (eski çalıştırmada son kısmı), tam günlük bağlantısıyla.

Uzak alan **niceliği** (Yönlülük, Kazanç, Gerçekleşen kazanç; dairesel polarizasyon verisi varsa RHCP/LHCP yönlülüğü), Örüntü sekmesinin yan panelinden, 3B uzak alan kartından veya örüntü gösterilirken **Son işlem › Uzak alan › Nicelik** yolundan seçilir; oturum boyunca korunur. Kazanç, yönlülük + 10·log10(η_rad); gerçekleşen kazanç, uyarılan portun uzak alan frekansındaki S11'iyle yönlülük + 10·log10(η_rad·(1 − |S11(f)|²)) olur. Maksimumları paketin `gain_dbi` ve `realized_gain_dbi` değerleridir. Işıma verimliliği yoksa kazanç seçenekleri kapalıdır (neden ipucundadır); örüntü yönlülük kalır.

**3B örüntü** görünürken sağ üst kart renk ölçeği, nicelik, uzak alan frekans etiketleri (çok portta uyarılan port), Dmax, kazanç, gerçekleşen kazanç, ışıma/uyumsuzluk/toplam verimlilik ve ana lob yönü θ, φ içerir. Oku yalnızca renk ölçeğine katlar. Çok portlu dizi, yalnızca yönlülük içeren dizi örüntüsünü (tüm portlar beslenmiş) gösterir.

Başka çalıştırma ağaçtan açılır. Üst çubuk aktarımları (**Paketi dışa aktar**, **VBA makrosu dışa aktar**) ve Son işlem › PDF raporu / Paket, gösterilen çalıştırmayı kullanır. Sonuç sekmesi araç çubuğunun sağındaki ✕, gösterilen çalıştırmayı (sonuç sekmeleri ve alt paneldeki Çalıştırmalar/Günlük) kapatır; sekmenin ✕ işareti yalnızca o sekmeyi kapatır. Her sekmenin araç çubuğunda ayrıca **Karşılaştır**, veri biçimi menüsü, **Veriyi kopyala**, **CSV** ve **Touchstone** vardır.

### Birden fazla projeyle çalışma

Düzenleyicide şu anda tek etkin tasarım vardır. Ana ekrandan başka tasarım açmadan kaydedin; her dosya kendi kayıtlı geometrisini ve sonuç ilişkilerini korur, ancak yeniden açılışta yeni Geri Al/Yinele geçmişi başlar. Sonuç sekmeleri seçili çalıştırmanın görünümleridir; bağımsız proje düzenleyicileri değildir.

Sonuç sekmesinde **Karşılaştır**, geçerli tasarımın çalıştırmalarını diğer projelerden ayrı gruplar. Etkin tasarımı veya birincil sonucunu değiştirmeden üst üste çizmek için başka projenin kayıtlı sonucunu seçin. En fazla sekiz çalıştırma karşılaştırılabilir. Proje/çalıştırma etiketleri eğrileri ve çıktıları ayırır. Sonuçlar yalnızca seçilince yüklenir; başarısız yüklemeler Yeniden dene/Kaldır sunar, şekil yakalama seçili karşılaştırmanın hazır olmasını bekler. Tasarım değişimi karşılaştırmayı temizler. Bağımsız düzenlenebilir proje sekmeleri ve yan yana proje pencereleri henüz yoktur.

Bağımsız Sonuçlar görüntüleyicisi de **Karşılaştır** ile dizinlenmiş sonuçları karşılaştırır. Başka proje görüntülenirken gönderilmiş simülasyonlar sunucuda sürer; kuyruk tek seferde tek çözücü çalıştırır. Yeni tasarımcı çalıştırmaları, taramalar, optimizasyonlar ve mesh yakınsaması incelemeleri, gönderim anında alınmış kayıtlı tasarımın denetlenmiş kopyasını kullanır. Sonraki düzenlemeler kuyruktaki girdiyi değiştirmez. Python modelleri ve eski işler özgün yollarını kullanır; kuyruktayken kaynakları değiştirmeyin. Tam kapsam için [kabul edilen tasarım girdileri](QUEUED-DESIGN-INPUTS.md) sayfasına bakın. [Çoklu proje planı](MULTI-PROJECT-PLAN.md), bağımsız düzenleyiciler için kalan durum, pencere ve oturum çalışmalarını kaydeder.

Taramalar ve optimizasyon aracı Optimize et sekmesinden (**Parametre taraması**, **Optimizasyon aracı**) başlar; çalıştırmaları ağaçta Sonuçlar altında görünür. Python modelleri Çalıştır panelini kullanır ([RUN-SERVER.md](RUN-SERVER.md), [OPTIMIZE.md](OPTIMIZE.md)); tasarım da burada diğer modeller gibi adıyla görünür.

Yeni tarama ekseni parametrenin geçerli değerinin ±%10'u aralığında 5 adımla başlar (asla tüm aralığıyla değil), tasarım frekansı yerine geometrik parametre seçer. Başka parametre seçilince aralık yeniden belirlenir. Optimizasyonun ilk parametresi de geometriktir, sınırları geçerli değerin ±%20'sidir.

Optimizasyon aracı simülasyondan önce tasarımın her adayını denetler. Denetim hatalı veya tasarımın kendi değerlerinde olmayan metal taşması/havada kalma (`metal-overhang`, `metal-floating`) oluşturan aday simüle edilmez. Değerlendirme tablosunda nedenli **Atlandı** görünür (ör. "'patch', 'substrate' üzerinden 1,2 mm taşıyor (x+)"); en az başarısız değerlendirme cezası alır, arama devam eder. Taramalar her noktayı olduğu gibi çalıştırır.

## Dosyalar

- **Konum**: tasarımlar çalıştırma sunucusunun modeller klasöründe, Python modellerinin yanında kaydedilir. Kaynak kopyasında `python/models/`; masaüstü uygulamasında çalışma klasörünün `models/` alt klasörü (macOS'te `~/Documents/Fairbeam`, Windows'ta `%USERPROFILE%\Documents\Fairbeam`).
- **Kaydetme**: her kayıt önceki sürümü `model-history/` içinde tutar. Dosya açıldıktan sonra diskte değiştiyse tasarımcı bildirir; yeniden kaydetmek sizin sürümünüzle üzerine yazar.
- **Biçim**: `fairbeam.design/1`, tek JSON nesnesi; `python/fairbeam/design.py` başında belgelenmiştir (tüm şekil türleri, dalga kılavuzu portları, dönüşümler, kesimler, bileşenler). Tam ve geçerli sonda beslemeli yama örneği:

  ```json
  {
    "schema": "fairbeam.design/1",
    "model": {"id": "my-patch", "name": "My patch"},
    "params": [
      {"key": "f0", "default": 2.45, "unit": "GHz"},
      {"key": "W", "default": 32, "unit": "mm"},
      {"key": "L", "default": 40, "unit": "mm"},
      {"key": "h", "default": 1.524, "unit": "mm"},
      {"key": "lam", "expr": "wavelength(f0)", "unit": "mm"},
      {"key": "G", "expr": "L + lam / 2", "unit": "mm"}
    ],
    "simulation": {"f_min": "f0 * 0.6", "f_max": "f0 * 1.3", "boundaries": "MUR", "end_criteria_db": -60},
    "materials": [
      {"name": "copper", "kind": "metal"},
      {"name": "substrate", "kind": "dielectric", "eps_r": 3.38, "tan_d": 0.0027, "tan_d_freq": "f0"}
    ],
    "parts": [
      {"name": "substrate", "material": "substrate", "primitives": [{"kind": "box", "start": ["-G/2", "-G/2", 0], "stop": ["G/2", "G/2", "h"]}]},
      {"name": "gnd", "material": "copper", "primitives": [{"kind": "box", "start": ["-G/2", "-G/2", 0], "stop": ["G/2", "G/2", 0]}]},
      {"name": "patch", "material": "copper", "primitives": [{"kind": "box", "start": ["-W/2", "-L/2", "h"], "stop": ["W/2", "L/2", "h"]}]}
    ],
    "ports": [{"type": "lumped", "number": 1, "R": 50, "start": [-6, 0, 0], "stop": [-6, 0, "h"], "direction": "z"}],
    "resistors": [],
    "mesh": {"mode": "auto", "cells_per_wavelength": 20},
    "far_field": {"enabled": true, "frequencies": ["f0"]},
    "monitors": {"currents": ["f0"]}
  }
  ```

  `f0`, `W`, `L`, `h` bağımsız; `lam`, `G` türetilmiş parametrelerdir (türetilmiş parametre üstündekileri kullanabilir). `monitors` isteğe bağlıdır. `monitors.currents`, `fairbeam run` komutunun `--fields` olmadan o frekanslarda yüzey akımı kaydetmesini sağlar. `monitors.efficiency: {"points": 21}`, `--efficiency 21` gibi bant boyunca verimlilik ekler. `monitors.field_planes`, `--field-plane` gibi kesitlerde E/H haritaları kaydeder.
- **Örnek tasarımlar**: [examples/designs/](../examples/designs/README.md), modeller klasörünüze kopyalanacak, tamamı 867 MHz İHA telemetrisi için tasarımlar içerir: geriye süpürülmüş bıçak anten, yarıklı geniş bantlı düzlemsel dipol, metal kaplamasız gövdeler için baskı kıvrımlı dipol, baskı kılıflı dipol, baskı iki elemanlı eşdoğrusal anten ve yer istasyonu için beş elemanlı Yagi; her birinin sonuçları ve diğer bantlara ölçekleme açıklaması vardır. Masaüstü uygulaması bunları 867 MHz örneklerinin kaynağı olarak çalışma klasörünün modeller klasörüne salt okunur kurar. **Yeni tasarım olarak aç…**, düzenlenebilir kopya oluşturur. Kimlikleri, dahil edilen Python modelleri gibi kendilerine ayrılmıştır.
- **Örnek kopyaları**: dahil edilen Python örneğinin kopyası; örnek açıklamasını, katı ad/etiketlerini ve malzeme adlarını korur. Dönüştürmenin yaptıkları (taşınan ve sabitlenen parametreler), `model.conversion` içinde saklanır; Özellikler'de **Dönüştürme notları** olarak görünür.
- **Komut satırı**: tasarım model dosyası gibi çalışır: `fairbeam run python/models/my_patch.design.json --set W=30` ([CLI.md](CLI.md)).
- **Python dışa aktarımı**: Son işlem › Rapor ve dışa aktarma › **Python** (masaüstünde ayrıca Dosya › Dışa aktar › Python…), Özellikler yerine **Python kaynağı** panelini açar. Tasarımı eşdeğer Python modeli (`MODEL`, `PARAMS`, `build`) olarak verir; elle düzenleme veya tasarımlarda henüz olmayan özellikler için kullanılabilir ([MODELS.md](MODELS.md)). **Kopyala** panoya, **Kaydet…** `.py` dosyasına yazar; tasarım değişiklikleri kaynağı eskittiğinde **Kaynağı yenile** görünür. Aynı geometriyi ve mesh'i kurar.
- **Düzenle ve Uygula**: Python panelindeki **Düzenle**, betiği düzenleyiciye dönüştürür (satır numarası, Python renklendirme, Tab girinti). **Uygula** (veya Ctrl/Cmd+Enter) sunucuya gönderir; sunucu çözücü olmadan geometriyi kurar, tasarımın katılarını, malzemelerini, portlarını, parametrelerini, mesh'ini, simülasyonunu ve uzak alanını sonuçla **tek geri alma adımında** değiştirir. Tasarımın adı/kimliği korunur. Betik, dahil edilen Python örnekleriyle aynı dönüştürücüyle okunur; kuralları geçerlidir: yalnızca tam şekiller, parametrelere doğrusal bağlı koordinatlar ifade olur, diğer sayılar sayı kalır, hiçbir şeyi etkilemeyen parametre çıkarılır. Uygula sonrasında panel yeni tasarımdan betiği yeniden yazar; bu betik aynı tasarımı kuruyorsa metniniz kalır, değilse değiştirilir ve normalleştirildiği bildirilir. Hata (Python istisnası, sözdizimi, desteklenmeyen özellik, zaman aşımı) satırıyla döner: düzenleyici satırı işaretler, mesaj başlık altında görünür, tasarım değişmez. **Bitti**, uygulanmamış değişiklikleri atmadan önce sorar. Düzenleme bağlı sunucu gerektirir; Python bilgisayarınızda çalışır. Web demosunda düğme nedeni belirtilerek devre dışıdır. Betik, alt süreçte 20 s süre ve 512 KB boyut sınırıyla, tek seferde bir tane çalışır; `FDTD.Run` / `Simulation.run` çözücü başlatmak yerine hata verir. Bu bir korumalı alan değildir: betik Python'un yapabildiği her şeyi yapabilir; yalnızca kendi kodunuzu uygulayın.

## VBA makrosunu içe aktarma

**VBA makrosunu içe aktar…** (Ana ekran, Giriş › Proje › Makroyu içe aktar, Dosya › VBA makrosunu içe aktar…), CST uyumlu VBA makrosu (`.bas`, `.mcs`) veya metin olarak kaydedilmiş geçmiş listesini okur. Kaydetmeden önce içe aktarma raporunu gösterir: oluşturulanlar, içe aktarılmayan/değiştirilen her komut ve satırı. Tasarıma ad verin; **Oluştur ve aç** kaydedip burada açar. Komut satırında aynı işlem: `fairbeam import-cst model.bas --out my.design.json`.

Okunanlar (`python/fairbeam/cst_import.py`, `SUPPORTED`): birimler; tasarım parametreleri olarak `StoreParameter`, `MakeSureParameterExists`, ... (değer bağımsız, ifade türetilmiş parametre; VBA `^`, `Sqr`, `Atn`, `Mod`, `\`, `Pi`, `clight`, ... çevrilir; ayrıca açıları ve sonuçları derece olan `Sind`, `Cosd`, `Tand`, `Asind`, `Acosd` ve `Atnd` derece işlevleri); malzemeler (Normal: εr ve tan δ, iletkenlik eşdeğer tan δ olarak; PEC; kayıplı metaller notla PEC olarak); kutular, silindir/borular, koniler, küreler, toruslar, çokgenler, kapatılmış/uzatılmış dikdörtgen veya daireler, nokta listesi uzatmaları; düzlemsel bir levhada `Solid.ThickenSheetAdvanced` (İç, Dış veya Ortalı; levhanın yüzey normaline göre alınır); aynı dış hatlı iki dışbükey, paralel levha arasında çok yüzlü olarak düz bir `Loft` (sıfır teğetlik); bileşenler; tasarımcının Boolean işlemlerinin desteklediği yerlerde (kutu, levha, çokgen) canlı Boolean olarak `Solid.Add` (birleşim), `Solid.Subtract`, `Intersect`, `Insert`; dönüşümler (öteleme, her açıda döndürme, aynalama, tekdüze ölçekleme, kopyalarla); eksenlere paralel yerel çalışma koordinat sistemleri; frekans aralığı, sınırlar, mesh yoğunluğu (dalga boyu başına çizgi), ayrık portlar, dirençler, aralığı verilmiş dalga kılavuzu portları, uzak alan ve H alanı monitörleri. Koordinatlar mm'ye çevrilir, portların mesh çizgilerine oturması için mesh çizgisi hassasiyeti olan 1e-6 mm'ye yuvarlanır. VBA kodunun kendisi (değişkenler, `If`, `For`) çalıştırılmaz.

Hiçbir şekil sessizce atlanmaz: içe aktarılamayan her nesne veya işlem raporda adıyla anılır (örneğin teğetli veya profilleri uyuşmayan bir `Loft`). İçe aktarılamayan bir loft profil levhalarını korur ve pencere geometrinin eksik olduğu uyarısını verir; simülasyondan önce bağlayıcı katıyı yeniden oluşturun.

Mesh yoğunluğu, `Mesh.LinesPerWavelength` komutundan ve açıkça `SetMeshType "Hex"` veya `"HexTLM"` olarak işaretlenmiş `MeshSettings` bloklarından okunur. Bu bloklarda `StepsPerWaveNear` dalga boyu başına hücreyi, `StepsPerWaveFar` ise yalnızca pozitif ve yakın yoğunluktan düşükse dalga boyu başına hava hücresini belirler. Dört yüzlü, yüzey, bilinmeyen ve belirtilmemiş mesh türleri FDTD yoğunluğunu belirlemez: dalga boyu başına adımları yok sayılır. Desteklenen bir yoğunluk yoksa Fairbeam, dalga boyu başına 20 hücrelik otomatik mesh varsayılanını kullanır. Desteklenen bir altı yüzlü mesh yoğunluğu, VBA makrosunda daha sonra desteklenmeyen bir blok görünse bile korunur. İçe aktarma raporu eşlemeyi veya yok sayılan yoğunluk ayarlarını açıklar; simülasyonu çalıştırmadan önce mesh'i ve tasarım denetimlerini gözden geçirin.

Fairbeam'in dışa aktardığı makro, `fairbeam-data:` ile başlayan yorumlarda tam openEMS port kutularını, sınır türlerini ve otomatik mesh ayarlarını taşır (diğer okuyucular yok sayar). Böylece tasarımı dışa aktarıp makroyu geri almak aynı modeli verir (`python/tests/test_cst_import.py`). Yalnızca yanlarındaki makro komutlarıyla uyuştuklarında kullanılırlar.

## PCB çizimini içe aktarma (DXF/Gerber)

`fairbeam import-pcb` ve **PCB çizimini içe aktar…** penceresi (aşağıda), baskı antenin 2B çizimini tasarıma dönüştürür (`python/fairbeam/pcb_import.py`). ASCII **DXF** (kapalı çoklu çizgiler, `CIRCLE`, `ARC`, `ELLIPSE`, uç uca birleşen çizgi/yay/açık çoklu çizgiler kapalı döngü yapılır), **Gerber RS-274X** (bölgeler, standart açıklık baskıları, yuvarlak/dikdörtgen açıklıklarla çizilmiş konturlar, yaylar) ve **Excellon** delik dosyaları okur (metalize delikler iki bakır düzlemi arasında metal pim olur). Ek Python paketi gerekmez.

```
fairbeam import-pcb patch.dxf --out my.design.json --layer-map TOP=top_copper,BOT=bottom_copper
fairbeam import-pcb board.gtl board.gbl board.gko board.drl --substrate RO4003C --thickness 0.813
```

- **Katmanlar.** Her bakır katmanı z düzleminde `polygon` levhalardan oluşan katı olur: üst bakır z = `h` (alttaş kalınlığı, parametre), alt bakır z = 0. Katmanlar addan (F.Cu, Top, GTL, Edge.Cuts, Profile ...) veya Gerber X2 dosya işlevinden tanınır. `--layer-map NAME=role`, `top_copper`, `bottom_copper`, `outline`, `ignore`, `top_clearance`, `bottom_clearance` rolleriyle değiştirir (solda katman adı, dosya adı veya desen). Tek tanınmayan kontur katmanlı dosya uyarıyla üst bakır kabul edilir.
- **Açıklıklar.** Bakır katman adını `_Antipad` (veya "clearance") ile izleyen katman, Fairbeam üretim çıktısındaki gibi (`B_Cu_Antipad`), o bakırın açıklığıdır: daire ve konturları delik olarak bakırdan çıkarılır. Böylece Fairbeam DXF/Gerber üretim dosyaları, toprakta sonda çevresindeki açıklık halkasıyla geri okunur.
- **Alttaş.** Kart dış çizgisi (Edge.Cuts / Profile) üzerinde kutu; yoksa bakır sınırlayıcı kutusu + `--margin` (2 mm). `--substrate` kütüphane adı (FR4, RO4003C ...) veya `--eps-r`, `--tan-d` ile özel ad alır. tan δ, tasarım frekansı `f0` değerinde uygulanır (`--f0`, varsayılan 2,45 GHz; bant 0,6–1,3 f0). Kart merkezi x = y = 0'a taşınır (`--origin keep` özgün koordinatları korur; rapor kaydırmayı verir).
- **Birimler.** DXF: `$INSUNITS` (yoksa mm varsayılır, eksik tüm dosyalar için tek uyarı; `--units mm|inch` zorlar). Gerber/Excellon kendi birimini taşır.
- **Eğriler.** Yay/daireler, hiçbir kiriş eğriden `--chord-tol` (0,02 mm) değerinden fazla uzak olmayacak şekilde bölütlenir.
- **Delikler.** CSXCAD çokgenlerinde delik yoktur; iç içe döngü (Gerber açıklık deliği, tek koyu bölge içindeki açık (LPC) daire baskısı/bölge, açıklık katmanı dairesi) bakır katısını **canlı Boolean çıkarma** yapar (konturlar eksi delikler; yukarıdaki Kesimler). Kayıtlı levhalar tam farktır; işlenen şekiller düzenlenebilir kalır. Delik içindeki ada ayrı katıdır (`top_copper_islands`).
- **Portlar.** Eklenmez; içe aktarıcı beslemeyi bilemez. Rapor "beslemeye bir port ekleyin" der.

Komutun yazdırdığı **içe aktarma raporu**, katman/rolleri, oluşturulanları ve içe aktarılmayan her öğeyi satırı/nedeniyle listeler: metin, tarama, spline, blok başvuruları, kapanmayan yollar, kendini kesen konturlar, Gerber açıklık makroları, tek koyu bölge içindeki daire baskısı/bölge dışındaki açık polariteli nesneler, adımlı tekrarlar, metalize olmayan delikler, frezelenmiş yarıklar.

### PCB çizimini içe aktar penceresi

**PCB çizimini içe aktar…** (Ana ekran, Giriş › Proje › PCB içe aktar, masaüstünde Dosya › PCB çizimini içe aktar…), aynı işi formla yapar. Dosyaları seçin veya pencereye bırakın (en fazla 12 dosya, her biri 8 MB, toplam 16 MB; sayfada okunup sunucuya gönderilir, tasarımı oluşturana kadar kaydedilmez).

- **Katmanlar.** Tablo her katmanı (DXF katmanı, Gerber/delik dosyası), içeriğini, **rol** menüsünü (üst/alt bakır, kart dış çizgisi, yok say, üst/alt bakır açıklığı; delik dosyasında delikler/yok say) ve seçimin nedenini gösterir: katman adı, Gerber işlevi, Excellon dosyası veya seçiminiz. Adı ipucu vermeyen katman "Belirsiz: kullanılmıyor" diye vurgulanır; rolünü seçin. Her değişiklik yeniden içe aktarır; rapor tabloyla daima eşleşir. Seçtiğiniz rolün yanındaki ok, içe aktarıcının seçimine döner. Eşleme, tüm DXF dosyalarında aynı katman adını kapsar; iki dosyada aynı adlı katman aynı rolü paylaşır.
- **Alttaş.** Kütüphane malzemesi (FR4, RO4003C ... veya Özel), kalınlık (mm), εr, tan δ, tasarım frekansı f0 (GHz). Malzeme seçimi εr/tan δ doldurur; gösterilen değerler tasarıma geçer. **Gelişmiş**: DXF birimleri, yay kiriş toleransı, dış çizgi yoksa pay, orijini ortalama veya koruma.
- **Rapor.** Önce içe aktarılmayanlar, sonra uyarı/notlar, ardından tasarım denetimleri (eksik port dışarıda bırakılır; pencere kendisi söyler). Özet, "her şey aktarıldı" yerine katman adlarından tahmin edilen rolleri listeler. Komut satırı bayrağı belirten notlar, pencerenin kendi kontrollerine göre yazılır (Gelişmiş › DXF dosyalarının birimi, Gelişmiş › Orijin, Katmanlar tablosu). Önerilen ad, dosyaların katman eki olmadan ortak gövdesidir (`export_patch-F_Cu.dxf`, `export_patch-B_Cu.dxf` için `export_patch`). Ad verin, **Oluştur ve aç** seçin.
- **Port.** İçe aktarıcı beslemeyi bilemez; yeni tasarımda port yoktur. Açıldıktan sonra "Beslemeye bir port ekleyin" ve Simülasyon › Portlar › Ayrık yoluna gidip beslemeye taşıyacağınız ayrık portu ekleyen düğme gösterilir.

Sunucu API'si `POST /api/import/pcb` (`{files: [{name, content_base64}], options: {layer_map, substrate, thickness, eps_r, tan_d, f0, units, chord_tol, margin, origin}}`; yanıt `{design, report, layers, checks}`). `pcb: {files, options}` ile `POST /api/designs` dosyayı oluşturur. Diğer dosyalar, hatalı sayılar veya fazla dosya 422 (boyut sınırının üstünde 413) döndürür.

## Senaryo denetimleri

Odaklı denetimler `npm run check:eta-presentation`, `npm run check:run-profiles` (saf mantık), ayrıca `npm run check:modal-focus`, `npm run check:run-profile-dialog` komutlarıdır (geçici Vite/çalıştırma sunucusu, Chrome ve openEMS içeren Python ortamı gerekir; çözücü çalıştırılmaz). İsteğe bağlı `scripts/check-home-accessibility.mjs`, çalışan Vite sunucusunda yakalanan API test verileri kullanır; ortam değişkenleri başlığındadır. Dar düzenler, üst menü, proje arama/sıralama/favoriler, hata durumları ve masaüstü panel tercihlerini geri yüklemeyi kapsar.

`npm run check:scenarios`, gerçek arayüzde headless Chrome ile gerçekçi ilk kullanım görevlerini İngilizce/Türkçe yürütür, kullanıcının takılacağı ilk noktada durur. `check:designer` denetiminden ağırdır (yaklaşık 3 dakika, tek kaba çözücü çalıştırması); onun parçası değildir.

- **S1**, yalnızca arayüzle boş tasarımdan yama kurar: FR4 kutu, toprak levhası, yama; sağ tık › Boolean › Çıkar ile yarık; Dönüştür penceresinin canlı önizlemesiyle aynalanmış katı; yüz ekstrüzyonu önizlemesi; ayrık port/bant; katı ve bileşende Renk…; Kaydet/yeniden yükleme, ardından **tek kaba çalıştırma** (aşağıda), S-parametreleri/Özet.
- **S2**, VBA makrosu (`examples/cst/patch-antenna.bas`) ve PCB çizimi (`python/tests/fixtures/pcb/*.gtl, *.gko`) içe aktarır; katıların/raporun göründüğünü denetler.
- **S3**, Tarama penceresi (varsayılan ±%10; gönderim yakalanır, asla gönderilmez), Optimize et (doğrulama mesajları) ve Simülasyon ayarlarını (Değişiklikleri at) açar.
- **S4**, dahil edilen iki örnek paketini tasarım çalıştırması olarak kopyalar (birinde sentetik alan haritası); Δ (A ile), Veriyi kopyala/CSV içeren Özet'i, çalıştırma Özellikler'ini, Faz/Canlandır içeren Alan haritası'nı ve yükleme hatasından sonra Yeniden dene'yi denetler.
- **S5**, Python panelini açar, betikte parametre değiştirip Uygula seçer (tek geri alma adımı); hata veren betik uygular (satır belirtilir, tasarım kalır); uygulanmamış değişikliklerle Düzenle'den çıkar (onay).
- **S6**, Ana ekran'dan Python modeli oluşturur, kaynağı Python panelinde olan bağlı Tasarım'ı açar; Ana ekran'a dönüp **Tasarım olarak aç** seçiminin kopya oluşturmadan aynı Tasarım'ı kullandığını doğrular.
- **S7**, yinelenen dönüşüm önizlemelerini, tek Uygula/geri al işlemini, bileşen genelinde dönüşümleri, katıların bileşen klasörleri arasında taşınmasını, bağımsız ızgara görünürlüğünü ve yerel çizim çerçevelerini denetler.

Her adım beklenen durumu doğrular ve sayfayı inceler: kapsayıcı dışına taşan öğe, araç ipucusuz kırpılmış metin, ham i18n anahtarı, pencere dışı iletişim kutusu, konsol hata/uyarısı (`[i18n]` eksik anahtar dahil) olmamalıdır. Başarısız adım `$TMPDIR/fairbeam-scenario-failures/` altına ekran görüntüsü kaydeder. İnceleme önce bilinen hatalı sayfada kendisini sınar.

Çalıştırıcı, geçici klasör üzerinden boş portlarda Vite ve çalıştırma sunucusu başlatır (`public/` kopyası; `projects/` aynı zamanda sunucunun `--projects` klasörüdür. Vite sonuçları public klasöründen sunar, sunucu `--projects` içine yazar; başka klasör yüklenmez, bkz. [RUN-SERVER.md](RUN-SERVER.md)). Sonunda ikisini de PID ile durdurur. Çözücü `/tmp/fairbeam-sim.lock` dizin kilidini alır (`mkdir` alır, `rmdir` bırakır), `nice -n 10` ile çalışır; kilit doluysa veya `--skip-run` varsa atlanır. Seçenekler: `S1 S3` (yalnızca bunlar), `--lang en|tr`, `--skip-run`. `FAIRBEAM_CHROME`, `FAIRBEAM_PYTHON` başka Chrome/Python gösterir. Tarayıcının yapamadığı denetimler [DESKTOP-CHECKLIST.md](DESKTOP-CHECKLIST.md) içindedir.

## Bilinen sınırlamalar

- **Horn verimliliği %100 üzerinde.** Piramidal horn (dalga kılavuzu portlu model), %100'ün biraz üstünde ışıma verimliliği bildirir; daha ince mesh'te fazlalık artar. Sebep araştırılmaktadır; %100 üstü sonuçlar kalite kontrol uyarısı taşır.
- **İmzasız Windows yükleyicisi.** macOS uygulaması imzalı ve Apple tarafından doğrulanmıştır, çift tıklamayla açılır. Windows yükleyicisinde kod imzası yoktur: SmartScreen ilk çalıştırmada uyarır (Daha fazla bilgi › Yine de çalıştır; [DESKTOP.md](DESKTOP.md)).

## Geri bildirim

Bildirimler ve fikirler, tarayıcıda açılan herkese açık [fairbeam-releases](https://github.com/ismailakdag/fairbeam-releases/issues) sorun izleyicisine gider:

- Ana ekranın alt bölümünde **Sorun bildir** (uygulama sürümü ve işletim sistemi doldurulmuş hata formu), **Özellik öner** vardır.
- Üst bölümdeki konuşma balonu (**Geri bildirim gönder**), iki formun listesini açar.

Uygulama kendiliğinden hiçbir şey göndermez, bağlantıya başka bilgi koymaz. Yardımcı olacaksa tasarım dosyasını/günlüğü ekleyin; önce özel bilgileri çıkarın. Masaüstünde uygulama penceresi web sayfası açmadığından sistem tarayıcısını yerel çalıştırma sunucusu açar.

### Dış çizgi köşelerini yuvarlatma ve pah kırma

Dikdörtgen levha/kutuya (veya seçili şekline) sağ tıklayıp **Dış çizgi köşelerini yuvarlat / pah kır…** seçin. Eksen ve yarıçap/geri çekme mesafesi seçin. Levhada eksen normal olmalıdır. Kutuda bu eksene paralel dört kenar işlenir; üst/alt çeperler keskin kalır. Boyut pozitif ve kısa kenarın yarısından küçük olmalıdır.

Bu geometrik işlemdir: pahlar sekiz noktalı çokgen, yuvarlatmalar çeyrek daire başına 16 kiriş olur. Levhalar yerel çokgene, kutular yerel çokgen uzatmasına dönüşür. Önizleme, mesh, Python ve geometri çıktıları aynı noktaları kullanır. Uygula, boyutları geçerli parametre değerleriyle kaydeder; katının malzemesini/dönüşümlerini korur, tek geri alma adımıdır. Kesimler ve canlı Boolean geçmişi önce somutlaştırılmalıdır. Keyfî 3B kenar radyüsleri, üst/alt çeper geçişleri ve serbest biçimli CAD yüzeyleri bu araçla desteklenmez.

**Bileşenler** üzerine sağ tıklayıp **Yeni bileşen** ile boş klasör oluşturun ve adlandırın. Klasörler boşken de kaydedilir. Katıları klasöre sürükleyin veya bağlam menüsünden **Bileşene taşı** kullanın. Klasör işlemleri düzeni etkiler; her katı kendi malzemesini ve sıralı dönüşümlerini korur. Dönüştür paneli, özgün şekille aynı düzlemde olsa bile gerçek yarı saydam sonuç yüzeylerini döndürme ekseni/merkezi veya ayna düzlemi referansıyla gösterir.

### RF kurulumunu açıkça belirleme

Portlar ve Toplu elemanlar **+** işlemleri oluşturma formu açar. İki ucu, akım/yayılma yönünü ve elektriksel ayarları girin; **Oluştur** tek geri alma adımı uygular. İptal tasarımı değiştirmez. Ayrık portlarda görünüm içinde küçük yön oku vardır. Mevcut port/elemanlar, seçilerek belirlenen uçlar dahil Özellikler'de düzenlenebilir.

Ayrık portun fiziksel openEMS kaynağı/sonlandırması pozitif gerçek direnç kullanır. İsteğe bağlı **Karmaşık güç dalgası referansı**, son işlem üst verisidir: Kurokawa katsayısı `(Zin - conj(Zref)) / (Zin + Zref)` olur; `Re Zref > 0` gerektirir. Empedans sonucu orta frekans örneğinde uyumu ve `1 - |Γ|²` değerini gösterir. Ham paketler, frekans ızgarasında ayrı karmaşık güç dalgası katsayıları tutar. Yerel S-parametreleri, Smith abağı, fiziksel kaynak ve çok portlu matrisler özgün gerçek referansını korur. Bu referans fiziksel yük eklemez. Pasif eşdeğer devre için R/L/C yükü kullanın; sabit sanal empedans geniş bantlı nedensel zaman alanı elemanı değildir.

Toplu elemanlar, eksik kolları boş bırakarak pozitif R (Ω), L (H), C (F) birleşimlerini ve **Seri** / **Paralel** topolojiyi destekler. Yerel RLC, CSXCAD/openEMS 0.37 veya yenisini gerektirir; eski ortamlar yaklaşım uygulamak yerine sınırlamayı bildirir. Kayıtlı `resistors` dizileri isteğe bağlı `L`, `C`, `topology` ile çalışmaya devam eder. Python dışa aktarımı ve geri okuma bunları korur. VBA makrosu her elemanı R/L/C değerleriyle `LumpedElement` olarak seri/paralel RLC biçiminde yazar (sıfır, bulunmayan bileşendir); makro içe aktarımı geri okur. [RF doğrulama kaydı](benchmarks/rf-rlc-workflows/README.md), yerel API desteğiyle devre yanıtı uyumunu ayırır: sınanan paralel devre %10 ölçütünü geçmiş, seri devre geçmemiştir. Seri sayısal doğruluk açık doğrulama konusudur.

Dalga kılavuzu kurulumu, openEMS'in sunduğu dikdörtgen TE modlarını açık açıklık boyutları, uyarım/prob uçları ve yayılma yönüyle destekler. Genel Bloch/Floquet portları, eğik periyodik uyarım ve yüksek kırınım mertebesi çıkarımı uygulanmamıştır. Normal gelişli PEC/PMC birim hücre düzeneği sınırlı simetri modelidir; genel Floquet desteği değildir.

Dielektrikler pozitif, izotropik, kayıpsız, frekanstan bağımsız bağıl manyetik geçirgenlik μr de sunar. Manyetik kayıp, anizotropik tensörler ve dispersif ferritler temsil edilmez.

Yerel API: [CSXCAD RLC özellikleri](https://docs.openems.de/en/latest/concepts/properties.html); referans düzeni: [scikit-rf güç dalgası tanımları](https://scikit-rf.readthedocs.io/en/latest/examples/networktheory/Working%20with%20Complex%20Characteristic%20Impedances.html).

### Geçerli görünümü dışa aktarma

Üst bölümdeki **Dışa aktar…** görünür çalışma alanını izler. Tasarım'ın 3B sekmesinde geometri biçimleri, kaydedilmemiş geçerli tasarım JSON'u ve Python sunar. Boş tasarımda geometri çıktısı yoktur. Sonuç sekmesinde CSV/Touchstone, araç çubuğunun geçerli sonucunu, S-parametresi seçimini ve karşılaştırmalarını kullanır. Şekil SVG/PNG, görünür büyüklük ve eğrilerle çizilmiş grafikleri yakalar. Çizim'de menü, çizimin SVG/PDF/PNG işlemlerini kullanır. Verisi olmayan biçim neden belirten araç ipucuyla devre dışıdır.

Kamera düğmesi ve Görünüm şeridi Ekran görüntüsü, görünür 3B görünümü, grafiği veya teknik çizimi yakalar. Ana ekran'da, boş geometride veya desteklenen şekli olmayan sonuç görünümünde devre dışıdır. Sonuç/çizim arkasında gizli 3B tuvali yakalamaz. İndirme istekleri, kayıt yolları, iptaller ve hatalar genel bildirimde de görünür.

### Render görünümü ve Render görüntüsü

3B görünümün **Render** düğmesi (kamera hazır görünümleri yanında, Görünüm şeridinin Render grubunda), tasarımı fiziksel tabanlı malzemeler, ana/dolgu/kenar ışıklı stüdyo ortamı, yumuşak zemin gölgesi ve portlarla gösterir. Bakır, altın, gümüş, kalay, nikel, alüminyum, pirinç, çelik kendi renk/pürüzlülükleriyle metaliktir; PEC veya bilinmeyen metal bakır olur. FR-4 yarı saydam sarı-yeşil laminat; Rogers, Taconic, PTFE krem; alümina beyaz; diğer dielektrikler nötr bejdir. Hava, vakum ve kesikler çizilmez. Katının kendi **Renk** seçimi varsayılanı geçersiz kılar, metalik görünümü korur. Malzeme tasarımcıda adından/kütüphane kaydından, sonuç/örnekte iletkenlik, dielektrik sabiti ve kaybından tanınır (paket adları taşımaz). Tablo `src/render/materials.ts` içindedir; Blender render aracının da kullandığı düz veridir.

Döndürme, kaydırma, yakınlaştırma ve kamera hazır görünümleri normal çalışır; düzenleme render'ı günceller; geri geçiş modelleme görünümünü tam geri getirir (seçim, saydam dielektrikler, kenarlar). Aynı düğme Sonuçlar/Örnekler 3B görünümünde de vardır. Hazır görünümler altındaki araç çubuğu portları (**Konnektör**: uygunsa SMA, değilse işaretçi; **İşaretçi**: küçük kırmızı boncuk/çubuk; **Gizli**), zemin gölgesini, PCB laminatlarında yeşil lehim maskesini ve koyu arka planı ayarlar.

Konnektör, karttan beslenen ayrık porta uyar: kart kenarında (yaklaşık 2 mm veya kartın %3'ü içinde), kenar tipi SMA o kenardan dışarı bakar, pimi hattın üzerindedir. Diğer durumda toprak düzleminin ötesinde boşluk varsa alttan montajlı SMA toprağın altında, pimi port boyunca yukarıdadır. Serbest havadaki dipol boşluğu, iki hat arasındaki port ve 6,35 mm altıgenden küçük toprak düzlemi işaretçi kullanır. Dalga kılavuzu portu ince flanş konturu, toplu eleman küçük SMD gövdesi gösterir.

**Render görüntüsü…** (Görünüm şeridi, render araç çubuğu, üst bölüm **Dışa aktar…**) ekran dışında görüntüler çizer, çalışma klasöründe `renders/<design-id>/` içine `<design>_<angle>_<timestamp>.png` olarak kaydeder (dolu adlara `-2`, `-3` eklenir; hiçbir render üzerine yazılmaz. Sunucu yoksa tarayıcı indirir). Açılar: İzometrik, Üst, Ön, Sağ, Arka, Sol, Alt ve geçerli görünüm; tek seferde istenen sayıda. Çözünürlük: 1920×1080, 3840×2160 veya özel (64–8192 px). Arka plan: saydam, stüdyo, koyu. Ayrıca portlar, lehim maskesi, zemin gölgesi, perspektif/ortografik ve kalite (Taslak: yok, Standart: 2×, Yüksek: 3× süper örnekleme; daima çoklu örnekleme ve GPU sınırları içinde). Görüntüler **Görüntüyü kopyala** ile küçük önizleme olarak görünür; **Klasörü aç**, sistem dosya yöneticisini açar. Render aracı ve kodu ilk kullanımda yüklenir.

### RF oluşturma ve Python klasör üst verisi

Portlar ve pasif R/L/C elemanları, tasarımı değiştirmeden önce oluşturma formu açar. Form uçları açık tutar, gerçek kaynak direncini karmaşık güç dalgası referansından ayırır; dalga kılavuzu kesim frekansını ve desteklenmeyen Floquet/Bloch iş akışlarını bildirir. Yerel seri RLC, oluşturma ve Özellikler'de sayısal doğrulama sınırlaması notuyla kullanılabilir (bkz. `docs/benchmarks/rf-rlc-workflows`).

Python dışa aktarımı, yalnızca isteğe bağlı `components` klasör yolları ve katı adı–bileşen eşlemeleri içeren `FAIRBEAM_ORGANIZATION` yazar. İçe aktarma/Uygula, geri okunan her grubun gerçek kaynak CSXCAD özelliğini kullanarak, yalnızca özellik adı benzersizse eşlemeleri geri yükler. Gruplara ayrılmış döndürülmüş kopyalar kaynak klasörlerini korur; gerçekten `[2]` ile biten ad kopya sayılmaz. Kaldırılan/yeniden adlandırılan katılar üst veriden yeniden oluşturulmaz. Sabiti içermeyen Python modülleri mevcut içe aktarma davranışını korur. Klasör listesi yolları, eğik çizgiyle ayrılmış boş olmayan adlar olmalıdır; eski katı yollarında boş bölüm uyarısı korunur.

RLC oluşturmanın isteğe bağlı hedef empedans yük yardımcısı, pozitif referans frekansında hedef `Z = R + jX` değerini fiziksel pasif paralel eşdeğere çevirir. `ω = 2πf` ile `Rp = (R² + X²)/R`; negatif reaktansta `C = -X/[ω(R² + X²)]`, pozitif reaktansta `L = (R² + X²)/(ωX)` doldurur. Sıfır reaktans yalnızca direnç verir. Hedef pozitif R gerektirir; bileşen değerleri SI Ω/H/F olarak kalır. Yalnızca seçilen frekansta eşleşir; sabit geniş bantlı sanal empedans oluşturmaz, portun güç dalgası referansını değiştirmez. Doldurma formda yereldir; Oluştur tek geri alınabilir düzenlemedir.

### Minimum pencere senaryo denetimi

`node scripts/check-scenarios.mjs S8 S9 S10 --compact --skip-run`, yerel masaüstü minimum boyutunda EN/TR Görünüm, görünür yüzey çıktıları ve RF formlarını çalıştırır. Rust pencere boyutlandırması 1024 × 700 mantıksal nokta kullanır; 728 noktalık çalışma alanında başlık çubuğu payıyla 1024 × 688'e iner. RF formları iki yükseklikte çalışır; İptal/Oluştur işlemleri iletişim kutusu içinde ve Tab ile ekranda erişilebilir kalmalıdır. Bu genişliklerde gezinti/özellikler panelleri üst katmandır; senaryolar gerektiğinde gerçek kenar şeritlerini açar. Varsayılan senaryo boyutları ve adım sayısı değişmez. Komut FDTD çözümü istemez.

`node scripts/check-scenarios.mjs S9 --compact --skip-run --ribbon-file-audit`, EN/TR dillerinde 1024, 1280, 1440 pikselde Görünüm/Simülasyon simge hizasını da denetler; Diğer menüsünün dosya seçicisinden gerçek sonuç paketi açar. Ek denetim isteğe bağlıdır.
