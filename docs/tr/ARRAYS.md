# Diziler: gömülü eleman örüntüleri ve hüzme yönlendirme

Bu sayfa Fairbeam'in faz dizisi desteğinin veri yapısını açıklar: çok portlu anten çalıştırmasının ne kaydettiği, bu verilerden dizi örüntülerinin nasıl oluşturulduğu ve sayıların anlamı. Görüntüleyicinin hüzme yönlendirme kontrolleri aynı verileri `src/lib/sparams.ts` ve `src/lib/array.ts` üzerinden okur.

## Port başına bir simülasyon

N portlu modelde `fairbeam run`, uyarılan her port için modeli bir kez kurup çalıştırır (varsayılan: N ≤ 4 ise tüm portlar, değilse port 1; `--excite all|1,3` ile değiştirin). Her çalıştırmada bir port uyarılır; diğerleri yerinde, dirençleriyle sonlandırılmış olarak kalır. Her çalıştırma şunları kaydeder:

- Her porttaki güç dalgaları; bunlar S-matrisinin bir sütununu verir (`results.sparams`, bkz. [BUNDLE.md](BUNDLE.md#sparams)).
- Çalıştırmanın uzak alanı (`port` ile etiketlenmiş `results.farfield` kayıtları).
- θ/φ ızgarasında karmaşık **gömülü eleman örüntüsü** E_θ, E_φ (`results.element_patterns`).

Örüntüler *gömülüdür*: bir port uyarılırken diğer elemanlar yerindedir ve yüklüdür. Bu nedenle karşılıklı kuplajı, komşulardan saçılmayı ve sonlu toprak düzlemini içerir. Dizi analizinin standart temeli budur (Mailloux, *Phased Array Antenna Handbook*, bölüm 6; Hansen, *Phased Array Antennas*, bölüm 7).

## Normalizasyon

Kaydedilen her örüntü, portunda **birim gelen güç dalgasının**, `a = U_inc / sqrt(Z_ref) = 1 sqrt(W)`, `radius_m` (1 m) uzaklıkta ürettiği uzak alan fazörü E'dir (V/m, tepe). Tüm portlar aynı faz merkezini (`phase_center`, modelin NF2FF merkezi) kullanır; örüntüler doğrudan üst üste toplanabilir.

Karmaşık uyarım ağırlıkları w_j için (portlardaki gelen dalgalar, sqrt(W)):

| Büyüklük | Tanım |
| --- | --- |
| Dizi alanı | E(θ, φ) = Σ_j w_j E_j(θ, φ) |
| Işıma şiddeti | U = r² (\|E_θ\|² + \|E_φ\|²) / (2 η0) |
| Gelen güç | P_inc = ½ Σ_j \|w_j\|² |
| Işınan güç | P_rad = fiziksel uzayda ∮ U dΩ (görüntü uzayı 2^mirror_planes değerine bölünür) |
| Yönlülük | D = 4π U / P_rad |
| Gerçekleşen kazanç | G_r = 4π U / P_inc. Uyumsuzluğu, diğer portlara kuplajı ve kaybı içerir |
| Toplam verimlilik | P_rad / P_inc |
| Aktif yansıma katsayısı | Γ_active,i = Σ_j S_ij w_j / w_i. Tüm portlar uyarılırken i portunun gördüğü değerdir |

2×1 yama dizisinde tutarlılık kontrolü: `combine` ile yalnızca port 1'i uyarmak D_max = 6.27 dBi ve gerçekleşen kazanç 6.019 dBi verir. Paketin kendi tek port uzak alanında da örüntü D_max değeri 6.27 dBi, gerçekleşen kazanç 6.019 dBi'dir. Böylece süperpozisyon openEMS'in normalizasyonunu tam olarak yeniden üretir.

## Python API (`fairbeam.array`)


```python
import json
from fairbeam import array

b = json.load(open("public/projects/patch-array-2x1.json"))
r = array.combine(b, {1: 1, 2: 1})                   # broadside: equal amplitude and phase
print(r["dmax_dbi"], r["peak_theta"], r["peak_phi"], r["realized_gain_max_dbi"])
print(r["gamma_active_at_f"])                         # {port: complex}

w = array.steering_weights(b, theta0=20, phi0=90)     # textbook progressive phase
r = array.combine(b, w)
theta, d_dbi = array.cut(r, phi_deg=90)               # elevation cut through the scan plane

array.combine(b, {1: (1.0, 0), 2: (0.5, -60)})        # amplitude and phase in degrees also accepted
```

- `combine(bundle, weights, f=None)`, kaydedilmiş eleman örüntüsü frekanslarından `f` değerine en yakınında çalışır. dBi cinsinden `[theta][phi]` yönlülük ızgarasını, `dmax_dbi`, `peak_theta`, `peak_phi`, gerçekleşen kazanç ızgarasını ve maksimumunu, `p_inc_w`, `p_rad_w` ve `total_efficiency` döndürür. S-matrisi tamsa ayrıca `results.frequency` boyunca port başına `gamma_active` ve `gamma_active_at_f` döndürür.
- `steering_weights(bundle, theta0, phi0, f=None, amplitudes=None)`, eleman konumları olarak **port merkezleriyle** w_n = A_n exp(−j k r̂0 · r_n) döndürür.
- Ağırlıklar `{port: complex}` veya `{port: (amplitude, phase_deg)}` sözlüğü ya da port sıralı dizi olabilir. Ağırlık verilmeyen portlar uyarılmaz, sonlandırılır.

## Gösterim: `python/models/patch_array_2x1.py`

Model, `patch_antenna.py` dosyasındaki sonda beslemeli yamanın iki kopyasını (32 × 40 mm, ε_r 3.38, 1.524 mm) tek alttaşta içerir. H-düzlemi olan y yönünde 61.2 mm aralıklıdır (2.45 GHz'de λ0/2). MUR sınırları ve mesh_div 20 kullanır. İki GPU çalıştırması toplam 2.8 s sürmüştür.

| Büyüklük | Değer |
| --- | --- |
| Rezonans (minimum S11), her port | 2.4345 GHz, −25.3 dB |
| Rezonansta kuplaj S21 | **−17.3 dB** (H-düzlemi, λ/2). Tipik ölçülen değerler −17 ile −20 dB'dir |
| Karşılıklılık \|S21 − S12\| | < 1e-6 (mesh ayna simetrisine sahiptir) |
| Tek eleman | D_max 6.27 dBi (örüntü), gerçekleşen kazanç 6.02 dBi, ışıma verimliliği 0.93 |

Aynı iki çalıştırmadan değerlendirilen uyarımlar:

| Ağırlıklar | D_max | Hüzme tepesi (θ, φ) | Gerçekleşen kazanç | \|Γ_active\| port 1 / 2 |
| --- | --- | --- | --- | --- |
| Yalnızca port 1 | 6.27 dBi | (9°, 265°) | 6.02 dBi | −25.3 dB / – |
| Diziye dik yön, 1 : 1 | 9.19 dBi | (0°, –) | 9.01 dBi | −21.7 dB / −21.7 dB |
| θ0 = 20° için kuramsal dağılım (61.2° kademeli faz) | 9.14 dBi | (15°, 90°) | 8.93 dBi | −18.8 dB / −18.0 dB |
| θ0 = 30° için kuramsal dağılım (89.5° kademeli faz) | 8.99 dBi | (21°, 90°) | 8.74 dBi | −17.0 dB / −16.4 dB |

- **Dizi kazancı**: diziye dik yöndeki D_max, tek gömülü elemandan 2.9 dB yüksektir; iki eleman için ideal değer 3.01 dB'dir. Fark, kuplaj ve elemanların asimetrik gömülü örüntülerinden kaynaklanır.
- **Hüzme kuramsal açıya ulaşmaz** (20° dağılım için 15°, 30° için 21°). Yalnızca iki elemanla dizi faktörü geniştir; diziye dik yönden uzaklaştıkça azalan eleman örüntüsüyle çarpılması tepeyi θ = 0'a çeker. Tam 20° için daha fazla faz veya eleman gerekir. `combine` gerçek tepeyi bildirir.
- **Tarama uyumu değiştirir**: kuplaj dalgası yansımaya tarama açısına bağlı bir fazla eklendiğinden aktif yansıma, dik yöndeki −21.7 dB'den 30° dağılımında −17 dB'ye yükselir. Büyük dizilerde tarama körlüğünün ardındaki etki budur; burada hafiftir.
- openEMS'in kendi yönlülük değeri (6.37 dBi, NF2FF yüzey gücü) ile örüntü integrali (6.27 dBi) arasında 0.1 dB fark vardır. Nedeni MUR sınırlarıdır (VALIDATION.md, bölüm 1c). `combine` daima örüntü integralini kullanır.

## 4×1 yama dizisi: `python/models/patch_array_4x1.py`

Bu model aynı yamanın, y yönünde 61.2 mm aralıklı dört kopyasını içerir (2.45 GHz'de λ0/2; 2.4525 GHz rezonansında d/λ = 0.501). PML sınırları ve otomatik mesh kullanır ([MESHING.md](MESHING.md)): 433 bin hücre, dört GPU çalıştırması toplam 18 s. Paket 0.64 MB'dir; eleman örüntüleri tam 3° × 5° ızgaradadır (seyreltme gerekmez).

**2.4525 GHz'de S-matrisi** (karşılıklılık 2.2e-3, en büyük sütun gücü 0.995):

| | Port 1 (kenar) | Port 2 (iç) |
| --- | --- | --- |
| Yansıma | S11 −23.5 dB | S22 −17.0 dB |
| 1. komşu | S21 −15.7 dB | S32 −14.3 dB |
| 2. komşu | S31 −24.7 dB | S42 −24.5 dB |
| 3. komşu | S41 −33.3 dB | – |

Yamalar tek başlarına ayarlanmıştır. Dizi içinde iç elemanlar daha fazla kuplaj görür; kendi uyumları kenardaki −23.5 dB'den −17 dB'ye düşer. Buradaki komşu kuplajı (−14 ile −16 dB), 2×1 modelinden 1.5–3 dB daha güçlüdür. Modellerin mesh'i (otomatik/elle) ve sınırları (PML/MUR) farklıdır; bu sonuçlar daha güvenilirdir.

**Gömülü eleman örüntüleri.** Kenar elemanın D_max değeri 6.66 dBi'dir; tepe dik yönden dizinin dışına doğru 6° sapar, gerçekleşen kazanç 6.26 dBi'dir. İç elemanın D_max değeri 6.60 dBi'dir; daha geniş ve eğik örüntüsü dizi düzleminde θ = 30° yönünde tepe yapar, gerçekleşen kazancı 5.93 dBi'dir. Gücünün daha fazlası sonlandırılmış komşulara kuplajlandığından ışıma verimliliği kenar elemandaki 0.92 yerine 0.87'dir.

Dizi düzleminde (φ = 90°) kuramsal kademeli fazla **tarama** (`array.steering_weights(b, θ0, 90)`):

| θ0 | Faz adımı | D_max | Hüzme tepesi | HPBW | En büyük yan lob (ön) | Gerçekleşen kazanç | η_total | \|Γ_active\| port 1 / 2 / 3 / 4 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0° | 0° | 11.95 dBi | 0° | 24° | −14.2 dB (−42°'de) | 11.77 dBi | 0.959 | −24.1 / −15.0 / −15.0 / −24.1 dB |
| 15° | 46.5° | 11.84 dBi | 15° | 24° | −12.3 dB (−27°'de) | 11.66 dBi | 0.959 | −21.3 / −17.4 / −16.7 / −21.9 dB |
| 30° | 90° | 11.69 dBi | 27° | 24° | −11.1 dB (−12°'de) | 11.43 dBi | 0.942 | −17.0 / −20.0 / −19.1 / −16.6 dB |
| 45° | 127° | 11.35 dBi | 39° | 27° | −9.0 dB (0°'de) | 10.59 dBi | 0.840 | −12.7 / −9.5 / −9.0 / −12.3 dB |

- **Dizi kazancı**: dik yöndeki D_max gömülü elemandan 5.3–5.35 dB yüksektir (dört eleman için ideal 6.02 dB). Eksiklik, özdeş olmayan gömülü örüntüler ve kuplajdan kaynaklanır.
- **Tarama kaybı**, 45°'de yönlülükte 0.6 dB, gerçekleşen kazançta 1.2 dB'dir. Gerçekleşen kazançtaki ek kayıp aktif uyumsuzluktur: iç elemanların |Γ_active| değeri dik yöndeki −15 dB'den 45°'de −9 dB'ye yükselir, toplam verimlilik 0.96'dan 0.84'e düşer. Faz dizisi tasarımında bu etki hesaba katılmalıdır; yalnızca gömülü örüntüler ve tam S-matrisiyle görünür.
- **Hüzme yönü**: büyük tarama açılarında tepe, komut edilen açının gerisinde kalır (30° için 27°, 45° için 39°). Çünkü eleman örüntüsü dik yönden uzaklaştıkça azalır (yukarıdaki 2×1 açıklaması).
- **Izgara lobları**: `array.grating_lobes(b, 45, 90)`, 1/(1 + sin 45°) = 0.586 sınırına karşı d/λ = 0.501 verir; görünür uzayda ızgara lobu yoktur. 45° taramada bunlar f = 0.586/0.501 × 2.4525 ≈ 2.87 GHz üzerinde, yamanın bant genişliği dışında oluşur. 45° örüntüsündeki en büyük yan lob (−9 dB, dik yöne yakın), ızgara lobu değil dört elemanlı dizinin olağan yan lobudur.
- **Bant genişliği**: yamalar dar bantlıdır. 30° taramada |Γ_active|, 2.45 GHz'de −14 ile −22 dB, ancak 2.40 ve 2.50 GHz'de yalnızca −3 ile −5 dB'dir.

## Depolama

`results.element_patterns`, port ve frekans başına n_θ · n_φ değerli dört diziyi, port/frekans başına bir ölçek katsayısıyla base64 little-endian int16 olarak saklar (`"i16le-base64-scaled"`; nicemleme adımı tepenin yaklaşık −90 dB altındadır, bu nedenle sentezlenen örüntüler tepenin 50 dB yakınında en fazla 0.01 dB değişir). 3° × 5° ızgarada port/frekans başına yaklaşık 47 kB'dir. Tek frekanslı 2×1 paket toplam 283 kB (gzip ile 118 kB), 4×1 paket 636 kB'dir (gzip ile 260 kB). Eski paketler float32 kullanır (`"f32le-base64"`, iki kat boyut) ve hâlâ okunur. Bölüm yaklaşık 2.5 MB'yi aşacaksa (float32 boyutuyla hesaplanır), θ/φ ızgarası tam sayı katsayıyla seyreltilir (`decimation` içinde kaydedilir); küre integralinin kapanması için θ = 180° korunur. Tam düzen [BUNDLE.md](BUNDLE.md#element-pattern-encodings) sayfasındadır.

## Sınırlamalar

- **Frekanslar**: örüntüler yalnızca kayıtlı uzak alan frekanslarında vardır. `--pattern` belirtilmedikçe bunlar ilk uyarılan portun bant merkezleridir. Γ_active tüm bantta kullanılabilir ancak frekanstan bağımsız ağırlıklar kullanır.
- Yönlendirme için **eleman konumları** port merkezleridir; aynı göreli noktadan beslenen özdeş elemanlar için uygundur. Diğer düzenlerde ağırlıkları açıkça verin.
- **Izgara lobları**, `array.grating_lobes` ile hesaplanır (düzgün doğrusal diziler; eleman konumları port merkezleri) ancak görüntüleyicide henüz otomatik işaretlenmez. Tarama körlüğü veya ızgara kenarında kesilen örüntüler için uyarı yoktur. Hüzme yönü optimizasyon aracı, Taylor veya Chebyshev dağılımı da yoktur; verilen ağırlıklar kullanılır.
- **Yönlülük** kayıtlı ızgarada (varsayılan 3° × 5°) integral alınarak hesaplanır. Büyük dizilerin çok dar hüzmeleri, `Simulation.evaluate` içinde daha küçük `theta_step` / `phi_step` gerektirir.
- **Maliyet**: port başına bir çalıştırma (N port için N çalıştırma). Büyük dizilerde küçük bir alt dizi simüle edin veya az sayıda portu uyarıp simetriden yararlanın. Yalnızca tüm portları uyarılmış diziler tam S-matrisine ve Γ_active değerlerine sahiptir.
- **Yarı uzay modelleri** (PEC toprak sınırı): `combine`, görüntü düzeltmesini `mirror_planes` ile uygular; bu yol henüz simüle edilmiş bir dizide doğrulanmamıştır.
