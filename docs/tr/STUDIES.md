# Taramalar, yakınsama çalışmaları ve Touchstone dışa aktarma

Üç CLI komutu `fairbeam run` üzerine kuruludur: `sweep`, `converge` ve `touchstone`. Kod `python/fairbeam/study.py` ve `python/fairbeam/touchstone.py` içindedir.

## `fairbeam sweep`

```bash
fairbeam sweep python/models/dipole.py --param length=50,58,66 --threads 4
fairbeam sweep python/models/inset_patch.py --param inset=6,8,10 --param feed_w=2.6,3.0 --set f_max=3.5
```

- Her `--param KEY=V1,V2,...` bir eksen ekler. Birden fazla eksen, son ekseni en hızlı değişen **Kartezyen** bir ızgara oluşturur.
- `--set KEY=VALUE`, diğer parametreleri tüm noktalarda sabitler.
- Her nokta, çözücü zamanı harcanmadan **önce** modelin `PARAMS` tanımına (tür, min, maks) göre doğrulanır.
- Noktalar **sırayla**, aynı anda tek openEMS süreciyle çalışır. `--threads` varsayılanı 4'tür.
- Her nokta, `<out>/studies/<name>/<slug>.json` dosyasına yazılan normal bir pakettir.
- Çalışma özeti `<out>/studies/<name>.json` dosyasına yazılır. `<out>` varsayılanı `public/projects`, `<name>` varsayılanı `<model-id>--sweep--<axes>` biçimindedir.
- Üye paketler galeri dizinine (`public/projects/index.json`) **eklenmez**; böylece 20 noktalı tarama galeriyi doldurmaz. Bir üyeyi doğrudan açın veya çalışma dosyasını yükleyin.

| Seçenek | Varsayılan | Anlamı |
| --- | --- | --- |
| `--param KEY=V1,V2,...` | zorunlu | Tarama ekseni (yinelenebilir) |
| `--set KEY=VALUE` | | Sabit değer (yinelenebilir) |
| `--name NAME` | türetilir | Çalışma adı |
| `--out DIR` | `public/projects` | Sonuçlar klasörü; çalışma `DIR/studies` altına gider |
| `--sim-root DIR` | `.sim` | Ham openEMS çıktısı (`.sim/<study>/<slug>`) |
| `--threads N` | `4` | FDTD iş parçacıkları |
| `--points N` | `801` | Frekans noktaları |
| `--pattern "2.4,5.8"` | bant merkezleri | GHz cinsinden uzak alan frekansları |
| `--end-db DB` | model varsayılanı | Enerji durdurma ölçütü, örneğin `-60` |
| `--no-exact` | kapalı | Durdurma ölçütünü her Nyquist periyodu yerine gerçek zamanda yaklaşık 4 s'de bir kontrol eder. Kesin denetim (bilgisayardan bağımsız durdurma; openEMS `--exact-endcriteria`) varsayılandır; eski `--exact` bayrağı kabul edilir ancak etkisizdir |
| `--engine cpu\|gpu` | `cpu` (veya `$FAIRBEAM_ENGINE`) | FDTD motoru |
| `--excite all\|1,3` | port sayısı <= 4 ise tümü, aksi halde 1 | Çok portlu modellerde her noktada uyarılan portlar (her biri ayrı çalıştırma) |
| `--verbose` | kapalı | openEMS çıktısını gösterir |

## `fairbeam converge`

### Tasarım: mesh yoğunluğu

```bash
fairbeam converge python/models/my_patch.design.json --densities 15,20,30,40 --max-runs 4 --engine gpu
```

`.design.json` ile `--param` verilmezse tasarım her otomatik mesh yoğunluğunda sırayla çalışır (`mesh.cells_per_wavelength`; Otomatik modda `cells_per_wavelength` alan ayarı). Her çalıştırmadan sonra rezonansı (S11 minimumu), oradaki |S11|'i, Dmax'ı (uzak alan varsa) ve giriş empedansını önceki çalıştırmayla karşılaştırır. Değişikliklerin tümünün `--tol-f` (%0.5), `--tol-s11` (1 dB) ve `--tol-dmax` (0.2 dB) değerlerinin kesin olarak altında kaldığı ilk adımda veya `--max-runs` (4) çalıştırmadan sonra durur. Kod `python/fairbeam/convergence.py`, seçenekler [CLI.md](CLI.md) içindedir. Çıktı:

```
 cells/λ      cells   f_res GHz     df %   S11 dB    dS11  Dmax dBi   dD dB           Zin ohm   time s  ok
      15      55104      2.4495        -   -42.35       -      6.76       -         49.7-0.4j      1.1
      20     101088      2.4538    0.173   -41.34    1.02      6.75  -0.003         49.8-0.5j      1.2  no
      30     250800      2.4559    0.088   -40.68    0.66      6.75  -0.002         49.3-0.1j      1.9  yes
tolerances: |df| < 0.5 %, |dS11| < 1 dB, |dDmax| < 0.2 dB
converged at 20 cells/λ
```

Tasarımcının Mesh yakınsaması… penceresi aynı çalışmayı çalıştırma sunucusu üzerinden yürütür (`POST /api/convergence`; her yoğunluk için bir çalıştırma işi, sonraki yalnızca kural devam etmeyi söylüyorsa kuyruğa alınır; `GET /api/convergence/{id}` aşağıdaki çalışma dosyasını döndürür, `POST /api/sweeps/{id}/cancel` durdurur). Bkz. [DESIGNER.md](DESIGNER.md#mesh-convergence).

Çalışma dosyasında `kind: "mesh-convergence"` bulunur; `axes` çalıştırılan yoğunlukları listeler, `convergence` kuralın durumunu tutar:

```json
{
  "schema": "fairbeam.study/1", "kind": "mesh-convergence", "id": "cv-20260928-101500-ab12",
  "name": "Patch · mesh convergence",
  "axes": [{"key": "mesh.cells_per_wavelength", "values": [15, 20, 30]}],
  "members": [
    {"density": 15, "status": "done", "file": "patch--mesh-15.json",
     "metrics": {"f_res": 2.4495e9, "s11_db": -42.35, "dmax_dbi": 6.756, "zin_re": 49.7, "zin_im": -0.4,
                 "matched": true, "cells": 55104, "timesteps": 14016, "wall_time_s": 1.1}, "summary": {"...": "..."}}
  ],
  "convergence": {
    "tolerances": {"f_pct": 0.5, "s11_db": 1.0, "dmax_db": 0.2}, "densities": [15, 20, 30], "max_runs": 3,
    "steps": [{"from": 15, "to": 20, "df_pct": 0.173, "ds11_db": 1.02, "ddmax_db": -0.003, "dzin_ohm": 0.14,
               "ok": {"f": true, "s11": false, "dmax": true}, "converged": false}],
    "converged": true, "converged_at": 20, "done": true, "reason": "converged",
    "verdict": "converged at 20 cells/λ", "next": null
  }
}
```

- `converged_at`, ilk yakınsayan adımın daha kaba yoğunluğudur; daha ince çalıştırma bunu doğrular.
- `reason`: `converged`, `exhausted` (yoğunluk kalmadı: “yakınsamadı: daha da inceltin veya modeli kontrol edin”), `failed`, `cancelled` veya `running` (bu durumda `next`, sıradaki yoğunluktur).
- Çalıştırmada uzak alan yoksa `ok.dmax`, `null` olur; Dmax hesaba katılmaz.
- Rezonans frekans örnekleri arasında iyileştirilir (S11 minimumu ve dB cinsinden komşularından geçen parabol); böylece ızgara aralığı %0.5 toleransa baskın olmaz.

### Python modeli: mesh parametresi

```bash
fairbeam converge python/models/dipole.py --param mesh_div=10,15,20,30 --end-db -60
fairbeam converge python/models/sierpinski_monopole.py --set iterations=2 --param cell=0.8,0.6,0.45
```

Bu, `sweep` komutunun tam bir eksenli ve değerlerini **kabadan inceye** sıraladığınız bir sarmalayıcısıdır. Ardışık inceltmeler arasında şunları bildirir:

- **ilk rezonansın** değişimi: −10 dB altındaki ilk bandın merkezi (S11 minimumu), uyumlu bant yoksa global S11 minimumu
- bu rezonansa en yakın uzak alan frekansındaki **Dmax** değişimi

|Δf| < `--tol-f` (varsayılan %0.5) ve |ΔDmax| < `--tol-d` (varsayılan 0.1 dB) olduğunda adım yakınsamış sayılır. Çalışma, **son** adımı yakınsamışsa yakınsamıştır. Çıktı:

```
  mesh_div      cells   f_res GHz      df %  Dmax dBi    dD dB  ok
        15      50544      2.4100         -      6.80        -
        20      97152      2.4325     0.934      6.81    0.010  no
        30     263568      2.4525     0.822      6.79   -0.021  no
        40     535920      2.4550     0.102      6.79   -0.002  yes
converged (last step |df| < 0.5 %, |dD| < 0.1 dB): YES
```

Yalnızca global hücre boyutunu değil, metal üzerindeki mesh'i kontrol eden parametreyi (`mesh_div`, `cell`, ...) inceltin. Bkz. [VALIDATION.md](VALIDATION.md#5-recommended-settings).

## Çalışma dosyası: `fairbeam.study/1`

```json
{
  "schema": "fairbeam.study/1",
  "kind": "sweep | convergence | mesh-convergence",
  "name": "patch-mesh-convergence",
  "created": "2026-09-24T23:20:11+0300",
  "model": {"id": "patch-antenna", "name": "Rectangular patch antenna", "file": "patch_antenna.py"},
  "axes": [{"key": "mesh_div", "values": [15, 20, 30, 40]}],
  "fixed": {},
  "threads": 4, "end_criteria_db": -60, "exact_endcriteria": true, "wall_time_s": 43.0,
  "members": [
    {"file": "studies/patch-mesh-convergence/patch-antenna--mesh_div-15.json",
     "params": {"mesh_div": "15"},
     "summary": {
       "bands": [{"f_lo": 2.39e9, "f_hi": 2.43e9, "f_center": 2.41e9, "s11_min_db": -37.2, "edge_lo": false, "edge_hi": false}],
       "first_resonance": {"f": 2.41e9, "s11_db": -37.2, "matched": true},
       "reactance_zeros": [{"f": 2.53e9, "r": 2.36}],
       "farfield": [{"f": 2.41e9, "dmax_dbi": 6.799, "dmax_pattern_dbi": 6.812, "rad_efficiency": 0.948, "gain_dbi": 6.57, "realized_gain_dbi": 6.57}],
       "dmax_dbi": 6.799, "rad_efficiency": 0.948,
       "cells": 50544, "min_cell": 0.38, "max_cell": 6.66, "timesteps": 12750, "wall_time_s": 6.4, "converged": true}}
  ],
  "convergence": {"tol_f_pct": 0.5, "tol_d_db": 0.1, "converged": true,
                  "steps": [{"df_pct": 0.934, "d_dmax_db": 0.01, "converged": false}]}
}
```

- `members[].file`, sonuçlar klasörüne görelidir; böylece görüntüleyici `/projects/<file>` adresini alabilir.
- `members[].params`, taranan değerleri komut satırında verildiği gibi (dize olarak) tutar.
- Frekanslar Hz cinsindedir.
- `summary.converged`, çalıştırmanın **çözücü** durdurma ölçütü durumudur. `convergence`, mesh çalışmasının sonucudur.
- `sparams` (yalnızca çok portlu modeller), ilk rezonans frekansında `{f, db: {"i,j": |S_ij| in dB}, reciprocity_max, passive}` veya `null` olur.
- `reactance_zeros`, Im(Zin)'in sıfırı yukarı yönde kestiği frekansları (seri rezonansları) o noktadaki Re(Zin) ile listeler. Port referans empedansından bağımsız oldukları için diğer çözücülerle karşılaştırılabilecek en uygun değerlerdir.
- `convergence`, `kind: "convergence"` (`--param` ile inceltme) ve farklı düzenle (yukarıya bakın) `kind: "mesh-convergence"` için bulunur. Ardışık her üye çifti için bir adım içerir.
- Yalnızca isteğe bağlı `--network-metric` / `--network-frequency` ölçütleriyle (bkz. [CLI.md](CLI.md)): çalışmada `network_criteria` bulunur; her üyenin `summary.network` (`--param`) veya `metrics.network` (tasarım) alanı sabit frekans değerlerini tutar. Her yakınsama adımı, sonucu kendi `converged` değeriyle mantıksal VE işlemine giren `network` nesnesi içerir. Seçenekler yoksa alanlar bulunmaz ve sonuçlar değişmez.

## `fairbeam touchstone`

```bash
fairbeam touchstone public/projects/patch-antenna.json              # -> public/projects/patch-antenna.s1p
fairbeam touchstone public/projects/dipole.json -o dipole.s1p --ref 0   # keep the 73 ohm port reference
```

Tek portlu pakette veya `--port N` ile `# GHz S RI R 50` başlıklı Touchstone v1 `.s1p` dosyası yazılır. Çok portlu pakette tam matris `.s<N>p` olarak yazılır; bunun için her portun uyarılmış olması gerekir (`--excite all`, en fazla 4 port için varsayılan). İki portlu dosya, v1 biçiminin gerektirdiği gibi her frekansta tek satırda sütun sırasıyla (S11 S21 S12 S22) yazılır; N ≥ 3 için satır başına en fazla dört karmaşık çift olacak şekilde satır satır yazılır. Farklı referans empedanslı portlar `--ref` değerine tam olarak yeniden normalize edilir. openEMS, S11'i ayrık portun kendi direncine göre ölçer. Tek portta yansıma katsayısı giriş empedansı üzerinden herhangi bir referansa **tam olarak** yeniden normalize edilir: `S' = (Zin − Z) / (Zin + Z)`. Varsayılan 50 Ω'dur; böylece dosya ADS veya scikit-rf'e beklendiği gibi aktarılır. `--ref 0`, portun özgün referansını korur. `--port N` bir port seçer; varsayılan uyarılan porttur.

Python'da Touchstone dosyalarını okumak için `fairbeam.touchstone.read_snp(path)` (`(f_hz, S, z0)` döndürür) veya uyarıları da döndüren `read_touchstone(path)` kullanın. v1 ve v2 dosyaları okunur. Y/Z verileri S'ye dönüştürülür, port başına v2 referansları tek empedansa yeniden normalize edilir ve gürültü blokları atlanır. Görüntüleyicinin içe aktarıcısıyla aynı kuralları kullanır.
