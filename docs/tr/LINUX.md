# Linux'ta kaynak koddan Fairbeam

Bu kurulum, CPU openEMS çözücüsünü, Python çalıştırma sunucusunu ve derlenmiş Fairbeam görüntüleyicisini yerel tarayıcıda çalıştırır. Kullanıcıya ait bir çalışma ortamı dizini kullanan kaynak kod/geliştirme kurulumudur. Yerel Tauri uygulaması, `.deb`, AppImage, güncelleme paketi veya herkese açık sürüm üretmez.

## Yerel masaüstü desteğinin hazırlık durumu

Aşağıdaki kaynak kod iş akışı Debian 13 x86_64 üzerinde test edilmiştir. Bu, desteklenen bir Linux masaüstü sürümü olduğu anlamına gelmez: yerel Tauri paketi veya Linux masaüstünde ilk açılış akışı test edilmemiştir. Mevcut eksikler:

| Alan | Bugün uygulanan | Linux masaüstü sürümü için eksik olan |
| --- | --- | --- |
| Tauri kabuğu ve paketi | Ortak Unix süreç grubu kapatma kodu; kabuk `~/opt/openEMS/venv/bin/python` yolunu arayabilir. | Linux'a özgü Tauri paket yapılandırması veya yerel Linux CI işi yoktur. Temel paket yapılandırması macOS `app`/`dmg` hedeflerini belirtir; Windows bunu NSIS ile değiştirir. |
| İlk açılış çalışma ortamı | `scripts/install-openems-linux.sh`, geliştirme için CPU openEMS/CSXCAD ortamını kaynak koddan derler. | `runtime/pins.json` içinde `linux-x86_64` uv/openEMS girdileri yoktur; `runtime/setup-runtime.sh` yalnızca macOS arm64 kabul eder. Linux kaynak yükleyicisi, paketlenmiş ve taşınabilir bir yönetilen çalışma ortamı değildir. |
| Güncellemeler | Tauri güncelleyici eklentisi kuruludur. Üst proje, Linux AppImage güncelleme dosyalarını belgeler. | `scripts/publish-release.mjs` yalnızca `windows-x86_64` ve `darwin-aarch64` kabul eder; akışta Linux paketi/imzası yayımlanmaz. |
| İsteğe bağlı oturum açma | Misafir modu varsayılandır. | İsteğe bağlı hesaplar derlemesi Apple/Windows anahtarlık arka uçlarını kullanır; Linux'taki yedek çözüm bellektedir ve oturumu kalıcı olarak saklamaz ([ACCOUNTS.md](ACCOUNTS.md)). |

İlk desteklenen Linux masaüstü hedefi olarak **Ubuntu 24.04 LTS x86_64** ile başlayın. Ubuntu, 2029'a kadar standart destek belirtir ([sürüm döngüsü](https://ubuntu.com/about/release-cycle)). Tauri'nin güncel Linux derleme gereksinimleri WebKitGTK 4.1'i ve sistem geliştirme kütüphanelerini içerir ([Tauri gereksinimleri](https://v2.tauri.app/start/prerequisites/)); openEMS'in ayrı yerel bağımlılıkları vardır ([openEMS gereksinimleri](https://docs.openems.de/en/latest/install/requirements.html)). Her iki kümenin de Ubuntu CI çalıştırıcısında doğrulanması gerekir. 24.04'ten eski sistemler için AppImage yayımlanacaksa, desteklendiği belirtilen en eski sistem üzerinde derleyin: Tauri, daha yeni derleme sistemlerinin asgari glibc sürümünü yükseltebileceği konusunda uyarır ([AppImage kılavuzu](https://v2.tauri.app/distribute/appimage/)).

Kaynak korumalarının bir bölümü zaten taşınabilirdir. Linux'ta kullanılabilir CPU sayısı `sched_getaffinity` ile belirlenir; otomatik iş parçacığı seçimi, sürece izin verilen mantıksal CPU sayısıyla sınırlıdır. Fiziksel çekirdek tahmini şu anda `/proc/cpuinfo` dosyasının tamamını okur ve cgroup CPU kotalarını hesaba katmaz. Çözücü, varsayılan olarak mesh'i 40 milyon hücreyle sınırlar ve hücre başına yaklaşık 90 bayt tahmin eder; bellek ön denetimi, sistemin `MemAvailable` değerinin %60'ı üzerinde uyarır, %90'ı üzerinde çalıştırmayı reddeder. Bunlar tahmindir. Belleği sınırlı bir konteyner veya korumalı ortam desteği ilan edilmeden önce CPU/çekirdek tespitinin izin verilen CPU kümesini ve cgroup v2 CPU/bellek sınırlarını dikkate almasını sağlayın. Varsayılan çalıştırmaları belirli çekirdeklere sabitlemeyin; uygulama CPU yakınlığını değiştirmeden gözlemlemelidir.

Önerilen uygulama sırası:

1. Ubuntu 24.04 x86_64 Tauri derleme/kısa işlev testi çalıştırıcısı ve Linux paket yapılandırması ekleyin. İlk hedef çalıştıktan sonra uyumluluk denetimleri için ikinci bir Ubuntu LTS sürümü tutun.
2. Özeti sabitlenmiş Linux uv ve CPU openEMS dosyaları ile Linux ilk açılış/onarım betiği ekleyin. Uyumlu Python wheel paketlerini ve gerekli paylaşımlı kütüphaneleri içeren taşınabilir bir openEMS/CSXCAD paketi derleyin veya birleştirin; kurulu uygulama yerel kod derlememeli veya `sudo` çağırmamalıdır.
3. İlk paket biçimini seçin ve yayımlama/imzalama yolunu bağlayın. AppImage, mevcut otomatik güncelleme akışına en az değişiklikle uyar: Tauri, Linux güncelleme dosyaları olarak `.AppImage` ve `.AppImage.sig` biçimlerini belgeler ([güncelleyici kılavuzu](https://v2.tauri.app/plugin/updater/)). Sürüm betiğini `linux-x86_64` için genişletin; `.deb` dağıtımını ayrı bir paket yöneticisi yolu olarak ele alın.
4. Gerçek bir Ubuntu masaüstünde yeni kurulum ve çalışma ortamı indirmesini, görüntüleyici açılışını, yerel dosya iletişim kutularını, kaba CPU dipol çalıştırmasını, iptal/çıkış sırasında süreç temizliğini ve imzalı güncellemeyi doğrulayın; kullanıcının çalışma klasörünün korunduğunu da kontrol edin. Kısa işlev testini yeni bir geçici klasörde tutun, `--engine cpu --threads 1` veya `2` kullanın ve varsayılan mesh korumasını açık bırakın.

Genel kabuk, çalışma ortamı doğrulayıcısı, sürüm akışı arayüzü ve kaynak ön denetimi macOS ve Windows derlemeleriyle paylaşılabilir. Linux'un destekleniyor sayılması için Linux'ta çalışan bir derleme çalıştırıcısı, dağıtıma özgü bağımlılık denetimleri, Linux çalışma ortamı dosyaları, paket yapılandırması ve Linux güncelleme hedefi hâlâ gereklidir.

## Gereksinimler

- C/C++ derleyicisi ve geliştirme kütüphaneleri bulunan Linux (Debian 13 x86_64 test edilmiştir)
- Geliştirme başlıkları ve `venv` içeren Python 3.10+; Python 3.12.14 test edilmiştir
- Görüntüleyici ve depo denetimleri için Node.js 22.6+ ve npm; Node 24.19.0/npm 11.9.0 test edilmiştir
- Git, CMake, make; resmi GitHub kaynaklarına ve Python/npm paket kayıtlarına ağ erişimi
- Görüntüleyici için WebGL destekli modern bir tarayıcı

Debian/Ubuntu'da şu sistem paketi komutlarını gözden geçirip kendiniz çalıştırın:

```bash
sudo apt-get update
sudo apt-get install build-essential git cmake pkg-config python3-dev python3-venv \
  libhdf5-dev libtinyxml-dev libboost-all-dev libcgal-dev libvtk9-dev
```

Yükleyici hiçbir zaman `sudo`, `apt` veya üst projenin sistem paketi yükleyicisini çağırmaz. VTK paketi ek bağımlılıklar getirebilir; bu kurulum Qt/AppCSXCAD derlemez. Diğer Linux dağıtımlarında eşdeğer geliştirme paketleri gerekir; [üst proje gereksinimlerine](https://docs.openems.de/en/latest/install/requirements.html) bakın.

## Kurulum ve başlatma

Depo kökünden:

```bash
# Native CPU libraries and Python bindings, then this checkout's fairbeam package
scripts/install-openems-linux.sh

# Built viewer
npm ci
npm run build

# Viewer and Python API together; opens the local browser on an available port
scripts/run-linux.sh
```

Başlatıcı mevcut `fairbeam app` komutunu kullanır, `127.0.0.1` adresine bağlanır ve sunucuyu ön planda tutar. Ctrl+C ile durdurun. Ön yüzü düzenledikten sonra `npm run build` komutunu yeniden çalıştırın. Python bu kaynak kopyasından düzenlenebilir olarak kurulduğundan Python değişiklikleri yeniden kurulum gerektirmez.

Ekransız bir sistem veya sabit port için:

```bash
scripts/run-linux.sh --no-browser --port 5320
# Open http://127.0.0.1:5320 on the same machine
scripts/run-linux.sh --help
```

`--models`, `--projects`, `--jobs`, `--sim-root` ve `--ui` dahil tüm argümanlar `fairbeam app` komutuna aktarılır. Varsayılan model/proje dizinleri bu kaynak kopyasındadır; ham çözücü çıktısı ve iş geçmişi onun `.sim` dizinini kullanır. Ayrıntılar için [RUN-SERVER.md](RUN-SERVER.md) belgesine bakın. Sunucu Python modellerinizi hesabınızın yetkileriyle çalıştırır; bir Python korumalı ortamı değildir.

### Özel yollar ve mevcut kurulum

```bash
PREFIX="$HOME/opt/fairbeam Linux" SRC="$HOME/opt/openems Linux sources" JOBS=2 \
  scripts/install-openems-linux.sh
PREFIX="$HOME/opt/fairbeam Linux" scripts/run-linux.sh

# Or select an existing interpreter with working openEMS, CSXCAD and fairbeam imports
PREFIX="/path/to/openEMS" FAIRBEAM_PYTHON="/path/to/venv/bin/python" \
  scripts/run-linux.sh --no-browser
```

Yükleyici ayarları:

- `PREFIX`: yerel kütüphaneler ve `venv/`; varsayılan `~/opt/openEMS`
- `SRC`: önbelleğe alınan üst proje kaynak kopyası ve derleme dizinleri; varsayılan `~/opt/openems-src-linux`
- `PYTHON`: yeni sanal ortam oluştururken kullanılan yorumlayıcı; varsayılan `python3`
- `JOBS`: yerel derleme paralelliği; varsayılan 2, belleği az sistemlerde 1 kullanabilirsiniz
- `CC`/`CXX`: derleyiciler; varsayılan `gcc`/`g++`

İçe aktarılabilen mevcut bir `PREFIX/venv`, openEMS/CSXCAD yeniden derlenmeden veya yükseltilmeden kullanılır. Normal yükleyici çalıştırması yine de Fairbeam'i mevcut kaynak kopyasından kurar. Geçersiz bir sanal ortam, yerel dosyalar yazılmadan önce reddedilir. Sanal ortam geçerliyse ancak yerel bağlayıcılar içe aktarılamıyorsa yükleyici yerel bileşenleri yeniden derler ve kurulu dosyalarının üzerine yazabilir; eski kurulumu korumak için yeni `PREFIX` ve `SRC` seçin.

Farklı bir üst proje revizyonundaki kaynak kopyası, izlenen değişiklikler içeren kopya veya başka kurulum dizinine ait CMake önbelleği değiştirilmeden bırakılır ve reddedilir; başka bir `SRC` seçin. Farklı kurulum dizinleri arasında derleme önbelleği kullanmak eski kütüphane yollarını koruyabilir. Temiz yeniden derleme için hem yeni `PREFIX` hem yeni `SRC` seçin.

Yükleyici fparser, CSXCAD ve openEMS'i ayrı ayrı, ardından Python bağlayıcılarını derler. Yeni derlemeler aşağıda sabitlenmiş üst proje revizyonlarını kullanır; Python bağımlılıkları yapılandırılmış pip kaynağından gelir ve sürümleri kilitli değildir. Her iki betik de mevcut değeri koruyarak `PREFIX/lib` ve `PREFIX/lib64` yollarını `LD_LIBRARY_PATH` değişkenine ekler. Python CLI'yi özel bir yerel kurulum diziniyle doğrudan çalıştırırken içe aktarma paylaşımlı kütüphaneleri bulamazsa aynı kütüphane yolunu kullanın.

## Asgari doğrulama

İlk denetim salt okunurdur; indirme, kurulum veya simülasyon yapmaz ve sunucu başlatmaz:

```bash
scripts/install-openems-linux.sh --check

# Set PREFIX here if the installation is not in the default directory
export PREFIX="${PREFIX:-$HOME/opt/openEMS}"
export LD_LIBRARY_PATH="$PREFIX/lib:$PREFIX/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# The suite expects the default mesh limit, not a user-provided override
env -u FAIRBEAM_MAX_CELLS "$PREFIX/venv/bin/python" -m unittest discover -s python/tests -q

# One small CPU simulation; writes only into a fresh temporary folder
smoke_dir="$(mktemp -d)"
"$PREFIX/venv/bin/python" -m fairbeam run python/models/dipole.py \
  --set mesh_div=10 --points 101 --end-db=-30 --threads 2 --engine cpu \
  --name linux-smoke --out "$smoke_dir/projects" --sim-root "$smoke_dir/sim"
printf 'Smoke results: %s\n' "$smoke_dir"
```

Simülasyonları birer birer çalıştırın. Bilerek kaba seçilen bu dipol, çalışma ortamının kısa işlev testidir; mesh yakınsaması sağlanmış bir doğruluk karşılaştırması değildir. Deponun ön yüz denetimleri [FROM-SOURCE.md](FROM-SOURCE.md#tests) belgesinde açıklanır.

## Test edilen yapılandırma ve sınırlar

30 Eylül 2026'da Fairbeam kaynak commit'i `d3de9af23b6d8c31295387b346e395d46707d6e6` ve aşağıdaki resmi üst proje kaynaklarıyla test edilmiştir:

| Bileşen | Test edilen revizyon/sürüm |
| --- | --- |
| Linux | Debian GNU/Linux 13 (trixie), x86_64 |
| Python | 3.12.14 |
| Derleyici / CMake | GCC/G++ 14.2.0 / CMake 3.31.6 |
| openEMS-Project | `9f5cdd4d71cae312633ab0b2c1db64867f8c782b` |
| openEMS | `5b1ecb1244e6bd192d83efdf2bc84e5f83c96047` (`v0.37.0-rc3-16-g5b1ecb1`) |
| CSXCAD | `bd2c133392d93251b640da1f8e2367163f00b7f5` (`v0.7.0-rc3-1-gbd2c133`) |
| fparser | `4b9c845b449b520c4b8c5f23c74cd04820084f81` |
| Yerel bağımlılıklar | Boost 1.83, HDF5 1.14.5, VTK 9.3.0, TinyXML 2.6.2, CGAL 6.0.1 |
| Python bağımlılıkları | NumPy 2.5.3, h5py 3.16.0, Cython 3.3.0, setuptools 84.0.0 |
| Ön yüz araçları | Node 24.19.0, npm 11.9.0 |

Testte sistem paketleri kullanılmamıştır: Debian geliştirme/çalışma ortamı paketleri yerel bir dizine çıkarılmış, yolları `CMAKE_PREFIX_PATH`, yalnızca teste özgü `CMAKE_TOOLCHAIN_FILE`, derleyici bayrakları ve `LD_LIBRARY_PATH` üzerinden sağlanmıştır. Son yükleyici, başlangıçta boş olan ve adlarında boşluk bulunan kaynak ve çalışma ortamı dizinlerinde uçtan uca derlemeyi 177.4 saniyede tamamlamıştır. Bu süre; sabitlenmiş üst proje kaynaklarını klonlamayı, üç yerel kütüphaneyi ve iki Python bağlayıcısını derlemeyi, sanal ortam oluşturmayı, Fairbeam'i kurmayı ve içe aktarmaları kontrol etmeyi içerir. Başka bir sistemde olağan apt kurulumuyla oluşan bağımlılık yerleşimi ayrıca test edilmemiştir.

Yükleyicinin mevcut kurulumu yeniden kullanma yolu da, eksik `pip` paketinin sanal ortama ait `ensurepip` ile kurulması dahil, geçmiştir. Beş regresyon testi, salt okunur denetimleri ve geçersiz sanal ortamların ya da başka kurulum dizinine ait derleme önbelleklerinin yerel dosyalar yazılmadan reddedilmesini doğrular. Göreli sanal ortam yorumlayıcısı dahil başlatıcının yol/argüman işlemesi geçmiştir. Başlatıcı derlenmiş görüntüleyiciyi sunmuş, yerel sağlık/API denetimlerine yanıt vermiş ve düzgün kapanmıştır.

100,842 hücreli CPU dipol kısa işlev testi, iki iş parçacığıyla 7,200 zaman adımından sonra yakınsamıştır. Duvar saati süresi 13.8 saniye, en yüksek süreç RSS belleği yaklaşık 101 MiB; 2.4 GHz'de S11 yaklaşık −37.6 dB, en yüksek yönlülük 2.19 dBi ve ışıma verimliliği %98.17 olmuştur. Bu değerler yalnızca o çalıştırmayı tanımlar; performans garantisi değildir.

Son yeni kurulan çalışma ortamı aynı testi 14.9 saniyede tekrarlamış, 7,200 zaman adımında yakınsamış ve ilk S11/empedans dizileriyle `1e-8` bağıl ve `1e-10` mutlak tolerans içinde eşleşmiştir. Başlatıcısı sağlık, arayüz dosyası ve sonuç paketi HTTP denetimlerinden de geçmiş ve düzgün kapanmıştır.

`npm run build` (TypeScript denetimi dahil), `npm run check:designer` ve `npm run check:exports` geçmiştir. Derleme, ana kod parçasının boyutu ve statik/dinamik içe aktarmaların birlikte kullanılması hakkında uyarılar vermiştir.

Doğrudan içe aktarmalar ve geometri dışa aktarımı da geçmiştir. Varsayılan mesh sınırıyla tam Python test paketi 146.3 saniyede 799 testi tamamlamıştır: 778 başarılı, 20 atlandı, bir başarısız. Analitik dipol testi `DipoleTest.test_moment_method_reference`, beklenen 2.42–2.47 GHz aralığının dışında, yaklaşık 2.53 GHz'de rezonans öngörmektedir; MoM matrisi sayısal olarak tam ranklı değildir (2.44 GHz'de 100 üzerinden 99). Bu analitik referans, bilinen açık bir sorundur.

Elle çalıştırılan tarayıcı test düzeneği ve `npm run check:scenarios -- --skip-run` bu yapılandırmada tarayıcı başlatamamıştır; dolayısıyla uygulama tarayıcı doğrulamaları, grafik etkileşim veya WebGL çizimi için başarılı sonuç iddiası yoktur. Yerel Tauri paketlemesi, GPU hızlandırması, diğer Linux dağıtımları/mimarileri ve dağıtılabilir Linux yükleyicileri de doğrulanmamıştır.
