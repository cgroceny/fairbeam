# Windows'ta Fairbeam

Görüntüleyici tüm tarayıcılarda çalıştığından, herkese açık demo (`https://fairbeam.org/app/`) Windows'ta doğrudan kullanılabilir. Bu sayfa Windows 10/11 (x64) üzerinde yerel simülasyon çalıştırmayı kapsar: openEMS, Python paketi, yerel çalıştırma sunucusu ve görüntüleyici.

**Durum:** Windows 11 Pro 25H2 (derleme 26200), AMD Ryzen 9 7900X (12 çekirdek / 24 iş parçacığı, 32 GB), Python 3.13.15, openEMS v0.37.0-rc3 / CSXCAD v0.7.0-rc3 (resmi MSVC derlemesi) ve Node.js 22.11.0 ile doğrulanmıştır. [Windows kurulumunu doğrulama](#verifying-a-windows-install) bölümündeki tüm denetimler geçmiştir.

## Platforma özgü kısımlar

| Kısım | macOS / Linux | Windows |
|---|---|---|
| openEMS | Kaynak koddan derlenir (`scripts/install-openems-macos.sh`) | [openEMS-Project sürümlerinden](https://github.com/thliebig/openEMS-Project/releases) resmi MSVC derlemesi: içinde Python wheel paketleri (cp313/cp314) bulunan `openEMS_x64_<version>_msvc.zip` |
| DLL arama | rpath | Python 3.8+, uzantı DLL'leri için `PATH` değişkenini kullanmaz: `fairbeam`, içe aktarılırken `OPENEMS_INSTALL_PATH` yolunu (yoksa `CSXCAD_INSTALL_PATH`, o da yoksa `C:\opt\openEMS`) `os.add_dll_directory` ile kaydeder; wheel paketleri de aynı iki değişkeni dikkate alır |
| openEMS çıktısını yakalama (çalıştırma istatistikleri, enerji izi, ilerleme) | 1/2 dosya tanımlayıcılarında `dup2` ve libc'nin `fflush` işlevi | Aynı `dup2` ve CPython ile MSVC derlemelerinin paylaştığı Universal CRT'nin (`ucrtbase`) `fflush` işlevi |
| Çalıştırma sunucusunun alt süreçleri | Yeni oturum; gruba SIGTERM/SIGKILL | Bir iş nesnesi içinde `CREATE_NEW_PROCESS_GROUP` (`fairbeam/procutil.py`): gruba CTRL_BREAK_EVENT gönderilir, ardından iş nesnesi sonlandırılır; böylece CTRL_BREAK'in durduramadığı süreçler de durur. Sunucu doğrudan öldürülse bile iş nesnesi tüm ağacı sonlandırır |
| Çalıştırmayı durdurma | SIGTERM (terminalde Ctrl+C: openEMS düzgün biçimde durur, `fairbeam run` paket yazmadan 130 koduyla çıkar) | CTRL_BREAK: openEMS'in kendi işleyicisi düzgün biçimde durdurur; `fairbeam run` paket yazmadan 130 koduyla çıkar |
| Sunucu çökmesinden kalan süreçler | `ps -o lstart` ve komut satırıyla eşleştirme; gruba SIGTERM/SIGKILL | Süreç oluşturma zamanı ve komut satırıyla eşleştirme (ctypes: `GetProcessTimes`, `NtQueryInformationProcess`), `taskkill /T /F` |
| GPU motoru | Metal türevi (macOS) | İsteğe bağlı: NVIDIA GPU'ları için türevin CUDA paketi (`scripts\install-openems-gpu-windows.ps1`, [GPU.md](GPU.md)); resmi derleme yalnızca CPU kullanır |

Kodu etkileyen iki Windows ayrıntısı:

- Sanal ortamın `Scripts\` klasöründeki `python.exe`, gerçek yorumlayıcıyı alt süreç olarak başlatan bir başlatıcıdır. Bu nedenle çalıştırma sunucusunun her Python alt süreci en az iki süreçten oluşan bir ağaçtır. Tek PID yerine tüm ağacın durdurulmasının (iş nesnesi, `taskkill /T`) nedeni budur.
- `os.kill(pid, 0)`, Windows'ta sürecin varlığını sorgulamaz; süreci sonlandırır (`TerminateProcess`). `procutil.pid_alive` bunun yerine `OpenProcess`/`GetExitCodeProcess` kullanır.

## Form önerileri

Masaüstü penceresi, “Saved info” açılır penceresinin CAD alanlarını örtmemesi için WebView2 genel otomatik doldurmasını devre dışı bırakır. Tarayıcı görüntüleyicisindeki metin, sayı ve ifade alanlarında da `autocomplete="off"` kullanılır. WebView2 bu HTML ipucunu yok sayabildiği için yerel pencere ayarı gereklidir; [Microsoft ayar başvurusuna](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings4) bakın. Ayar, güncellenmiş masaüstü yürütülebilir dosyası başlatıldığında uygulanır. Eski bir yürütülebilir dosyanın sayfasını yenilemek, yerel pencere ayarlarını değiştirmez. Mevcut tasarımlar ve profil verileri korunur; Fairbeam'in kendi parametre ve Bileşen önerileri çalışmaya devam eder.

## Kurulum

PowerShell kullanın. Python sürümü openEMS arşivindeki wheel paketleriyle eşleşmelidir (v0.37.0-rc3 için 3.13 veya 3.14). Aşağıdaki yollar `C:\opt\openEMS` ve `C:\code\fairbeam` kullanır; başka bir klasör veya sürücü de aynı şekilde çalışır. Yalnızca `OPENEMS_INSTALL_PATH`, `openEMS.exe` dosyasının bulunduğu klasörü göstermelidir.

1. **Araçlar** (kurulu olanları atlayın):

   ```powershell
   winget install --id Git.Git -e
   winget install --id GitHub.cli -e
   winget install --id Python.Python.3.13 -e
   winget install --id OpenJS.NodeJS.LTS -e
   ```

   Ardından `PATH` yenilensin diye yeni bir PowerShell açın ve `py -3.13 --version` ile kontrol edin. Varsayılan `python` değişmeden Python'u başka bir sürücüye kurmak için:
   `winget install --id Python.Python.3.13 -e --scope user --override "/quiet InstallAllUsers=0 TargetDir=D:\Python313 PrependPath=0 Include_launcher=0"`
   (`py -3.13` yine bulur).

2. **Depo**, LF satır sonlarıyla (dışa aktarma denetimleri dosyaları bayt bayt karşılaştırır; deponun `.gitattributes` dosyası LF kullanımını zorunlu kılar):

   ```powershell
   git config --global core.autocrlf false
   gh repo clone ismailakdag/fairbeam C:\code\fairbeam
   cd C:\code\fairbeam
   ```

3. **openEMS:** arşivin en üst düzeyinde `openEMS\` klasörü vardır; `C:\opt` içine açıldığında doğrudan `C:\opt\openEMS\openEMS.exe` oluşur (`README.txt`, `C:\openEMS` varsayar; herhangi bir klasör kullanılabilir).

   ```powershell
   gh release download v0.37.0-rc3 -R thliebig/openEMS-Project -p "openEMS_x64_*_msvc.zip" -D $env:TEMP
   Expand-Archive "$env:TEMP\openEMS_x64_v0.37.0-rc3_msvc.zip" -DestinationPath C:\opt
   C:\opt\openEMS\openEMS.exe --help        # prints the openEMS v0.37.0-rc3 banner
   [Environment]::SetEnvironmentVariable("OPENEMS_INSTALL_PATH", "C:\opt\openEMS", "User")
   $env:OPENEMS_INSTALL_PATH = "C:\opt\openEMS"
   ```

   Değişken süreç başlarken okunur: bu adımdan önce açılmış terminaller ve düzenleyiciler yeniden başlatılana kadar değişkeni göremez.

4. Depo klasöründe **openEMS wheel paketleri ve `fairbeam` paketi bulunan bir sanal ortam**:

   ```powershell
   py -3.13 -m venv .venv
   .\.venv\Scripts\Activate.ps1
   python -m pip install --upgrade pip
   python -m pip install numpy h5py (Get-ChildItem C:\opt\openEMS -Recurse -Filter "*cp313*win_amd64.whl").FullName
   python -m pip install -e python
   python -c "import fairbeam, CSXCAD, openEMS; print('ok', fairbeam.__version__)"
   ```

   CSXCAD wheel paketi, PyPI'den matplotlib paketini de getirir. openEMS README dosyasındaki `pip install --no-index --find-links C:\opt\openEMS\python openEMS` biçimi ancak `pip install numpy h5py matplotlib` sonrasında çalışır; çünkü `--no-index`, pip'in bunları indirmesini engeller. `ImportError: DLL load failed while importing CSXCAD` hatası, `OPENEMS_INSTALL_PATH` değişkeninin bu terminalde ayarlanmadığı veya `CSXCAD.dll` dosyasını içeren klasörü göstermediği anlamına gelir.

5. Görüntüleyici için **Node.js 22 LTS** kurun, ardından depo klasöründe `npm ci` çalıştırın.

## Çalıştırma

```powershell
# one simulation (coarse, about 30 s)
cd python
python -m fairbeam run models/dipole.py --set mesh_div=10 --points 201 --end-db -30 --threads 4

# the viewer with the local run server (two terminals)
python -m fairbeam serve   # in python\, http://127.0.0.1:5320/api
npm run dev                # in the repository folder, http://localhost:5310
```

## Windows kurulumunu doğrulama

Windows kurulumunun çalışıp çalışmadığını belirleyen denetimler bunlardır; sırayla çalıştırın ve çıktıyı saklayın.

1. `python\` içinde `python -m unittest discover -s tests -v` çalıştırın (sunucu testleri openEMS'in test benzetimini kullanır). Doğrulanan: 312 test başarılı, 1 test atlandı (openEMS yerine geçen bir kabuk betiği gerektiren GPU motoru tespiti).
2. Yukarıdaki kaba dipol çalıştırmasını `--name win-dipole` ile yapın, ardından `python ..\scripts\ci-check-bundle.py ..\public\projects\win-dipole.json` çalıştırın. openEMS çıktısı yakalanamadıysa (zaman adımı veya enerji izi yoksa) denetim başarısız olur. Doğrulanan: 100842 hücre, yaklaşık 28 s'de 7200 zaman adımı, 6 enerji noktası, 2,400 GHz'de en düşük S11 -37,6 dB, `ok`. Sonrasında paketi silin ve `git restore public/projects/index.json` çalıştırın: üretilen paketler commit'e eklenmez.
3. `npm ci`, `npx tsc --noEmit`, `npm run -s build`, `npm run -s check:cst`, `npm run -s check:exports` çalıştırın.
4. `fairbeam serve` çalışırken görüntüleyicide Simülasyon çalıştır panelini açın, bir çalıştırma başlatın, ilerlemeyi izleyin ve sonucu açın. İkinci çalıştırmayı iptal edin: süreç ağacı kaybolmalı (`Get-Process python, openEMS`) ve bu çalıştırma için paket yazılmamalıdır.
5. Bir çalıştırma sürerken `fairbeam serve` sürecini Ctrl+C ile durdurun: geride `openEMS` / `python` süreci kalmamalı; iş, kesintiye uğramış olarak listelenmelidir.
6. `python -m fairbeam clean-sim --dry-run`, yalnızca `.sim\` altındaki ham çalıştırma klasörlerini listeler (`jobs\` veya son 10 dakikada yazılmış içerikleri asla listelemez).

Aynı kurulum, kısa işlev testi ve Python testleri `.github/workflows/ci.yml` içinde (elle tetiklenerek) bir GitHub Windows çalıştırıcısında da yürütülür.

## Masaüstü uygulaması

Masaüstü uygulaması kendi çalışma ortamını kurar; yukarıdaki elle kurulum adımlarının hiçbirini gerektirmez. Sürüme özgü doğrulama için [RELEASES.md](RELEASES.md), uygulama sözleşmesi için [DESKTOP.md](DESKTOP.md) belgesine bakın. Windows'ta:

- Yükleyici: kullanıcı başına NSIS `.exe` (`installMode: currentUser`, yönetici yetkisi gerekmez); WebView2, gömülü başlatıcıyla kurulur (`src-tauri/tauri.windows.conf.json`). Windows 11'de WebView2 zaten bulunur. Güncellemeler uygulamada sunulur ve pasif modda yüklenir (`src-tauri/tauri.conf.json` içindeki `plugins.updater.windows.installMode`).
- Yükleyici ile `fairbeam.exe` sürüm bilgileri: CompanyName “Fairbeam”, LegalCopyright ise `bundle.copyright` değeridir. Tauri'nin NSIS şablonu CompanyName yazmadığı için `src-tauri/windows/installer-hooks.nsh` bunu ekler; `npm run check:installer-info`, değerin `bundle.publisher` ile eşit kalmasını sağlar.
- Çalışma ortamı: `%LOCALAPPDATA%\org.fairbeam.desktop\runtime`; ilk açılışta `runtime\setup-runtime.ps1` (Windows PowerShell 5.1) ve `runtime\install.py` tarafından oluşturulur. Doğrulanan durumlar: yeni kurulum, yeniden çalıştırma, `-Repair`, `--app-only`, bozuk indirmeler, ağ olmaması, boşluk ve ASCII dışı karakter içeren yollar. Bu ortamdan başlatılan sunucu, yukarıdaki 4. ve 5. adımların denetimlerinden geçer (çalıştırma, iptal, geride çalışan süreç bırakmadan Ctrl+C).
- Kurulu uygulama uçtan uca doğrulanmıştır: ilk açılış kurulumu, çalıştırma, iptal, çıkış, zorla sonlandırma, ikinci açılış, mevcut Python kullanımı ve kaldırma. [DESKTOP.md](DESKTOP.md) içindeki Windows listesine bakın.
- Mevcut bir Python kullanılıyorsa (yukarıdaki adımlarla kurulan sanal ortam), 3. adımda ayarlandığı gibi kullanıcı ortamında `OPENEMS_INSTALL_PATH` bulunmalıdır. Yoksa uygulama “The chosen Python cannot run Fairbeam ... DLL load failed while importing CSXCAD” hatasını gösterir. CUDA kurulumunun sanal ortamı istisnadır: uygulama değişkeni kendisi ayarlar ([GPU.md](GPU.md)).
- Derleme için Rust (`rustup`, `stable-x86_64-pc-windows-msvc`) ve Visual Studio 2022 C++ derleme araçları gerekir.

## Bilinen sınırlamalar

- Resmi openEMS derlemesi yalnızca CPU kullanır. Fairbeam'in kurulum ekranı ve Genel ayarlar, isteğe bağlı NVIDIA derlemesini ayrı bir yönetilen `gpu-runtime` klasörüne kurabilir; CPU ortamı kullanılabilir kalır. Seçilen ortam sonraki uygulama açılışında devreye girer; ortam ikisini de bildiriyorsa Çalıştır iletişim kutusu CPU ve GPU seçeneklerini sunar. Ayrı bir Fairbeam yükleyicisi veya CUDA araç takımı gerekmez. Harici GPU kurulumları desteklenmeye devam eder. [GPU.md](GPU.md) belgesine bakın.
- Sembolik bağlantılar geliştirici modu veya yönetici yetkisi gerektirir. Çalıştırma sunucusu bunlara bağımlı değildir (bağlantı oluşturacağı yerde model dosyasını kopyalar); `clean-sim` komutunun bağlantıları izlemediğini kontrol eden test, gerekli yetki yoksa bu kısmı atlar.
- Konsolsuz başlatılan çalıştırma sunucusu (bağımsız bir GUI süreci), işlerine CTRL_BREAK gönderemez; bu durumda iptal işlemi bekleme süresinden (5 s) sonra iş nesnesini sonlandırır ve openEMS düzgün durdurma işlemini gerçekleştiremeden durur. Sonuç aynıdır: paket yazılmaz ve süreç kalmaz. (Denenmemiştir: doğrulanan tüm kurulumlarda sunucu konsoldan çalıştırılmıştır.)
- Yükleyici kod imzalı değildir: indirilen `.exe` ilk çalıştırıldığında SmartScreen “Windows protected your PC” uyarısını gösterir (More info › Run anyway). macOS derlemesi imzalıdır ve Apple tarafından doğrulanmıştır.
