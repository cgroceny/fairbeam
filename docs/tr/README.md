# Örnek tasarımlar

Tasarımcı dosyaları (`<name>.design.json`; biçim için [docs/DESIGNER.md](../../docs/DESIGNER.md#files)).
`*_867` tasarımları, uygulamadaki 867 MHz örneklerinin kaynaklarıdır. Masaüstü uygulaması bunları
çalışma klasörünün modeller klasörüne salt okunur olarak kurar. Bu örneklerden birinde
**Yeni tasarım olarak aç…** seçildiğinde Ana ekran › Tasarımlarınız altında düzenlenebilir bir
kopya oluşturulur. Depodan çalışıyorsanız düzenlemek için dosyayı yeni bir adla `python/models/`
altına kopyalayın (`*_867` adları örneklere ayrılmıştır). Diğer modeller gibi komut satırından da çalıştırabilirsiniz:

```bash
fairbeam run examples/designs/blade_867.design.json --engine gpu --out /tmp/blade
```

`python/tests/test_example_designs.py`, buradaki her tasarımın oluşturulabildiğini ve tasarım
denetimlerinden geçtiğini doğrular.

## İHA bıçak anteni, 867 MHz (`blade_867.design.json`)

867 MHz bandının çevresini incelemek için 300 × 300 mm toprak düzlemi üzerinde eğimli bir PEC
bıçak kullanan eğitim örneği. Bu galeri örneğinin ölçülmüş anteni veya belirlenmiş konnektörü yoktur.
Adı, incelenmek istenen bandı belirtir; rezonans veya fiziksel empedans uyumu garantisi değildir.
**Durum: mesh duyarlı.** S11 yakınsama çalışması otomatik meshi doğrulamadı; galeri örneği,
doğrulanmış anten olarak değil, geometri ve sayısal inceleme amacıyla korunur.

**Besleme modeli.** z = 0 ile z = 2 mm arasındaki mevcut 50 Ω ideal çizgi varsayılan olarak korunur.
`feed_fraction`, isteğe bağlı düzlemsel kaynak genişliğinin mevcut 4 mm dilime oranını seçer:
1 tüm dilimi, 0.5 yarısını kapsar; 0 önceki ideal çizgiyi seçer. Bunlar farklı uyarım modelleridir.
Genişlik değişince S11 değişir; bu parametre ölçülmüş donanım için bir düzeltme katsayısı değildir.
Toprak ve bıçak dış hatları değişmedi. Koaksiyel pin, toprak açıklığı, konnektör dielektriği,
altlık veya radom modellenmez.

| Parametre | Varsayılan | Anlamı |
| --- | --- | --- |
| `f0` | 0,867 GHz | uzak alan ve yüzey akımı frekansı |
| `gnd` | 300 mm | kare toprak düzlemi |
| `h` | 80 mm | boşluğun üzerindeki yükseklik; uç z = 82 mm'de |
| `wb` / `wt` | 60 / 30 mm | alt / üst bıçak genişliği |
| `sweep` | 25 mm | üst kenar merkezinin arkaya kayması |
| `g` | 2 mm | kaynak boşluğu |
| `wf` | 4 mm | bıçağın besleme dilimi genişliği |
| `feed_fraction` | 0 | kaynak genişliğinin `wf` değerine oranı; 0 ideal çizgiyi korur |
| `ht` | 12 mm | dilimin üzerindeki genişleme yüksekliği |

**Sayısal ayarlar.** Korunan başlangıç modeli 0,7–1,05 GHz, altı sınırda MUR, −50 dB enerji
sönümü ve her pakette kaydedilen otomatik adım sınırını kullanır. Otomatik mesh, dalga boyu başına 20 hücre
ve ince özellik iyileştirmesi kullanır. Yenilenen paket 801 port örneği, y = 0 elektrik alan kesiti,
yüzey akımları ve 21 verimlilik örneği içerir. Enerji sönümü ile mesh yakınsaması ayrı kontrollerdir.

```bash
fairbeam run examples/designs/blade_867.design.json --engine cpu --threads 12 \
  --points 801 --field-plane E y 0 0.867 --out public/projects
```

**Kaynak duyarlılığı.** Sabit geometri, dış mesh ve kaynak genişliğiyle iki ardışık yerel
hücre yarılama, düzlemsel kaynağın S11 minimum derinliğini 0,179 ve 0,098 dB değiştirdi;
en büyük karmaşık farklar 0,00431 ve 0,00257 oldu. İki adım da önceden belirlenen sınırları geçti.
İdeal çizgi kontrolünde değişimler 0,787 ve 0,666 dB, karmaşık farklar 0,03006 ve 0,02888 oldu;
bu kontrol geçmedi. Yalnızca rezonans frekansının kararlı görünmesi bu duyarlılığı gizliyordu.
Bu bulgu, yerel ayrıklaştırma duyarlılığının azaldığını gösterir; fiziksel doğruluk kanıtı değildir.
Ayrı otomatik mesh testleri, girdi özetleri ve sınırlar için
[tekrarlanabilir kaynak ve mesh çalışmasına](../../docs/STUDIES.md#blade-declare-the-source-before-judging-the-mesh) bakın.
Bu kontroller PML_8 ve −60 dB kullanır; korunan galeri başlangıç modelinden ayrıdır. Sonlu kaynak
seçeneği, varsayılanın sayısal olarak doğrulanmış alternatifi değildir. Kaynağın tüm genişliğini
denetleyen yeni kontrol, tek enine hücrenin yeterli sayılmasını önler; fakat bu asgari hücre
kontrolü S11 yakınsamasını garanti etmez.

**Yorumlama.** Empedans uyumu, ışıma ve verimlilik; kaynak varsayımına, sonlu toprak düzlemine
ve ayrıklaştırmaya bağlıdır. S11 yakınsaması, uzak alan veya verimlilik yakınsamasını kanıtlamaz.
PEC modelinde iletken veya dielektrik kayıp yoktur; ışıma verimliliğinin birden sapması sayısaldır,
ölçülmüş malzeme kaybı değildir. %100'ün üzerindeki görünür verimliliği kırpmayın veya fiziksel
sonuç saymayın. Örneği donanım tasarımında kullanmadan önce gerçek beslemeyi, malzemeyi ve
muhafazayı ekleyin; optimizasyondan önce yakınsama kontrollerini tekrarlayın.

Başka bir bant için uzunlukları `0.867 / f_new` ile ölçeklemek yalnızca başlangıç geometrisi verir.
Kaynak boşluğu, toprak düzlemi, frekans bandı ve monitörleri tutarlı biçimde güncelleyip meshi yeniden
kontrol edin. Önceki örneğin ayar taraması ve çizgi kaynaklı ışıma değerleri isteğe bağlı sonlu kaynağı
tanımlamaz. Belgenin sonraki karşılaştırma tabloları tarihsel çizgi kaynak sonuçları olarak
korunmuş ve bu şekilde etiketlenmiştir.

## Yarık yüklü geniş bant düzlemsel dipol, 867 MHz (`wideband_dipole_867.design.json`)

**Kompozit (metal olmayan) gövdeli** bir İHA için telemetri anteni; böyle bir gövdede
`blade_867` gibi bir monopole toprak düzlemi sağlayacak metal kaplama yoktur. 863–870 MHz
SRD / LoRa bandında, bıçak radoma sığan dengeli baskı dipoldür. Düşey kutupludur ve azimutta
her yöne ışıma yapar. Bant genişliği için kollar geniş, yüksekliği azaltmak için yarıklıdır.

**Model.** Düşey FR-4 şerit (`f0` frekansında εr 4,3, tan δ 0,02; 1,6 mm; xz düzleminde,
x uçuş ekseni, z yukarı), y = 0 yüzeyinde merkezdeki `g` besleme aralığının üstünde ve altında
iki bakır kol (PEC levha) taşır. 50 Ω ayrık port aralığı köprüler. Her kol, aralıktaki `wf`
genişliğindeki besleme dilinden `ht` geçiş yüksekliği boyunca tam `w_arm` genişliğine açılır;
aralığın kenarından `h_arm` uzaklıktaki uca kadar uzanır. Her kolun iki dış kenarından içeri,
`l_s` uzunluğunda ve `w_s` genişliğinde dört çift enine yarık açılır. Bunlar tasarımcının Katı
kesimleridir ve parametreleri izler. İlk çift aralık kenarından `z_s` uzaklıktadır; sonrakiler
`p_s` aralıklarla gelir. Üst kol bir kez çizilip kesilir, ardından alt kolu oluşturmak için
z = 0'a göre aynalanır. Toprak düzlemi yoktur. Açık sınırlar PML'dir (8 hücre); her yönde
0,7 GHz'de çeyrek dalga boyu (107 mm) hava vardır. Otomatik mesh, 1,05 GHz'de dalga boyu başına
30 hücre kullanır (yaklaşık 270 000 hücre); her 2 mm yarık boyunca 2, kart kalınlığında 4 hücre vardır.

Karşılıklı yarıklar, her kolun ortasında `w_arm − 2 l_s` = 6 mm genişliğinde kesintisiz bir
omurga bırakır. Geniş kol, akımın çoğunu dış kenarlarında taşır. Yarıklar bu yolu keser;
akım her yarığın çevresinden dolanarak omurgada ve yarık uçlarında yoğunlaşır. `f0` yüzey akımı
haritası bunu gösterir. Elektriksel uzunluk artar; aynı yükseklikte rezonans aşağı kayar.
Yarıklar karşılıklı çiftler halinde olduğundan yatay akımları birbirini götürür ve örüntü düşey
kutuplu kalır.

| Parametre | Değer | Anlamı |
| --- | --- | --- |
| `f0` | 0,867 GHz | tasarım frekansı (uzak alan ve yüzey akımı) |
| `h_arm` | 54 mm | besleme aralığı kenarından uca kol yüksekliği (ayarlanmış). Uçtan uca `H_tot` = 110 mm (0,32 λ) |
| `w_arm` | 40 mm | kol genişliği (x), 0,12 λ |
| `ht` | 8 mm | besleme dilinden tam genişliğe geçiş yüksekliği |
| `wf` | 18 mm | aralıktaki besleme dili genişliği (ayarlanmış: geniş dil besleme endüktansını düşürür) |
| `g` | 2 mm | besleme aralığı (port uzunluğu) |
| `l_s` | 17 mm | her dış kenardan içeri yarık uzunluğu. Karşılıklı yarıklar arasındaki omurga (`spine`) 6 mm'dir |
| `w_s` | 2 mm | yarık genişliği |
| `p_s` | 10 mm | yarık adımı |
| `z_s` | 16 mm | besleme aralığı kenarının üzerindeki ilk yarık çifti. Son yarık kenarın 48 mm üzerinde biter (`slot_top`) |
| `t_sub` | 1,6 mm | FR-4 kalınlığı |
| `m` | 3 mm | bakır çevresindeki FR-4 payı. Kart 46 × 116 mm'dir (`W_b` × `L_b`) |

Bant 0,7–1,05 GHz, durdurma ölçütü −60 dB; uzak alan ve yüzey akımı `f0` frekansında, ışıma verimliliği
bant boyunca 21 frekansta hesaplanır. Yarık sayısı kol başına dört çifttir; dosyada her yarık için
bir kesim vardır. `h_arm`, `slot_top` değerinden büyük kalmalıdır; aksi halde son kesimler hiçbir
şey kaldırmaz ve denetimler bunu bildirir.

**Ayarlama** (GPU motoru, çalıştırma başına yaklaşık 7 s). İlk tahmin (`h_arm` 60, `wf` 3,
`l_s` 14) 0,758–0,897 GHz'de uyum verdi; bu bant fazla düşüktü ve en iyi uyum yalnızca −16,5 dB'ydi.
Kolu kısaltmak bandı, `h_arm` başına mm'de yaklaşık %1,3 yukarı taşıdı. Daha geniş besleme dili,
besleme endüktansını düşürür. `h_arm` = 56 için `wf` değerini 3'ten 10 mm'ye çıkarmak en iyi
|S11|'i −16,8'den −19,3 dB'ye, bant genişliğini %18,2'den %19,9'a iyileştirdi. 58 mm'de
10'dan 18 mm'ye geçiş bunları −19,1'den −22,3 dB'ye ve %19,2'den %20,6'ya taşıdı
(`l_s` = 14 için bant 0,797–0,976 GHz). Daha uzun yarıklar (`l_s` 17) rezonansı %5 düşürdü;
her kolu 4 mm kısaltmak rezonansı geri getirdi ve bant genişliği %17,8 oldu.

**Sonuçlar** (varsayılanlar: PML 8, dalga boyu başına 30 hücre; GPU motoru, 6,6 s çözücü süresi):

| Büyüklük | Değer |
| --- | --- |
| 863 / 867 / 870 MHz'de \|S11\| | −17,7 / −18,7 / −19,4 dB (en iyi: 0,889 GHz'de −22,3 dB) |
| 867 MHz'de giriş empedansı | 39,6 + j0,4 Ω (seri rezonans, X = 0, 867 MHz'dedir) |
| −10 dB bandı | 0,816–0,987 GHz (171 MHz, %19). 863 MHz'in altında 47 MHz (%5,4), 870 MHz'in üstünde 117 MHz (%13) pay |
| Dmax / kazanç / gerçekleşen kazanç | 2,02 / 1,97 / 1,91 dBi (yalnızca örüntüden Dmax: 2,01 dBi) |
| Işıma / toplam verimlilik | 867 MHz'de %98,9 / %97,6. Toplam verimlilik 0,84–0,95 GHz arasında %95'in üzerindedir |
| Ana lob | ufukta (θ = 90°), yükseliş düzlemi demet genişliği yaklaşık 85° |
| Azimut, ufuk (θ = 90°) | ortalama kazanç 1,90 dBi, dalgalanma 0,13 dB |
| Kutuplanma | düşey (E_θ). Çapraz kutuplanma (E_φ) her yerde tepeden en az 40 dB aşağıdadır; simetri nedeniyle ufukta sıfırlanır |
| Zenit (θ = 0°) | −38 dBi, dipolün sıfır noktası |

Tasarım başlangıçta MUR sınırları ve dalga boyu başına 20 hücreyle ayarlandı. Bu durumda Dmax
2,21 dBi, yalnızca örüntüden 2,01 dBi ve empedans 41,8 + j6,4 Ω çıktı. Yalnızca çeyrek dalga
boyu hava olduğunda MUR, güç dengesini saptıracak kadar yansıtır (aşağıdaki kılıflı dipolünde de
aynısı ölçüldü). Dalga boyu başına 30 hücreli PML, iki Dmax tahminini 0,02 dB içine getirir ve
artık varsayılandır; uyum neredeyse değişmedi.

**Yarıklı ve yarıksız kollar.** Yarıklar kaldırılıp `wf`, `ht` ve `w_arm` aynı tutulduğunda,
kollar `h_arm` = 67 mm'de aynı rezonansa ulaşır: 0,847 GHz'de X = 0, bant 0,769–1,000 GHz'dir.
Yarıklar uçtan uca yüksekliği, aynı 40 mm genişlikte 136'dan 110 mm'ye indirir (%19 kısalma).
Bunun karşılığında bant daralır: yarıksız dipol %27 bantta uyum sağlar, 867 MHz'de −27 dB verir.
Ayrıca yönlülüğü 0,2 dB daha yüksek (2,43 / örüntüden 2,19 dBi), azimut dalgalanması iki katıdır (0,27 dB).

**Kuram ve `blade_867` ile karşılaştırma.**

**Tarihsel Blade sütunu:** Aşağıdaki Blade değerleri ve ilgili karşılaştırmalar güncel galeri paketini değil, önceki ideal çizgi/MUR kaynağını kullanır.

| | İdeal λ/2 dipol (ince tel) | Bu dipol | `blade_867` |
| --- | --- | --- | --- |
| Toprak düzlemi gerekli mi? | hayır | hayır | evet (metal kaplama) |
| Yükseklik × genişlik | yaklaşık 166 mm (0,48 λ) × tel | 110 × 40 mm (kart 116 × 46 mm) | 300 mm kaplama üzerinde, kaplamanın üstünde 82 mm × 60 mm |
| Zin | 0,5 λ'da 73 + j42 Ω, rezonansta (0,48 λ) yaklaşık 70 Ω | 867 MHz'de 39,6 + j0,4 Ω | 49,5 + j19,3 Ω |
| −10 dB bandı (50 Ω) | tel kalınlığına bağlı olarak yaklaşık %5–10 | %19 | en az %32,2 |
| Dmax | 2,15 dBi | 2,02 dBi | 4,10 dBi, kaplamanın 45° üzerinde |
| Ufuk kazancı, dalgalanma | 2,15 dBi, 0 dB | 1,90 dBi, 0,13 dB | −1,4 dBi, 1,5 dB |

Uçtan uca 0,32 λ olan dipol, rezonanslı λ/2 dipolden kısadır. Yönlülüğü kısa dipolünki
(1,76 dBi) ile λ/2 dipolünki arasındadır. Bu kadar kısa ince dipolde direnç yaklaşık 25 Ω
olacakken, geniş kollar direnci 40 Ω civarında tutar ve ince dipolün iki–üç katı bant genişliği
sağlar. Ufukta, küçük toprak düzlemindeki bıçaktan yaklaşık 3,5 dB daha fazla kazanç verir.
Bıçağın lobu toprak düzlemi kenarları nedeniyle yukarı eğilir.

**Sınırlamalar.**

- **Balun.** Port dengelidir. Aralığa doğrudan bağlanan koaksiyel kablonun dış iletkeninde akım
  oluşur; bu akım ışıma yapar, örüntüyü eğer ve uyumu kaydırır. Uygulamada koaksiyeli alt kolun
  ortasından aralığa götürün; koldan ayrıldığı yere kovan tipi şok (867 MHz'de havada yaklaşık
  86 mm λ/4 kovan veya ferrit boncuklar) ekleyin ya da kartın arkasına balun (daralan mikroşerit
  veya Marchand balun) basın. Bunların hiçbiri modelde yoktur.
- **Radom ve FR-4 toleransı.** Radom, boya ve bağlantı ayağı modellenmemiştir. İnce cam elyafı
  kabuk frekansı birkaç yüzde düşürür; FR-4'ün εr değeri tedarikçiye ve frekansa göre yaklaşık
  4,2–4,7 arasında değişir. İkisi de çoğunlukla bandı aşağı taşır. Bant 870 MHz'in %11 üstüne,
  863 MHz'in %6 altına uzanır; yaklaşık %10'a kadar aşağı kayma, 863–870 MHz'i bandın içinde
  tutar. Takılan radom daha fazla kaydırırsa `h_arm` değerini kısaltın: 1 mm yaklaşık %1,3 kaydırır.
- **Montaj.** Dipolün çevresi kompozit olmalıdır. Yaklaşık λ/4 (86 mm) içindeki karbon elyafı
  parçalar, kablolar, batarya ve metal donanım uyumu ve örüntüyü değiştirir. Besleme koaksiyelini
  kollardan uzaklaştırın; mümkünse kollara dik yönlendirin.
- **Kayıplar.** Bakır kayıpsızdır (PEC). Gerçek bakır verimde yüzde birkaç ondalık puan kaybettirir.
  FR-4 kaybı modellenmiştir. Alanın çoğu havada olduğundan yaklaşık %1 kayba yol açar.

## Metal olmayan hava araçları için baskı meander dipol, 867 MHz (`meander_dipole_867.design.json`)

Yukarıdaki bıçak bir monopoldür; toprak düzlemi gövdenin metal kaplamasıdır. Kompozit veya köpük
gövdede (cam elyafı, köpük, 3B baskı plastik) böyle bir kaplama yoktur. Bu gövdedeki monopolün
karşı elemanı koaksiyel kablonun ekranı olur; uyum ve örüntü kablonun güzergâhına bağlı hale gelir.
Dipol iki yarısını da kendisi taşır. Bu tasarım, yaklaşık 110 × 35 mm bıçak radoma sığan,
863–870 MHz için düşey bir baskı dipoldür.

**Model.** 1,6 mm FR-4 kart (εr 4,3, tan δ 0,02) xz düzlemindedir: x uçuş ekseni (+x arkaya),
z yukarıdır. Bıçak biçimindeki dış hattı kökte 34 mm, uçta 22 mm genişliğindedir; ön kenar
`sweep` kadar geriye eğilir. Bakır tek yüzdedir (y = 0); 35 µm kalınlıkla çizilir, levha olarak
oluşturulur (tasarımcının ince metal varsayılanı). Her kol merkez aralığında `l_feed` uzunluğunda
düz şeritle başlar, `n` dönüşlü meander ile devam eder (dönüş genişliği `a`, adım `p`; dönüş başına
iki yatay basamak) ve kısa düz `l_end` bölümüyle biter. Alt kol üst kolun aynasıdır (her kol
Katısında `mirror` dönüşümü). Böylece iki kolun basamaklarındaki yatay akımlar ters yönlerde
akar ve uzak alanda birbirini götürür. `w` genişliğindeki dengeli 50 Ω ayrık port, merkezdeki `g`
aralığını köprüler. Toprak düzlemi yoktur. Açık sınırlar PML'dir (8 hücre); kart ile PML arasında
her yönde 0,75 GHz'de çeyrek dalga boyu (100 mm) hava bulunur.

Kollar her kesim için kutulardan oluşur (basamaklar, aralarındaki bağlantılar, besleme şeridi ve
uç); `n` değerini izleyen `translate` kopyaları sayesinde tüm değerler düzenlenebilir ve optimizasyon aracı
bunları değiştirebilir. Kart, z = 0'da birleşen iki çokgendir. Birleşim besleme aralığının ortasına
mesh çizgisi yerleştirir; böylece port bir yerine iki hücre alır.

**Neden düz kollar ve meander uçlar?** Kısa dipolde akım beslemede en büyüktür, uçlarda sıfıra
iner. Beslemeye yakın bölüm ışımanın çoğunu yapar ve ışıma direncini belirler. Buradaki bir
meanderin basamakları, neredeyse hiç ışıma yapmayan karşıt akımlar taşırdı. Bu nedenle akımın
yüksek olduğu yerde kollar düzdür; meander uçlarda bulunur. Burada kolu bobin gibi yükleyerek
elektriksel uzunluğu artırır ve direnci az azaltır. İlk denemede 3 dönüş ve 25 mm düz bölüm
kullanıldı (112 mm yükseklik); 767 MHz'de yalnızca 29 Ω ile rezonans verdi. İki dönüş ve 30 mm
düz bölüm, 101 mm yükseklikte 40 Ω sağlar.

| Parametre | Değer | Anlamı |
| --- | --- | --- |
| `f0` | 0,867 GHz | tasarım frekansı (uzak alan ve yüzey akımı) |
| `w` | 2 mm | iz genişliği (ve port genişliği) |
| `g` | 2 mm | besleme aralığı (port uzunluğu) |
| `l_feed` | 30 mm | aralıktan ilk basamağa kadar düz bölüm |
| `n` | 2 | kol başına meander dönüşü (tarama veya optimizasyon aracının değiştirebilmesi için `nt` tam sayısına yuvarlanır) |
| `a` | 16 mm | meander dönüş genişliği (x), aynı zamanda bakır genişliği |
| `p` | 8 mm | dönüş adımı (z); basamak aralığı `p/2 − w` = 2 mm |
| `l_end` | 1,5 mm | her uçtaki düz son bölüm (ayarlanmış) |
| `t` | 1,6 mm | FR-4 kalınlığı |
| `t_cu` | 35 µm | bakır kalınlığı (levha olarak modellenir) |
| `m` | 3 mm | bakır çevresindeki kart payı |
| `sweep` | 12 mm | kökte öne doğru ek kart kordu |

Türetilen değerler: uçtan uca bakır yüksekliği `H` = 101 mm (867 MHz'de 0,29 λ), kart
107 × 34 mm (`H_board`, `W_board`), tek kol iz uzunluğu `L_arm` ≈ 114 mm. Düz baskı λ/2 dipol
yaklaşık 140–150 mm yüksekliğinde olurdu.

Bant 0,75–1,0 GHz, durdurma ölçütü −50 dB; uzak alan ve yüzey akımı `f0` frekansında, ışıma verimliliği
bant boyunca 21 frekansta hesaplanır. Otomatik mesh (1 GHz'de dalga boyu başına 20 hücre)
966 000 hücre içerir. En küçük hücre 0,26 mm'dir: 2 mm iz boyunca 6, basamaklar arasındaki 2 mm
aralık boyunca 6 ve besleme aralığında 2 hücre vardır. Bir çalıştırma 18 500 zaman adımı,
GPU motorunda 10 s çözücü süresi gerektirir.

**Sınırlar.** MUR ile alanlar çok yavaş sönümlendi (60 000 zaman adımından sonra −37 dB) ve uzak
alan, bu kadar kısa dipolün verebileceğinden fazla olan 2,5 dBi çıktı. Birinci dereceden MUR sınırı,
küçük ve düşük kazançlı antenin yüzeye yakın geliş açılarıyla gönderdiği dalganın bir kısmını
yansıtır. PML bunu soğurur: çalıştırma 18 500 adımda −50 dB'ye ulaşır; 1,97 dBi, kısa dipol
(1,76 dBi) ile λ/2 dipol (2,15 dBi) arasındadır.

**Ayarlama.** Ayarlama sırasında GPU motoru, dalga boyu başına 14 hücre ve −40 dB; son
çalıştırmada tasarımın 20 hücre/dalga boyu ve −50 dB değerleri kullanıldı:

| Çalıştırma | Değişiklik | Sınırlar | Rezonans (Im Z = 0) | Buradaki R | Çözücü süresi |
| --- | --- | --- | --- | --- | --- |
| 1 | n = 3, l_feed = 25, l_end = 4 (H = 112 mm) | MUR | 767 MHz | 29 Ω | 12 s |
| 2 | n = 2, l_feed = 30, l_end = 4 (H = 106 mm) | MUR | 848 MHz (yakınsamadı) | 34 Ω | 11 s |
| 3 | l_end = 1,5 (H = 101 mm) | PML 8 | 875,6 MHz | 40 Ω | 9 s |
| 4 | son, 20 hücre/λ, −50 dB | PML 8 | 875,3 MHz | 40 Ω | 10 s |
| 5 | FR-4 εr: 4,3 yerine 4,5 | PML 8 | 872,2 MHz | 40 Ω | 9 s |
| 6 | l_end = 4 (H = 106 mm) | PML 8 | 856,9 MHz | 41 Ω | 9 s |

3. ve 4. çalıştırma arasındaki mesh değişikliği rezonansı 0,3 MHz kaydırdı. 6. çalıştırma ayarlama
eğimini verir: her uçtaki `l_end` için mm başına −7,5 MHz, yani yaklaşık −%0,9/mm.
5. çalıştırma, alanın çoğu havada olduğundan FR-4'ün burada az etkili olduğunu gösterir:
εr'deki +0,2 değişim bandı −%0,4 kaydırır.

**Sonuçlar** (son çalıştırma, varsayılanlar):

| Büyüklük | Değer |
| --- | --- |
| 863 / 867 / 870 MHz'de \|S11\| | −15,4 / −16,8 / −17,8 dB (VSWR 1,41 / 1,34 / 1,29) |
| En iyi uyum | 878 MHz'de −19,4 dB |
| −10 dB bandı | 843,8–915,6 MHz (72 MHz, %8,2), merkez 879,7 MHz: 867 MHz'in %1,5 üzerinde |
| 867 MHz'de giriş empedansı | 38,8 − j6,4 Ω |
| 867 MHz'de Dmax / kazanç / gerçekleşen kazanç | 1,97 / 1,77 / 1,68 dBi |
| 867 MHz'de ışıma / toplam verimlilik | %95,5 / %93,5 (FR-4 kaybı; bakır kayıpsız) |
| Bant boyunca ışıma verimliliği | 862,5 MHz'de %95,2; 875 MHz'de %96,0; 0,75–1,0 GHz boyunca %93–99,6 (21 nokta) |
| Azimut, ufuk (θ = 90°) | 1,93–1,97 dBi: dalgalanma 0,04 dB |
| Yükseliş | ana lob ufukta; yarı güç demet genişliği 85° (θ = 48°–132°); yukarı ve aşağıda sıfırlar |
| Kutuplanma | düşey (E_θ). Çapraz kutuplanma (E_φ) ufukta −44 dB'nin, her yerde −33 dB'nin altında |

−10 dB bandındaki paylar: 863–870 MHz bant dışına çıkmadan önce bant %5,0 aşağı (üst kenar
870 MHz'e ulaşır) veya %2,2 yukarı (alt kenar 863 MHz'e ulaşır) kayabilir. Frekansı düşüren radom
bu nedenle daha geniş paya sahiptir.

**Diğer tasarımlarla karşılaştırma.**

**Tarihsel Blade sütunu:** Aşağıdaki Blade değerleri ve ilgili karşılaştırmalar güncel galeri paketini değil, önceki ideal çizgi/MUR kaynağını kullanır.

| | İdeal λ/2 dipol | Bu meander dipol | Bıçak monopol (`blade_867`) |
| --- | --- | --- | --- |
| Yükseklik | 0,48 λ (ince telde yaklaşık 165 mm, FR-4 baskıda 140–150 mm) | 101 mm (0,29 λ) | kaplamanın 82 mm üzerinde |
| Gereksinim | balun | balun | metal kaplama (toprak düzlemi) |
| Rezonansta direnç | 73 Ω | 40 Ω | 50 Ω |
| −10 dB bant genişliği (50 Ω) | iletken kalınlığına bağlı yaklaşık %5–10 | %8,2 | en az %32,2 |
| Dmax | 2,15 dBi | 1,97 dBi | 4,10 dBi (kaplamanın 45° üzerinde) |
| Işıma verimliliği | %100 | %95,5 (FR-4) | %99,7 (PEC) |
| Ufuk | 2,15 dBi, her yöne | 1,95 dBi, 0,04 dB dalgalanma | −1,4 dBi, 1,5 dB dalgalanma |

Meander dipol, tam λ/2 dipole göre üçte bir daha kısa olmak için 0,2 dB yönlülükten vazgeçer.
Toprak düzlemi gerektirmez; örüntüsü, uçuşun büyük bölümünde yer istasyonunun bulunduğu ufukta
tepe yapar. Bıçak daha yüksek tepe kazancı ve çok daha geniş bant sunar; ancak yaklaşık λ veya
daha büyük metal kaplama ister ve sonlu kaplama tepeyi 45° yukarı eğer.

**Üretim notları ve sınırlamalar.**

- **Balun.** Port dengelidir; koaksiyel modellenmemiştir. Kollara doğrudan lehimlenen koaksiyelin
  ekranında akım akar; bu akım ışıma yapar, örüntüyü eğer ve kablo güzergâhına göre uyumu kaydırır.
  Beslemede balun veya ortak mod şoku kullanın: kablonun beslemeden ayrıldığı yerde λ/4 kovan
  (bazuka) balun (yaklaşık 80 mm), beslemenin 2–3 cm yakınında kabloya takılan UHF ferrit boncuklar
  veya kart üzerinde baskı balun. S11'i şok takılıyken ölçün. Kabloyu yön değiştirmeden önce
  en az λ/4 (86 mm) boyunca dipole dik olarak (x ekseninde) beslemeden uzaklaştırın.
- **Uyum.** Uyumlama devresi olmadan 40 Ω, en iyi −19 dB |S11| verir. 50 Ω uyum için daha yüksek
  direnç gerekir; bunu daha uzun `l_feed` düz bölümü ve daha az veya daha dar dönüşler (daha küçük
  `a`) sağlar, ancak yüksekliği artırır. Daha geniş `w` izi bandı biraz genişletir.
- **Radom ve FR-4.** Radom modellenmemiştir; birkaç milimetrelik cam elyafı kabuk frekansı
  birkaç yüzde düşürür ve %5 payın içinde kalır. FR-4 değişkendir (partiye ve frekansa göre
  εr 4,2–4,7, tan δ 0,015–0,025); bu, bandı %1'den az kaydırır. Gerçek bakır (modeldeki levhalar
  kayıpsızdır), 2 mm izde yaklaşık %1 ek kayıp getirir. Üretimden sonra S11'i radom içinde ölçün
  ve `l_end` değerini düzeltin (mm başına −7,5 MHz; iki uçta da aynı).
- **Hava aracı.** Metal olmayan gövde varsayılmıştır. Karbon elyafı iletkendir: anteni karbon
  boru ve kaplamalardan, bataryalardan, servo ve güç kablolarından uzak tutun (tercihen λ/4,
  86 mm) veya bunları modelleyin.
- **Besleme.** Besleme konnektör değil, 2 mm ayrık porttur.

**Diğer bantlar.** Her uzunluğu `k = 0.867 / f_new` ile ölçekleyin (FR-4 kalınlığı hariç);
`f0` ve simülasyon bandını ayarlayın (yaklaşık 0,85 × ve 1,15 × f0). `l_end` değerini, daha büyük
adımlar için `l_feed` değerini yeniden ayarlayın. Yalnızca 867 MHz'in simülasyonu yapılmıştır.
867 MHz dipolün −10 dB bandı 916 MHz'de biter; 902–928 MHz ISM bandını kapsamaz ve bu bant için
ayrı ayar gerekir.

## Baskı kılıflı dipol, 867 MHz (`sleeve_dipole_867.design.json`)

**Kompozit (metal olmayan) gövdeli**, dolayısıyla monopole toprak düzlemi sağlayacak metal
kaplaması bulunmayan İHA için koaksiyel beslemeli telemetri dipolü. 863–870 MHz SRD / LoRa
bandına yönelik bu yarım dalga dipol, bıçak radoma sığan ince FR-4 şeride basılır. Düşey kutupludur
ve azimutta her yöne ışıma yapar. Alt kol besleme koaksiyelinin çevresinde kovan oluşturur;
böylece koaksiyel, anten boyunca merkez beslemeye ulaşır ve ayrı balun gerektirmeden alttan çıkar.

**Model.** Düşey FR-4 şerit (`f0` frekansında εr 4,3, tan δ 0,02; `t` = 1,6 mm; xz düzleminde,
x uçuş ekseni, z yukarı) tüm bakırı (PEC levhalar) y = 0 yüzeyinde taşır:

- `g` besleme aralığının üzerinde, `w_up` genişliğinde ve `l_up` uzunluğunda **üst kol**;
- aralığın altında, `w_sl` genişliğinde ve `l_sl` uzunluğunda **kovan** (alt kol). Koaksiyelin iki
  yanındaki, her biri `ws` genişliğinde iki şeritten oluşur; her şeritle koaksiyel arasında `s`
  yarığı vardır. Üstte tüm kovan genişliğini kaplayan `hb` yüksekliğindeki köprü, şeritleri ve
  koaksiyelin örgüsünü birleştirir;
- dış iletkeniyle modellenen **koaksiyel**: merkez çizgisinde `w_f` genişliğinde şerit,
  köprüden kablonun çıktığı kart alt kenarına kadar uzanır.

`w_f` genişliğindeki 50 Ω ayrık port köprü ile üst kol arasındaki aralığı köprüler. Bu, kablo
ucundan üst kolun tabanına aralığı geçen koaksiyel iç iletkeni temsil eder. Örgü kovana yalnızca
köprüde değdiğinden, koaksiyel ile kovan şeritleri kısa devreli eş düzlemli saplama oluşturur
(yaklaşık 66 mm; 867 MHz'de kartın etkin ortamında yaklaşık 0,3 λ). Bu, kılıflı dipolün şokudur:
açık alt uçta örgü ile kovan arasında yüksek empedans sunar ve anten akımının kablonun dışına
akmasını engeller. Kart iki uçta da bakırdan `m` kadar taşar. Toprak düzlemi yoktur. Açık sınırlar
PML'dir (8 hücre); her yönde 0,75 GHz'de çeyrek dalga boyu (100 mm) havanın ardındadır.
Otomatik mesh, 1,0 GHz'de dalga boyu başına 30 hücre kullanır (yaklaşık 443 000 hücre);
her 1 mm yarıkta 3, 2 mm besleme aralığında 3 ve kart kalınlığında 4 hücre vardır.

**Koaksiyelin yerleşimi.** Merkez şeride yerleştirilen ince koaksiyel kullanın (RG-178, RG-316
veya rijit yapı için 2,2 mm yarı rijit kablo). Örgüyü köprü pedine ve isterseniz şerit boyunca
lehimleyin. Örgü başka hiçbir yerde kovan şeritlerine değmemelidir; iki 1 mm yarık bunları ayırır.
İç iletkeni 2 mm aralığı geçecek şekilde üst kolun tabanına lehimleyin. Kablo eksen boyunca aşağı
iner ve kartın alt kenarından (z = −73,8 mm), radom tabanından dışarı çıkar.

| Parametre | Değer | Anlamı |
| --- | --- | --- |
| `f0` | 0,867 GHz | tasarım frekansı (uzak alan ve yüzey akımı) |
| `l_up` | 68,8 mm | besleme aralığının üzerindeki üst kol uzunluğu (ayarlanmış) |
| `l_sl` | 68,8 mm | besleme aralığının altındaki kovan uzunluğu (ayarlanmış, `l_up` ile eşit) |
| `w_up` | 10 mm | üst kol genişliği |
| `w_sl` | 16 mm | kovan genişliği: iki şerit, koaksiyel ve iki yarık. Her şerit (`ws`) 6 mm'dir |
| `g` | 2 mm | besleme aralığı (port uzunluğu) |
| `wb` | 20 mm | kart genişliği |
| `t` | 1,6 mm | FR-4 kalınlığı |
| `w_f` | 2 mm | koaksiyel (besleme hattı) genişliği |
| `s` | 1 mm | koaksiyel ile her kovan şeridi arasındaki yarık |
| `hb` | 3 mm | kovanın üstündeki köprü yüksekliği (örgü lehim pedi) |
| `m` | 4 mm | kolun üzerinde ve kovanın altında kart payı |

Dipol uçtan uca `L` = 139,6 mm'dir (867 MHz'de 0,40 λ); kart `H` = 147,6 × 20 × 1,6 mm'dir.
Bant 0,75–1,0 GHz, durdurma ölçütü −60 dB (zaman adımı sınırı 150 000); uzak alan ve yüzey akımı
`f0` frekansında, ışıma verimliliği bant boyunca 21 frekansta hesaplanır.

**Ayarlama** (GPU motoru, her biri 7–61 s süren 11 çalıştırma):

| Çalıştırma | Değişiklik | En iyi \|S11\| | Çözücü süresi |
| --- | --- | --- | --- |
| 1 | ilk tahmin, `l_up` = `l_sl` = 74 mm, MUR, 20 hücre/λ | 0,803 GHz (−50 dB). 60 000 adım sınırında −44 dB'de durdu | 6,7 s |
| 2–4 | 68; 67; 66,5 mm; 150 000 adım sınırı | 0,863; 0,874; 0,880 GHz | her biri 10,6 s |
| 5 | 66,5 mm, MUR yerine PML 8 | 0,892 GHz, −19,7 dB | 22,2 s |
| 6 | 67,8 mm | 0,877 GHz, −19,6 dB | 23,0 s |
| 7 | `w_up` = 16 mm | 0,884 GHz, −18,9 dB: %1,3 daha geniş bant, uyum iyileşmedi. Kullanılmadı | 23,3 s |
| 8, 9 | 30 ve 40 hücre/λ | 0,889; 0,890 GHz | 31,4; 43,8 s |
| 10 | 68,8 mm, 30 hücre/λ (varsayılanlar) | 0,877 GHz, −19,6 dB | 32,5 s |
| 11 | varsayılanlar, 100 mm yerine 175 mm hava | S11 farkı en çok 0,05 dB, Dmax −0,03 dB | 58,9 s |

İlk çalıştırma yavaş sönümlendi: koaksiyel-kovan saplaması bandın altında, 0,7 GHz yakınında
rezonansa girer; Q çoğunlukla FR-4 kaybıyla belirlenir ve dar bant uyarımı uzundur (9 900 adım).
150 000 adıma izin verildiğinde çalıştırmalar yaklaşık 98 000 (20 hücre/λ) veya 137 000 adımda
(30 hücre/λ) yakınsar. Burada sınırlar etkilidir. MUR ile openEMS'in Dmax değeri (2,72 dBi)
ve örüntüden tümleştirilen Dmax (2,10 dBi) arasında 0,6 dB fark vardı; uyum frekansı yaklaşık
%1,4 düşüktü. PML 8 ile ikisi 0,03 dB içinde uyuşur ve daha fazla hava sonucu değiştirmez.
20 hücreli mesh uyumu %1,4 aşağı yerleştirdi; 30 ve 40 hücre %0,1 içinde uyuştuğundan dosya
30 kullanır. Her iki uzunluktaki 1 mm değişim uyumu yaklaşık 11 MHz (%1,3) kaydırır.

**Sonuçlar** (varsayılanlar, GPU motoru, 442 800 hücre, 137 448 zaman adımı, 32,5 s çözücü süresi):

| Büyüklük | Değer |
| --- | --- |
| 863 / 867 / 870 MHz'de \|S11\| | −18,2 / −18,8 / −19,2 dB (867 MHz'de VSWR 1,26) |
| En iyi uyum | 877 MHz'de −19,6 dB; radom için 867 MHz'in %1,1 üzerinde (sınırlamalara bakın) |
| 867 MHz'de giriş empedansı | 55,8 − j10,7 Ω. Seri rezonans (X = 0) 0,896 GHz'de, R = 65 Ω |
| −10 dB bandı | 0,817–0,954 GHz (137 MHz, %15,4). 863 MHz'in altında 46 MHz (%5,3), 870 MHz'in üstünde 84 MHz (%9,6) pay |
| Dmax / kazanç / gerçekleşen kazanç | 2,10 / 2,05 / 1,99 dBi (yalnızca örüntüden Dmax: 2,09 dBi) |
| Işıma / toplam verimlilik | 867 MHz'de %98,8 / %97,5. Işıma verimliliği bantta %97,7–99,0; toplam verimlilik 0,844–0,917 GHz arasında %95'in üzerinde |
| Ana lob | ufukta (θ = 90°), yükseliş demet genişliği 78° (51°–129°) |
| Azimut, ufuk (θ = 90°) | ortalama 2,08 dBi, dalgalanma 0,04 dB |
| Kutuplanma | düşey (E_θ). Yatay (E_φ) güç toplamdan 46 dB, ufukta E_θ'dan en az 63 dB düşük |
| Zenit / nadir | −39 dBi, dipolün sıfır noktaları |

**Kuram ve diğer iki tasarımla karşılaştırma.**

**Tarihsel Blade sütunu:** Aşağıdaki Blade değerleri ve ilgili karşılaştırmalar güncel galeri paketini değil, önceki ideal çizgi/MUR kaynağını kullanır.

| | İdeal λ/2 dipol (ince tel) | Bu kılıflı dipol | `wideband_dipole_867` | `blade_867` |
| --- | --- | --- | --- | --- |
| Toprak düzlemi gerekli mi? | hayır | hayır | hayır | evet (metal kaplama) |
| Besleme | dengeli (balun gerekir) | koaksiyel, kovan içinden | dengeli (balun gerekir) | kaplamadan geçen koaksiyel |
| Yükseklik × genişlik | yaklaşık 166 mm (0,48 λ) × tel | 139,6 × 16 mm (kart 147,6 × 20 mm) | 110 × 40 mm (kart 116 × 46 mm) | 300 mm kaplama üzerinde, kaplamanın 82 mm üstünde × 60 mm |
| Zin | 0,5 λ'da 73 + j42 Ω, rezonansta yaklaşık 70 Ω | 867 MHz'de 55,8 − j10,7 Ω, rezonansta 65 Ω | 41,8 + j6,4 Ω | 49,5 + j19,3 Ω |
| −10 dB bandı (50 Ω) | yaklaşık %5–10 | %15,4 | %17,8 | en az %32,2 |
| Dmax | 2,15 dBi | 2,10 dBi | 2,0–2,2 dBi | 4,10 dBi, kaplamanın 45° üzerinde |
| Ufuk kazancı, dalgalanma | 2,15 dBi, 0 dB | 2,08 dBi, 0,04 dB | 2,14 dBi, 0,12 dB | −1,4 dBi, 1,5 dB |

Kılıflı dipol λ/2 dipol gibi davranır: aynı örüntü (78° demet genişliği, 0,05 dB daha az yönlülük)
ve ince dipolün 70 Ω değerine yakın 65 Ω rezonans direnci. Bakırın altındaki FR-4 anteni kısaltır;
0,48 λ yerine 0,42 λ'da rezonansa girer (X = 0). 10–16 mm geniş şeritler telin yaklaşık iki katı
bant genişliği sağlar, ancak uyum −19 dB'de kalır: direnç bant boyunca yükselir (0,85 GHz'de
51 Ω, 0,90 GHz'de 67 Ω). Üç tasarımın en darıdır (20 mm kart) ve balunsuz koaksiyel beslenen
tek tasarımdır. Ufukta, küçük toprak düzlemindeki bıçaktan 3,5 dB fazla kazanç verir.
Yarıklı geniş bant dipolden 30 mm daha uzundur.

**Sınırlamalar.**

- **Kablo.** Model koaksiyeli kartın alt kenarında bitirir. Gerçek kablo oradan devam eder;
  kovan ucunda örgünün dışına ulaşan akım kablo boyunca akar, ışıma yapar, örüntüyü eğer ve uyumu
  kaydırır. Modelde koaksiyel şerit alt ucuna yakın, tepe kol akımının yaklaşık %15'ine kadar akım
  taşır. Saplama ideal λ/4 yerine 0,3 λ uzunluğundadır; şok etkisi iyi ama kusursuz değildir.
  Kabloyu kartın altında en az λ/4 (86 mm) anten ekseninde tutun. Dönmesi gerekiyorsa kart kenarına
  ferrit boncuk veya kelepçeli ferrit ekleyin. Etkiyi görmek için kart kenarından aşağı `coax`
  şeridini sürdüren, kablo yarıçapında bir `wire` ekleyip karşılaştırın.
- **Radom.** Radom, boya ve bağlantı ayağı modellenmemiştir. İnce cam elyafı kabuk frekansı
  birkaç yüzde düşürür. En iyi uyum %1,1 yukarıdadır; bant 863 MHz'in %5,3 altına ve 870 MHz'in
  %9,6 üstüne uzanır. Yaklaşık %5 aşağı kayma, 863–870 MHz'i −10 dB bandında tutar. Takılan radom
  daha fazla kaydırırsa `l_up` ve `l_sl` değerlerini birlikte kısaltın: 1 mm bandı yaklaşık %1,3 kaydırır.
- **FR-4 toleransı.** FR-4'ün εr değeri tedarikçiye ve frekansa göre yaklaşık 4,2–4,7, kalınlığı
  ±%10 değişir. Alanın çoğu havadadır; bant, εr'deki bağıl değişimin yaklaşık beşte biri kadar
  kayar (εr 4,7'de yaklaşık %2 aşağı; kartın dipolü ne kadar kısalttığına dayanan tahmindir,
  simülasyonu yapılmamıştır). İlk kartlarda S11'i ölçün ve iki uzunluğu birlikte düzeltin.
- **Montaj.** Antenin yaklaşık λ/4 (86 mm) yakınındaki karbon elyafı parçalar, kablolar, batarya
  ve metal donanım uyumu ve örüntüyü değiştirir.
- **Kayıplar.** Bakır kayıpsızdır (PEC); gerçek bakır verimde yüzde birkaç ondalık puan
  kaybettirir. FR-4 kaybı modellenmiştir ve yaklaşık %1'dir.

## Baskı 2 elemanlı kolineer anten, 867 MHz (`collinear_867.design.json`)

**Kompozit (metal olmayan) gövdeli** İHA için daha yüksek kazançlı telemetri anteni. Yukarıdaki
kılıflı dipolün üzerine, aynı fazda beslenen ikinci yarım dalga eleman eklenmiştir. 863–870 MHz'de
düşey kutuplu ve azimutta her yöne ışımalıdır; toprak düzlemi veya balun gerektirmez. Yanıtladığı
soru şudur: λ/2 dipole göre ufukta ne kadar ek kazanç elde edilir ve bunun yükseliş demet
genişliği ile uzunluğa etkisi nedir? Ufukta 2,0 dB ek kazanç elde edilir (2,1 yerine 4,1 dBi).
Yükseliş demeti 78°'den 39°'ye daralır; anten 140 yerine 352 mm uzunluğundadır.

**Model.** Düşey FR-4 şerit (`f0` frekansında εr 4,3, tan δ 0,02; `t` = 1,6 mm; 30 mm
genişliğinde; xz düzleminde, x uçuş ekseni, z yukarı). Işıma yapan bakırın tamamı (PEC levhalar)
y = 0 yüzeyindedir:

- **alt eleman**, `sleeve_dipole_867` kılıflı dipolü. `g` besleme aralığının üzerinde `l_up`
  uzunluğunda kol, altında `l_sl` uzunluğunda kovan vardır. Kovan, `w_f` örgü şeridinin iki
  yanında, her yanda `s` yarığıyla ayrılan iki şerittir; üstte `hb` köprüsüyle örgü şeridine
  bağlanırlar. O tasarımda olduğu gibi örgü şeridi ile kovan, akımı kablodan uzak tutan şoku oluşturur;
- **fazlama meanderi**, kolun üstünden üst elemanın altına uzanan (74 mm yüksekliğinde),
  `w_m` = 2 mm izden `n_m` = 6 dönüş; genişlik `2 a_m` = 26 mm, adım `p_m`;
- **üst eleman**, `l_top` uzunluğunda ve `w_top` genişliğinde; alt ucundan meander ile beslenir.

Besleme noktası yaklaşık 200 Ω'dur; 50 Ω kablo doğrudan besleyemez. Üst eleman dipol kolu
üzerinden beslendiğinden ışıma direnci dipolünkine eklenir. Bu nedenle beslemede **çeyrek dalga
hat** kullanılır. Arka yüzdeki (y = −t) `w_t` = 1,2 mm iz, 1,2 mm örgü şeridinin arkasında
z = −`l_t` noktasından besleme aralığına uzanır; burada bir via izi kolun tabanına bağlar. İz ile
örgü şeridi kartın iki yüzünde karşılıklı duran yaklaşık 116 Ω'luk şerit çifti oluşturur.
`l_t` = 58 mm uzunluğundadır; via ve uçlar dahil edildiğinde yaklaşık çeyrek kılavuz dalga
boyudur. 50 Ω ayrık port, koaksiyelin bittiği hat alt ucunda kart kalınlığını köprüler.
Burada örgü örgü şeridine lehimlenir; iç iletken bir via ile arka ize geçer.

Toprak düzlemi yoktur. Açık sınırlar PML'dir (8 hücre); her yönde 0,75 GHz'de çeyrek dalga boyu
(100 mm) havanın ardındadır. Otomatik mesh, 1,0 GHz'de dalga boyu başına 30 hücre kullanır
(3,46 milyon hücre). Her 1 mm yarıkta 3, besleme aralığında 4; 1,2 mm besleme izi boyunca 6,
meander basamakları arasındaki 4 mm aralıkta 10 ve kart kalınlığında 12 hücre vardır.

**Bu seçeneğin nedeni.** Üç kolineer yapı değerlendirildi:

- ortak besleme ağıyla aynı fazda beslenen **merkezden beslemeli dipol çifti**; 30 mm şerit
  üzerinde dengeli bölücü ve balun gerektirir;
- bir elemanın merkezinden beslenen **Franklin** (faz çeviren saplamayla bağlanan iki λ/2 şerit).
  Dengeli portla, yukarıdaki yalın baskı dipoller gibi balun gerektirir;
- **kılıflı dipol tabanına saplama ve ikinci eleman eklenmesi** (bu tasarım).

Kovan tabanı üretimde en pratiktir. Koaksiyel kendi şoku içinden eksen boyunca gelir; geri kalan
bölüm tek yüzlü bakır desen, arkada bir hat ve iki via içerir. Tümü FR-4 üzerinde ince bakır ve
ayrık porttan oluşur; Fairbeam bunu aslına uygun modeller (yalnızca bakır kayıpsız kabul edilerek
idealleştirilmiştir). Saplama, iki eleman arasında akım yönünü çevirmelidir. Yalın bir aralıkla
iki eleman zıt fazda ışıma yapar; λ/2 düz tel ise araya zıt fazda ışıyan eleman eklerdi.
Bu nedenle saplama, basamaklarındaki ters akımların birbirini götürdüğü meander biçiminde katlanır.

Kazancı eleman aralığı belirler. İdeal iki kolineer λ/2 dipol, merkezler arası 0,5 λ'da
3,8 dBi, 0,6 λ'da 4,4 dBi ve 0,75 λ'da 5,0 dBi verir (yarı güç demet genişlikleri 48°, 42°, 35°).
FR-4 üzerinde her eleman yalnızca yaklaşık 0,41 λ uzunluğundadır; eksen boyunca saplama gerekli
aralığı sağlamanın da tek yoludur. 74 mm meander, merkezleri 211 mm (0,61 λ) ayırır. 0,75 λ
örneğinin 5 dBi kazancı yaklaşık 50 mm ek uzunluk, toplam yaklaşık 400 mm gerektirir;
bu da hedeflenen 350 mm sınırını aşar.

| Parametre | Değer | Anlamı |
| --- | --- | --- |
| `f0` | 0,867 GHz | tasarım frekansı (uzak alan ve yüzey akımı) |
| `l_up`, `l_sl` | 68,8 mm | besleme aralığının üzerindeki dipol kolu ve altındaki kovan (`sleeve_dipole_867` ile aynı) |
| `w_up`, `w_sl` | 10, 16 mm | kol genişliği; kovan genişliği (iki şerit, örgü şeridi ve yarıklar). Her şerit (`ws`) 6,4 mm'dir |
| `g` | 2 mm | besleme aralığı |
| `w_f` | 1,2 mm | örgü şeridi genişliği (besleme hattının ön iletkeni) |
| `s`, `hb` | 1, 3 mm | örgü şeridi yanındaki yarık; kovan üstündeki köprü yüksekliği |
| `w_t` | 1,2 mm | arka yüzdeki besleme izi genişliği (şerit çifti yaklaşık 116 Ω) |
| `l_t` | 58 mm | koaksiyel ucundan (port) besleme aralığına hat uzunluğu (ayarlanmış) |
| `w_v` | 1 mm | kola giren via, besleme aralığının `w_v`/2 üzerinde bulunur |
| `n_m` | 6 | meander dönüşü (`nt` tam sayısına yuvarlanır) |
| `p_m` | 12 mm | meander adımı (iki basamak); basamak aralığı 4 mm |
| `a_m` | 13 mm | eksenden bağlantıların dış kenarına meander yarı genişliği (ayarlanmış) |
| `w_m` | 2 mm | meander iz genişliği |
| `l_top`, `w_top` | 142, 10 mm | üst eleman uzunluğu ve genişliği |
| `wb`, `t`, `m` | 30; 1,6; 4 mm | kart genişliği, FR-4 kalınlığı, iki uçtaki kart payı |

Türetilen değerler: meander yüksekliği `H_m` = 74 mm, iz uzunluğu `L_m` ≈ 384 mm. Güçlü
kuplajlı basamaklar nedeniyle iz λ/2'den çok uzundur. Eleman aralığı `d_el` = 211 mm (0,61 λ).
Kovan ucundan tepeye anten uzunluğu `L` = 351,6 mm; kart `H` = 359,6 × 30 × 1,6 mm.
Bant 0,75–1,0 GHz, durdurma ölçütü −60 dB (zaman adımı sınırı 250 000). Uzak alan ve yüzey akımı
`f0` frekansında, ışıma verimliliği bant boyunca 21 frekansta hesaplanır.

**Ayarlama** (GPU motoru, 12 çalıştırma. 1–7: 30 hücre/λ, −50 dB; 8–9: 30 hücre/λ, −40 dB;
10: 20 hücre/λ, −40 dB; 11–12: varsayılanlar):

| Çalıştırma | Fazlama bölümü ve besleme | Demet (θ = 90° ufuktur) | Uyum | Çözücü süresi |
| --- | --- | --- | --- | --- |
| 1 | üç kollu zikzak saplama ("N"), 30 mm yüksekliğinde; port aralıkta | ufkun 27° altında; ufukta −3 dBi | 124 − j31 Ω | 50 s |
| 2–4 | aynı, 60 / 45 / 50 mm | 27,5° yukarı / 14° aşağı / 7,6° aşağı | 58 − j80 / 182 + j27 / 275 − j108 Ω | 59–63 s |
| 5 | aynı, 52,5 mm | ufukta, Dmax 4,30 dBi; ancak azimut dalgalanması 2,1 dB | 181 − j195 Ω | 64 s |
| 6 | paralel iki aynalanmış meander, 5 dönüş | 38° yukarı: çift halka gibi davranır | 327 − j109 Ω | 73 s |
| 7 | tek tam genişlikli meander, 4 dönüş, `a_m` 10,5 | 25° aşağı (faz yetersiz) | 148 − j146 Ω | 74 s |
| 8 | 5 dönüş ve şerit çiftli hat (`w_t` 1,6, `l_t` 48) | 9,5° aşağı, Dmax 3,78 dBi | bant 0,902–1,0 GHz | 134 s |
| 9 | `a_m` 11,2, `w_t` 1,2 | 7,4° aşağı, Dmax 4,22 dBi | bant 0,875–1,0 GHz | 199 s |
| 10 | 6 dönüş | 3,7° aşağı, Dmax 4,80 dBi | 867 MHz'de −17 dB, bant 0,851–0,998 GHz | 213 s |
| 11 | `a_m` 13 | 1,0° aşağı, Dmax 4,74 dBi | 867 MHz'de −12,1 dB, bant 0,837–0,894 GHz | 460 s |
| 12 | `l_t` 58 (varsayılanlar) | 1,1° aşağı, Dmax 4,76 dBi | 867 MHz'de −12,0 dB, bant 0,822–0,969 GHz | 420 s |

Zikzak saplama (1–5. çalıştırmalar) fazı belirledi: uygun yüksekliğin yakınında her mm demeti
1,3–3° kaydırdı. Ancak bağlantıları ayna simetrili değildir. Doğru yükseklikte azimut örüntüsüne
2,1 dB dalgalanma ekleyen yatay akım kaldı. Basamakları tam genişliğe uzanan meander bu akımı
yok eder (0,2 dB dalgalanma). Daha çok dönüş veya daha geniş basamak fazı artırır: bir ek dönüş
demeti yaklaşık 15° yükseltti (7–8); `a_m` değerindeki 0,7 mm artış 2° yükseltti (8–9).
Port aralıktayken demeti ufka yakın yönlendiren seçeneklerin besleme empedansı 150–300 Ω'du.
Şerit çiftli dönüştürücü bunu 50 Ω'a indirir. 11. ve 12. çalıştırmalar yalnızca hat uzunluğuyla
ayrılır (48 ve 58 mm); uzun hat bandı genişletip yukarı kaydırdı. Model büyüdükçe çalıştırmalar
yavaşladı. Meanderin ince hücreleri mesh'i 1,1 milyondan 3,5 milyona çıkardı; şok ve besleme
hattı yavaş sönümlenir (−60 dB'ye 227 000 zaman adımı).

**Sonuçlar** (varsayılanlar, GPU motoru, 3,46 milyon hücre, 227 360 zaman adımı, 420 s çözücü süresi):

| Büyüklük | Değer |
| --- | --- |
| 863 / 867 / 870 MHz'de \|S11\| | −12,3 / −12,0 / −11,8 dB (867 MHz'de VSWR 1,67) |
| −10 dB bandı | 0,822–0,969 GHz (147 MHz, %15,7), iki minimum: 0,84 GHz'de −15,1 dB ve 0,935 GHz'de −17,8 dB. 863 MHz'in altında 41 MHz (%4,8), 870 MHz'in üstünde 99 MHz (%11) pay |
| 867 MHz'de giriş empedansı | portta 67,9 − j24,3 Ω (besleme hattının koaksiyel ucunda) |
| Dmax / kazanç / gerçekleşen kazanç | 4,76 / 4,19 / 3,90 dBi (yalnızca örüntüden Dmax: 4,75 dBi) |
| Işıma / toplam verimlilik | 867 MHz'de %87,6 / %82,2. Işıma verimliliği 0,84–1,0 GHz arasında %83–88. Bandın altında, antenin uyumunun çok kötü olduğu yerde düşer (0,75 GHz'de %23). 21 noktanın tamamı güvenilirlik sınırında |
| Ufuk (θ = 90°) | kazanç 4,09 dBi (azimut ortalaması), dalgalanma 0,20 dB; gerçekleşen kazanç 3,81 dBi |
| Yükseliş | yarı güç demet genişliği 38,8° (θ = 71,9°–110,8°); tepe ufkun 1,1° altında. Ufkun 45°–75° altında −15 ile −17 dBi yan loblar |
| Zenit / nadir | −32 / −34 dBi |

`f0` yüzey akımının biri dipol kolunda, diğeri üst elemanda iki maksimumu vardır; fazları 15°
içinde uyuşur. Aradaki meander basamaklarında büyük karşıt akımlar birbirini götürür. Ancak
meander kusursuz bir faz kaydırıcı değildir. Bağlantıları, üst elemandakine yakın büyüklükte
zıt fazlı net düşey akım taşır ve kazancı biraz azaltır. Bu nedenle anten ufukta 4,1 dBi verir;
aynı 0,61 λ aralıklı ideal dipol çiftinden 0,3 dB düşüktür. Paket yalnızca toplam yönlülüğü
sakladığından çapraz kutuplanma ayrıştırılmaz. Basamaklar eksene göre simetriktir;
azimut dalgalanması 0,2 dB'dir.

**Kılıflı dipol ve ideal kolineer ile karşılaştırma.**

| | `sleeve_dipole_867` | Bu kolineer | İdeal 2 elemanlı kolineer, 0,61 λ | İdeal 2 elemanlı kolineer, 0,75 λ |
| --- | --- | --- | --- | --- |
| Uzunluk × genişlik | 139,6 × 16 mm (kart 147,6 × 20 mm) | 351,6 × 26 mm (kart 359,6 × 30 mm) | yaklaşık 380 mm tel | yaklaşık 425 mm tel |
| Ufuk kazancı | 2,08 dBi | 4,09 dBi (+2,0 dB) | 4,42 dBi | 5,04 dBi |
| Dmax / kazanç | 2,10 / 2,05 dBi | 4,76 / 4,19 dBi | 4,42 dBi | 5,04 dBi |
| Yükseliş HPBW | 78° | 38,8° | 41,4° | 35,1° |
| Demet eğimi | 0° | 1,1° aşağı | 0° | 0° |
| Azimut dalgalanması | 0,04 dB | 0,20 dB | 0 dB | 0 dB |
| 867 MHz'de \|S11\|, −10 dB bandı | −18,8 dB, %15,4 | −12,0 dB, %15,7 | | |
| Işıma verimliliği | %98,8 | %87,6 | %100 | %100 |

**Dar demetin uçuşta anlamı.** 2 dB ek kazanç yalnızca ufka yakın elde edilir. Uzakta, yer
istasyonu genellikle ufkun birkaç derece yakınındadır; uzun ve yatay uçuşta kazancın tamamı
kullanılır. Tablo, anten düşeyken ufkun altındaki açıya göre kazancı (azimut ortalaması) gösterir:

| Ufkun altında | 0° | 5° | 10° | 15° | 20° | 30° | 45° | 60° |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bu kolineer | 4,1 | 4,0 | 3,5 | 2,6 | 1,3 | −2,7 | −15,7 | −17,5 dBi |
| λ/2 dipol (2,08 dBi, ideal örüntü biçimi) | 2,1 | 2,0 | 1,9 | 1,6 | 1,3 | 0,3 | −2,0 | −5,5 dBi |

Kolineer, ufuktan yaklaşık 20°'ye kadar daha iyi, ötesinde daha kötüdür. 30° sonrasında fark büyür:

- **Yatış.** 30° yatış demeti 30° eğer: alçak kanat tarafında aşağı, yüksek kanat tarafında
  yukarı. Ufukta yan taraftaki yer istasyonu bu durumda demet tepesinden 30° uzaktadır.
  Kolineer alçak kanat tarafında −4,9 dBi, yüksek kanat tarafında −2,7 dBi verir; λ/2 dipol
  hâlâ 0,3 dBi verir. Böylece dipolden 2 dB iyi olmak yerine 3–5 dB kötü olur. Ufkun 10–20°
  altındaki istasyon alçak kanat tarafında 0,4–3,1 dBi, yüksek kanat tarafında −10 ile −25 dBi
  görür. Yalnızca uçuş doğrultusunda yatış demeti değiştirmez. Dönüşler için bağlantı hesabında
  kolineeri yaklaşık −5 dBi, dipolü 0 dBi alın.
- **Üstten geçiş.** Düşeyin yaklaşık 45° çevresinde (istasyonun üstünde, tırmanışta veya sahaya
  yakınken) kolineer −15 ile −18 dBi, dipol −2 ile −12 dBi verir. İkisinin de tam aşağıda
  sıfırı vardır; kolineerin zayıf sinyal konisi çok daha geniştir. Yer istasyonunun üzerinden
  veya yakınından geçen İHA için yeterli bağlantı payı ya da çeşitlilik sağlayan ikinci anten
  (örneğin dipol veya aşağı bakan yama) gerekir.

Kolineer, uzun menzilli ve çoğunlukla yatay uçuşta avantaj sağlar. Dik yatışlı veya üstten
geçişli kısa menzil uygulamalarında kılıflı dipolün 78° demeti daha dayanıklı seçimdir.

**Üretim notları ve sınırlamalar.**

- **Besleme ve kablo.** İnce koaksiyeli (RG-178 veya RG-316) kartın alt kenarından besleme
  hattının alt ucuna (z = −58 mm) kadar örgü şeridine yatırın. Örgüyü burada şeride lehimleyin;
  iç iletkeni kaplamalı via ile arka yüz izine geçirin. İz, aralığın 1,5 mm üzerinde kolun
  tabanına giren ikinci via ile biter. Örgü kovan şeritlerine değmemelidir; iki 1 mm yarık
  ayrımı sağlar, bu nedenle yalnızca kısa bölüm soyun. Kılıflı dipolde olduğu gibi karttan sonraki
  kablo modellenmemiştir. Kart altında en az λ/4 (86 mm) eksen üzerinde tutun veya kart kenarına
  ferrit takın.
- **Uyum.** 863–870 MHz'de uyum kılıflı dipolün −19 dB değeri yerine −12 dB'dir. Bant geniştir
  (%15,7), fakat iki minimum içerir; aralarında yaklaşık 880 MHz'de −11,5 dB vardır. Merkez,
  hedeflenen %1 yerine 867 MHz'in %3 üzerindedir. Daha fazla ayarlama çalıştırması yapılmadı.
  Sonraki adımlar biraz daha geniş `w_t` izi (daha düşük hat empedansı) veya `l_t` değerini
  58 mm çevresinde bir–iki milimetre yeniden ayarlamaktır. Uyumsuzluk gerçekleşen kazançta
  0,28 dB kaybettirir.
- **Radom.** İnce cam elyafı kabuk frekansı birkaç yüzde düşürür. Bant 863 MHz'in %4,8 altına
  uzanır; yaklaşık %4'e kadar kayma 863–870 MHz'i içinde tutar. Faz daha hassastır: radom
  meanderi elemanlardan daha fazla yavaşlatırsa demet eğilir. Radom takılıyken örüntüyü
  (veya ufuktaki sinyal gücünü) denetleyin; `a_m` değerini (mm başına yaklaşık 3° eğim)
  veya üst elemanı düzeltin.
- **Uzunluk.** 360 mm kart İHA için uzundur. Rijit radom veya direk gerekir. Uçuşta esneyen
  kart, yatış gibi demeti eğer. Kaplama karbon değil cam elyafıysa alt 150 mm (kılıflı dipol)
  gövde içine yerleştirilebilir.
- **Kayıplar.** Işıma verimliliği, kılıflı dipolün %98,8 değerine karşı %87,6'dır. Ek kayıp büyük
  olasılıkla akım yoğunluğunun yüksek olduğu besleme hattı ve meander basamakları altındaki
  FR-4'tedir (tahmin; model kaybı ayrıştırmaz). Düşük kayıplı laminat (tan δ yaklaşık 0,004)
  kaybın çoğunu geri kazandırabilir, ancak εr değişeceğinden `l_t` ve `a_m` yeniden ayarlanmalıdır.
  Bakır kayıpsızdır (PEC); gerçek bakır verimde yüzde birkaç ondalık puan ek kayıp getirir.
- **FR-4 toleransı.** εr'nin 4,2–4,7 arasında olması bandı ve meander üzerinden eğimi değiştirir.
  Tasarımı kesinleştirmeden önce ilk kartlarda S11'i ve örüntüyü ölçün.

## Yer istasyonu için 5 elemanlı Yagi, 867 MHz (`yagi_867.design.json`)

863–870 MHz SRD / LoRa bandındaki İHA telemetri bağlantısının **yer istasyonu** için yönlü anten.
İHA'da her yöne ışıyan anten (`sleeve_dipole_867`) kullanılır; menzil için ek kazancı istasyon
sağlar. 283 mm bom üzerinde beş elemanlı Yagi-Uda'dır: yansıtıcı, saç tokası uyumlamalı beslenen
dipol ve üç yönlendirici. Kazancı 10,4 dBi, ön/arka oranı 18,6 dB'dir. İHA dipolünün düşey
kutuplanmasına uyması için elemanları **düşey** monte edin.

**Model.** Metalin tamamı alüminyumdur; xz düzleminde (y = 0) PEC levhalarla modellenir.
x bom ekseni (+x ileri, İHA'ya doğru), z elemanlar boyunca yukarıdır. Kart ve dielektrik yoktur.
Her eleman **4 mm çubuktur** (`d`); `w` = 2 `d` = 8 mm genişliğinde düz şerit olarak modellenir.
w genişliğindeki düz şeridin yuvarlak tel eşdeğer yarıçapı w/4'tür; şerit ve çubuğun akım dağılımı
ile rezonansı yaklaşık aynıdır. Levhalar hacim içinde mesh gerektirmediğinden zaman adımı makul
kalır. Otomatik mesh, her şeridin genişliğine 6 hücre (1,33 mm), levha düzleminin iki yanına da
bu boyutta ikişer hücre yerleştirir. Parçalar:

- x = −`s_r` konumunda, `L_r` uzunluğunda **yansıtıcı**;
- **beslenen eleman**, orijinde aralarında `g` = 6 mm besleme aralığı bulunan düz dipolün iki
  yarısı; uçtan uca `L_de`;
- **saç tokası** (beta uyumlama). Elemanlarla aynı genişlikte iki ray, iki yarıdan besleme
  aralığının kenarları boyunca yansıtıcıya doğru uzanır. Beslenen elemanın arka kenarından
  `l_hp` = 23 mm geride, ekseninden 35 mm uzakta (`x_hp`) bir çubuk rayları kısa devre eder.
  Saç tokası beslemeye paralel kısa devreli şerit çiftli saplamadır: yaklaşık 7–9 nH paralel endüktans;
- x = `s_1`, `s_1 + s_2` ve `s_1 + s_2 + s_3` konumlarında, `L_d1`, `L_d2` ve `L_d3`
  uzunluğunda 1–3 **yönlendiricileri**.

8 mm genişliğindeki 50 Ω ayrık port besleme aralığını köprüler. Besleme **dengelidir**; uygulamada
koaksiyel için aralıkta 1:1 balun gerekir (üretim notlarına bakın). Bom **metal olmayan** malzeme
(cam elyafı, PVC veya ahşap) kabul edilerek model dışında bırakılmıştır. Açık sınırlar PML'dir
(8 hücre); her yönde 0,8 GHz'de çeyrek dalga boyu (94 mm) havanın ardındadır. Otomatik mesh,
0,95 GHz'de dalga boyu başına 30 hücre kullanır (715 000 hücre). En küçük hücre 0,37 mm'dir;
saç tokası raylarının kısa devreyle birleştiği yerdedir.

**Bu seçeneğin nedeni.** Üç beslenen eleman türü değerlendirildi:

- **katlanmış dipol** (Yagi'de yaklaşık 200–300 Ω). 4:1 balun gerekir; balun da modellenmezse
  50 Ω port 4–6:1 uyumsuzluk görür;
- **FR-4 üzerinde baskı quasi-Yagi**. Küçüktür, ancak FR-4 verimi düşürür (yukarıdaki kolineerde
  %12 kayıp), εr toleransı bandı kaydırır ve 10 dBi için yaklaşık 0,8 λ (280 mm) uzun kart gerekir;
- **saç tokası uyumlamalı düz dipol** (bu tasarım). Yaklaşık 10 dBi kazançlı Yagi'nin besleme
  direnci düşüktür (aşağıdaki ilk çalıştırmada 25 Ω). Beslenen eleman biraz kısa (kapasitif)
  ayarlanır; saç tokasının paralel endüktansı sonucu 50 Ω'a dönüştürür.

Üç seçenek içinde çubuk veya şeritten en kolay üretilen saç tokası yapısıdır; yalnızca 1:1
balun gerekir. Havada metal şeritlerden ve aralıkta ayrık porttan oluşur; Fairbeam bunu aslına
uygun modeller. Saç tokasının kısa devresi gerilim sıfırıdır; DC toprak olarak boma veya direğe bağlanabilir.

Boyutların başlangıcı **NBS 5 elemanlı tasarımıdır** (NBS Teknik Not 688: d/λ = 0,0085 için
0,8 λ bom, 0,2 λ aralıklar, 0,482 λ yansıtıcı ve 0,428/0,420/0,428 λ yönlendiriciler).
NBS tasarımı yalnızca kazanç için optimize edilmiştir. 4 mm çubuklu ince tel momentler yöntemi
(MoM) modeli 867 MHz'de 11,3 dBi, ancak yalnızca 12,9 dB ön/arka oranı; 870 MHz'de 11,7 dB verdi.
(MoM modeli küçük bir Python betiğidir; Fairbeam'in parçası değildir.) Boyutlar ve aralıklar,
863–870 MHz boyunca en az 20 dB ön/arka oranıyla 10,3–10,8 dBi için bu modelde yeniden optimize edildi.
Yansıtıcı daha geriye, son yönlendirici daha ileriye taşındı; bom 0,82 λ oldu. Ardından FDTD
çalıştırmaları boyları şerit modele göre düzeltti (aşağıdaki Ayarlama bölümüne bakın).

| Parametre | Değer | Anlamı |
| --- | --- | --- |
| `f0` | 0,867 GHz | tasarım frekansı (uzak alan ve yüzey akımı) |
| `d` | 4 mm | eleman çubuk çapı; şerit genişliği `w` = 2 `d` = 8 mm |
| `L_r` | 162,4 mm | yansıtıcı uzunluğu (0,470 λ) |
| `L_de` | 156 mm | 6 mm aralık dahil, uçtan uca beslenen eleman (0,451 λ; ayarlanmış) |
| `L_d1`, `L_d2`, `L_d3` | 142,9; 137,1; 129,8 mm | yönlendirici uzunlukları (0,413; 0,396; 0,375 λ) |
| `s_r` | 78 mm | yansıtıcıdan beslenen elemana (0,226 λ) |
| `s_1`, `s_2`, `s_3` | 47, 60, 98 mm | beslenen elemandan yönlendirici 1'e, 1'den 2'ye, 2'den 3'e (0,136; 0,174; 0,283 λ) |
| `g` | 6 mm | dipol yarıları ve saç tokası rayları arasındaki besleme aralığı |
| `l_hp` | 23 mm | beslenen elemanın arka kenarından kısa devreye saç tokası yarık uzunluğu (ayarlanmış) |

Türetilen değerler: `boom` uzunluğu yansıtıcıdan yönlendirici 3'e 283 mm'dir (0,82 λ).
`x_hp` saç tokası uzunluğu, beslenen elemanın ekseninden kısa devrenin arkasına 35 mm'dir.
Anten 283 × 162 mm'dir; şerit genişlikleri için x yönünde 8 mm eklenir. Bant 0,8–0,95 GHz,
durdurma ölçütü −60 dB (zaman adımı sınırı 200 000). Uzak alan ve yüzey akımı `f0` frekansında,
ışıma verimliliği bant boyunca 21 frekansta hesaplanır.

**Ayarlama** (GPU motoru, 6 çalıştırma: 1–5: 20 hücre/λ ve −40 dB; 6: varsayılanlar):

| Çalıştırma | Değişiklik | 867 MHz'de sonuç | Çözücü süresi |
| --- | --- | --- | --- |
| 1 | MoM uzunlukları (yansıtıcı 166,5, beslenen eleman 152, yönlendiriciler 146,5/140,5/133 mm), saç tokası yok | beslenen eleman 25,7 + j0,4 Ω; Dmax 10,78 dBi, F/B 15,8 dB | 2,0 s |
| 2 | parazitik elemanlar %2,5 kısa, `L_de` 145,4 mm, saç tokası `l_hp` 5 mm | F/B 18,0 dB, Dmax 10,44 dBi; 21,9 + j72,2 Ω (−2,4 dB) | 5,5 s |
| 3 | `L_de` 152 mm | 42,7 + j49,3 Ω (−6,5 dB) | 4,2 s |
| 4 | `L_de` 158 mm, `l_hp` 18 mm | −14,6 dB; en iyi: 858 MHz'de −18,5 dB | 3,6 s |
| 5 | `L_de` 156,5 mm, `l_hp` 23 mm | −22,8 dB; en iyi: 863 MHz'de −30,7 dB | 3,6 s |
| 6 | `L_de` 156 mm: varsayılanlar, 30 hücre/λ ve −60 dB | −27,2 dB; en iyi: 865 MHz'de −33,0 dB | 38,0 s |

1. çalıştırma şeritlerin MoM çubuklarından yaklaşık %2,5 uzun davrandığını gösterdi; aynı sonucu
vermesi için MoM modelindeki tüm boyları %2,5–3 artırmak gerekiyordu. Ön/arka oranı (15,8 dB)
ve kazancı, MoM modelinin 867 yerine yaklaşık 882 MHz sonucuyla uyuştu. 2. çalıştırmada parazitik
elemanlar %2,5 kısaltıldı ve bant boyunca 18 dB ön/arka oranı elde edildi. Bundan sonra örüntü
çok az değişti: kalan çalıştırmalarda Dmax 0,05 dB, ön/arka oranı 0,7 dB içinde kaldı.
Saç tokası ve beslenen eleman birlikte ayarlandı. Her çalıştırmadan sonra o ana kadarki sonuçlara
uydurulan model sonraki değerleri seçti; model saç tokasını, empedansı `L_de` ile doğrusal değişen
beslenen elemana paralel kısa devreli saplama olarak ele alır. `L_de` değerindeki 1 mm değişim
besleme reaktansını yaklaşık 6–8 Ω değiştirir. Son çalıştırmanın uyumu, kaba çalıştırmaların
156 mm için verdiği frekansın yaklaşık %0,3 yakınındadır.

**Sonuçlar** (varsayılanlar, GPU motoru, 714 840 hücre, 79 206 zaman adımı, 38,0 s çözücü süresi):

| Büyüklük | Değer |
| --- | --- |
| 863 / 867 / 870 MHz'de \|S11\| | −28,6 / −27,2 / −20,7 dB (867 MHz'de VSWR 1,09) |
| En iyi uyum | 864,7 MHz'de −33,0 dB |
| 867 MHz'de giriş empedansı | 49,4 + j4,3 Ω. 863,6 MHz'de X = 0, R = 53,1 Ω |
| −10 dB bandı | 844,4–883,1 MHz (38,7 MHz, %4,5). 863 MHz'in altında 19 MHz (%2,2), 870 MHz'in üstünde 13 MHz (%1,5) pay |
| Dmax / kazanç / gerçekleşen kazanç | 10,45 / 10,40 / 10,39 dBi (yalnızca örüntüden Dmax: 10,45 dBi) |
| Işıma / toplam verimlilik | 867 MHz'de %99,0 / %98,8. Işıma verimliliği 0,80–0,935 GHz arasında %97–99,6; metal PEC olduğundan eksik yüzde sayısaldır. Toplam verimlilik 0,845–0,883 GHz arasında %89'un üzerinde. 21 noktanın tamamı güvenilirlik sınırında |
| Ön/arka oranı | 867 MHz'de 18,6 dB (863 MHz'de 18,9 dB, 870 MHz'de 18,1 dB). Arka lob arka yarı uzayın en büyük lobudur; dolayısıyla tüm arka bölgeye göre oran da aynıdır |
| E düzlemi (düşey, elemanların düzlemi) | yarı güç demet genişliği 54,1° (863–870 MHz boyunca 53,8–54,5°), tepe ufukta. Zenit ve nadirde eleman sıfırları −24 dBi |
| H düzlemi (yatay, azimut) | yarı güç demet genişliği 69,8° (69,2–70,6°). Boma dik yön (90°) −11,7 dBi, tepeden 22 dB düşük |
| 863 / 867 / 870 MHz boyunca | Dmax 10,35 / 10,45 / 10,52 dBi, gerçekleşen kazanç 10,29 / 10,39 / 10,42 dBi |

Demet genişlikleri örüntüden ara değerlemeyle hesaplanır (θ'da 3°, φ'de 5° adımlar).
Bant kenarı değerleri için son çalıştırmada dosyanın 863, 867 ve 870 MHz uzak alanlarını içeren
kopyası kullanıldı; asıl dosya yalnızca `f0` uzak alanını kaydeder. `f0` yüzey akımı beslenen
elemanda tepe yapar. Bu tepeye göre yönlendiriciler sırasıyla %59; %76; %52; yansıtıcı %51;
saç tokasının kısa devresi %60 akım taşır (dolaşan akımı).

**Kuram ve kılıflı dipolle karşılaştırma.**

| | NBS 5 elemanlı (0,8 λ), MoM, 4 mm çubuk | Yeniden optimize edilmiş, MoM | Bu tasarım, FDTD | `sleeve_dipole_867` |
| --- | --- | --- | --- | --- |
| Bom | 277 mm (0,80 λ) | 283 mm (0,82 λ) | 283 mm (0,82 λ) | yok |
| 867 MHz'de kazanç | 11,3 dBi | 10,5 dBi | 10,40 dBi (gerçekleşen 10,39 dBi) | 2,05 dBi (gerçekleşen 1,99 dBi) |
| Ön/arka | 12,9 dB (870 MHz'de 11,7 dB) | 20,9 dB | 18,6 dB | 0 dB |
| E / H düzlemi HPBW | 47° / 57° | 54° / 71° | 54,1° / 69,8° | 78° / her yöne |
| Besleme | 17 + j19 Ω | saç tokasından önce 25 − j18 Ω | saç tokasıyla 49,4 + j4,3 Ω | 55,8 − j10,7 Ω |

0,8 λ Yagi yaklaşık 10–11 dBi verir (NBS tablosunda kazanç için optimize edilmiş sürüm yaklaşık
9,2 dBd, yani 11,3 dBi'dir). Arka lobun çoğunlukla girişim ve yer yansımalarını aldığı yer
istasyonunda, arka yarı uzayı temizlemek için 0,9 dB kazançtan vazgeçmek olağan bir seçimdir.
FDTD ön/arka oranı MoM'dan 2,3 dB düşüktür; büyük olasılıkla şeritler yuvarlak çubuklardan biraz
farklı kuplaj oluşturur. 863–870 MHz boyunca 18,6 dB'nin 0,5 dB yakınında kalır.

**Bağlantı hesabı: ek menzil.** Serbest uzayda, sabit bağlantı payında menzil iki anten kazancının
çarpımının kareköküyle artar. Bir uçtaki ΔG (dB) kazanç farkı menzili 10^(ΔG/20) ile çarpar.
İstasyondaki kılıflı dipolün (1,99 dBi gerçekleşen kazanç) yerine Yagi (10,39 dBi gerçekleşen kazanç)
konulduğunda:

| İstasyon anteni | Gerçekleşen kazanç | ΔG | Menzil çarpanı | Daha önce 10 km'ye ulaşan bağlantının yeni menzili |
| --- | --- | --- | --- | --- |
| `sleeve_dipole_867` | 1,99 dBi | | 1 | 10 km |
| Bu Yagi, İHA'ya yöneltilmiş | 10,39 dBi | 8,4 dB | 2,63 | 26 km |
| Bu Yagi, azimutta İHA'dan 30° sapmış | 8,3 dBi | 6,3 dB | 2,07 | 21 km |

Anten karşılıklı olduğundan çarpan hem yukarı hem aşağı bağlantı için geçerlidir. Bu bir serbest
uzay değeridir. Gerçek güzergâhta yer yansıması, Fresnel bölgesi açıklığı ve yer eğriliği menzili
daha önce sınırlar; anten yükseklikleri ve arazi kazanç kadar etkilidir. SRD bandının güç sınırı
(863–870 MHz'in büyük bölümünde genellikle 25 mW ERP, 14 dBm) anten kazancını da içerir.
Dolayısıyla Yagi kullanan verici istasyon, sınırda kalmak için verici gücünü Yagi'nin dipole göre
kazancı kadar (8,2 dB) düşürmelidir. Alış yönünde 8,4 dB'nin tamamı korunur.

**Üretim notları ve sınırlamalar.**

- **Yöneltme.** İstasyon Yagi'si İHA'ya bakmalıdır. Azimut demet genişliği 70°'dir: kazanç
  bomdan ±35° sapmada 3 dB, ±60° sapmada yaklaşık 12 dB düşer. Sahanın her yönünde uçan İHA için
  takip düzeneği yararlıdır: telemetriden gelen İHA GPS konumuyla sürülen yatay döndürme servosu.
  İHA'nın ufkun yaklaşık 25° üzerine çıktığı yakın ve yüksek geçişlerde eğim ekseni yardımcı
  olur. Sabit Yagi tek sektörde yürütülen göreve uygundur.
- **Kutuplanma.** İHA'nın düşey dipolüne uyması için elemanları düşey monte edin. Yatay Yagi
  çapraz kutuplanma nedeniyle 20 dB veya daha fazla kaybeder.
- **Balun.** Besleme dengeli olduğundan koaksiyelde aralıkta 1:1 akım balunu gerekir. Kablonun
  son 50 mm'sindeki ferrit boncuklar (örneğin RG-316 üzerinde 3–5 adet tip 43 veya 61 boncuk,
  RG-58 üzerinde kelepçeli nüve) veya yaklaşık 86 mm uzunluğunda λ/4 kovan (bazuka) balun
  kullanılabilir. Balunsuz durumda koaksiyelin dışındaki akım örüntüyü bozar ve ön/arka oranını
  azaltır. Koaksiyeli elemanlara paralel değil, bom boyunca uzaklaştırın.
- **Bom ve direk.** Modelde bom yoktur. Metal olmayan bomda elemanları olduğu gibi takın.
  Metal bomdan geçerek ona bağlanan elemanlarda her elemanı bom düzeltmesi kadar uzatın:
  küçük yuvarlak bom için DL6WU çizelgesine göre bom çapının yaklaşık 0,5–0,7 katı (burada
  simülasyonu yapılmamıştır). Elemanlar yalıtılmış ve bomdan en az bir bom çapı yukarıdaysa
  düzeltme neredeyse sıfırdır. Beslenen eleman metal bomdan yalıtılmalıdır; yalnızca saç tokası
  kısa devresinin merkezi bağlanabilir. Düşey elemanlara yakın ve paralel metal direk örüntüyü
  bozar. Bomu direğe yansıtıcının arkasından bağlayın veya direğin üst yarım metresini metal
  olmayan malzemeden yapın.
- **Çubuk veya şerit.** Model 8 mm genişliğinde düz şerittir. Bu genişlikte 1–2 mm kalın
  alüminyum şerit, benzetilen yapıyı doğrudan üretir. Yuvarlak 4 mm çubuklar kuramsal olarak
  eşdeğerdir; uyumun yaklaşık %1'e kadar kaymasını bekleyin. Bitmiş antende `L_de` veya `l_hp`
  değerini düzeltin: `L_de` değerindeki 1 mm değişim uyumu yaklaşık 5 MHz kaydırır.
- **Saç tokası.** Rayları aynı çubuk veya şeritten, kenardan kenara 6 mm aralıkla, besleme
  aralığı kenarları hizasında yapın. `l_hp` yarık uzunluğu ile `L_de` uyumu birlikte belirler;
  daha uzun yarık endüktansı artırır. Geometri, her `l_hp` > 0 için kısa devreyi beslenen elemanın
  arkasında tutar. Tasarım denetimleri besleme aralığını geçen kısa devreyi işaretlemez
  (portun üzerinden geçen levha portu kısa devre eder); saç tokasını düzenlerken bunu gözetin.
- **Bant.** −10 dB bandı %4,5 genişliğindedir; baskı dipollerden dardır. Uzunluk toleransı
  yaklaşık ±%1'dir (`L_de` üzerinde ±2 mm). Örüntünün bandı daha geniştir: ön/arka oranı
  863–870 MHz boyunca 18 dB'nin üzerinde kalır.
- **Kayıplar.** Metal kayıpsızdır (PEC). Alüminyum 867 MHz'de verimde yüzde birkaç ondalık puan kaybettirir.
- **Çevre.** Antenin önünde birkaç dalga boyu içindeki binalar, araçlar ve insanlar örüntüyü
  değiştirir, sinyali yansıtır. Anteni yüksek ve çevresi açık bir yere monte edin.
