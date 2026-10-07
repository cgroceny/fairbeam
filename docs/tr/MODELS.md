# Model yazma

## Model dosyaları

Model, üç öğe tanımlayan düz bir Python dosyasıdır:

- `MODEL`: `id`, `name`, `description` ve isteğe bağlı `reference` içeren sözlük.
- `PARAMS`: `fairbeam.Param(key, default, label, unit, description, minimum, maximum)` listesi. `default` türü, `--set` değerlerinin nasıl ayrıştırılacağını belirler (int, float veya str).
- `build(p: dict) -> Simulation`: çözülmüş parametre değerlerini alır; geometri, portlar, mesh ve isteğe bağlı NF2FF kutusuyla tamamen yapılandırılmış `fairbeam.Simulation` döndürür.

**Mesh oluşturma**: geometri ve portlardan sonra (`add_nf2ff_box` öncesinde) `sim.auto_mesh()` çağırarak tüm mesh'i geometriden üretin: metal kenarlarında üçte bir kuralı, dar şeritler boyunca ince hücreler, çözümlenmiş dielektrik katmanları, kademeli hava ve λ/4 pay. Yakınsamış, elle ayarlanmış mesh'lerle %0.1 içinde uyuşur ([MESHING.md](MESHING.md)). Düzenleyici şablonları bunu kullanır.

`Simulation`, olağan openEMS/CSXCAD nesnelerini sarar (`sim.fdtd`, `sim.csx`, `sim.mesh`). Normal CSXCAD çağrılarını kullanabilirsiniz. `metal`, `dielectric`, `lumped_port`, `waveguide_port`, `lumped_resistor` (ideal R/L/C için ayrıca `lumped_element`, `lumped_inductor`, `lumped_capacitor`; bkz. [BUNDLE.md](BUNDLE.md#lumped_elements)), `add_nf2ff_box`, `smooth_mesh` ve `set_focus` yardımcıları, görüntüleyici ve VBA makro dışa aktarıcısının gerektirdiği üst verileri de kaydeder (kayıp tanjantı, port tanımları, faz merkezi, varsayılan kadraj). `sim.metal(name)` mükemmel iletkendir; `sim.metal(name, conductivity=5.8e7, thickness=0.035)` (S/m, mm) kayıplı metaldir: levhalar belirtilen kalınlıkta openEMS iletken levhası, hacimler ise belirtilen iletkenliğe sahip malzeme olur.

Model bir tasarımcı dosyası da olabilir (`<id>.design.json`, bkz. [DESIGNER.md](DESIGNER.md#files)): `fairbeam run`, `params`, `geometry`, `sweep`, `converge` ve `optimize`, `.py` yerine bunu kabul eder; hazır dosyalar `examples/designs/` içindedir. Ana ekran şablonlardan yeni tasarım oluşturur (boş tasarım, yarım dalga dipol, çeyrek dalga monopol, açık uçlu dalga kılavuzu, yama, baskı kılıflı dipol, mikroşerit hat).


```python
# minimal strip dipole (the shipped python/models/dipole.py adds PML, thirds-rule edges and a finer
# mesh around the strip; this bare version resonates ~8 % low, see docs/VALIDATION.md)
from fairbeam import Param, Simulation

MODEL = {"id": "dipole", "name": "Half-wave dipole",
         "description": "Thin-strip dipole with a centre lumped feed."}

PARAMS = [
    Param("length", 58.0, "Total length", "mm", minimum=5),
    Param("width", 1.0, "Strip width", "mm", minimum=0.1),
    Param("gap", 1.0, "Feed gap", "mm", minimum=0.2),
    Param("f_min", 1.5, "Band start", "GHz", minimum=0.1),
    Param("f_max", 3.5, "Band stop", "GHz", minimum=0.2),
]


def build(p: dict) -> Simulation:
    sim = Simulation(p["f_min"] * 1e9, p["f_max"] * 1e9)      # MUR boundaries, DC-free pulse
    L, w, g = p["length"], p["width"], p["gap"]
    arm = sim.metal("dipole", label="Dipole arms")
    arm.AddBox(priority=10, start=[-w / 2, 0, g / 2], stop=[w / 2, 0, L / 2])
    arm.AddBox(priority=10, start=[-w / 2, 0, -L / 2], stop=[w / 2, 0, -g / 2])
    sim.lumped_port(1, 73, [-w / 2, 0, -g / 2], [w / 2, 0, g / 2], "z")

    sim.mesh.AddLine("x", [-80, -w / 2, w / 2, 80])
    sim.mesh.AddLine("y", [-80, 0, 80])
    sim.mesh.AddLine("z", [-100, -L / 2, -g / 2, g / 2, L / 2, 100])
    sim.smooth_mesh()                                           # λ/20 at f_max
    sim.set_focus([-10, -10, -L / 2 - 5], [10, 10, L / 2 + 5])
    sim.add_nf2ff_box(center=[0, 0, 0])
    return sim
```


```bash
fairbeam params python/models/dipole.py
fairbeam run python/models/dipole.py --set length=60
```

Yapı ile emici sınırlar arasında `f_min` frekansında en az λ/4 boşluk bırakın (PML_8 bu payın içindedir; MUR yaklaşık λ/2 gerektirir). Dahil edilen modeller (`python/models/patch_antenna.py`, `python/models/sierpinski_monopole.py`) kenar mesh'i, dielektrikler, PEC toprak sınırları ve fraktal geometriyi gösterir.

## Dahil edilen modeller

`python/models/` içindeki her modelin `public/projects/` içinde simülasyon paketi ve [VALIDATION.md](VALIDATION.md) içinde doğrulama bölümü vardır.

| Model | Açıklama | Gösterdiği özellikler | Doğrulama |
| --- | --- | --- | --- |
| `dipole.py` | Yarım dalga şerit dipol, 2.4 GHz | Üçte bir kuralıyla kenarlar, PML, mesh incelemesi | §1 |
| `patch_antenna.py` | Dikdörtgen yama, RO4003C, sonda beslemesi | Dielektrik mesh'i, `--set mesh=auto` | §2 |
| `inset_patch.py` | FR4 üzerinde içeri beslemeli yama | Mikroşerit besleme, çentikler | §2b |
| `minkowski_patch.py` | Minkowski fraktal yama | Çokgen geometri | §2c |
| `sierpinski_monopole.py` | PEC toprak üzerinde Sierpinski yapısı | Yarı uzay, fraktal yinelemeleri | §3 |
| `microstrip_line.py` | 50 Ω geçiş hattı | İki portlu S-matrisi | §7 |
| `wilkinson_divider.py` | Yalıtım dirençli Wilkinson bölücü | Toplu direnç, üç port | §8 |
| `patch_array_2x1.py`, `patch_array_4x1.py` | Yama dizileri | Gömülü eleman örüntüleri, yönlendirme | §9, [ARRAYS.md](ARRAYS.md) |
| `branchline_coupler.py` | 90° hibrit | Dört port, `auto_mesh` | §11 |
| `lowpass_stepped.py` | 5. dereceden basamaklı empedanslı alçak geçiren | Dar hatlar, `auto_mesh` | §12 |
| `pyramidal_horn.py` | Optimum 16 dBi horn, WR-90, 10 GHz | Çokyüzlü duvarlar, **dalga kılavuzu portu**, bir yüzü atlanan NF2FF | §13 |
| `helix_axial.py` | Kraus eksenel mod helis, 2.4 GHz | İnce tel `Curve`, **dairesel polarizasyon çıktıları** | §14 |

## Düzlemsel olmayan geometri, dalga kılavuzu portları ve dairesel polarizasyon

- **Eğik katılar**: üçgen yüzlü CSXCAD `Polyhedron` olarak oluşturun (CSXCAD yalnızca üçgenleri doğru rasterleştirir; `pyramidal_horn.py` içindeki `slab()` işlevine bakın). Paket, görüntüleyici ve çizim çokyüzlüleri tam olarak yeniden üretir; `auto_mesh` her köşe koordinatına çizgi yerleştirir. Döndürülmüş şekiller (`AddTransform`) doğru simüle edilir ancak yalnızca sınırlayıcı kutu olarak dışa aktarılır.
- **İnce teller**: CSXCAD `Curve` (yarıçapsız nokta listesi), en yakın mesh kenarlarına yerleştirilir; `auto_mesh` uzanımını yarı boyutlu hücrelerle kapsar. Etkin yarıçapı bir hücrenin kesridir; bu nedenle giriş empedansı mesh'e bağlıdır (bkz. §14). Yarıçaplı `Wire`, hacim olarak rasterleştirilir ve yarıçaptan küçük hücreler gerektirir.
- **Dalga kılavuzu portları**: `sim.waveguide_port(n, start, stop, "z", a, b, "TE10")` kılavuz kesitini kapsar; uyarım `start`, problar `stop` düzlemindedir. Kılavuzu port arkasındaki PML içine uzatın (`auto_mesh(pad=[q, q, q, q, 0, q])` o yüzü yapı üzerinde bırakır); geçtiği NF2FF yüzünü atlayın (`add_nf2ff_box(directions=[1, 1, 1, 1, 0, 1])`). S11, TE dalga empedansına göredir ([BUNDLE.md](BUNDLE.md#ports)). Kesiti tek bir homojen, dispersif olmayan malzemeyle dolu kılavuzda aynı değerleri porta da verin (`eps_r=2.08`, `mu_r=1.0`, yalnızca Python modelleri): referans, dolu kılavuzun β ve Z_TE değerlerini kullanır. Bu anahtarlar yalnızca referansı ayarlar; malzemeyi normal şekilde çizin. Verilmezse hava referansı korunur (`python/examples/rectangular_guide_loss.py` bunları kullanır).
- **Dairesel polarizasyon**: `sim.cp_outputs = True`, her uzak alana RHCP/LHCP yönlülük ve eksenel oran ızgaraları ekler.
- **Örüntü frekansları**: `sim.pattern_freqs = [...]` (Hz), varsayılan bant merkezlerini değiştirir; örneğin geniş bantlı antenlerde bant kenarları ve tasarım frekansı kullanılabilir.

## Malzeme kütüphanesi

`fairbeam.materials`, yaygın anten malzemelerinin nominal değerlerini kaynaklarıyla içerir. Tasarımcıdaki **Malzeme kütüphanesi** penceresi (Modelleme şeridi, Malzemeler grubu, **Kütüphane**) aynı listeyi (`src/designer/materials.ts`) gösterir ve seçilen değerleri tasarıma kopyalar; böylece tasarım dosyası bağımsız kalır. Python modelinde `ro = fairbeam.materials.get("ro4003c")`, ardından `sim.dielectric("sub", ro["eps_r"], tan_d=ro["tan_d"], tan_d_freq=ro["tan_d_freq"] * 1e9)` kullanın. Laminatlar üretim partisi, kalınlık ve frekansa göre değişir; kritik tasarımlarda satın aldığınız laminatın veri sayfasını kullanın. openEMS kaybı sabit iletkenlikle modeller; tan δ belirtilen frekansta doğrudur (boşsa bant merkezi). Kütüphanedeki PEC mükemmel iletkendir; iletken kaybı için tasarım metaline `conductivity` (S/m, boş = PEC), levhalara ayrıca `thickness` (mm; varsayılan 0.035) verin.

| Malzeme | Tür | εr | tan δ | Frekans | Kaynak ve notlar |
| --- | --- | --- | --- | --- | --- |
| PEC (bakır) | metal | | | | Mükemmel elektrik iletkeni (openEMS metali). Bakırın sonlu iletkenliği (5.8e7 S/m) ve yüzey pürüzlülüğü modellenmez; baskı antenlerde iletken kaybı küçüktür. |
| FR4 | dielektrik | 4.3 | 0.02 | 1 GHz | Genel cam-epoksi laminat. εr 4.2–4.7 ve tan δ 0.015–0.025; reçine oranı, tedarikçi ve frekansa göre değişir. Laminatınızın veri sayfasını kullanın. |
| Rogers RO4003C | dielektrik | 3.38 | 0.0027 | 10 GHz | Rogers RO4003C veri sayfası: 10 GHz, 23 °C'de proses εr 3.38 ± 0.05 ve tan δ 0.0027 (Rogers devre tasarımı için tasarım εr değeri 3.55'i önerir). |
| Rogers RO4350B | dielektrik | 3.48 | 0.0037 | 10 GHz | Rogers RO4350B veri sayfası: 10 GHz, 23 °C'de proses εr 3.48 ± 0.05 ve tan δ 0.0037 (tasarım εr 3.66). |
| Rogers RT/duroid 5880 | dielektrik | 2.2 | 0.0009 | 10 GHz | Rogers RT/duroid 5880 veri sayfası: 10 GHz'de εr 2.20 ± 0.02 ve tan δ 0.0009. |
| Taconic TLY-5 | dielektrik | 2.2 | 0.0009 | 10 GHz | Taconic (AGC) TLY-5 veri sayfası: 10 GHz'de εr 2.20 ± 0.02 ve tan δ 0.0009. |
| %99.5 alümina | dielektrik | 9.8 | 0.0001 | 10 GHz | %99.5 alümina ince film alttaşları için tipik değerler (mikrodalga frekanslarında εr 9.7–9.9, tan δ yaklaşık 0.0001); tedarikçi değerini kontrol edin. |
| PTFE (Teflon) | dielektrik | 2.1 | 0.0002 | 10 GHz | Kütlesel PTFE, tipik: 1–10 GHz arasında εr 2.0–2.1, tan δ 0.0001–0.0003. |
| Hava / vakum | dielektrik | 1 | 0 | | Serbest uzay. Arka plan zaten vakumdur; başka dielektrikte hava boşluğu veya delik açmak için daha yüksek öncelikle kullanın. |

Tasarımcıda bu yerleşik listenin yanında kişisel **Malzemelerim** listesi de vardır (tasarım malzemelerinden kaydedilir, çalışma klasörünün `materials.json` dosyasında saklanır; bkz. [DESIGNER.md](DESIGNER.md#materials-and-parts)). `fairbeam.usermaterials` bu dosyayı doğrular; Python modelleri okumaz, tasarım da bu dosyaya başvurmaz.

## Uygulamada model yazma

`fairbeam serve` çalışırken (masaüstü uygulaması başlatır), Ana ekran › Python modelleri yoluyla açılan Python modelinin Çalıştır panelinde **Model kodu** sekmesi bulunur: CodeMirror düzenleyicide Python renklendirmesi ve ⌘F / Ctrl+F ile arama. Çalıştır panelindeki **Yeni**, Yeni model penceresini açar; *Python modeli* şablondan kaynak dosyası, *Görsel tasarım* ise `.design.json` oluşturur.

Ana ekrandaki **Yeni Python modeli…**, kaynak dosyasını oluşturur, çözücüyü çalıştırmadan geometrisini düzenlenebilir Tasarım'a dönüştürür ve kayıtlı kaynak koduyla Tasarım'ın Python panelini açar. Mevcut Python modeli satırlarında Çalıştır işlemi yanında **Tasarım olarak aç** bulunur; bağlı tasarım varsa yeniden açılır. Dönüştürme başarısız olursa Python kaynağı kayıtlı kalır ve Çalıştır panelinin kod düzenleyicisinde açılabilir. Dönüştürmeden sonra kaynak dosyası değişirse Tasarım Python paneli bunu bildirir; kod burada gözden geçirilip yeniden uygulanabilir.

- **Yeni model** (*Python modeli*), `python/templates/` içindeki şablondan modeller klasöründe (`python/models/` kaynak kopyasında, `~/Documents/Fairbeam/models/` masaüstü uygulamasında) `<id>.py` oluşturur:

  | Şablon | Gösterdiği özellikler |
  | --- | --- |
  | `blank.py` | Sonlu toprak düzleminde ayrık portlu metal çubuk; her bölüm açıklanır (kimlik, parametreler, çözücü, geometri, port, mesh, kadraj) |
  | `dipole.py` | Ortadan beslemeli ince şerit yarım dalga dipol |
  | `monopole_on_ground.py` | Sonsuz toprak üzerinde çeyrek dalga monopol (PEC yarı uzay sınırı) |
  | `patch_probe_fed.py` | Sonda (ayrık port) beslemeli alttaş, toprak ve yama |
  | `microstrip_line.py` | İki uçta ayrık portlu hat. Port 2 `excite=False` olarak tanımlıdır; ancak `fairbeam run` dört porta kadar tüm portları uyarır (`--excite`, bkz. [MULTIPORT.md](MULTIPORT.md)); böylece S21 dahil iki portlu S-matrisi elde edilir |

  Kimlik dosya adıdır (`^[a-z][a-z0-9_]{1,40}$`); var olan dosyanın üzerine yazılmaz.
- ⌘S / Ctrl+S ile **Kaydet** seçin (veya "Kaydet ve önizle"). Sunucu dosyayı yazar, yükler ve kurar (yalnızca geometri, `fairbeam geometry` gibi); sonucu bildirir. Parametre formu yeni `PARAMS` ile güncellenir, 3B görünüm yeni geometriyi gösterir. Sözdizimi hatası veya `build()` istisnası düzenleyicide ilgili satırda işaretlenir; altında mesaj, kaynak satırı ve hata izi görünür.
- **Geçmiş.** Her kayıt önceki sürümü `.sim/model-history/<id>/` altında tutar. Son 20 sürüm listelenir, düzenleyiciye geri yüklenebilir (geri almak için kaydedin).
- **Çakışmalar.** Açıldıktan sonra dosya diskte başka düzenleyiciyle değiştiyse kayıt reddedilir; "Diskten yeniden yükle" veya "Yine de kaydet" seçenekleri sunulur.
- Dahil edilen modeller (yukarıdaki tablodaki tüm dosyalar) burada salt okunurdur; **Çoğalt** düzenlenebilir kopya oluşturur.

Model dosyaları düz Python'dur; herhangi bir düzenleyicide çalışmaya devam edebilirsiniz. Uygulama modeli yeniden seçtiğinizde değişiklikleri alır.

Otomatik mesh (`sim.auto_mesh()`), seçenekleri, kuralları ve doğrulaması [MESHING.md](MESHING.md) sayfasındadır.
