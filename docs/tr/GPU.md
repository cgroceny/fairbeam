# GPU motoru (isteğe bağlı: Apple silicon, Windows'ta NVIDIA)

[SeanMollet/openEMS](https://github.com/SeanMollet/openEMS) (GPL-3.0), openEMS'e GPU motoru ekler: Apple silicon üzerinde Metal (macOS 15+), diğer sistemlerde CUDA. `scripts/install-openems-gpu-macos.sh`, bunu normal kurulumun yanına kaynak koddan derler (`~/opt/openEMS-gpu`, ayrı venv; `~/opt/openEMS` değişmez). Ardından:


```bash
~/opt/openEMS-gpu/venv/bin/fairbeam run python/models/patch_antenna.py --engine gpu
npm run serve:gpu          # run server using the GPU build; the Run panel and the designer's Run dialog then offer an Engine picker
```

Masaüstü uygulaması, openEMS GPU motorunu listeliyorsa `~/opt/openEMS-gpu/venv` ortamını kendiliğinden kullanır (Genel ayarlar › openEMS'in GPU derlemesiyle başlat; varsayılan açık; [DESKTOP.md](DESKTOP.md#shell)).

Apple M5 Pro üzerinde ölçülmüştür; iki motorun sonuçları aynıdır (durma zaman adımı, |S11|, Dmax, verimlilik):

| Model | Hücre | CPU (4 iş parçacığı) | Metal GPU |
| --- | --- | --- | --- |
| Yama anten, −60 dB | 0,26 M | 10,6 s¹ | 1,6 s |
| Yama anten, −40 dB | 0,1 M | 8,0 s | 0,72 s |
| Sierpinski monopol, 3. yineleme | 2,0 M | 12,0 s | 2,7 s (2650 MCells/s) |

¹ Güncel modelle 2026-09-25 tarihinde yeniden ölçülmüştür (12628 zaman adımı; 10,59 ve 10,75 s süren iki çalıştırmanın en iyisi).
Depodaki `public/projects/patch-antenna.json`, 16,06 s bildirir: sabit durdurma ölçütü kontrol aralığından önce üretilmiştir ve 18468 zaman adımı sürmüştür.

Aynı modellerin Windows masaüstü sistemindeki (Ryzen 9 7900X, CPU motoru) sonuçları ve Apple M5 Pro (Metal) paketleriyle karşılaştırması: [BENCHMARKS.md](BENCHMARKS.md).

Gerçekte kullanılan motor openEMS günlüğünden okunur ve pakete (`run.engine`) kaydedilir. GPU içermeyen bir derlemede `--engine gpu` istendiğinde uyarı yazılır ve CPU kullanılır. Bu çatallanmış sürüm `--exact-endcriteria` desteklemez; Fairbeam sürümün kendi cihaz üzerindeki sık aralıklı enerji kontrolünü kullanır. Tek geliştiricinin sürdürdüğü beta sürüm olduğundan, kendi yapılarınızda iki motoru karşılaştırana kadar referans sonuçları için CPU derlemesini kullanın.

## NVIDIA GPU ile Windows (CUDA)

Aynı `v0.37.0-beta1+gpu` etiketinin yayını, CI'da MSVC 2022 ve CUDA 12.8.1 ile sm_60–sm_120 için derlenen Windows paketini içerir. CUDA çalışma ortamı statik bağlanmıştır; CUDA araç takımı değil, CUDA 12 uyumlu NVIDIA sürücüsü gerekir. Fairbeam'in yönetilen Windows kurulumu, Windows ikincil sürüm uyumluluğunun alt sınırı olan 528.33'ü kullanır ve bu sabitlenmiş paket için 6.0–12.0 hesaplama yeteneğini kontrol eder. NVIDIA'nın [CUDA 12.8.1 sürüm notlarına](https://docs.nvidia.com/cuda/archive/12.8.1/cuda-toolkit-release-notes/index.html) bakın. Desteklenen GPU yoksa bu sürüm, CPU üzerindeki referans arka ucuna döner; bu yol normal derlemeden daha yavaştır.

`scripts\install-openems-gpu-windows.ps1`, URL ve SHA-256 ile sabitlenmiş paketi indirir, normal kurulumun yanına çıkarır ve paketin wheel dosyalarıyla `fairbeam` içeren ayrı bir venv oluşturur. Ardından `openEMS.exe --help` çıktısında GPU motorunu denetler. Normal kurulum ve kullanıcının `OPENEMS_INSTALL_PATH` değişkeni değiştirilmez.


```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-openems-gpu-windows.ps1 -Prefix C:\opt\openEMS-gpu
$env:OPENEMS_INSTALL_PATH = "C:\opt\openEMS-gpu"     # this venv loads its DLLs from there
C:\opt\openEMS-gpu\venv\Scripts\python.exe -m fairbeam run python\models\patch_antenna.py --engine gpu
```

GPU venv ortamını kullanırken `OPENEMS_INSTALL_PATH` değişkenini GPU klasörüne ayarlayın. Wheel dosyaları DLL'leri bu değişkenden yükler; değişken genellikle CPU derlemesini gösterir. Günlük arka ucu belirtir: `Create FDTD engine (GPU, backend: CUDA (NVIDIA GeForce RTX 3060))`.

Ryzen 9 7900X ve NVIDIA GeForce RTX 3060 (12 GB, sürücü 591.74) üzerinde, aynı sistemde dört iş parçacığı kullanan CPU motoruyla karşılaştırılarak ölçülmüştür. Süreler tüm port çalıştırmalarının çözücü süreleri toplamıdır:

| Model | Hücre | CPU, 4 iş parçacığı | RTX 3060, CUDA | Hızlanma | MCells/s (CUDA) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Yama anten | 276,138 | 52,9 s (3 çalıştırmanın medyanı) | 2,56 s (3 çalıştırmanın medyanı) | 21 × | 1376 |
| 4 × 1 yama dizisi (4 çalıştırma) | 452,270 | 873,8 s | 25,1 s | 35 × | 1424 |
| Piramidal horn | 1,136,520 | 224,6 s | 6,3 s | 36 × | 1948 |
| Sierpinski monopol, 3. yineleme | 2,012,304 | 61,1 s | 3,4 s | 18 × | 3052 |
| Wilkinson bölücü (3 çalıştırma) | 113,103 | 41,1 s | 4,4 s | 9 × | 825 |

Sonuçlar `scripts/bench_compare.py` ile karşılaştırılmıştır:
- **Aynı sistemin CPU motoruyla.** İkisi aynı zaman adımında durduğunda (yama anten, 4 × 1 dizi, Wilkinson) tüm değerler 0,000 dB hassasiyetinde uyuşur. Horn ve Sierpinski monopol, GPU sürümü durdurma ölçütünü cihazda denetlediği için 50–480 zaman adımı farkla durur. Buna rağmen Dmax farkı 0,009 dB, |S11| farkı 0,1 dB içindedir.
- **Apple M5 Pro Metal paketleriyle** (horn, 4 × 1 dizi ve Wilkinson; hepsi aynı zaman adımında durur): −30 dB üzerindeki tüm S-parametrelerinde 0,1 dB, Dmax değerinde 0,005 dB içinde uyuşur.

Tüm sayılar [BENCHMARKS.md](BENCHMARKS.md) sayfasındadır.

### Görüntüleyicide CUDA motoru

Çalıştırma sunucusunun Python ortamındaki openEMS derlemesi GPU motorunu içeriyorsa tasarımcının Çalıştır penceresi ve Çalıştır paneli **Motor** seçicisini (CPU / GPU) gösterir. Genel ayarlar › **Varsayılan motor** başlangıç seçimini belirler (GPU yoksa CPU kullanılır). `/api/health` bu durumda `"engines": ["cpu", "gpu"]` listeler. Windows'ta sunucu `openEMS.exe` dosyasını `OPENEMS_INSTALL_PATH` içinde arar; değişken GPU klasörünü göstermelidir.

**Depodan** (macOS'taki `npm run serve:gpu` karşılığı):

1. Yeni bir PowerShell penceresinde yalnızca bu terminal için değişkeni GPU derlemesine ayarlayın: `$env:OPENEMS_INSTALL_PATH = "C:\opt\openEMS-gpu"`.
2. `python\` klasöründe GPU venv ortamının Python'uyla çalıştırma sunucusunu başlatın:


   ```powershell
   $py = "C:\opt\openEMS-gpu\venv\Scripts\python.exe"
   & $py -m fairbeam serve --python $py
   ```

   Başlangıç satırı `(engines: cpu, gpu)` ile biter. Başlatılan çalıştırmalar değişkeni devralır. Değişken yoksa venv CSXCAD'i içe aktaramaz; CPU derlemesini gösteriyorsa onun DLL'lerini yükler ve çalıştırmalar NaN sonuçlarıyla başarısız olur.
3. Görüntüleyiciyi normal şekilde başlatın (`npm run dev` veya `npm run build` sonrasında `--ui dist`). Çalıştır panelinde Motor altında **GPU** seçin. İş günlüğünde `Create FDTD engine (GPU, backend: CUDA (NVIDIA GeForce RTX 3060))`, pakette `run.engine: "gpu"` görünür.

**Masaüstü uygulamasında** (yönetilen çalışma ortamı gerekmez):

1. Kurulum betiğinin varsayılan öneki (`C:\opt\openEMS-gpu`) veya başka sabit sürücüde `\opt\openEMS-gpu` (örneğin `D:\opt\openEMS-gpu`; önce C:, ardından diğer sabit sürücüler sırayla aranır) kullanıldığında uygulama GPU venv ortamını kendiliğinden seçer (Genel ayarlar › **openEMS'in GPU derlemesiyle başlat**, varsayılan açık). Kurulum ekranının **GPU derlemesini tercih et** seçeneği bulunan klasörü gösterir. Yalnızca `<drive>:\opt\openEMS-gpu\venv\Scripts\python.exe` varlığı denetlenir; ağ, çıkarılabilir ve optik sürücüler atlanır. Başka önek için "Var olan bir Python kullan…" seçip `<prefix>\venv\Scripts\python.exe` dosyasını belirtin veya `%APPDATA%\org.fairbeam.desktop\settings.json` içindeki `python` alanını `"runtime": "external"` ile düzenleyin. Bu Python'un openEMS'i GPU motorunu listeliyorsa açıkça seçilen Python öncelikli olduğundan Genel ayarlar anahtar yerine GPU derlemesini (klasörü ve iki motorun kullanılabildiği notunu) gösterir.
2. Başka işlem gerekmez. Kurulum betiğinin oluşturduğu düzende, `<prefix>\venv\Scripts\python.exe` ve yanında `<prefix>\openEMS.exe` bulunduğunda uygulama sunucu ve çalıştırmalar için `OPENEMS_INSTALL_PATH=<prefix>` ayarlar. Kullanıcının değişkeni CPU derlemesini göstermeye devam edebilir. Diğer harici Python ortamları kullanıcının `OPENEMS_INSTALL_PATH` değerini kullanır.
3. Çalıştır penceresi ve Çalıştır paneli Motor seçicisini gösterir. Sunucu günlüğünde (`%LOCALAPPDATA%\org.fairbeam.desktop\logs\server.log`) `openEMS 0.37.0b1+gpu` ve `(engines: cpu, gpu)` görünür.

### Tek uygulama kurulumunda isteğe bağlı yönetilen GPU desteği

Masaüstü uygulaması CPU çalışma ortamını normal şekilde kurar. Windows'ta kurulum ve Genel ayarlar, sabitlenmiş NVIDIA GPU paketini uygulamanın kullanıcıya özel `gpu-runtime` klasöründe de hazırlayabilir. CPU ortamı yanındaki `runtime` klasöründe kalır. Ayrı bir Fairbeam yükleyicisi, sistem Python'u veya CUDA araç takımı gerekmez.

Genel ayarlar donanım uygunluğunu ve kurulum ilerlemesini bildirir. Hazırlanan GPU ortamı, uygulama sonraki açılışında uygulanacak açık bir başlangıç seçimidir; hazırlanması geçerli sunucuyu veya çalışan simülasyonu durdurmaz. Desteklenen mevcut GPU kurulumu yeniden indirilmeden kullanılabilir. Eksik, desteklenmeyen veya bozuk GPU ortamında CPU yolu kullanılabilir kalır. Çalıştır penceresi CPU ve GPU seçeneklerini yalnızca etkin ortam her ikisini sunduğunda gösterir.

İsteğe bağlı GPU derlemesi hâlâ kaynak projenin beta yazılımıdır. Yönetilen GPU kurulumu şu anda yalnızca Windows'ta kullanılabilir; macOS ve Linux'ta mevcut harici ortam iş akışları değişmez.
