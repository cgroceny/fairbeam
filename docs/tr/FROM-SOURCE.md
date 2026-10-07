# Fairbeam'i kaynak koddan çalıştırma

Bu kılavuz, geliştirici ortamını kurmak için openEMS'i derler, Fairbeam'i depodan yükler, ilk modeli çalıştırır ve görüntüleyiciyi açar. Masaüstü uygulamasını denemek için [Başlarken](GETTING-STARTED.md) sayfasına bakın. Komut başvurusu [CLI.md](CLI.md), görüntüleyiciden simülasyon çalıştırma bilgileri [RUN-SERVER.md](RUN-SERVER.md) belgesindedir.

Linux için CPU çalışma ortamı yükleyicisini ve yerel tarayıcı başlatıcısını da içeren [Linux'ta kaynak koddan kurulum](LINUX.md) kılavuzunu kullanın. Aşağıdaki kurulum komutları macOS içindir.

## Kurulum ve ilk çalıştırma

Gereksinimler: Homebrew bulunan macOS, Xcode komut satırı araçları, Python 3.10+ (python.org dağıtımı önerilir) ve Node.js 20+.

```bash
# 1. Build openEMS + CSXCAD from source into ~/opt/openEMS and install fairbeam into its venv
#    (about 5-10 minutes; the VTK step heats the CPU)
scripts/install-openems-macos.sh

# 2. Run a model. This writes public/projects/<slug>.json and updates public/projects/index.json
~/opt/openEMS/venv/bin/fairbeam run python/models/patch_antenna.py
~/opt/openEMS/venv/bin/fairbeam run python/models/sierpinski_monopole.py --set iterations=3 --threads 6

# 3. Start the viewer on http://127.0.0.1:5310
npm install
npm run dev
```

Kurulum betiğinin varsayılanlarını ortam değişkenleriyle değiştirebilirsiniz: `PREFIX` (varsayılan `~/opt/openEMS`), `SRC` (varsayılan `~/opt/openems-src`), `JOBS` (varsayılan: çekirdeklerin yarısı) ve `FORCE=1` (tamamlanmış adımları yeniden derler). openEMS zaten kuruluysa paketi `<venv>/bin/pip install -e python` ile onun sanal ortamına yükleyin.

## Testler

Python testleri yalnızca standart kütüphanedeki `unittest` modülünü kullanır (pytest gerekmez) ve openEMS'i çalıştırmaz: son işlem, port ve NF2FF nesnelerinin test benzetimleriyle yürütülür. `fairbeam`, CSXCAD ve openEMS bağlayıcılarını içe aktardığı için openEMS sanal ortamı gereklidir. Herhangi bir `npm` adımı yoktur.

```bash
PYTHONPATH=python ~/opt/openEMS/venv/bin/python -m unittest discover -s python/tests      # ~1 s
PYTHONPATH=python ~/opt/openEMS/venv/bin/python -m unittest discover -s python/tests -p test_bands.py -v   # one module
```

| Modül | Kapsam |
| --- | --- |
| `test_excitation.py` | Gauss türevi darbe: sıfır DC, spektral tepe konumu, `f_max` noktasında -20 dB, analitik düzey ile FFT karşılaştırması |
| `test_mesh.py` | `merge_lines`: gerekli çizgilerin korunması, `tol` değerinden dar hücrelerin olmaması, sınırlı genişleme |
| `test_bands.py` | Bant tespiti: bant yok, tek veya birden çok bant, aralık uçlarına temas, tüm aralık, tek örnek |
| `test_model.py` | `Param` ayrıştırma ve sınırları, `resolve_params`, `load_model`, dağıtılan tüm modellerin üst verileri |
| `test_geometry.py` | Üç normal için çokgen düzlem içi sıralamasının gidiş-dönüş denetimi (CSXCAD'in 3B sınırlayıcı kutusuyla karşılaştırma), linpoly, kutu levhalar, NF2FF kutusu |
| `test_evaluate.py` | Test nesneleriyle `Simulation.evaluate`: S11/Zin, verimlilik, kazanç, 0–3 düzlem için PEC/PMC ayna düzeltmesi |
| `test_bundles.py` | `public/projects` içindeki kayıtlı paketler: gerekli anahtarlar, dizi uzunlukları, yönlülük ızgarası boyutu `len(theta) x len(phi)`, dizin tutarlılığı |
| `test_parse_log.py` | openEMS günlüğünden çalıştırma istatistikleri: hızlı çalıştırmalarda ve özel uyarımda yakınsama/sınır tespiti |
| `test_analytic.py` | Balanis örneklerine karşı yama iletim hattı modeli ve mikroşerit formülleri, dipol indüklenmiş EMK ve MoM referansları |
| `test_study.py` | Tarama eksenleri, rezonans/Zin ölçütleri, yakınsama raporu |
| `test_touchstone.py` | `.s1p` yazıcısı: 50 ohm'a yeniden normalleştirme, gidiş-dönüş, kayıtlı yama paketi |
| `test_multiport.py` | Sentetik dalgalardan S-matrisi oluşturma (sızıntılı sonlandırmalar, kısmi uyarım), karşılıklılık/pasiflik denetimi, yeniden normalleştirme, N-port Touchstone gidiş-dönüşü ve satır bölme |
| `test_network.py` | İdeal devre referansları: çeyrek/yarım/tam dalgada uyumlu hatlar, ABCD'ye karşı eşit olmayan referanslar, seri kısa devreler, Butterworth merdiveni, Wilkinson çift/tek modları, dal hatlı hibrit, reddedilen girdiler |
| `test_planar_calibration.py` | Bağımsız kayıplı ABCD kaskatları ve düğüm ağlarına karşı iki hatla yayılım çıkarımı ve referans düzlemi kaydırmaları, dal eşitlikleri, reddedilen kontroller ve güvenli olmayan düzeltmeler |
| `test_array.py` | Analitik dizi çarpanıyla dizi birleştirme karşılaştırması, yönlendirme, gerçekleşen kazanç normalleştirmesi, aktif yansıma; çok portlu modellerin yalnızca geometrisinin oluşturulması |
| `test_nrw.py` | Malzeme çıkarımı: NRW (kayıpsız, kayıplı, manyetik, Debye; kalın numunede grup gecikmesi dalı; yarım dalga maskesi), NIST yinelemeli yöntem (tüm bant, rezonansta gürültü), sonuç dosyası alanları, `Simulation.dielectric(mu_r=...)` |
| `test_dispersion.py` | Dispersif malzemeler: openEMS'in kendi formüllerine karşı Debye / Lorentz / Drude, CSXCAD özellikleri, kutup kuralları (manyetik Debye yok; Debye kutupları Lorentz kutupları olarak gerçekleştirilir), Djordjevic-Sarkar, kutup çözünürlüğü, `Simulation.dispersive` ve paket kaydı, frekansa bağlı analitik katmanlar |
| `test_debye_fit.py` | Kutup uydurma: kaba kuvvetle NNLS karşılaştırması, bant boyunca Djordjevic-Sarkar FR4, kutuplarda zaman adımı sınırı, korunan Lorentz / Drude kutupları yanında Debye kutupları, kutup modellerine uydurma, gürültülü ve iletken veriler, CSV ve `.cell.json` girdisi, `debye-fit` komutu |
| `test_dispersion_validation.py` | Regresyon durumları: başlangıçta geçirimsiz bandın üzerinde NRW, tümü geçirimsiz ve yalıtılmış örnekler, yanlış manyetik olmayan malzeme beyanı (geçirimsiz bant üzerinde ve dar bantta kalın manyetik numune), NaN/sonsuz malzeme sabitleri, kutuplar ve uydurma kontrolleri, bant merkezinde ε′ = 0 |
| `test_material_cell.py` | Düzlem dalga malzeme hücresi: kapalı biçimli Fresnel tabakasına karşı transfer matrisi (kayıplı, manyetik, kaskat), sentetik prob gerilimlerinden S11/S21, hücre sınırları, mesh, kaynak ve problar, boş referans hücresi, aynı zaman adımıyla iki çalıştırma (prob dosyasından geri okunur) |
| `test_waveguide_fixture.py` | Dalga kılavuzu malzeme düzeneği: kapalı biçimle kılavuzlu tabaka karşılaştırması, kılavuzlu NRW/NIST geri çıkarımı (sayısal β0 ile), de-embedding, kesim frekansları ve bant denetimi, düzenek mesh'i ve portları, zaman adımı eşleştirmeli çalıştırıcı ve sonuç dosyası alanları, dispersif (Debye) numune; hava aralığı: rezonans ve kapasitör düzeltmeleri (TN 1355-R C.1 ve C.23–C.24), aralığın uyardığı modlar, kademeli enine mesh, taşınan referans düzlemleri, sonuçtaki düzeltilmiş değerler |

Tablo temel modülleri listeler. `python/tests/` içinde tasarımlar ve denetimleri (`test_design.py`, `test_design_checks.py`, `test_example_designs.py`), çalıştırma sunucusu ve iş kuyruğu (`test_server.py`, `test_jobs.py`), optimizasyon aracı, VBA makrosu içe aktarıcısı ve telemetri gibi başka testler de vardır.

### İsteğe bağlı kılavuzlu dalga düzenekleri

Üç test modülü ayrıca elle başlatılan bir openEMS çalışması içerir. Test keşfi yalnızca analitik referanslarını ve analiz kodunu kontrol eder; çözücü ancak açıkça `--fdtd` verildiğinde çalışır. Her durum kendi sürecinde (30 dakika sınırı, en fazla dört çözücü iş parçacığı) çalışır ve ham modal spektrumları, `report.json` dosyasını ve mesh çalışmasından sonra `comparison.json` dosyasını `--out` klasörüne yazar. Depo dışında yeni bir klasör kullanın: bunlar paket değil, araştırma kayıtlarıdır. Bir kapsam ancak üç mesh, hepsinde enerji ölçütüyle durma ve belirtilen sınırlar içinde art arda iki mesh karşılaştırmasıyla doğrulanmış sayılır.

| Modül | Yapı | Karşılaştırılan referans |
| --- | --- | --- |
| `test_circular_guide_loss.py` (`circular_guide_fixture.py`) | Dielektrikle dolu dairesel kılavuz, TE11 (Pozar Örnek 3.2 parametreleri) | Kapalı biçimden β ve dielektrik/iletken zayıflaması; altın duvar, bilinen yaklaşık %8 farkı olan dirençli levha yaklaşımıdır; bu nedenle doğrulanmış değildir |
| `test_coax_cutoff.py` (`coax_cutoff_fixture.py`) | Koaksiyel (halkasal) kılavuz, TE11 kesim frekansı (Örnek 3.3 parametreleri) | Tam Bessel özdeğeri; ders kitabındaki yaklaşık değer farklı bir hedeftir |
| `test_surface_wave.py` (`surface_wave_fixture.py`) | Topraklanmış dielektrik levha, TM0/TE1/TM1 (Örnek 3.4 parametreleri) | On iki mod/kalınlık noktasında arayüz denklemlerinden β |

```bash
cd python
python -m tests.test_circular_guide_loss --fdtd --mesh 8 --loss none --out <new folder>   # one coarse case
python -m tests.test_circular_guide_loss --fdtd --out <new folder>                        # the full mesh study
python -m tests.test_circular_guide_loss --analyse-only --out <that folder>
```

Görüntüleyicinin kendi denetimleri vardır: `npm run typecheck` (`tsc --noEmit`), `npm run build`, `npm run check:cst` ve `npm run check:exports` ile `npm run check:designer` grupları; tüm `check:*` betikleri `package.json` içinde listelenir. Masaüstü kabuğunda Rust birim testleri bulunur: `cd src-tauri && cargo test`.

Masaüstü kabuğunu kaynak kopyasından denemek için `npm run desktop` komutunu çalıştırın (yerel pencerede 5315 portunda Vite ve 5325 portunda API; Rust gerekir, [DESKTOP.md](DESKTOP.md#building-and-developing) belgesine bakın). `npm run app`, görüntüleyiciyi derler ve API ile birlikte tarayıcıda boş bir portta sunar.

## Platformlar arası kullanım

Görüntüleyici modern tüm tarayıcılarda çalışır. Python paketi taşınabilirdir. openEMS, Windows derlemeleri ve Linux dağıtım paketleri sağlar; Fairbeam, Python bağlayıcıları içe aktarılabilen her openEMS kurulumuyla çalışır. Platforma özgü kısımlar macOS ve Linux kurulum betikleri, openEMS'in C++ standart çıktısının yakalanması (`dup2` ve libc'nin veya Windows'ta Universal CRT'nin `fflush` işlevi) ve çalıştırma sunucusunun süreç yönetimidir. Windows, resmi openEMS derlemesiyle doğrulanmıştır: [WINDOWS.md](WINDOWS.md) belgesine bakın. Test edilen Linux CPU/kaynak kurulumu ve doğrulama sınırları [LINUX.md](LINUX.md) belgesindedir.
