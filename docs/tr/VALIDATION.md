# Doğrulama

Bu sayfa Fairbeam/openEMS sonuçlarını kapalı biçimli teoriyle (analitik sonuçlarla) karşılaştırır. Yakınsamış değerlere ulaşmak için gereken mesh ve çözücü ayarlarını da kaydeder. Buradaki tüm çalıştırmalar, gösterilen komutlarla tekrarlanabilir. Galeri çalışmalarının çalışma dosyaları (`fairbeam.study/1`, [STUDIES.md](STUDIES.md) belgesine bakın) ve üye paketleri `public/projects/studies/` içinde kayıtlıdır. Bölüm 18'deki odaklı karşılaştırmanın ayrı bir sayısal kaydı vardır; ham simülasyon çıktıları depoya eklenmemiştir.

**Özet**

| Denetim | Sonuç |
| --- | --- |
| İndüklenmiş EMK yöntemine karşı yarım dalga dipol rezonansı | Üç uzunlukta FDTD, kapalı biçimli rezonansın %1,3–1,4 altında (yöntemin rezonans uzunluğu doğruluğu yaklaşık %1–2) |
| Rezonansta dipol giriş direnci | 72,2–73,1 Ω (ders kitabındaki 73 Ω, sonsuz incelikte λ/2 değeridir) |
| Dipol Dmax | 2,13–2,17 dBi (teori: L = 0,47 λ için 2,11 dBi, λ/2 için 2,15 dBi) |
| Dipol ışıma verimliliği (PEC, kayıpsız) | Yakınsamış mesh'te 0,998–0,9996 |
| İletim hattı modeline karşı yama rezonansı | Yakınsamış FDTD 2,455 GHz, model 2,513 GHz (−%2,3) |
| Yama Dmax | 6,79–6,81 dBi, tipik 6–8 dBi |
| Yama verimliliği (tan δ = 0,001) | 0,95–0,965; 1 − Q/Q_d ≈ 0,953 ile tutarlı |
| Yarı uzay ayna düzeltmesi | Sierpinski modelinde ışıma verimliliği 0,985–0,995; düzeltme olmadan yaklaşık 1,99 olurdu |
| 50 Ω mikroşerit hat (iki portlu) | Varsayılan mesh'te Z0 48,3 Ω; ≈ 49,3 Ω'a yakınsar (Hammerstad: 50,0 Ω); ε_eff 2,68'e karşı 2,75 (+%2,7); 6 GHz'e kadar \|S11\| ≤ −22 dB; dielektrik kaybı sabit iletkenlik modeliyle uyuşur |
| Wilkinson bölücü, 2,4 GHz | Ders kitabındaki 100 Ω dirençle S21 = S31 = −3,09 dB, S11 −24 dB, S23 −22 dB; ancak S22 = S33 yalnızca −18,4 dB. 70 Ω dirençle tüm yansımalar ve yalıtım −25 dB altındadır. Direnç düzenekleri denenen aralıkta %0,1 içinde uyuşur (eleman üzerinde doğrudan simülasyonla elde edilmiştir); neden henüz bilinmemektedir (bölüm 8) |
| openEMS toplu direnci | Eleman üzerinde simüle edildiğinde, denenen değer, mesh ve caps seçeneklerinde 0,5–6 GHz arasında gerçek kısım hatası <%0,1 ([openems-lumped-resistor.md](openems-lumped-resistor.md)) |
| Dizi süperpozisyonu | `fairbeam.array.combine` üzerinden tek uyarılan eleman, openEMS gerçekleşen kazancını (6,019 dBi) ve örüntü Dmax değerini tam yeniden üretir; 2×1 yama kuplajı S21 −17,3 dB |
| Otomatik mesh | Yakınsamış elle oluşturulan mesh rezonanslarına göre dipol −%0,07, yama −%0,10; benzer veya daha az hücreyle ([MESHING.md](MESHING.md)) |
| Dal hatlı kuplör, 2,4 GHz | 2,4 GHz'de S21 −3,21 / S31 −2,99 dB, 90,0°, S11 −34 dB, S41 −35 dB (kollar %3,5 ayarlanmış; ders kitabı uzunluklarında merkez %3,8 yüksek) |
| Kademeli empedanslı alçak geçiren filtre | Chebyshev geçirme bandı (0,42 dB dalgalanma) yeniden üretilir; −3 dB kesim frekansı 2,36 GHz; ideal hat 2,49 GHz, toplu eleman prototipi 2,65 GHz (basamak süreksizlikleri ve 1 rad'a varan βl) |
| Dalga kılavuzu portu (WR-90 geçiş kılavuzu) | 8–12 GHz boyunca \|S11\| < −40 dB, \|S21\| = 0 ± 0,004 dB; β, teorinin %0,2'si içinde |
| Odaklı WR-90 iletim karşılaştırması | 30/40/50 hücre/λ mesh'lerinde karmaşık S21 ve 10 GHz fazı, ilan edilen hedefi ve iki mesh adımı toleransını sağlar; en ince mesh'te 8,2–11,8 GHz boyunca en yüksek \|ΔS21\| 0,00632, faz hatası −0,137°. Kapsam ve tekrarlama bölüm 18'de |
| Piramit huni, 10 GHz, WR-90 portu | 8 / 10 / 12 GHz'de D = 14,73 / 15,52 / 15,70 dBi; faz hatalı açıklık modelinde 14,38 / 15,39 / 15,85 dBi (Balanis denklem 13-54); E/H düzlemi HPBW aynı modelin 1,2° / 1,8° içinde; 8–12 GHz boyunca S11 ≤ −16,6 dB |
| Eksenel mod helis, 2,4 GHz | RHCP, D = 11,6 dBi (Kraus 13,85 dBi; yüksek tahmin verdiği bilinir), eksende AR 0,9 dB (Kraus 0,6 dB), HPBW 42–45° (Kraus 41°), 2,0–2,9 GHz boyunca ortalama R_in 164 Ω (Kraus 140 Ω; ince telde mesh'e bağlı) |
| Düzlem dalga malzeme hücresi, dielektrik tabaka (ε_r 4, 10 mm, 1–10 GHz) | 20 hücre/λ'da karmaşık S11 ve S21, transfer matrisi tabakasının 0,006 / 0,009 içinde (40'ta 0,005 / 0,003); \|S21\| 0,03 dB ve 0,5° içinde; kayıpsız güç dengesi %0,7 içinde; tan δ = 0,05 ile de aynı |
| Dispersif tabakalar (Debye, Lorentz, Drude, Djordjevic-Sarkar FR4) | 20 hücre/λ'da S11, S21 frekansa bağlı analitik tabakanın 0,007–0,031 içinde; mesh inceldikçe azalır. 40 hücre/λ'da NRW/NIST, ε(f)'yi %1 (Debye), %5 (Lorentz), %8 (Drude, ε′ sıfırdan geçerken) ve %0,3 (NIST, FR4 laminat; 1–10 GHz boyunca tan δ 0,019–0,023) içinde geri çıkarır. openEMS 0.37.0rc3 DebyeMaterial, 1B'de ΣΔε/ε∞ ≈ 0,6; 3B'de ≈ 0,3 üzerinde ıraksar (PML olmadan da); bu nedenle Debye kutupları ve laminatlar, uydurulmuş Lorentz kutuplarıyla çalıştırılır |
| Tabaka hücresinden malzeme çıkarımı (NRW, NIST) | NIST: tüm bantta εr′ %0,4, tan δ 0,0023 içinde (verilen 0,05 için f_ref'te tan δ 0,0508); NRW: güvenilir frekanslarında εr′, μr′ yaklaşık %1 içinde, manyetik tabakanın μr 2 değeri geri çıkarılır; yarım dalga rezonansından uzakta NRW tan δ 0,02 içinde (20 hücre/λ) |
| Dalga kılavuzu malzeme düzeneği, WR-90 (8,2–12,4 GHz, 10 mm numune) | εr 4 için 20 hücre/λ'da S11 ve S21 kılavuzlu transfer matrisi tabakasının 0,011 / 0,009 içinde (30'da 0,005 / 0,005); boş kılavuz \|S11\| ≤ −42,8 dB; NIST εr′ %0,48 (%0,24) içinde, verilen 0,02 için tan δ 0,0206 (0,0204); NRW εr′, μr′ %1,4 (%0,7) içinde, μr 2 geri çıkarılır |
| WR-90 düzeneğinde hava aralığı (εr 4, tan δ 0,02) | Her iki geniş duvarda 0,025 / 0,2 mm aralık, görünen εr′ değerini %1,3 / %8,9 düşürür; enine rezonans düzeltmesi (TN 1355-R C.1) bunu +%0,15 / +%0,44'e getirir (30 hücre/λ; yarı statik kapasitör modeli: +%0,18 / +%2,2); dar duvarlarda 0,5 mm'ye kadar aralık <%0,1 değiştirir |

Doğruluğu en çok etkileyen unsur genel hücre boyutu değildir. Metal kenarların ve sıfır kalınlıklı levhaların mesh'i, emici sınır ve enerji durdurma ölçütü daha önemlidir. Önerilen ayarlar bölüm 5'tedir.

## Kullanılan çözücü ayarları

Aksi belirtilmedikçe doğrulama çalıştırmalarında her Nyquist periyodunda tam değerlendirilen **−60 dB** durdurma ölçütü (`--end-db -60 --exact`, openEMS `--exact-endcriteria`), 4 iş parçacığı, 801 frekans noktası ve DC içermeyen Gauss türevi uyarım kullanılır. Varsayılan olarak openEMS durdurma ölçütünü yalnızca ilerleme yazdırırken, yaklaşık her 4 s duvar saati süresinde kontrol eder. Kısa çalıştırmalar bu nedenle ölçütü sisteme bağlı bir miktar aşar; süreleri yaklaşık 4 s'nin katıdır.

### Durdurma ölçütü (yama, entegrasyon ölçümü)

mesh_div 20 ile `python/models/patch_antenna.py`. Tam durdurma ölçütlü CPU çalıştırması ile openEMS'in Metal GPU derlemesindeki sonuçlar aynıydı:

| Durdurma ölçütü | Zaman adımları | S11 min | Dmax (dBi) | Işıma verimliliği |
| --- | --- | --- | --- | --- |
| −40 dB | 8162 | −24,0 dB @ 2,435 GHz | 6,804 | 0,856 |
| −50 dB | 10626 | −30,9 dB @ 2,4325 GHz | 6,807 | 0,925 |
| −60 dB | 13860 | −37,3 dB @ 2,4325 GHz | 6,809 | 0,955 |
| −70 dB | 16170 | −38,9 dB @ 2,4325 GHz | 6,809 | 0,961 |

Rezonans frekansı ve Dmax, −40 dB'de zaten yakınsamıştır; S11 derinliği ve ışıma verimliliği yakınsamamıştır. Verimlilik Prad / P_acc'dir; henüz ışımamış sönümlenme enerjisi P_acc'yi bozar. S11 derinliği, verimlilik ve kazanç için **≤ −60 dB** kullanın. Dağıtılan `patch_antenna.py`, `dipole.py` ve yeni modeller `end_criteria_db=-60` ayarlar. Düşük Q'lu dipol durdurma ölçütüne duyarsızdır: −40 dB (tam olmayan) ve −60 dB (tam) çalıştırmalarının rezonansları %0,01 içinde aynı çıkmıştır.

## 1. Yarım dalga dipol

Model: `python/models/dipole.py`. y = 0 düzleminde 1 mm genişliğinde, sıfır kalınlıklı, 58 mm uzunluğunda PEC şerit; merkezde 1 mm aralık ve 73 Ω ayrık port. PML_8 sınırlarıyla serbest uzaydadır; varsayılan olarak PML içinde en az λ(f_min)/4 serbest uzay bulunur. w genişliğinde düz şerit, elektriksel olarak a = w/4 = 0,25 mm yarıçaplı yuvarlak tele eşdeğerdir (Balanis, *Antenna Theory*, bölüm 9.7).

İkisi de `fairbeam/analytic.py` içinde bulunan referanslar:

- **İndüklenmiş EMK yöntemi** (`dipole_impedance`, Balanis denklemler 8-60a/8-61a). Sinüzoidal akım varsayar. İnce tel limitinde doğrudur (λ/2'de 73,08 + j42,51 Ω, birim testle kontrol edilir); ancak sonlu yarıçapta rezonans yakınındaki R'yi düşük tahmin eder. Rezonans uzunluğu doğruluğu yaklaşık %1–2'dir.
- Aynı elektriksel uzunluktaki sinüzoidal akımlı dipolün **yönlülüğü** (`dipole_directivity`).

### 1a. Uzunluğa göre rezonans

`fairbeam sweep python/models/dipole.py --param length=50,58,66 --set f_min=1.4 --set f_max=3.8 --end-db -60 --exact --threads 4`
(3,8 GHz'e göre mesh_div 20, en büyük hücre 3,9 mm). “Rezonans”, X_in'in artarak sıfırdan geçtiği noktadır; port empedansına bağlı değildir.

| L (mm) | FDTD f_r (GHz) | L/λ | FDTD R_in (Ω) | İndüklenmiş EMK f_r (GHz), R (Ω) | FDTD / indüklenmiş EMK farkı |
| --- | --- | --- | --- | --- | --- |
| 50 | 2,7934 | 0,4659 | 73,1 | 2,8345; 62,2 | −1,4 % |
| 58 | 2,4153 | 0,4673 | 72,8 | 2,4485; 62,6 | −1,4 % |
| 66 | 2,1278 | 0,4684 | 72,6 | 2,1552; 62,8 | −1,3 % |

| L (mm) | Dmax openEMS (dBi) | Örüntüden Dmax (dBi) | Teori (dBi) | Işıma verimliliği |
| --- | --- | --- | --- | --- |
| 50 | 2,131 | 2,134 | 2,106 | 0,9985 |
| 58 | 2,145 | 2,138 | 2,108 | 0,9989 |
| 66 | 2,153 | 2,144 | 2,109 | 0,9991 |

FDTD rezonansı beklendiği gibi 1/L ile ölçeklenir (f_r·L, %0,6 içinde sabittir). İndüklenmiş EMK değerinin %1,3–1,4 altındadır; bu, yöntemin rezonans uzunluğu için belirtilen %1–2 doğruluğu içindedir (sinüzoidal akım varsayar ve gerçek 1 mm aralıklı şeridi modellemez). FDTD giriş direnci (72,6–73,1 Ω), ince λ/2 dipolün ders kitabındaki 73 Ω değerine yakındır; indüklenmiş EMK yöntemi ise sonlu yarıçapta rezonans yakınındaki R'yi düşük tahmin eder. Dmax, sinüzoidal akım değerinden 0,02–0,05 dB yüksektir; sonlu yarıçaplı dipolde beklenen yön budur. Verimlilik %0,2 içinde 1'dir.

### 1b. Mesh yakınsaması

`fairbeam converge python/models/dipole.py --set pad=80 --param mesh_div=10,15,20,30,40 --end-db -60 --exact --threads 4`
(en büyük hücre = λ(3,5 GHz) / mesh_div).

| mesh_div | En büyük hücre (mm) | f_r'de hücre/λ | Hücre | X = 0 noktasında f_r (GHz) | Δ (en ince mesh ile) | R_in (Ω) | Dmax / örüntü Dmax (dBi) | η_rad | Duvar saati süresi (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 8,57 | 14,5 | 71 632 | 2,3934 | −1,09 % | 74,7 | 2,169 / 2,154 | 0,991 | 10,7 |
| 15 | 5,71 | 21,8 | 95 220 | 2,4096 | −0,42 % | 73,3 | 2,167 / 2,151 | 0,997 | 9,7 |
| 20 | 4,28 | 29,0 | 166 212 | 2,4147 | −0,21 % | 72,7 | 2,163 / 2,144 | 0,999 | 13,6 |
| 30 | 2,86 | 43,3 | 406 700 | 2,4186 | −0,05 % | 72,4 | 2,135 / 2,134 | 0,9995 | 20,3 |
| 40 | 2,14 | 57,9 | 809 776 | 2,4198 | 0 | 72,2 | 2,133 / 2,135 | 0,9996 | 35,1 |

Şerit yakınındaki mesh, en büyük hücreden daha incedir: şerit eninde ve ona normal doğrultuda 0,25 mm, kol uçlarında λ/40. Varsayılan mesh (mesh_div 20), en ince mesh'in %0,2'si içindedir.

### 1c. Önemli olan: mesh oluşturma tekniği (mesh_div 20)

Bu çalıştırmalar, düşük Q'lu bu antende sorun yaratmayan −40 dB tam olmayan durdurmayı kullanmıştır.

| Kurulum | X = 0 noktasında f_r (GHz) | Δ (yakınsamış 2,420 ile) | Dmax openEMS / örüntü (dBi) |
| --- | --- | --- | --- |
| MUR, 50 mm pay, kol uçlarında mesh çizgisi, şeride normal doğrultuda kaba mesh | 2,2252 | −8,0 % | 2,10 / 2,14 |
| + kol uçlarında üçte bir kuralı | 2,3257 | −3,9 % | 2,01 / 2,14 |
| + MUR yerine PML_8 (60 mm) | 2,3655 | −2,2 % | 2,135 / 2,142 |
| + şeride normal doğrultuda ince mesh (varsayılan model) | 2,4184 | −0,1 % | 2,14 / 2,143 |

- **Mesh çizgisine denk gelen metal kenarlar**, levhayı elektriksel olarak yaklaşık yarım hücre uzun gösterir (alan tekilliği). İlk satır, varsayılan hücre boyutunda %8 düşüktür ve yavaş yakınsar (mesh_div 10 / 20 / 40'ta 2,105 / 2,225 / 2,306 GHz). openEMS'in “üçte bir kuralı”, her kenarın 1/3 içinde ve 2/3 dışında çizgiler yerleştirerek bu sapmanın çoğunu giderir.
- **Sıfır kalınlıklı levhanın normal doğrultusunda ince mesh gerekir.** 1 mm şerit çevresindeki y hücreleri 4,3 mm olduğunda şerit çok daha kalın iletken gibi davranır; düzlem içi çözünürlük ne olursa olsun rezonansı yaklaşık %2 düşük olur.
- **Yaklaşık λ/2 uzaklıktaki MUR sınırları, rezonansı %1–1,5 ve Dmax'ı ±0,15 dB kaydıracak kadar yansıtır.** 50 / 100 / 150 mm paylarla rezonans 2,3257 / 2,3522 / 2,3687 GHz, openEMS Dmax değeri 2,01 / 2,27 / 2,13 dBi olmuştur. 60 / 100 mm'de PML_8 ile: 2,3657 / 2,3630 GHz ve 2,136 / 2,128 dBi. Örüntü integraliyle hesaplanan Dmax (`dmax_pattern_dbi`) tüm durumlarda 2,14–2,18 dBi içinde kalmıştır. İki Dmax değeri arasındaki fark, yararlı bir yansıma uyarısıdır.

## 2. Dikdörtgen yama

Model: openEMS “Simple Patch Antenna” eğitiminden uyarlanan `python/models/patch_antenna.py`. Yama, ε_r 3,38 ve tan δ 0,001 olan 60 × 60 mm, 1,524 mm kalınlıklı alttaş üzerinde 32 mm (rezonans doğrultusu, x) × 40 mm (y) boyutundadır. x = −6 mm'de 50 Ω ayrık portla sonda beslemelidir; yaklaşık 0,7 λ uzakta MUR sınırları kullanır.

**İletim hattı modeli** (`analytic.patch_resonance`, Balanis bölüm 14.2; Hammerstad):

- ε_eff = (ε_r + 1)/2 + (ε_r − 1)/2 · (1 + 12 h/W)^(−1/2) = **3,176**
- ΔL = 0,412 h (ε_eff + 0,3)(W/h + 0,264) / ((ε_eff − 0,258)(W/h + 0,8)) = her kenarda **0,733 mm**
- f_r = c0 / (2 (L + 2ΔL) √ε_eff) = **2,513 GHz**. Saçaklanmasız ideal kavite, c0 / (2L√ε_r), 2,548 GHz verir.

Varsayımlar: sonsuz toprak düzlemi ve alttaş, yarı statik ε_eff, h ≪ λ; sonda yüklemesi ve yüzey dalgaları yok. Tipik doğruluk %1–3'tür.

`fairbeam converge python/models/patch_antenna.py --param mesh_div=15,20,30,40 --end-db -60 --exact --threads 4`
(en büyük hücre λ(3 GHz)/mesh_div; `AddEdges2Grid`, yama kenarlarında bu hücre boyutunun yarısıyla üçte bir kuralı çizgileri yerleştirir; alttaş boyunca 4 hücre; frekans adımı 2,5 MHz = %0,1):

| mesh_div | En büyük hücre (mm) | Hücre | S11 minimumunda f_r (GHz) | Δ (iletim hattı modeliyle) | S11 min (dB) | Dmax / örüntü Dmax (dBi) | η_rad | Duvar saati süresi (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 15 | 6,66 | 50 544 | 2,4100 | −4,1 % | −37,2 | 6,799 / 6,812 | 0,948 | 6,4 |
| 20 | 5,00 | 97 152 | 2,4325 | −3,2 % | −37,3 | 6,809 / 6,827 | 0,955 | 7,5 |
| 30 | 3,33 | 263 568 | 2,4525 | −2,4 % | −36,0 | 6,788 / 6,813 | 0,949 | 11,1 |
| 40 | 2,50 | 535 920 | 2,4550 | −2,3 % | −34,5 | 6,786 / 6,814 | 0,953 | 13,2 |

mesh_div 30'da alttaş boyunca 4 yerine 8 hücre kullanılması aynı rezonansı (2,4525 GHz) ve Dmax'ı (6,786 dBi) vermiştir. Yalnızca S11 derinliği −41,2 dB'ye değişmiştir.

Bunlar global mesh gözlemleridir; besleme empedansının yakınsadığını kanıtlamaz. Sabit dış
bölgede, −60 dB enerji sönümü ve 50 kHz frekans örneklemesiyle yapılan ayrı bir yerel besleme
inceltmesinde son adım S11 minimum frekansını yalnızca %0,055, derinliğini ise 3,59 dB değiştirdi.
Varsayılan ideal çizgi kaynak için port çözünürlüğü ayrıca denetlenmelidir; frekans kararlılığı
tek başına yeterli değildir. İsteğe bağlı sonlu ayak izi modeli ve tekrarlanabilir kontroller
[STUDIES.md](STUDIES.md#separate-feed-refinement-from-the-global-mesh) içinde açıklanır.

- Rezonans **2,455 GHz'e, iletim hattı tahmininin %2,3 altına** yakınsar. Bu, modelin belirtilen doğruluğu içindedir ve olağan yöndedir: basit model, sonda endüktansını, sonlu 60 mm toprak düzlemini ve dispersiyonu ihmal eder. Eski varsayılan (mesh_div 20) %0,9 düşük okuyordu. Modelin varsayılanı artık mesh_div 30'dur (mesh_div 40'tan %0,1 fark, 11 s).
- mesh_div 30'da kenar hücresi 1,7 mm, yani yaklaşık alttaş yüksekliğidir. Mikroşeritte ışıyan kenarlardaki hücreyi ≲ h tutun.
- **Dmax 6,79–6,81 dBi**, ince ve düşük ε değerli alttaş üzerindeki yama için olağan 6–8 dBi aralığındadır.
- **Işıma verimliliği 0,95–0,965**, yalnızca dielektrik kaybıyla tutarlıdır (metal PEC). −10 dB bant genişliği (2,433–2,470 GHz, %1,5), Q ≈ 1/(√2 · 0,015) ≈ 47 verir; η ≈ 1 − Q/Q_d = 1 − 47 · tan δ ≈ 0,953.

### 2b. FR4 üzerinde içten beslemeli yama (`python/models/inset_patch.py`)

Tasarım, 1,6 mm FR4 üzerinde (ε_r 4,4, tan δ 0,02) 2,40 GHz için ders kitabı tasarımıdır; `fairbeam.analytic` ile hesaplanır: W = 38,0 mm, L = 29,4 mm (iletim hattı modeli). Girinti derinliği y0 = 9,0 mm'dir (Ramesh & Yip FR4 uydurması; Balanis yarık iletkenlikleriyle cos² formülü, `inset_depth`, 10,9 mm verir). 50 Ω hat 3,08 mm genişliğindedir (`microstrip_width`); yarıklar 1 mm'dir. PML_8 sınırlarıyla, kart kenarındaki hat ucunda bir ayrık port bulunur.

| Kurulum | S11 minimumunda f (GHz) | S11 min (dB) | Dmax (dBi) | η_rad | Duvar saati süresi (s) |
| --- | --- | --- | --- | --- | --- |
| Varsayılan: mesh_div 20, yarık başına 1 hücre, alttaşta 3 hücre | 2,401 | −15,6 | 6,63 | 0,465 | 9,6 |
| İnce: mesh_div 30, yarık başına 2 hücre, alttaşta 4 hücre | 2,396 | −21,3 | 6,61 | 0,469 | 27,2 |
| İletim hattı modeli | 2,400 | | | | |

- Rezonans tasarım frekansının %0,2'si içindedir; iki mesh arasındaki fark da %0,2 içindedir. Sonda beslemeli yamanın aksine uzunluk düzeltmesi gerekmemiştir. Girinti ve besleme hattı, rezonansı bölüm 2'deki FDTD sapmasının düşürdüğü kadar yukarı kaydırır. Bunu iletim hattı modelinin tam doğru olduğu şeklinde yorumlamayın.
- **Uyum derinliği, girinti yarıklarının çözünürlüğüne bağlıdır** (−15,6 ve −21,3 dB). Uyum önemliyse yarıkları ≥ 2 hücreyle çözün (`--set slot_cells=2`).
- η ≈ 0,47, ince yamada FR4'ün etkisidir. −10 dB bant genişliğinden Q ≈ 1/(√2 · 0,028) ≈ 25, dolayısıyla 1 − Q·tan δ ≈ 0,5 bulunur. Kazanç bu nedenle ≈ 3,3 dBi'dir.

### 2c. Minkowski fraktal yaması (`python/models/minkowski_patch.py`)

Yama, 1,524 mm kalınlığında ε_r 3,38 alttaş üzerinde 30 mm kare dış boyuta ve 0,5 derinlik oranına sahiptir; x = −5 mm'de sonda beslemelidir, PML_8 kullanır. Çalışma: `fairbeam sweep python/models/minkowski_patch.py --param iterations=0,1,2 --exact --set boundary=PML_8`
(`public/projects/studies/minkowski-iterations.json`; varsayılan MUR ve feed_x = −3,5 mm eklenmeden önce çalıştırılmıştır).

| Yineleme | Çevre (mm) | Alan (mm²) | S11 minimumunda f (GHz) | Kareye göre kayma | Dmax (dBi) | η_rad |
| --- | --- | --- | --- | --- | --- | --- |
| 0 (kare) | 120 | 900 | 2,558 | | 6,85 | 0,876 |
| 1 | 160 | 700 | 2,326 | −9,1 % | 6,64 | 0,794 |
| 2 | 213 | 622 | 2,278 | −10,9 % | 6,60 | 0,772 |

- Kaymanın çoğu ilk yinelemede oluşur; ikinci yinelemenin katkısı azdır. Yama elektriksel olarak küçüldükçe yönlülük ve verimlilik biraz düşer.
- Kare (yineleme 0), iletim hattı tahmininin (2,694 GHz) **%5,0 altında** rezonansa girer. Bu, sonda beslemeli yama sapmasının iki katıdır; çünkü model mesh çizgilerini metal kenarların **üzerine** yerleştirir (üçte bir kuralı yoktur; girintiler bunun için fazla yakındır). Bölüm 1c'deki gibi bu kenarlar, her uçta yaklaşık yarım hücre (0,6 mm) elektriksel uzama gösterir. Mutlak frekansları vermeden önce `fairbeam converge ... --param cell=1.25,0.9,0.6` çalıştırın. Yinelemeler arasındaki bağıl kayma daha az duyarlıdır.
- Dağıtılan varsayılan MUR sınırlarını kullanır (46 s yerine 16 s). PML_8'e göre yineleme 1'de frekans %0,1, Dmax 0,12 dB değişmiştir. Referans sonuçlar için `--set boundary=PML_8` kullanın.

## 3. Sierpinski üçgen monopolü (kayıtlı sonuçlar, yeniden çalıştırılmadı)

Paket: `public/projects/sierpinski-monopole--iterations-3.json`. 3 yinelemeli, 48 mm yüksekliğinde, 60° açılıdır; sonsuz PEC toprak düzlemi üzerinde durur (PEC sınırı, görüntü teorisi). Üçgendeki hücre boyutu 0,8 mm'dir (1,96 M hücre). Çalıştırma −40 dB tam olmayan durdurma kullanmış, −52,9 dB'ye kadar aşmıştır. Model, alt üçgenlerin temas ettiği noktalarda basamaklı mesh'in gerektirdiği 1,2 mm bağlantı köprüleri bulunan, serbest duran PEC levhadır.

- Ayna düzeltmesi doğrulanır. Üç örüntü frekansında ışıma verimliliği, 2^m düzeltmesiyle (m = 1) 0,994 / 0,985 / 0,988'dir; düzeltmesiz yaklaşık 1,98 olurdu. openEMS Dmax ile örüntü integrali Dmax, 0,07 dB içinde uyuşur (9,26 / 9,33; 11,14 / 11,15; 13,38 / 13,36 dBi).
- Daha ince mesh'te yeniden çalıştırılmamıştır (zaten 1,96 M hücre); bu nedenle burada bant konumlarına ilişkin iddia yoktur.

## 3b. Yüzey akımı (nitel denetim)

Komut: `fairbeam run python/models/patch_antenna.py --fields`. Kayıtlı `patch-antenna.json`, 2,453 GHz rezonansına en yakın alan kaydı olan 2,457 GHz'deki haritaları içerir. Kaydedilen büyüklük, levha düzleminde openEMS rot(H) çıktısından elde edilen |J_s|'dir. Tanım için [BUNDLE.md](BUNDLE.md#fields) belgesine bakın. Harita beklenen TM10 biçimindedir:

- Rezonans boyutu (x) boyunca akım yarım sinüstür. x = −16 mm ışıyan kenarda tepe değerin 0,06'sı, merkezde 0,69'u, x = +16 mm'de 0,055'idir; sonda çevresinde (x ≈ −8 ile −5 mm) düzleşmiş bölüm vardır.
- Yama eninde (y) yaklaşık düzgündür (0,69–0,72). Işımayan y = ±20 mm kenarlarının en dış hücresinde 0,76–1,0'a yükselir; bu, bir hücreye yayılmış kenar tekilliğidir. Genel maksimum y = −19,2 mm'dedir.
- Toprak düzlemindeki görüntü akımı yamanın altında yoğunlaşır ve kart kenarlarında < 0,05'e düşer.

Karşılaştırma yalnızca niteldir: kenar tepesi mesh'e bağlıdır. Haritalar mutlak A/m değerini değil, akım dağılımının biçimini gösterir.

## 4. Mesh yakınsaması özeti

| Anten | Varsayılan mesh rezonansının yakınsamış değerden farkı | Tüm mesh'lerde Dmax aralığı | Varsayılan |
| --- | --- | --- | --- |
| Dipol (şerit, PML) | −0,2 % (mesh_div 20) | 0,04 dB | mesh_div 20, üçte bir kuralı, normal doğrultuda ince mesh |
| Yama (sonda beslemeli) | −0,1 % (mesh_div 30) | 0,02 dB | mesh_div 30 (önceden 20: −0,9 %) |

Yönlülük, rezonans frekansından çok daha hızlı yakınsar. İkisi de aşağıdan yakınsar: kaba basamaklı mesh, metali elektriksel olarak büyük gösterir.

## 5. Önerilen ayarlar

1. **En büyük hücre:** en yoğun dielektrikte f_max'ta λ/20 (yama: ε_r 3,38 ile λ0/30). **Metal kenarlardaki hücreler** en fazla alttaş yüksekliği kadar olmalı; üçte bir kuralı uygulanmalıdır (`AddEdges2Grid(..., metal_edge_res=...)` veya açıkça 1/3 içeride, 2/3 dışarıda çizgiler).
2. **Sıfır kalınlıklı levhalar:** levha yakınında levhaya normal doğrultudaki mesh'i en dar özelliğin (şerit veya yarık genişliği) ölçeğine kadar inceltin.
3. **Sınırlar:** uzak alanın önemli olduğu durumlarda PML içinde ≥ λ(f_min)/4 serbest uzayla PML_8 kullanın. MUR, ≥ λ/2 gerektirir ve yine de Dmax'ta ±0,15 dB sapma oluşturur. PEC/PMC sınırlarını gerçek simetri ve toprak düzlemleri için kullanın.
4. **Durdurma ölçütü:** S11 derinliği, verimlilik ve kazanç için tam durdurma değerlendirmesiyle −60 dB. −40 dB yalnızca rezonans frekansı ve örüntü biçimi için yeterlidir.
5. **Her zaman inceltme çalıştırın:** `fairbeam converge <model> --param <mesh param>=coarse,...,fine`. Son adım ilk rezonansı <%0,5, Dmax'ı <0,1 dB değiştiriyorsa kabul edin.
6. **`dmax_dbi` ile `dmax_pattern_dbi` değerlerini karşılaştırın.** Yaklaşık 0,1 dB'den büyük fark, sınır yansımalarına veya kesilmiş/kaba NF2FF yüzeyine işaret eder.

## 6. Sonuçları okuma notları

- **S-parametreleri:** S11, genellikle 50 Ω olan port empedansına göre raporlanır. Dipol modeli 73 Ω port kullanır. `fairbeam touchstone <bundle>`, Zin üzerinden tam yeniden normalleştirilmiş 50 Ω `.s1p` yazar. Port referansına bağlı olmayan **rezonansı (X_in = 0) ve Zin'i** karşılaştırın.
- **Yönlülük:** `dmax_pattern_dbi`, uzak alan örüntüsünün integralinden elde edilen yönlülüktür. IEEE kazancı `gain_dbi`, gerçekleşen kazanç `realized_gain_dbi` değerine karşılık gelir.
- **Kayıp:** openEMS, tan δ'yı yalnızca `tan_d_freq` noktasında (bant merkezi) doğru olan sabit iletkenlikle modeller. Sabit kayıp tanjantından fark merkez yakınında küçüktür, bant uçlarına doğru artar.
- **Portlar:** Fairbeam besleme aralığı boyunca ayrık portlar kullanır. Mikroşerit hattaki dalga kılavuzu portu, hat ucundaki ayrık porta eşdeğer değildir.
- **Çok portlu yapı:** `fairbeam touchstone <bundle>`, `.s2p`/`.s3p` dosyaları yazar (v1, 50 Ω).
- **Dalga kılavuzu portları** (huni, bölüm 13): S11 modun dalga empedansına normalleştirilir; `fairbeam touchstone`, dalga kılavuzu portlarını yeniden normalleştirmez.
- **Dairesel polarizasyon** (helis, bölüm 14): örüntü CSV'si RHCP/LHCP yönlülüğünü ve eksenel oranı içerir (IEEE kabulü). Helis teli openEMS'te sıfır yarıçaplı eğridir; dolayısıyla R_in tel yarıçapına bağlıdır (bölüm 14).

## 7. Mikroşerit hat (iki portlu referans)

Model: `python/models/microstrip_line.py`. 0,813 mm kalınlık, ε_r 3,38, tan δ 0,0027 ile 40 mm hat; Hammerstad 50 Ω genişliği 1,898 mm. Kartın iki kenarında düşey 50 Ω ayrık portlar ve MUR sınırları vardır. GPU motorunda −60 dB ile port başına bir olmak üzere iki çalıştırma yapılır; her biri bir saniyeden kısadır.

Çıkarım (`fairbeam.analytic`):

- `line_from_s2p`: iki portlu yapının ABCD matrisi Z0 = sqrt(B/C) verir; S21'in açılmış fazı ε_eff'yi verir.
- `line_z0_estimate`, hattın çeyrek dalga noktalarında Z0'ın medyanını alır. Yarım dalga noktalarının yakınında B ve C sıfıra gider; port geçiş parazitleri sqrt(B/C)'ye baskın olur.

`fairbeam run python/models/microstrip_line.py --engine gpu --set strip_cells=N --set sub_cells=N`:

| Şerit ve alttaş boyunca hücre | Hücre | Z0 (Ω) | ε_eff (1-2 GHz) | max \|S11\| 0,5-6 GHz | Karşılıklılık |
| --- | --- | --- | --- | --- | --- |
| 2 | 15 360 | 43,7 | 2,772 | −16,2 dB | 1.2e-3 |
| 4 | 26 400 | 46,6 | 2,756 | −20,0 dB | 9.4e-4 |
| **8 (varsayılan)** | 49 600 | **48,3** | **2,750** | **−22,4 dB** | 7.9e-4 |
| 12 | 69 920 | 48,8 | 2,749 | −22,8 dB | 7.5e-4 |
| Hammerstad (yarı statik) | | 50,0 | 2,670 | | |
| Hammerstad-Jensen 1980 | | 49,8 | 2,677 | | |

- Z0 aşağıdan yakınsar. Adımlar (2,9; 1,6; 0,5 Ω), kapalı biçimli değerin %1,5'i içinde olan yaklaşık 49,3 Ω'a ekstrapole edilir. Kaba mesh'li şerit daha geniş görünür (daha düşük Z0); dipoldekiyle aynı kenar sapmasıdır.
- ε_eff, yarı statik formülün %2,7 üzerinde yerleşir. h = 0,8 mm için 1–2 GHz'de dispersiyon yalnızca yaklaşık %0,5 ekler; yaklaşık %2, alttaştaki basamak/mesh sapmasıdır. Faz hızı bu nedenle yaklaşık %1,3 düşüktür. Yama rezonansını tahminin %2,3 altına getiren işaret de budur.
- |S21|, 1 GHz'de −0,054 dB, 2,4 GHz'de −0,067 dB'dir (karşılıklılık 8e-4). openEMS, tan δ'yı bant merkezinde (3,25 GHz) ayarlanmış sabit iletkenlikle modeller. 1 GHz'de bu, nominal kayıp tanjantının 3,25 katıdır; mikroşeridin kapalı biçimli dielektrik kaybı (Pozar, *Microwave Engineering*, bölüm 3.8), 40 mm için 0,046 dB, simülasyonda 0,048 dB'dir. Yaklaşık 3 GHz üzerinde sütun gücü, yalnızca dielektrik kaybının öngördüğünden daha fazla düşer (6 GHz'de 0,978); açık kart kenarlarındaki ayrık port geçişleri az miktarda ışıma yapar.
- Kalan |S11| (−22 dB), %3,5 Z0 sapmasından ve port geçişlerinden kaynaklanır. Aynı tür port kullanan aşağıdaki Wilkinson sonuçları için bunu taban seviye olarak dikkate alın.
## 8. Wilkinson güç bölücü

Model: `python/models/wilkinson_divider.py`, aynı alttaş üzerinde 2,4 GHz. Merkez çizgisi boyunca çeyrek dalga uzunluğunda iki 70,7 Ω kol (1,035 mm), kol uçlarında 1,9 mm aralığı birleştiren 100 Ω toplu direnç ve 10 mm besleme hatları üzerinde üç 50 Ω ayrık port içerir. Tüm kenarlar eksenlere paraleldir. Varsayılan mesh: 50 Ω şerit eninde ve alttaş boyunca 6'şar hücre, 106 bin hücre; GPU'da üç çalıştırma 2,6 s.

İdeal teori (Pozar bölüm 7.3): f0'da S21 = S31 = −3,01 dB ve S11 = S22 = S33 = S23 = 0.

| f (GHz) | S11 | S21 = S31 | S22 = S33 | S23 (yalıtım) |
| --- | --- | --- | --- | --- |
| 2,2 | −17,2 | −3,15 | −19,0 | −20,4 |
| 2,3 | −20,2 | −3,11 | −18,8 | −21,5 |
| **2,4** | **−24,2** | **−3,09** | **−18,4** | **−22,0** |
| 2,5 | −27,1 | −3,08 | −17,7 | −21,8 |

- **Güç bölünmesi:** S21 = S31 = −3,09 dB, idealin 0,08 dB altında. Bu, dielektrik kaybı ve az miktarda ışımadır: 1. sütunda gücün %1,4'ü eksiktir; bölünme tam simetriktir. Karşılıklılık 1.5e-3'tür.
- **Giriş uyumu:** S11, 2,3–2,6 GHz arasında −20 dB altındadır; minimumu (−27 dB) 2,49 GHz'dedir. Kol uzunluğu (giriş hattının kenarından çıkış uzantısına merkez çizgisi boyunca çeyrek dalga), tasarım frekansını %4 içinde yeniden üretir.
- **Zayıf nokta çıkış uyumu ve yalıtımdır.** Bunları çift ve tek modlarla yazın: S22 = (Γe + Γo)/2, S23 = (Γe − Γo)/2. 2,4 GHz'de çıkışlarda görülen tek-mod empedansı 50 Ω değil, yaklaşık 34 Ω'dur; direnç taramasında 1/R ile ölçeklenir (Z_odd ≈ 1700 Ω² / (R/2)). Ders kitabındaki R = 100 Ω ile S22 bu nedenle −18 dB'de, S23 −22 dB'de kalır.
- **İnceleme (dört ek çalıştırma).** Sonuç: direnç düğümündeki tek-mod empedansı R/2 = 50 Ω yerine, yaklaşık 62–66 Ω ve neredeyse saf dirençtir.
  - Düğümden her porta çıkış yolu (besleme hattı, kıvrım ve uzantı) 21 mm, yani 2,4 GHz'de yaklaşık λg/4'tür. Bu, 1/R bağıntısını açıklar: Z_seen = Z_line² / Z_node. Bu mesh'in 47,5 Ω hattıyla (bölüm 7), Z_node = 47,5² / 34 ≈ 66 Ω.
  - Her beslemeyi λg/4 uzatmak (`--set feed_len=29`), portun düğümü doğrudan görmesini sağlar: Z_odd = 61,4 − j2,4 Ω. S22 yalnızca dönüşüm değiştiği için −24,8 dB'ye iyileşir.
  - Tek-mod kol uzantısı 2,4 GHz'de açık devredir (|X| > 2 kΩ); eksik iletkenliği sağlayamaz.
  - **Neden direnç değildir (bu, önceki yorumu düzeltir).** Doğrudan elemanda simüle edildiğinde (pasif ayrık portun −U/I değeri), openEMS toplu direncinin gerçek kısmındaki hata 0,5–6 GHz boyunca <%0,1'dir; 30–300 Ω, akım boyunca veya enine 1–8 hücre, `caps` ile veya onsuz aynı sonuç alınır. Kayıplı malzeme bloğu aynı davranır ([openems-lumped-resistor.md](openems-lumped-resistor.md)). Önceki “2,4 GHz'de +%10” yorumu, mikroşerit test hattının farklı mesh'li referans hatla de-embedding işleminden kaynaklanıyordu ve yanlıştı. Wilkinson'un toplu direncini aynı 100 Ω değerinde kayıplı malzeme gövdesiyle değiştirmek aynı tek-mod empedansını verir: 34,1 + j3 Ω'a karşı 34,2 + j3 Ω.
  - Direnç aralığı da neden değildir (0,5 mm'de Z_odd = 32,5 + j10 Ω; 1,9 veya 2 mm ile aynı); mesh yoğunluğu (şerit başına 10 hücre, mesh_div 30), çıkış kıvrımı açıklığı (1–8 mm) ve yan yana çıkış uzantıları da değildir.
  - **Hâlâ açıklanamayan nokta:** bu yerleşimin tek-mod düğüm empedansı yaklaşık 1,25–1,3 × R/2'dir. 70 Ω direnç bunu yaklaşık 50 Ω'a getirir (−42 dB yalıtım). Denenen direnç düzenekleri %0,1 içinde uyuşur; olası açıklamalar arasında düğümdeki yerleşim ve basamaklı FDTD etkileri bulunur. Daha fazla inceleme gereklidir.
  - **Model fiziksel 100 Ω değerini korur.** Hangi nedenin geçerli olduğu henüz bilinmemektedir.
- **Direnç taraması** (`fairbeam sweep python/models/wilkinson_divider.py --param r_iso=60,70,85,100 --engine gpu`, `public/projects/studies/wilkinson-resistor-sweep.json`):

| R_iso | 2,4 GHz'de S22 | 2,4 GHz'de S23 | en iyi S23 | S11, S22, S33, S23'ün tamamı < −20 dB |
| --- | --- | --- | --- | --- |
| 60 Ω | −26,2 dB | −26,4 dB | −26,8 dB @ 2,455 GHz | 2,30-2,67 GHz |
| **70 Ω** | −25,6 dB | **−37,3 dB** | **−41,9 dB** @ 2,444 GHz | 2,30-2,67 GHz |
| 85 Ω | −21,4 dB | −27,9 dB | −28,0 dB @ 2,425 GHz | 2,30-2,56 GHz |
| 100 Ω (ders kitabı, varsayılan) | −18,4 dB | −22,0 dB | −22,0 dB @ 2,414 GHz | yok |

  Teorinin öngördüğü gibi S11, S21 ve S31, R'ye bağlı değildir: çift modda direnç akımı yoktur. Teoriyle karşılaştırmanın görünür kalması için model, ders kitabındaki 100 Ω varsayılanını korur. `--set r_iso=70`, ayarlanmış tasarımdır.

## 9. Diziler

2×1 yama dizisi (`python/models/patch_array_2x1.py`) ve gömülü eleman örüntülerinin birleştirilmesi [ARRAYS.md](ARRAYS.md) belgesinde açıklanır. Doğrulama noktaları:

- `fairbeam.array.combine` üzerinden tek uyarılan eleman, paketin kendi tek portlu uzak alanıyla aynı gerçekleşen kazancı (6,019 dBi) ve örüntü Dmax değerini (6,27 dBi) verir; birim gelen dalga başına normalleştirme doğrudur.
- Düzgün uyarım yönlülüğe 2,9 dB ekler (iki eleman için ideal 3,01 dB). λ/2'de H düzlemi kuplajı S21 = −17,3 dB'dir.
- Görüntüleyicinin TypeScript birleştirmesi (`src/lib/array.ts`), kayıtlı pakette Python değerlerini yeniden üretir (`npm run check:array`): düzgün uyarımda 9,18 dBi, 20° faz dağılımında θ = 15° yönünde hüzme, Γ_active −21,7 dB.

## 10. Otomatik mesh

`Simulation.auto_mesh()` ([MESHING.md](MESHING.md)), yakınsamış elle ayarlanan mesh'lerle karşılaştırılmıştır; GPU motoru, −60 dB: dipol (`--set mesh=auto`, 219 bin hücre) 2,4182 GHz'de rezonansa girer (yakınsamış 2,4198 GHz, −%0,07); R_in 72,5 Ω, Dmax 2,16 dBi. Yama (`--set mesh=auto`, 153 bin hücre) 2,4525 GHz'de rezonansa girer (yakınsamış 2,4550 GHz, −%0,10; elle varsayılan mesh_div 30: 264 bin hücreyle 2,4525 GHz); Dmax 6,89 dBi'dir (elle mesh'ten 0,1 dB yüksek; MUR duvarlarının λ/30 yerine λ/20 hücrelerle buluşmasına bağlanır).

Bölünmüş aralıkların yanındaki kademelendirme düzeltmesi ([MESHING.md](MESHING.md), kural 7), dal hatlı kuplörün (69 bin → 76 bin hücre) ve alçak geçiren filtrenin (100 bin → 126 bin) mesh'lerini değiştirir; dipol, yama ve dizi mesh'leri aynıdır. Bölüm 11 ve 12 paketleri düzeltilmiş mesh üreticisiyle 2026-09-25 tarihinde yeniden çalıştırılmıştır (GPU motoru); aşağıdaki bölümler yeni değerleri verir: dal hatlı kuplörde S11 minimumu 2,414 GHz (önceden 2,406); 2,4 GHz'de S11 −33,7 dB (−29,1), S41 −35,4 dB (−30,9), S21 −3,21 dB (−3,05), S31 −2,99 dB (−3,17), faz yine 90,0°. Alçak geçiren filtrede −3 dB noktası 2,356 GHz (2,349), −20 dB noktası 3,346 GHz (3,360), dalgalanma 0,42 dB (0,45). İletim yolları ≤ 0,2 dB, merkez frekansları %0,3 değişir; bu, değerlerin mesh duyarlılığıdır.

## 11. Dal hatlı (90°) kuplör

Model: `python/models/branchline_coupler.py`; 0,813 mm kalınlık ve ε_r 3,38 ile 2,4 GHz. Birleşim merkezleri arasındaki merkez çizgileri boyunca çeyrek dalga uzunluklu 35,4 Ω (3,16 mm) seri kollar, 50 Ω (1,90 mm) paralel kollar ve 10 mm beslemelerde dört 50 Ω ayrık port içerir. `auto_mesh` mesh'i: 76 bin hücre; GPU'da dört çalıştırma 3,0 s. Teori (Pozar bölüm 7.5): f0'da S21 = −j/√2 ve S31 = −1/√2 (her biri −3,01 dB, aralarında 90°), S11 = S41 = 0.

| Kol ölçeği | S11 minimumunda f | 2,40 GHz'de S11 | S41 | S21 | S31 | ∠S21 − ∠S31 |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 (ders kitabı)¹ | 2,493 GHz (+3,8 %) | −21,6 dB | −21,8 dB | −3,27 dB | −3,05 dB | 90,2° |
| **1,035 (varsayılan)** | 2,414 GHz | **−33,7 dB** | **−35,4 dB** | **−3,21 dB** | **−2,99 dB** | **90,0°** |

¹ Bölünmüş aralık kademelendirme düzeltmesinden (bölüm 10) önceki mesh ile oluşturulmuş, yeniden çalıştırılmamıştır.

- Ders kitabındaki uzunluklarla kuplörün merkezi %3,8 yüksektir. Birleşim kareleri kolların elektriksel uzunluğunu kısaltır; bu, olağan T birleşimi düzeltmesidir. Buna rağmen 2,4 GHz'de |S11|, |S41| < −20 dB, ±0,2 dB bölünme ve 90° ± 0,2° zaten sağlanır.
- Kolları 1,035 ile ölçeklemek merkezi düzeltir. Bu durumda S11 ve S41, 2,30–2,53 GHz boyunca (%9,7) −20 dB altında; faz farkı 2,08–2,92 GHz boyunca 90° ± 5° içindedir. f0'da genlik dengesizliği 0,22 dB'dir.
- Sütun gücü 0,980'dir: aynı alttaştaki Wilkinson ile uyuşan %2 dielektrik kaybı ve ışıma. Yerleşim ve mesh simetrik olduğundan matris tam karşılıklı ve simetriktir (S11 = S22 = S33 = S44).

## 12. Kademeli empedanslı alçak geçiren filtre

Model: `python/models/lowpass_stepped.py`; 0,5 dB dalgalanmalı, fc = 2,5 GHz olan 5. dereceden Chebyshev filtre. 0,813 mm kalınlıklı ε_r 3,38 alttaş üzerinde 20 Ω (6,58 mm) ve 110 Ω (0,375 mm) hatlar sırayla yer alır; paralel kapasitörle başlar. Bölüm uzunlukları 7,59 / 6,84 / 11,30 / 6,84 / 7,59 mm'dir. Tasarım denklemleri (Pozar bölüm 8.6, `fairbeam.analytic.stepped_impedance_lowpass`): fc'de kapasitörler için βl = g_k Z_low / Z0, endüktörler için βl = g_k Z0 / Z_high; her hattın Hammerstad genişliği ve ε_eff değeri kullanılır. `auto_mesh` mesh'i, 0,375 mm hat eninde 4 hücre dahil 126 bin hücredir. GPU'da iki çalıştırma 4,2 s sürmüştür.

| Yanıt | −3 dB frekansı | −20 dB frekansı | \|S21\| @ 2,5 GHz | 3,0 GHz | 4,0 GHz | 6,0 GHz |
| --- | --- | --- | --- | --- | --- | --- |
| Toplu eleman prototipi (`lowpass_prototype_s21`) | 2,648 GHz | 3,362 GHz | −0,5 dB | −12,2 dB | −30,3 dB | −50,9 dB |
| İdeal iletim hattı kaskadı (`cascade_lines_s`, basamak süreksizlikleri yok) | 2,485 GHz | 3,519 GHz | −3,3 dB | −12,9 dB | −24,4 dB | −28,1 dB |
| **openEMS** | **2,356 GHz** | **3,346 GHz** | −6,0 dB | −15,5 dB | −25,5 dB | −22,4 dB |

- **Geçirme bandı:** 2 GHz'e kadar dalgalanma 0,42 dB'dir (kayıp dahil |S21| ≥ −0,42 dB); |S11| ≤ −11,4 dB. İdeal 0,5 dB eş dalgalı yanıtın |S11| değeri ≤ −9,6 dB olduğundan geçirme bandı biçimi Chebyshev biçimidir.
- **Kesim kayması:** −3 dB noktası ideal hat kaskadının %5,2, toplu eleman prototipinin %11 altındadır. Prototipten kaskada fark (−%6), kısa hat yaklaşımıdır: ortadaki kapasitörde βl, π/4 önerisinin çok üstünde, 1,0 rad'a ulaşır. Kalan −%5,2, basamak süreksizlikleridir. Her 20 Ω / 110 Ω geçişi saçaklanma kapasitansı ekler; geniş bölümler elektriksel olarak uzun görünür. FDTD mikroşeridin yaklaşık %1,3 yavaş fazı da eklenir (bölüm 7).
- **Kenar duyarlılığı:** eski mesh üreticisi, üç 20 Ω bölümün aynı doğru üzerindeki kenarlarında üçte bir kuralı yerine çizgileri tam kenara yerleştiriyordu; bu otomatik mesh hatası düzeltilmiştir. O çalıştırmada −3 dB noktası %4,8 daha düşük olan 2,243 GHz'deydi. Bu, bölüm 1c'deki kenar sapmasıdır: kenarları mesh çizgisindeki geniş, düşük empedanslı bölümler daha geniş görünür ve daha fazla kapasitans taşır. Pozar bu filtre türü için aynı aşağı kaymayı belirtir. Tam 2,5 GHz hedefleyen tasarımda düşük Z bölümleri kısaltılır veya `fairbeam sweep ... --param fc=...` ile ayarlama yapılır.
- **Durdurma bandı:** dağıtılmış filtre, toplu eleman prototipinden daha yavaş düşer ve bölümler λ/4'e yaklaştığından yaklaşık 5 GHz üzerinde yeniden yükselir (6 GHz'de −24 dB). İdeal kaskat da aynı geri yükselmeyi gösterir (−28 dB). Bu, kademeli empedans filtrelerinin bilinen sınırıdır; sayısal artefakt değildir.
- Karşılıklılık 1e-6'dır. Geçirme bandında sütun gücü 0,989, yani dielektrik kaybı %1'dir.

## 13. Dalga kılavuzu portlu piramit huni

Model: `python/models/pyramidal_horn.py`; WR-90 (22,86 × 10,16 mm) üzerinde 10 GHz'de G0 = 16 dBi için en uygun kazançlı huni. Balanis tasarım denklemleri (bölüm 13.4.3, `fairbeam.analytic.pyramidal_horn_design`), A × B = 86,2 × 64,5 mm açıklık ve boğazdan açıklığa 51,8 mm mesafe verir. Duvarlar 2 mm kalınlıklı, üçgenlenmiş çokyüzlülerdir. Besleme, z− PML içine uzanan 30 mm kılavuzda openEMS `RectWGPort` (TE10) portudur; böylece S11 yalnızca boğaz ve açıklık yansımasını içerir. Tüm yüzlerde PML, 8 GHz'de λ/4 hava ve z− yüzü olmayan NF2FF kutusu vardır (aşağıya bakın). `auto_mesh` mesh'i (12 GHz'de 20 hücre/λ): 1,10 M hücre, GPU'da 5,6 s.

**Besleme seçimi.** Koaksiyel sonda yerine dalga kılavuzu portu, huniyi besleme geçişinden ayırır. Fairbeam'in `evaluate()` işlevinde yalnızca küçük değişiklikler gerekmiştir: port türü `ports[]` içine kaydedilir, moda eşlenmiş problardan S11 = u_ref / u_inc alınır; referans empedansı frekansa bağlı TE10 dalga empedansıdır: Z_TE = η0 / √(1 − (f_c/f)²) (`results.ports[k].z_ref_f`).

**Port denetimi** (`python/examples/waveguide_thru.py`: düz WR-90 kılavuz, bölge sınırları olarak PEC duvarlar, 75 mm aralıklı iki TE10 port, 0,4 s): 8–12 GHz boyunca |S11| < −40 dB (10 GHz'de −46 dB), |S21| = 0 ± 0,004 dB; S21 fazı β·L'nin 0,5–1,5° içindedir (FDTD β değeri %0,1–0,17 yüksektir; 20 hücre/λ'daki olağan sayısal dispersiyon). Karşılıklılık 1e-6, sütun gücü 1,002.

**Sonuçlar** (yayımlanan paket):

| f | D (openEMS) | D (açıklık modeli) | D (G0 formülü, ε_ap 0,51) | E düzlemi HPBW | model | düzgün | H düzlemi HPBW | model | kosinüs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 GHz | **14,73 dBi** | 14,38 dBi | 14,05 dBi | **30,3°** | 30,4° | 29,5° | **32,4°** | 32,7° | 29,9° |
| 10 GHz | **15,52 dBi** | 15,39 dBi | 15,99 dBi | **24,1°** | 25,3° | 23,6° | **27,1°** | 28,4° | 23,9° |
| 12 GHz | **15,70 dBi** | 15,85 dBi | 17,57 dBi | **21,7°** | 22,2° | 19,7° | **24,9°** | 26,7° | 19,9° |

- *Açıklık modeli* (`fairbeam.analytic.horn_aperture`): açılımın ikinci dereceden faz hataları exp(−jk(x²/2ρ2 + y²/2ρ1)) ile cos(πx/A) açıklık alanı; ρ1 = 61,5 mm ve ρ2 = 70,5 mm, geometrinin ekseni boyunca tepeden açıklığa uzaklıklardır. Yönlülük, Balanis denklem 13-54'e (Fresnel integrali formülü) eşittir; hüzme genişlikleri faz hatasını ve Huygens eğiklik çarpanını içerir. openEMS farkı +0,35 / +0,13 / −0,15 dB içindedir; hüzme genişlikleri 1,2° (E), 1,8° (H) içinde olup openEMS biraz daha dardır. Kalan fark, açıklık modelinin ihmal ettiği kenar kırınımı ve duvar akımlarıdır.
- *G0 formülü:* sabit açıklık verimliliğiyle 10 log10(0,51 · 4πAB/λ²). 10 GHz'de openEMS, 16 dBi tasarım hedefinin 0,47 dB altındadır. Tasarım denklemleri, eksenel ρ1, ρ2 mesafeleri yerine eğik ρe, ρh uzunluklarını alır (Balanis yaklaşımı); bu nedenle oluşturulan huninin faz hatası “optimum” değerden yüksek, açıklık verimliliği 0,51 yerine 0,46 (openEMS) / 0,445'tir (açıklık modeli). f0 üzerinde sabit verimlilik formülü ilkesel olarak yanlıştır: faz hatası frekansla artar, sabit huninin kazancı yataylaşır (12 GHz: ε_ap 0,33).
- *Ders kitabındaki düzgün (50,8° λ/B) ve kosinüs (68,8° λ/A) açıklıklara göre hüzme genişlikleri:* bunlar faz hatasız sınırlardır. Optimum huninin ikinci dereceden faz hatası ikisini de genişletir; burada E düzleminde %2–10, H düzleminde %8–25. Açıklık modeli bunu yeniden üretir.
- *S11:* 8–12 GHz boyunca ≤ −16,6 dB (11,2 GHz'de minimum −28,7 dB); boğaz ve açıklık yansımasının tipik dalgalanmasıdır.
- **PML mesafesi:** λ/4 yerine λ/2 hava (8 GHz'de), D'yi ≤ 0,01 dB, hüzme genişliklerini ≤ 0,1°, S11'i ≤ 0,1 dB değiştirir. λ/4 yeterlidir.
- **Mesh:** 30 hücre/λ (2,4 M hücre, 14 s), D'yi 0,09 / 0,24 / 0,04 dB artırır; S11 maksimumunu −16,6'dan −17,9 dB'ye taşır. Hüzme genişliği değişimi ≤ 0,3°, 12 GHz E düzleminde 0,8°'dir.
- **z− yüzü olmayan NF2FF kutusu:** besleme kılavuzu alt yüzü keser. Altı yüzün tümü kullanılırsa kılavuz içindeki TE10 gücü ışıma sayılır: D, 12,4 dBi'ye düşer; Prad/Pacc 2,3 çıkar. Bu yüzü atlamak (`add_nf2ff_box(directions=[1, 1, 1, 1, 0, 1])`), yalnızca boğaz düzlemi altındaki küçük huni arka ışımasını dışarıda bırakır.
- **Güç dengesi.** PEC huninin verimliliği 1'dir, ancak Prad/Pacc 1,037 (30 hücre/λ'da 1,08) okunmuştur. NF2FF kutusu doğru, portun kabul edilen gücü düşüktü: besleme kılavuzu, beş yüzlü NF2FF kutusu ve huni kesit düzlemlerindeki tam Yee kafesi Poynting akısı (kaydırılmış konumlarındaki ham E ve H; H düzleme enterpole edilmiş) %0,1–0,4 içinde uyuşur (kapalı denge 1,001). Kutu, huniye uzaklığından (0–7,5 mm) ve frekans/zaman alanı kaydından bağımsızdır; uzak alan integrali kutu gücünü yeniden üretir. openEMS'in mod eşleme probları kılavuz gücünü 20 hücre/λ'da %4,3; 30'da %8,6 düşük okur; 8–12 GHz boyunca sabittir. Düğümlere enterpole edilen alanlar, tam düğüm alanları üzerinden normalleştirilmiş şablonlara izdüşürülür; PEC duvarda düğüm, hava değerinin yarısını taşır (E: metal tarafındaki kenar sıfır), alanı ise metal tarafındaki yarım hücreyi de içerir. Hata, duvara bitişik hücre boyutunda birinci derecedendir (duvarlar mesh çizgilerindeyken 0,5 mm hücrede %5; 0,25 mm'de %2,6); dolayısıyla yoğunluğu değil mesh'i izler: otomatik mesh, geniş duvar yanında 20 hücre/λ'da 0,38 mm, 30'da 0,77 mm hücre koyar. `fairbeam.wgport`, mesh çizgilerinden bu hatayı hesaplar (ideal moda aynı izdüşüm); `evaluate()`, portun U ve I değerlerini bunun kareköküyle ölçekler. Prad/Pacc artık 8 / 10 / 12 GHz'de 0,995 / 0,993 / 0,992 (20 hücre/λ), 0,998 / 0,997 / 0,995'tir (30 hücre/λ). Düzeltme yalnızca TE10 için alan verisiyle kontrol edilmiştir.

## 14. Eksenel mod helis ve dairesel polarizasyon

Model: `python/models/helix_axial.py`; 2,4 GHz'de Kraus eksenel mod helisi: çevre C = λ (yarıçap 19,9 mm), sarım açısı 13° (aralık S = 28,8 mm), N = 7 tur (1,6 λ uzunluk), sağ elli sarım, 100 mm kare toprak düzlemi (0,8 λ). Helis ince PEC teldir; tur başına 36 noktalı CSXCAD `Curve` kullanır, toprak ile tel başlangıcı arasındaki 3 mm aralıkta 120 Ω ayrık portla beslenir. PML sınırları, 1,8 GHz'de λ/4. `sim.cp_outputs = True`, uzak alana dairesel bileşenleri ekler. 30 hücre/λ'da `auto_mesh` (havada 1,66 mm, helis çevresinde 0,83 mm): 1,35 M hücre, GPU'da 10 s.

**Geometri şekli.** openEMS tel için `Curve` şeklinin mesh'ini güvenilir biçimde oluşturur (kendi Helical_Antenna eğitimi de bunu kullanır): FDTD, eğriyi en yakın mesh kenarlarına yerleştirir. Gerçek yarıçaplı `Wire` veya süpürülmüş şerit, telden küçük hücreler gerektirir. Paket eğri noktalarını tam saklar (yeni şekil türü `curve`, BUNDLE.md); görüntüleyici eğri boyunca tüp çizer.

**Dairesel polarizasyon.** E_R = (E_θ + jE_φ)/√2 ve E_L = (E_θ − jE_φ)/√2 (IEEE, e^{jωt}); kısmi yönlülükler D·|E_R|²/|E|² ve D·|E_L|²/|E|², AR = (|E_R| + |E_L|)/||E_R| − |E_L||. +z yönünde ışıyan sağ elli helis RHCP vermelidir; bu, işaret kabulünü uçtan uca kontrol eder.

| f | C/λ | D | RHCP (θ = 0) | LHCP (θ = 0) | AR (θ = 0) | HPBW | Kraus D | Kraus HPBW | Kraus AR | Kraus R_in |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2,1 GHz | 0,875 | 10,14 dBi | 10,12 dBi | −13,5 dBi | 1,14 dB | 54° | 12,11 dBi | 50,0° | 0,60 dB | 123 Ω |
| 2,4 GHz | 1,000 | **11,58 dBi** | **11,57 dBi** | **−14,2 dBi** | **0,89 dB** | 42-45° | 13,85 dBi | 40,9° | 0,60 dB | 140 Ω |
| 2,7 GHz | 1,125 | 11,71 dBi | 11,60 dBi | −4,3 dBi | 2,82 dB | 33° | 15,38 dBi | 34,3° | 0,60 dB | 158 Ω |

Kraus tahminleri (Kraus & Marhefka, *Antennas*, 3. baskı, bölüm 8; `fairbeam.analytic.helix_axial_mode`): D = 15 C²NS/λ³, yani 10,8 + 10 log10(C²NS/λ³) dBi, HPBW = 52 λ^{3/2}/(C√(NS)), AR = (2N + 1)/2N, R_in = 140 C/λ Ω.

- **Yönlülük:** 2,4 GHz'de Kraus'tan 2,3 dB düşük. Kraus formülünün yüksek tahmin verdiği bilinir: artmış faz hızı koşulunu varsayar, beslemeyi ve sonlu toprak düzlemini ihmal eder. Simülasyondaki hüzme genişliği 2,4 ve 2,7 GHz'de Kraus ile 1–4° içinde uyuşur; örüntü biçimi doğrudur. Formülün frekansla artışı (C²), C = λ üzerinde yeniden üretilmez: eksenel oran artarken D, 11,7 dBi'de kalır. 7 turlu helis kısadır; gereken Hansen-Woodyard fazlaması Kraus bandının yalnızca bir bölümünde sağlanır.
- **Polarizasyon:** sağ elli sarımdan beklendiği gibi RHCP. 2,4 GHz'de eksendeki LHCP düzeyi RHCP'den 25,8 dB düşük, AR = 0,89 dB'dir (Kraus: N = 7 için 0,60 dB). Üç örüntü frekansında eksendeki AR 1,1 / 0,9 / 2,8 dB'dir.
- **Giriş empedansı:** ağırlıklı olarak dirençli. 2,0–2,9 GHz boyunca R = 81–254 Ω (ortalama 164 Ω), X = −117 ile +54 Ω (ortalama −35 Ω); 2,4 GHz'de Z_in = 165 − j18 Ω. 120 Ω'a göre S11, 1,8–2,74 GHz arasında −10 dB altındadır. Kraus'un 140 C/λ değeri aralık içindedir; ancak mesh çalışmasına bakın.
- **Mesh (ince tel etkisi):** 20 / 30 / 40 hücre/λ (0,54 / 1,35 / 2,70 M hücre), D(2,4 GHz) = 12,11 / 11,58 / 11,38 dBi, AR = 1,10 / 0,89 / 0,88 dB ve ortalama R_in = 138 / 164 / 181 Ω verir. Örüntü ve eksenel oran yakınsar (30 ile 40 arasında 0,2 dB); giriş direnci artmaya devam eder. Çünkü FDTD ince telinin etkin yarıçapı hücrenin sabit bir kesridir: ince mesh daha ince tel, ince helis daha yüksek empedans demektir. R_in'i tek mesh'teki FDTD değeriyle değil, yarıçapı belirtilmiş telle karşılaştırın.
- **Sınırlar:** MUR sınırlarıyla bu model kararsızlaşmıştır (GPU motorunda yaklaşık 20 000 zaman adımından sonra enerji artmıştır); PML_8 kararlıdır ve −60 dB'ye yakınsar. Işıma verimliliği 0,997 (PEC).
## 15. Düzlem dalga malzeme hücresi (homojen tabaka)

Model: `python/examples/slab_cell.py`; `fairbeam.material_cell.PlaneWaveCell` ile oluşturulan, dik gelişte 1–10 GHz için dielektrik tabaka (10 mm, ε_r 4, isteğe bağlı kayıplı). Hücre 5 × 5 mm'dir; H'ye normal (x) duvarlar PMC, E'ye normal (y) duvarlar PEC olduğundan TEM dalgası enine sonsuz bir tabaka görür; iki uç PML_8'e uzanır. Tüm kesiti kaplayan yumuşak E_y levha kaynağı dalgayı başlatır; y− duvardan y+ duvara uzanan gerilim probları, tabakanın önündeki ve arkasındaki f_max'ta λ/4 (7,5 mm) uzaklıktaki referans düzlemlerindedir. `fairbeam material-cell`, önce boş hücreyi, sonra tabakalı hücreyi aynı mesh'te çalıştırır; S11 = (V1 − V1,inc) / V1,inc ve S21 = V2 / V2,inc hesaplayıp vakum fazıyla tabaka yüzlerine taşır. Referans: `Simulation.dielectric` ile aynı sabit iletkenlik kaybını kullanan transfer matrisi tabakası `fairbeam.analytic.slab_s` (birim testler kapalı biçimli Fresnel tabakasıyla karşılaştırır). 4 × 4 × 54 hücre; iki çalıştırmanın toplamı bir saniyeden kısadır.

```bash
cd python
python -m fairbeam material-cell examples/slab_cell.py --set cpw=20 --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/slab_cell.py --set cpw=20 --set tan_d=0.05 --threads 4 --out <folder> --sim-root <folder>
```

| tan δ | hücre/λ (tabakada) | max \|ΔS11\| | max \|ΔS21\| | \|S21\| hata | S21 faz hatası | 1 − \|S11\|² − \|S21\|² |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 10 | 0,048 | 0,031 | 0,11 dB | 1,8° | −0,001 ile 0,004 |
| 0 | 20 | 0,006 | 0,009 | 0,03 dB | 0,5° | 0,000 ile 0,007 |
| 0 | 40 | 0,005 | 0,003 | 0,01 dB | 0,2° | −0,001 ile 0,004 |
| 0,05 | 10 | 0,042 | 0,028 | 0,10 dB | 1,7° | 0,087 ile 0,167 |
| 0,05 | 20 | 0,006 | 0,008 | 0,04 dB | 0,5° | 0,084 ile 0,168 |
| 0,05 | 40 | 0,004 | 0,003 | 0,01 dB | 0,2° | 0,083 ile 0,168 |

ΔS, 401 frekanstaki karmaşık farktır. Yarım dalga tabakasının 7,5 GHz'deki S11 çukuru −47 dB çıkar (20 hücre/λ). S21 faz hatası, sayısal dispersiyondan beklendiği gibi 20'den 40 hücre/λ'ya geçince yarıya iner. Kayıpsız tabakanın güç dengesi %0,7 içinde kapanır; kayıplı tabaka bant boyunca %8–17 soğurur.

- **Eşit zaman adımları.** openEMS, zaman adımını mesh *ve* malzemelerden seçer; tabakalı hücre boş hücreden uzun adımla çalışır (burada 2,29 ve 1,83 ps). Yumuşak kaynak genliğini her zaman adımında bir kez ekler; başlattığı dalga 1/dt ile ölçeklenir. Kendi adımlarıyla çalıştırıldığında |S21| analitik değerin sabit 0,81 katı çıkmış, kayıpsız tabaka %48'e kadar “soğurmuştur”. Enine hücreler küçüldükçe hatanın azalmasının nedeni, iki adımın aynı enine sınıra yaklaşmasıydı. Bu nedenle çalıştırıcı, her iki çalıştırmanın kendi adımını openEMS kurulumundan (`setup_only`, zaman adımı yürütmeden) okur; ikisini küçük olanla çalıştırır (`openEMS.SetTimeStep`) ve sonrasında farklı adım bildirilirse durur. ε_r, μ_r ≥ 1 için küçük adım boş hücreninkidir. Dispersif numune daha kısa adım gerektirebilir (Drude ε′ < 1; bölüm 15c). Böylece sonuç enine hücre sayısına bağlı kalmaz (enine 2, 4 ve 16 hücre: en yüksek |ΔS21| 0,008–0,009).
- **Uyarım.** openEMS TF/SF düzlem dalgası (uyarım türü 10) hiçbir malzemeyle kesişmemelidir; kutusunun PEC/PMC duvarları ve uzak PML boyunca uzanması gerekirdi. Yumuşak E_y levha kaynağı (tür 0; openEMS `Metamaterial_PlaneWave_Drude` örneğindeki gibi) kesit boyunca düzgündür; bu, PEC/PMC hücresinin TEM modudur. Geriye giden dalgası z− PML'ye girer.
- **Kapsam.** Yalnızca dik geliş: openEMS'te periyodik (Floquet) sınırlar yoktur. Yapılandırılmış numune (FSS, metamalzeme hücresi), PEC ve PMC duvarlarına göre simetrik olmalıdır. En yoğun malzemede f = c / (2 max(a, b)) üzerinde hücre yüksek modları iletir; bu örnek o sınırın oldukça altında kalır (havada 30 GHz, tabakada 15 GHz). Referans düzlemlerinde (vakum), hücrenin merkez düzlemlerine göre ayna simetrisi olmayan numune ilk yüksek modu c / (2 max(a, b)) üzerinde, merkezlenmiş numune c / max(a, b) üzerinde uyarabilir. `PlaneWaveCell` ikisini de sonuca kaydeder (`cell.f_higher_mode`) ve `f_max` bunlara ulaştığında uyarır.

### 15b. S11 ve S21'den malzeme parametreleri (NRW, NIST)

Aynı çalıştırmalara `fairbeam.nrw` malzeme çıkarımı uygulanır (CLI.md, “Malzeme parametreleri”): εr, μr ve kayıp tanjantları için NRW; `--nist` ile yalnızca εr'yi çıkaran yinelemeli yöntem. Referans, tabakanın kendi malzemesi εr(1 − j tan δ · f_ref/f) ve μr'dir; f_ref = 5,5 GHz (`Simulation.dielectric` sabit iletkenlik kaybı). Manyetik durum εr 3, μr 2'dir (`Simulation.dielectric(..., mu_r=2)`), εr = μr değildir: eşit olsaydı tabaka vakuma uyumlu olur, S11 sıfırlanır ve NRW'nin tersine çevireceği veri kalmazdı.

```bash
cd python
python -m fairbeam material-cell examples/slab_cell.py --set cpw=20 --nist --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/slab_cell.py --set cpw=20 --set tan_d=0.05 --nist ...
python -m fairbeam material-cell examples/slab_cell.py --set cpw=20 --set eps_r=3 --set mu_r=2 --set tan_d=0.02 --nist ...
```

1–10 GHz boyunca en büyük sapmalar (401 frekans; NRW güvenilir frekanslarında, varsayılan `--nrw-floor 0.3` ile bunların 336–349'unda):

| Tabaka | hücre/λ | NRW εr′ | NRW μr′ | NRW tan δ | NRW tan δ_μ | NIST εr′ | NIST tan δ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| εr 4, kayıpsız | 20 | 0,37 % | 0,75 % | 0,020 | 0,022 | 0,42 % | 0,0022 |
| εr 4, kayıpsız | 40 | 0,89 % | 1,14 % | 0,003 | 0,004 | 0,17 % | 0,0021 |
| εr 4, tan δ 0,05 | 20 | 0,91 % | 1,39 % | 0,020 | 0,022 | 0,41 % | 0,0023 |
| εr 4, tan δ 0,05 | 40 | 0,76 % | 0,97 % | 0,004 | 0,005 | 0,16 % | 0,0020 |
| εr 3, μr 2, tan δ 0,02 | 20 | 0,57 % | 1,17 % | 0,005 | 0,006 | (μr = 1 varsayılmış) | |
| εr 3, μr 2, tan δ 0,02 | 40 | 0,73 % | 0,77 % | 0,003 | 0,003 | (μr = 1 varsayılmış) | |

Tan δ hataları mutlaktır.

- **Verilen εr ve tan δ geri çıkarılır.** NIST bant boyunca εr′ = 4,00–4,02, verilen 0,05 için tan δ(5,5 GHz) = 0,0508 (20 hücre/λ) ve 0,04996 (40 hücre/λ) verir. Kayıpsız tabakada 0,0010 ve 0,00001 verir. NRW, manyetik tabakanın μr′ = 2,00–2,02 değeri dahil, güvenilir frekanslarında εr′ ve μr′ değerlerini yaklaşık %1 içinde geri çıkarır.
- **Yarım dalga rezonansı.** β′d = π noktasında (εr 4 tabakası için 7,5 GHz), 20 hücre/λ'da yaklaşık 0,006 olan S-parametresi hatası (bölüm 15), 1/\|sin β′d\| ile büyütülür. Korunan noktalardaki en büyük NRW tan δ hatası `--nrw-floor 0.15` için 0,036, varsayılan 0,3 için 0,020; 0,5 için 0,011'dir (kayıpsız tabaka, 20 hücre/λ). NIST'te bu büyütme yoktur: tan δ, rezonans dahil her yerde 0,0023 içindedir. Düşük kayıplı dielektriklerde tan δ için NIST kullanın.
- **Manyetik numunede NIST**, beklendiği gibi manyetik olmayan tabakayı manyetik tabakaya uydurur (εr′, 3–9 çıkar). NRW μr′ ≈ 2 bulduğu için komut uyarır.
- **Birim testler** (`python/tests/test_nrw.py`, `slab_s` ile sentetik S-parametreleri):
  - İki yöntem de kayıpsız, kayıplı, manyetik ve Debye dispersiyonlu numuneleri 1e-9 içinde geri çıkarır.
  - 5 GHz'den başlayan 50 mm, εr 9 tabakada en düşük frekansta faz 2,5 tur sarar; grup gecikmesi doğru dalı seçer.
  - S11 ve S21 üzerinde 1e-3 gürültüyle NIST εr′ değerini %1 içinde tutar; maskelenmemiş NRW rezonansta on kattan daha kötüdür.

### 15c. Dispersif malzemeler (Debye, Lorentz, Drude, Djordjevic-Sarkar)

Model: `python/examples/dispersive_cell.py`; 1–10 GHz boyunca 5 × 5 mm hücrede 10 mm tabaka, `Simulation.dispersive` (`fairbeam.dispersion`) ile oluşturulur. Dört malzeme seçeneği vardır:

- `debye`: ε∞ 3, 3 GHz'de Δε = 2 olan bir Debye kutbu; openEMS'e uydurulmuş Lorentz kutupları olarak verilir (aşağıda).
- `lorentz`: ε∞ 2, 6 GHz'de Lorentz kutbu, f_p 3 GHz, sönüm 0,6 GHz.
- `drude`: ε∞ 2, f_p 3 GHz, sönüm 0,5 GHz; yaklaşık 2,1 GHz altında ε′ < 0.
- `fr4`: 1 GHz'de εr 4,4 ve tan δ 0,02 olan Djordjevic-Sarkar FR4; Lorentz kutuplarına uydurulur.

`analytic_layers`, frekansa bağlı katmanları kabul eden `slab_s` işlevine aynı ε(f) değerini verir.

```bash
cd python
python -m fairbeam material-cell examples/dispersive_cell.py --set model=lorentz --set cpw=20 --nist --threads 4 --out <folder> --sim-root <folder>
```

**openEMS kabulleri (adım 0).** Motorun Debye'yi de çalıştıran tek bir Drude/Lorentz uzantısı vardır. Belgelerin her yorumu için analitik tabakayla karşılaştırılan kısa tek-tabaka çalıştırmaları (20 hücre/λ), kabulleri belirler. Frekanslar Hz'dir; Lorentz/Drude terimleri, openEMS matlab `CalcLorentzMaterial` / `CalcDebyeMaterial` işlevlerindeki gibi ε∞ ile ölçeklenir (formüller `fairbeam.dispersion` içinde):

| Malzeme | Yorum | max \|ΔS11\| | max \|ΔS21\| |
| --- | --- | --- | --- |
| Drude (1 kutup) | Hz, ε∞ ile ölçekli | **0,013** | **0,014** |
| | rad/s cinsinden plazma frekansı | 0,73 | 0,74 |
| Lorentz (6 GHz'de 1 kutup) | Hz, ε∞ ile ölçekli | **0,018** | **0,020** |
| | Drude olarak (kutup yok sayılmış) | 0,73 | 0,87 |
| | rad/s | 0,38 | 0,80 |
| Debye (1 kutup) | ε∞ + Δε/(1 + jωτ) | **0,031** | **0,042** |
| | Δε, ε∞ ile ölçekli / 2π olmadan τ / eşlenik / dispersif olmayan | 0,22-0,52 | 0,31-0,84 |

**openEMS 0.37.0rc3 DebyeMaterial, ΣΔε/ε∞ yaklaşık 0,6'yı aşınca 1B'de ıraksar (3B'de yaklaşık 0,3; aşağıya bakın).** Neden kutup sayısı değil, toplam Δε'nin ε∞'ye oranıdır. Prob 10¹⁰–10³¹ düzeyine, ardından NaN'a gider. Yalnızca openEMS ve kendi zaman adımıyla, 1B kanaldaki aynı 10 mm tabakadan oluşan bağımsız sütun, sınırı gösterir:

| ΣΔε/ε∞ | 0,08-0,50 | 0,55 | 0,60 | 0,62 | 0,64 | 0,67 |
| --- | --- | --- | --- | --- | --- | --- |
| düzgün 1 mm z hücreleri | kararlı | kararlı | kararlı | kararlı | büyür | büyür |
| düzgün 0,5 mm z hücreleri | kararlı | kararlı | büyür | büyür | büyür | büyür |

- Aynı davranış 0,25 mm'de; bir veya iki kutupla (toplam önemlidir), ε∞ 3 veya 10 ve 2 veya 8 GHz'e karşılık gelen τ ile de görülür.
- Zorlanmış çok daha kısa adım (1,45 ps yerine 0,5 ps), 0,67'yi kararlı tutar.
- Kademeli düzlem dalga hücre mesh'inde 0,67'de tek kutup tesadüfen kararlı kalmış, ΣΔε = ε∞ olan iki ve üç kutupta büyüme olmuştur.
- openEMS'in kendi testi (`master` dalındaki `python/Tests/Dispersive_Materials.py`), “for d_eps >~ eps_inf” için kararsızlık belirtir; sınır bunun yaklaşık yarısıdır. Fiziksel Debye ortamları bunu çok aşar (su: Δε/ε∞ ≈ 15).
- **Lorentz tabanlı malzemeler**, openEMS'in kendi adımıyla bu yapılandırmaların hepsinde kararlıdır: iki Drude kutbu, iki Lorentz kutbu, aşırı sönümlü Lorentz kutupları (uydurulmuş Debye kutbu, uydurulmuş FR4 laminat) ve bant içi Lorentz kutbu. İki Lorentz ve üç aşırı sönümlü Lorentz kutbu, analitik tabakanın en yüksek |ΔS| 0,006–0,016 içinde kalır.

Bu nedenle `fairbeam.dispersion`, openEMS'e hiçbir zaman DebyeMaterial vermez. `Simulation.dispersive`, Debye kutuplarını Djordjevic-Sarkar laminat gibi bandın iki tarafında birer dekad genişletilmiş aralıkta aşırı sönümlü Lorentz kutuplarına uydurur (`fairbeam.debye_fit.fit_model`). Δε/ε∞ ne olursa olsun bunlar pasif, nedenseldir ve sönüm hızlarının altında Debye benzeri davranır.

**3B'de sınır daha düşüktür ve nedeni PML değildir.** 10 mm Debye küpü, yumuşak E_z nokta kaynağı, düzgün hücreler ve 20 000 zaman adımı içeren kapalı PEC kavite (30 mm, hiç PML yok; openEMS #229 için `debye_3d_nopml.py`) şöyle davranır:

| Hücre | Kararlılığın sürdüğü ΣΔε/ε∞ | Büyümenin başladığı değer |
| --- | --- | --- |
| 1 mm | 0,28 | 0,29-0,30 |
| 0,5 mm | 0,29 | 0,30-0,33 |

3B sınırı yaklaşık 0,25–0,33'tür; 1B kanalın yarısıdır. 20 000 zaman adımı içinde bunun altında daha yavaş büyüme dışlanamaz. Djordjevic-Sarkar FR4 laminat (Δε/ε∞ ≈ 0,25), bu nedenle 3B sınırının güvenle altında değil, sınırdadır. openEMS'e Lorentz kutupları olarak verilmesi için bir neden daha budur. openEMS-Project tartışmaları [140](https://github.com/thliebig/openEMS-Project/discussions/140) ve [157](https://github.com/thliebig/openEMS-Project/discussions/157), laminatın Lorentz uydurmasının ıraksadığını bildirir. Orada plazma frekansları yaklaşık 900 GHz'di. Burada her kutup frekansı zaman adımıyla sınırlandırılır (ω·dt ≤ 0,5; 1,6 ps'de yaklaşık 50 GHz).

Kararsızlık, bağımsız tekrarlama örneğiyle (yalnızca openEMS ve CSXCAD) [openEMS #229](https://github.com/thliebig/openEMS/issues/229) olarak bildirilmiştir. 0.37.0rc3 (Windows) ile o dönemin master dalı (Ubuntu 24.04'te derlenen openEMS 6970767, CSXCAD 0306a9f) aynı sonucu verir. Üst projede daha sonra düzeltilmiştir (openEMS 624fa1d, “DebyeMaterial: integrate the pole capacitor, not the loop equation”). Paketlenen 0.37.0rc3 çalışma ortamı düzeltmeyi içermediğinden Debye kutupları openEMS'e hâlâ uydurulmuş Lorentz kutupları olarak verilir.

**Sonuçlar** (1–10 GHz boyunca en büyük sapmalar, 401 frekans; NRW güvenilir frekanslarında; Lorentz ve Drude tabakalarının ε′ değeri sıfırdan geçtiğinden ε için karmaşık bağıl hata |Δε|/|ε| kullanılır):

| Malzeme | hücre/λ | \|ΔS11\| | \|ΔS21\| | NRW \|Δε\|/\|ε\| | NIST \|Δε\|/\|ε\| |
| --- | --- | --- | --- | --- | --- |
| Debye (uydurulmuş, 4 Lorentz kutbu) | 20 | 0,008 | 0,013 | 1,6 % | 1,3 % |
| Debye (uydurulmuş, 4 Lorentz kutbu) | 40 | 0,006 | 0,006 | 1,1 % | 0,87 % |
| Lorentz | 20 | 0,028 | 0,031 | 8,7 % | 9,5 % |
| Lorentz | 40 | 0,016 | 0,016 | 4,4 % | 4,9 % |
| Drude | 20 | 0,014 | 0,015 | 15,1 % | 15,1 % |
| Drude | 40 | 0,008 | 0,008 | 8,0 % | 8,0 % |
| FR4 (DS, 7 / 9 kutup) | 20 | 0,007 | 0,010 | 1,8 % | 0,56 % |
| FR4 (DS, 7 / 9 kutup) | 40 | 0,005 | 0,005 | 0,85 % | 0,28 % |

- **Yakınsama.** Sapmalar hücre boyutuyla azalır (Lorentz, Drude ve FR4 tabakalarında 20'den 40 hücre/λ'ya geçince yaklaşık yarıya); dolayısıyla model uyuşmazlığı değil, FDTD ayrıklaştırma hatasıdır. NRW ile NIST uyuşur; çıkarım hatasını ters çözüm değil, S-parametresi hatası belirler.
- **Debye.** Karşılaştırma, simüle edilen (uydurulmuş) kutuplarladır. Debye kutbunun kendisine göre uydurma, εr′ için %0,10 ve tan δ için 0,0009 (20 hücre/λ, 1,78 ps), ya da %0,03 ve 0,0002 (40 hücre/λ) ekler. Uydurulmuş malzeme, düzlem dalga hücresinde tesadüfen kararlı kalan openEMS yerel tek-kutuplu Debye malzemesinden daha doğrudur (adım 0: 20 hücre/λ'da en yüksek |ΔS| 0,031 / 0,042; 40'ta 0,018 / 0,021).
- **Hatanın yeri.** Lorentz tabakasında NRW, 5–8 GHz dışında ε'yi %1 içinde geri çıkarır. Kutup çevresindeki güçlü dispersiyon S hatasını büyütür (20 hücre/λ'da %9'a kadar). Drude tabakasındaki %15, ε′ değerinin sıfırdan geçtiği 2–4 GHz'dedir; 5 GHz'den itibaren %2 içindedir.
- **Zaman adımı.** Her çalıştırmanın kendi adımı kurulumda okunur; ikisi küçük olanla çalışır. Burada numunenin kendi adımı daha uzundur (Lorentz 2,03 ve 1,63 ps, Drude 1,54 ve 1,18 ps, ε∞ ≥ 1). Birim testler daha kısa adımlı numuneyi de kapsar. Çalıştırmadan önce kutuplar adımla karşılaştırılır: 1,38 ps tahminiyle FR4 uydurması, gerçek adımı 1,85 ps olan hücrede reddedilmiştir (`dt / τ` 0,67). Bundan sonra `Simulation.dispersive`, uydurmayı oluşturulmuş mesh'in CFL adımıyla sınırlar; burada bu, boş hücrenin adımına eşittir.

**Dispersif numunelerde NRW dalı.** Sentetik tabakalarda (Debye, Drude ve dört Lorentz durumu; 5–60 mm, 801 nokta), bant medyanından seçilen tek dal kalın Lorentz tabakalarında başarısız olmuş; yalnızca bandın alt ucundan seçilen dal da soğurma çizgisinin üzerinde başarısız kalmıştır. NRW artık geçirimsiz frekanslar (|S21| < −60 dB) arasındaki her kesit için, daha az dispersif uçtan dal seçer. Bandın en düşük frekansından başlamayan kesit, numune manyetik olmayan olarak belirtilmedikçe (`--nist`) ve kesit boyunca μr'yi 1'in 0,1 yakınında tutan tam bir dal bulunmadıkça güvenilir değildir. Bununla 24 durumun hiçbirinde güvenilir frekanslar arasında yanlış değer kalmaz. `--nist` olmadan frekansların %77'si, bununla %86'sı güvenilirdir.

İlk sürüm üç durumu yanlış değerlendirmiştir:

- Bandın altından itibaren geçirimsiz olan Drude tabakası (ε∞ 2, f_p 6 GHz, τ 1 ns, 1–10 GHz, 101 nokta), ilk görünür frekansından itibaren biliniyor sayılmıştır. 60 mm'de %341'e kadar hatalı 47 güvenilir değer bulunmuştur.
- Geçirimsiz tabaka (εr 4 − 10j, 300 mm, en yüksek |S21| 7·10⁻⁶), “tüm sonlu değerler” yedek seçimine dönmüş ve 23 güvenilir değer üretmiştir.
- Aralıklı, birbirinden yalıtılmış görünür örnekler IndexError hatasına neden olmuştur.

Artık Drude tabakasında `--nist` olmadan güvenilir değer yoktur; bununla 55 (60 mm) / 45 (100 mm) değer, modelin 2·10⁻¹⁴ içinde elde edilir. Geçirimsiz tabaka ve yalıtılmış örnekler NRW değeri üretmez (komut malzeme parametresi bildirmez). Bu durumlar ve geçersiz malzeme girdileri (NaN veya sonsuz sabitler, kutuplar ve uydurma kontrolleri; bant merkezinde ε′ = 0 olup tan δ'nın kaydedilmemesi), `python/tests/test_dispersion_validation.py` içinde birim testtir. Bölüm 15b, 15c ve 17'nin saklanan FDTD sonuçlarına bu kurallarla yeniden çıkarım uygulandığında tablolardaki tüm değerler değişmeden kalır.

**Djordjevic-Sarkar FR4.** 1 GHz'de εr 4,4 ve tan δ 0,02'den (m1 = 4, m2 = 12) elde edilen laminat, 1–10 GHz boyunca εr′ 4,40 → 4,27 ve tan δ 0,0199–0,0201 gösterir. 5,5 GHz'de tan δ 0,02 veren sabit iletkenlik ise 0,11 → 0,011 üretirdi.

- **Uydurma.** `Simulation.dispersive`, gevşeme süreçlerini mesh'in zaman adımıyla sınırlayarak laminatı 0,1–100 GHz arasında uydurur. Bant içindeki uydurma hataları:
  - 1,85 ps'de (20 hücre/λ): εr′ %0,04, tan δ 0,0006; 7 kutup.
  - 0,97 ps'de (40 hücre/λ): εr′ %0,03, tan δ 0,0004; 9 kutup.
- **Zaman adımı ve uydurma hatası.** Daha kaba zaman adımı gevşeme frekanslarını daha düşükten sınırlar (yaklaşık 0,08/dt), üsttekileri dışarıda bırakır. 2,9 ps'de sınır 27 GHz, 10 GHz'deki tan δ hatası 0,0013'tür.
- **FDTD ve NIST.** Tabakanın NIST tan δ değeri bant boyunca 0,019–0,023'te kalır (model 0,0199–0,0201). 0,003 içindeki sapma, hücrenin S-parametresi hatasının (0,005–0,01) ε″'ye yansımasıdır. −80 ve −100 dB durdurma ölçütlerinde yaklaşık aynıdır. εr′, 20 hücre/λ'da %0,56; 40'ta %0,28 içindedir.
## 17. Dalga kılavuzu malzeme düzeneği (WR-90)

Model: `python/examples/wr90_fixture.py`; 8,2–12,4 GHz bandında WR-90 kılavuzunu
(22,86 × 10,16 mm) dolduran, 10 mm kalınlığında homojen numune. `fairbeam.waveguide_fixture.WaveguideFixture`
ile oluşturulur. x ve y yönlerinde PEC duvarlar vardır. Her uçta bir TE10 dalga kılavuzu portu
(`Simulation.waveguide_port`) bulunur; probları numune yüzünden bir kılavuz genişliği (22,86 mm)
uzakta, uyarım düzlemi iki hücre daha dışarıdadır; ardından PML_8 gelir. Port 1 uyarılır,
port 2 sonlandırılır.

`fairbeam material-cell`, boş kılavuzu ve numuneyi aynı zaman adımıyla çalıştırır. S11 ve S21'i
port dalgalarından alır (referans: TE10 dalga empedansı); boş çalıştırmada simülasyonla elde edilen β0 ile
referanslarını numune yüzlerine taşır. Referans çözüm kılavuzlu aktarım matrisi levhasıdır:
`fairbeam.analytic.slab_s(..., kc=π/a)`. Birim testleri bunu kapalı biçimdeki kılavuzlu levha
çözümüyle karşılaştırır. εr = 1 için model boş kılavuz denetimidir. Mesh, numunede 20 hücre/λ
ile 20 × 10 × 86 çizgi; 30 hücre/λ ile 30 × 14 × 112 çizgidir. İki çalıştırma toplamda
4 iş parçacığında 1,5–4 s sürer.

```bash
cd python
python -m fairbeam material-cell examples/wr90_fixture.py --set eps_r=1 --nist --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/wr90_fixture.py --nist --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/wr90_fixture.py --set tan_d=0.02 --nist --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/wr90_fixture.py --set eps_r=3 --set mu_r=2 --set tan_d=0.02 --nist --threads 4 --out <folder> --sim-root <folder>
```

Daha ince mesh için `--set cpw=30` ekleyin. Varsayılanlar εr 4, tan δ 0, μr 1 ve cpw 20'dir.
Aşağıdaki sonuçlar Windows 11 üzerinde openEMS 0.37.0rc3, CPU motoru ve 4 iş parçacığıyla elde edilmiştir.

Kılavuzlu levhaya göre S-parametreleri (401 frekans; ΔS karmaşık farktır):

| Numune | hücre/λ | en büyük \|ΔS11\| | en büyük \|ΔS21\| | \|S21\| hatası | S21 faz hatası | 1 − \|S11\|² − \|S21\|² |
| --- | --- | --- | --- | --- | --- | --- |
| boş kılavuz | 20 | 0,0073 | 0,0036 | 0,000 dB | 0,20° | −0,0001 – 0,0000 |
| boş kılavuz | 30 | 0,0037 | 0,0015 | 0,000 dB | 0,09° | 0,0000 |
| εr 4, kayıpsız | 20 | 0,011 | 0,009 | 0,024 dB | 0,68° | −0,0004 – 0,0017 |
| εr 4, kayıpsız | 30 | 0,005 | 0,005 | 0,013 dB | 0,36° | −0,0008 – 0,0016 |
| εr 4, tan δ 0,02 | 20 | 0,010 | 0,009 | 0,025 dB | 0,69° | 0,063 – 0,141 |
| εr 4, tan δ 0,02 | 30 | 0,005 | 0,005 | 0,011 dB | 0,36° | 0,063 – 0,140 |
| εr 3, μr 2, tan δ 0,02 | 20 | 0,015 | 0,024 | 0,024 dB | 1,44° | 0,094 – 0,109 |
| εr 3, μr 2, tan δ 0,02 | 30 | 0,006 | 0,011 | 0,011 dB | 0,67° | 0,094 – 0,108 |

Malzeme parametreleri (NRW güvenilir frekanslarında: dolu numunelerde 401 frekansın 339–356'sı,
boş kılavuzda 401'inin tamamı; tan δ hataları mutlaktır):

| Numune | hücre/λ | NRW εr′ | NRW μr′ | NRW tan δ | NIST εr′ | NIST tan δ | 10,3 GHz'de NIST tan δ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| boş kılavuz | 20 | 0,79 % | 0,79 % | 0,006 | 0,19 % | 0,0010 | 0,0010 (0) |
| boş kılavuz | 30 | 0,36 % | 0,36 % | 0,003 | 0,08 % | 0,0007 | 0,0006 (0) |
| εr 4, kayıpsız | 20 | 0,90 % | 1,38 % | 0,010 | 0,48 % | 0,0005 | 0,0005 (0) |
| εr 4, kayıpsız | 30 | 0,47 % | 0,66 % | 0,007 | 0,24 % | 0,0004 | 0,0004 (0) |
| εr 4, tan δ 0,02 | 20 | 0,90 % | 1,36 % | 0,012 | 0,48 % | 0,0006 | 0,0206 (0,0200) |
| εr 4, tan δ 0,02 | 30 | 0,40 % | 0,65 % | 0,008 | 0,24 % | 0,0004 | 0,0204 (0,0200) |
| εr 3, μr 2, tan δ 0,02 | 20 | 0,60 % | 0,81 % | 0,016 | (μr = 1 varsayılır) | | |
| εr 3, μr 2, tan δ 0,02 | 30 | 0,40 % | 0,36 % | 0,007 | (μr = 1 varsayılır) | | |

- **Verilen εr ve tan δ geri elde edildi.** NIST, bant boyunca εr′ = 4,00–4,02 (20 hücre/λ)
  ve 4,00–4,01 (30) verir. Kayıplı numunenin verilen 0,02 tan δ değeri için 10,3 GHz'deki
  sonuçlar 0,0206 ve 0,0204'tür. NRW, manyetik numunede μr′ = 1,99–2,02 değerini geri elde eder.
  20'den 30 hücre/λ'ya geçiş hataları yaklaşık yarıya indirir. Kılavuzlu biçim, düzlem dalga
  hücresine (bölüm 15b) göre yeni hata kaynağı içermez: aynı ayrıklaştırma hatasına portun kendi
  uyumsuzluğu eklenir (boş kılavuzun |S11|'i 20 hücre/λ'da en çok −42,8 dB, 30'da −48,6 dB).
- **Simülasyonla elde edilen β0.** Boş kılavuzda referans düzlemleri arasında simülasyonla elde edilen β0, analitik
  √(k0² − (π/a)²) değerinden %0,16–0,22 (20 hücre/λ) ve %0,07–0,10 (30) farklıdır; bu sayısal
  dispersiyondur. Çalıştırıcı, referans düzlemi taşıma işleminde (de-embedding), NRW'de ve NIST'te
  ölçülen değeri kullanır; karşılaştırma için analitik değeri raporlar. Analitik β0 kullanılırsa
  NIST εr′ hatası %0,48 yerine %0,66 (εr 4, 20 hücre/λ), %0,24 yerine %0,33 (30) olur.
  NRW εr′, 0,06 yüzde puan içinde değişmeden kalır; μr′ hatası en çok 0,17 puan artar
  (20 hücre/λ'da εr 4 için %1,38 yerine %1,52; manyetik numune için %0,81 yerine %0,98).
  Yukarıdaki analitik levha karşılaştırması, kapalı biçim çözümün gerektirdiği analitik β0'yı
  kullanır; dolayısıyla faz hataları bu dispersiyonu içerir.
- **Eşit zaman adımları.** Dolu kılavuzun kendi adımı boş kılavuzunkinden yaklaşık %28 uzundur
  (20 hücre/λ'da 2,04 ve 1,60 ps). Çalıştırıcı ikisini openEMS kurulumundan (`setup_only`)
  okur, ikisini de küçük adımda çalıştırır ve sonunda aynı adımı kullandıklarını denetler.
  Denetim port problarının zaman eksenini okur: openEMS'in ilerleme satırı konsolu iki ondalıklı
  sabit gösterimde bırakır. İlerleme yazdıracak kadar uzun bir çalıştırmadan sonra aynı süreçteki
  sonraki çalıştırma zaman adımını "0.00 s" olarak kaydeder (ilk burada dalga kılavuzu portlarıyla
  görüldü, ancak onlara özgü değildir;
  [üst projeye bildirildi](https://github.com/thliebig/openEMS/issues/229#issuecomment-5970656429)).
  Düzlem dalga hücresi de aynı yardımcıyı (`fairbeam.material_cell.run_at_one_timestep`, gerilim
  probuyla) kullanır; dispersif numunenin kutuplarını çözümlemeyen adımı reddetme denetimi de
  buna dahildir (bölüm 15c).
- **Uyarım.** Örnek, bant sınırlı Gauss kullanır (`excitation="gauss"`). DC'ye kadar uzanan
  varsayılan Gauss türevi darbesiyle εr 4 çalıştırması tamamlanmadı: dolu bölümün TE10 kesim
  frekansı (3,28 GHz) ile boş kılavuzunki (6,56 GHz) arasında enerji numunede yayılır, ancak
  yanındaki havada yayılamaz. Enerji içeride hapsolur ve durdurma ölçütüne ulaşılamaz. Düzenek bu
  birleşim için uyarı verir.
- **Bant.** Bant, boş kılavuzun TE10 kesim frekansı c/(2a) = 6,56 GHz'in üzerinde başlamalıdır.
  `f_max`, TE20 (13,1 GHz) veya TE01 (14,8 GHz) kesimine ulaştığında komut uyarır. Dolu bölümün
  kesim frekansları (εr 4 için TE20: 6,56 GHz) bant içindedir ve yalnızca raporlanır: kesiti
  dolduran homojen numune TE10'u TE20 veya TE01'e bağlamaz.
- **Kapsam.** Numune kılavuzu duvardan duvara doldurur. Gerçek numuneyle duvarlar arasında
  görünür εr'yi düşüren hava aralığı vardır; bölüm 17b bunu modeller. Dispersif numune
  (`Simulation.dispersive`, bölüm 15c) kılavuzda da çalışır: Debye numunesi (ε∞ 3, Δε 1,5,
  10 GHz'de gevşeme, Lorentz kutuplarına uydurulmuş), benzetilen kutuplarının kılavuzlu levha
  çözümüne göre en büyük |ΔS11| / |ΔS21| = 0,018 / 0,018 ve 20 hücre/λ'da NIST |Δε|/|ε| = %1,3
  verdi; düzlem dalga hücresiyle aynıdır.
- **Birim testleri** (`python/tests/test_waveguide_fixture.py`):
  - Kılavuzlu levha kapalı biçim çözümle uyuşur; kc = 0 için serbest uzay levhasına dönüşür.
  - Kılavuzlu NRW ve NIST, sentetik S-parametrelerinden kayıpsız, kayıplı ve manyetik numuneleri
    1e-9 doğrulukla geri elde eder; kayıplı örnekte %0,5 yavaş sayısal β0 ile de aynı sonuç alınır.
    Çalıştırıcı kılavuzlu S-parametrelerinden Debye numunesinin ε(f) değerini geri elde eder;
    hücre gibi, çözümlenmemiş kutupları reddeder.
  - Referans düzlemi taşıma, yüzlere referanslı S-parametrelerini tam olarak geri elde eder.
  - Düzeneğin mesh'i, portları, boş referansı, kesimleri ve bant denetimi; çalıştırıcının zaman
    adımı eşleştirmesi ve sonuç alanları FDTD çalıştırması olmadan denetlenir.

### 17b. Numune ile kılavuz duvarları arasındaki hava aralığı

Aynı düzenekte numuneyle her geniş duvar (`gap_y`; TE10'un E alanı aralığı geçer) veya her dar
 duvar (`gap_x`; alan sıfıra yakındır) arasında, iki yanda eşit hava aralığı bırakılır. Numune:
10,3 GHz'de εr 4, tan δ 0,02; 10 mm. `fairbeam material-cell` görünür εr'yi (ölçülen yayılım
sabitini vermek için tam dolu numunenin sahip olması gereken değer) çıkarır ve
`fairbeam.waveguide_fixture.gap_correction` ile düzeltir. İki modeli NIST Teknik Not 1355-R
(Baker-Jarvis ve diğerleri, 1993), Ek C'yi izler; formüller kopyalanmamış, modellerden türetilerek
kodda yazılmıştır:

- **`resonance`** (varsayılan; C.1.1, denklem C.1–C.4): kılavuz yüksekliği boyunca enine
  rezonans, her frekansta çözülür. Eşit aralıklarda merkez düzlemi simetri düzlemidir; yarım
  kılavuz b/2 − gap_y yüksekliğinde numune ve gap_y aralığı içerir. Kutupları kaldırmak için
  çarpılıp açılmış biçim: k1 sin(k1 d) − ε κ tanh(κ gap_y) cos(k1 d) = 0;
  k1 = k0 √(ε − ε_app), κ = k0 √(ε_app − 1), d = b/2 − gap_y. Kapasitör değerinden başlanarak
  karmaşık Newton yöntemiyle ε için çözülür. Sonuç temel köktür; denklem k1 ve κ'ya göre çift
  olduğundan karekök dalları sonucu değiştirmez.
- **`capacitor`** (C.2.2, denklem C.23–C.24; orada toplam aralık b − d için, burada 2 gap_y):
  numune ve iki aralık seri bağlıdır: b / ε_app = (b − 2 gap_y) / ε + 2 gap_y. Bu, rezonans
  modelinin frekanstan bağımsız (yarı statik) limitidir (TN 1355-R, düşük frekansta C.1'in
  Westphal denklemine indirgendiğini belirtir).
- **Dar duvarlar** (iki modelde de; TN 1355-R'de yoktur, burada türetilmiştir): aralıklar ve
  numune yan yanadır; TE10 alan enerjisi sin²(πx/a) ile ağırlıklandırılır:
  ε_app = w + (1 − w) ε; w = 2 gap_x / a − sin(2π gap_x / a) / π. Aralığa göre birinci derece yaklaşım.

```bash
cd python
python -m fairbeam material-cell examples/wr90_fixture.py --set tan_d=0.02 --set gap_y=0.1 --nist --threads 4 --out <folder> --sim-root <folder>
python -m fairbeam material-cell examples/wr90_fixture.py --set tan_d=0.02 --set gap_x=0.5 --nist --threads 4 --out <folder> --sim-root <folder>
```

Aşağıdaki satırlar için `--set gap_y=` ile 0,025; 0,05; 0,1 veya 0,2; `--set gap_x=` ile 0,1
veya 0,5 kullanın. İnce mesh için `--set cpw=30` ekleyin. Sonuç dosyası görünür değerleri
`material.nrw` / `material.nist`, rezonans düzeltmesini `material.gap_correction`, kapasitör
düzeltmesini `material.gap_correction.capacitor` altında tutar. Numunenin εr′ = 4 değerine göre
NIST εr′ hatası: 8,2–12,4 GHz bant ortalaması (401 frekans), parantezde banttaki en büyük değer:

| Aralık (her yanda) | hücre/λ | görünür | düzeltilmiş, kapasitör | düzeltilmiş, rezonans | 10,3 GHz'de tan δ: görünür / kapasitör / rezonans | zaman adımı | hücre |
| --- | --- | --- | --- | --- | --- | --- | --- |
| yok | 20 | +0,21 % (0,48) | +0,21 % (0,48) | +0,21 % (0,48) | 0,0206 / 0,0206 / 0,0206 | 1 025 | 14 535 |
| yok | 30 | +0,11 % (0,24) | +0,11 % (0,24) | +0,11 % (0,24) | 0,0204 / 0,0204 / 0,0204 | 1 517 | 41 847 |
| gap_y 0,025 mm | 20 | −1,17 % (1,32) | +0,30 % (0,54) | +0,26 % (0,51) | 0,0202 / 0,0206 / 0,0206 | 42 517 | 62 985 |
| gap_y 0,025 mm | 30 | −1,28 % (1,36) | +0,18 % (0,30) | +0,15 % (0,26) | 0,0200 / 0,0204 / 0,0204 | 41 480 | 128 760 |
| gap_y 0,05 mm | 20 | −2,45 % (2,60) | +0,45 % (0,69) | +0,32 % (0,54) | 0,0199 / 0,0207 / 0,0206 | 21 238 | 54 910 |
| gap_y 0,05 mm | 30 | −2,57 % (2,64) | +0,32 % (0,43) | +0,19 % (0,27) | 0,0197 / 0,0205 / 0,0204 | 20 760 | 112 665 |
| gap_y 0,1 mm | 20 | −4,77 % (4,92) | +0,92 % (1,15) | +0,42 % (0,60) | 0,0194 / 0,0209 / 0,0206 | 10 660 | 46 835 |
| gap_y 0,1 mm | 30 | −4,90 % (5,00) | +0,77 % (0,88) | +0,27 % (0,46) | 0,0192 / 0,0207 / 0,0204 | 10 179 | 96 570 |
| gap_y 0,2 mm | 20 | −8,73 % (8,90) | +2,39 % (2,65) | +0,62 % (1,15) | 0,0185 / 0,0216 / 0,0204 | 5 240 | 38 760 |
| gap_y 0,2 mm | 30 | −8,88 % (8,99) | +2,19 % (2,40) | +0,44 % (0,94) | 0,0183 / 0,0214 / 0,0202 | 5 320 | 80 475 |
| gap_x 0,1 mm | 20 | +0,28 % (0,51) | +0,28 % (0,51) | +0,28 % (0,51) | 0,0206 / 0,0206 / 0,0206 | 10 660 | 29 835 |
| gap_x 0,1 mm | 30 | +0,13 % (0,24) | +0,13 % (0,24) | +0,13 % (0,24) | 0,0204 / 0,0204 / 0,0204 | 10 701 | 66 378 |
| gap_x 0,5 mm | 20 | +0,25 % (0,49) | +0,26 % (0,50) | +0,26 % (0,50) | 0,0206 / 0,0206 / 0,0206 | 2 310 | 21 420 |
| gap_x 0,5 mm | 30 | +0,12 % (0,23) | +0,13 % (0,24) | +0,13 % (0,24) | 0,0204 / 0,0204 / 0,0204 | 2 460 | 50 505 |

- **Geniş duvar aralıkları görünür εr′ değerini belirgin düşürür.** Her yanda 0,025 mm aralık
  (kılavuz yüksekliğinin %0,5'i) %1,2–1,3; 0,2 mm ise %8,8 düşürür. Görünür tan δ da düşer
  (0,2 mm'de 0,02 yerine 0,0183). İki mesh 0,15 yüzde puan içinde uyuşur; etki ayrıklaştırmadan
  değil, hava aralığından kaynaklanır.
- **Düşüş rezonans modelini izler.** Aralıksız sonuca göre (30 hücre/λ), 0,025–0,2 mm için
  simülasyon −%1,39; −%2,68; −%5,01; −%8,99; rezonans modelinin bant ortalamaları −%1,42,
  −%2,75; −%5,15; −%9,24; kapasitör modeli −%1,45; −%2,87; −%5,58; −%10,56 verir.
- **Kapasitör düzeltmesi yarı statik olduğu için fazla düzeltir.** Düzeltilmiş εr′ aralıksız
  sonucun 0,07; 0,21; 0,65; 2,08 yüzde puan üzerinde kalır (0,2 mm'de +%2,2); tan δ da yüksek
  çıkar (0,0204 yerine 0,0214). Temel neden frekanstan bağımsız olmasıdır: enine rezonansın
  düşük frekans limitidir; aralığın etkisi frekansla azalır (rezonans modelinde 0,2 mm için
  8,2 GHz'de −%9,7'den 12,4 GHz'de −%8,7'ye).
- **Rezonans düzeltmesi geriye 0,04–0,32 yüzde puan bırakır** (30 hücre/λ; 20'de 0,05–0,41);
  tan δ, aralıksız değerin 0,0002 yakınındadır. Kalan fark aralıkla büyür, mesh inceldikçe
  küçülür (0,2 mm'de 0,41 → 0,32). Bir kısmı FDTD'nin aralığı iki hücreyle çözümlemesinden,
  kalanı rezonans modelinin yaklaşımlarından (köşelerde alan bükülmesinin ihmal edilmesi,
  dar duvar ağırlıklandırması) kaynaklanır; bu çalışma bunları ayırmaz.
- **Dar duvar aralıklarının etkisi çok azdır.** TE10 alanı dar duvarlarda sıfıra yakındır.
  Model 0,5 mm için −%0,01 verir; simülasyon bunu aralıksız sonuçtan ayıramaz (0,07 yüzde puan
  içinde, yalnızca daha ince enine mesh'in oluşturduğu değişim düzeyinde).
- **Yüksek modlar.** Simetri nedeniyle dar duvar aralığı TE30'u (kesim 19,7 GHz), geniş duvar
  aralığı TE12 / TM12'yi (30,2 GHz) uyarır; TE11 / TM11 (16,2 GHz) için asimetrik aralık gerekir.
  Referans düzlemlerine kadar 22,86 mm'de, 12,4 GHz için 64 dB ve 115 dB sönümlenirler
  (TE11 / TM11 43 dB sönümlenirdi); bu nedenle düzlem konumları korunur. Düzlemleri 45,72 mm'ye
  taşıyan denetim, aralıklı ve aralıksız durumda sonuçları aynı miktarda değiştirir
  (|ΔS11| ≤ 0,015, tek frekanslarda NIST εr′ %0,7, bant ortalaması %0,03). Bu düzeneğin kendi
  değişkenliğidir; yüksek modların ölçülebilir etkisi kalmaz. Hava aralığının modları f_max'ta
  40 dB'den az sönümlenecekse düzenek uyarı vererek düzlemleri dışarı taşır.
- **Hesaplama maliyeti.** Aralıktaki en az iki hücre zaman adımını belirler: 0,025 mm aralık,
  20 hücre/λ'da dolu kılavuzun 41 katı (30'da 27 katı) adım gerektirir. İki çalıştırma
  4 iş parçacığında 75–100 s sürer; aralıksız durumda 2–3,5 s'dir. Uygulamada aralığı ölçün;
  ardından `gap_x` / `gap_y` ile simülasyon yapın veya ölçülen veriye `gap_correction` uygulayın.
- **Birim testleri** (`python/tests/test_waveguide_fixture.py`, `AirGap` ve çalıştırıcı):
  - kapasitör modeli, TN 1355-R denklem C.23–C.24'e göre (gerçek ve sanal kısımlar, toplam
    aralık b − d = 2 gap_y) ve rezonans modelinin düşük frekans limiti olarak;
  - rezonans düzeltmesinin kayıpsız ve kayıplı numunelerde ileri modelini temel kökte,
    karekök dallarından bağımsız tersine çevirmesi ve WR-90 bant ortalamaları;
  - dar duvar ağırlığının TE10 alan enerjisi integraliyle karşılaştırılması;
  - aralık modları ve sönümleri, kademeli enine mesh (numune kenarları çizgiler üzerinde,
    aralıkta en az iki hücre, büyüme oranı ≤ 1,3, aralıksız durumda değişiklik yok), taşınan
    referans düzlemleri;
  - sonuç dosyasında iki düzeltme; `--tol-material` rezonans düzeltmesini denetler.

## 18. WR-90 iletimi için sınırlı karşılaştırma

[Pozar karşılaştırma kaydı](benchmarks/pozar-comparisons.md), Örnek 3.9 ile ilişkili sınırlı
WR-90 iletim denetimini belgeler. Windows'ta paketlenen openEMS 0.37.0rc3 çalışma ortamıyla,
mevcut `python/examples/waveguide_thru.py`, sabit ölçüm düzlemleri ve üç mesh kullanılır.

Kabul edilen büyüklükler, kaydedilen yansıma denetimine ve enerji durdurmalarına bağlı olarak,
8,2–11,8 GHz boyunca karmaşık S21 ve 10 GHz'deki fazıdır. Tüm hedef denetimleri ve ardışık
iki mesh karşılaştırması, çalıştırmalardan önce belirtilen toleransları sağlar. Ayrı ölçülen
grup hızı yakınsama ölçütünü sağlamadığından Örnek 3.9'un tamamı doğrulanmış değildir.
Bu sınırlı karşılaştırma, başka hiçbir örneğin durumunu doğrulanmış olarak değiştirmez.

Kayıt model parametrelerimizi, denklemleri ve sayısal sonuçları içerir; galeriye yeni paket eklemez.

## 19. Bölüm 3 karşılaştırma kapsamları

[Bölüm 3 kaydı](benchmarks/pozar-chapter-03.md), Örnek 3.1–3.7 için hedefi ve mesh
ölçütlerini sağlayan büyüklükleri, çoğaltma komutları ve açık model sınırlarıyla toplar.
Örnek 3.1, kaynak darbesi tamamlanmış ve tam -80 dB duruşlu yeni 20/30/40 koşu
grubunu kullanır; tarihsel erken durdurulmuş kolonlar kapsam dışında kalır. Diğer
eski gruplar ve taşıma kontrolleri özgün kaynak bilgilerini korur. Kayıt sonlu mesh
farkı sınırlarını ve monoton olmayan değişimi açıkça belirtir; kabul yalnızca
listelenen büyüklük ve geometri için geçerlidir, asimptotik sıra iddiası taşımaz.

İletken kaybı sapmaları, kabul edilmeyen mikroşerit empedans/kayıp sonuçları, eksik 3.8
mesh dizisi ve yukarıda belirtilen ayrı grup hızı sınırlaması bu kapsamın dışındadır.
Hiçbir galeri modeli veya üretilmiş paket değişmez.

## 20. Bölüm 4 karşılaştırma kapsamları

[Bölüm 4 kaydı](benchmarks/pozar-chapter-04.md), 4.8 için hedefi ve mesh ölçütlerini
sağlayan ideal akımla hesaplanan modal genlik ve giriş direncini toplar. Darbe
tamamlanıp kesin -90 dB enerji duruşuna ulaşıldıktan sonra iki ardışık mesh farkı,
bağımsız sınır kontrolü ve kendi hedef/kalite ölçütlerini sağlar. 4.2 arayüzü,
yeni sınır kontrolü enerji duruşunu sağlayamadığı için kapsam dışında kalır.

Filament reaktansı, pratik beslemeler ve genel mod dönüşümü kapsam dışındadır.
Probun hedef hataları monoton değildir; sınır/prob üçlüsü duyarlılığı doğruluk iddiasını
belirlenen toleranslarla sınırlar. Yalnız hesap içeren altı örnek yeni FDTD gerektirmez.
Hiçbir galeri modeli veya üretilmiş paket değişmez.

## 21. Bölüm 5 karşılaştırma kapsamları

[Bölüm 5 kaydı](benchmarks/pozar-chapter-05.md), Örnek 5.3 ve 5.5–5.8 için ilan edilen
hedef, ardışık mesh ve bağımsız sınır ölçütlerini sağlayan örneklenmiş ideal TEM
kapsamlarını toplar. Sürekli geçişler ayrıca iki profil inceltme ölçütünü sağlar.
Her bağımsız fikstür PR'ına ve çoğaltma komutlarına bağlantı verir.

Örnek 5.1, 5.2 ve 5.4, durdurma veya sayısal ölçütleri sağlamadığından kapsam dışındadır.
Kesin Chebyshev/Klopfenstein dalgalanma sınırı, gerçek PCB yerleşimleri ve Designer'daki
genel ölçümler kabul edilen kapsamların dışındadır.

## 22. Bölüm 6 karşılaştırma kapsamları

[Bölüm 6 kaydı](benchmarks/pozar-chapter-06.md), ideal koaksiyel rezonatör (6.1),
dikdörtgen TE101/TE102 boşluklar (6.3) ve kapalı silindirik TE011 boşluk (6.4)
için örneklenmiş dielektrik kayıp frekansı ve yüksüz Q kapsamlarını toplar.
Açıkça tanımlanan, eşlenmiş TEM devre dualinde (6.6) karmaşık yansıma,
rezonans ve yüklü Q da bağımsız daha sıkı zaman kontrolüyle kaydedilir.
İki ardışık mesh karşılaştırması ve ilan edilen bağımsız kontroller sabit
sınırlarını sağlar; asimptotik yakınsama sırası iddia edilmez.

Açık mikroşerit ve dielektrik rezonatör Q'su, hacimsel bakır kaybı, gerçek
kuplaj boşlukları ve ölçülmemiş harici/radyasyon Q payları kapsam dışında kalır.
Örnek 6.7/6.8 yalnız hesap içerir. Kayıt fikstür PR'larını ve çoğaltma
komutlarını bağlar; galeri modeli, üretilmiş paket veya kitap içeriği eklemez.

6.2 için onaylanan üç uzun, kapalı mikroşerit inceltme koşusu tamamlandı.
Durdurma, ardışık mesh ve hava açıklığı kontrolleri sağlanır; ancak ince mesh
frekans hatası %1,017947 ile değişmeyen %1 hedefini aşar. Bu kapsam kabul
edilmez; bölüm kaydı PR #81'deki tam ölçümlere bağlantı verir.
