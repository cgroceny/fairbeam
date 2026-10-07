# Turkish UI glossary (TR/EN)

The terms the Turkish interface uses, and why they were chosen. The UI texts are in
`src/i18n/en.json` and `src/i18n/tr.json` (keys `area.item`, English is the fallback), the native
menus and update dialogs in `src-tauri/src/i18n.rs`, the splash/setup page in its own table in
`src-tauri/splash/index.html`. `node scripts/check-i18n.mjs` (part of `npm run check:designer`)
checks that both languages have the same keys and `{parameters}`.

To change a term, change it here and in `tr.json` (search for the Turkish word). Suggestions from
Turkish students and Teknofest teams are welcome.

## Principles

- Common Turkish RF-engineering usage: established symbols and loanwords stay (S11, VSWR, port,
  mesh, empedans). A Turkish gloss may follow the English term on first use in a help text.
- Product names, file formats and code stay as they are: Fairbeam, openEMS, CSXCAD, Python,
  Touchstone, `.design.json`, `.s2p`, Gerber, PDF, CSV, GPU/CPU, TE10.
- Units and symbols stay: mm, GHz, dB, dBi, Ω, S/m, εr, tan δ, λ.
- Short, natural UI Turkish. Buttons are imperatives ("Kaydet", "Çalıştır", "İptal"), menus use
  title case like macOS Turkish ("Farklı Kaydet…"), sentences end with a full stop.
- Suffixes on names and codes take an apostrophe: openEMS'in, Python'u, S11'in. Fairbeam
  is read with a front vowel (/iː/) before the final m and takes the front-vowel suffixes: Fairbeam'i, Fairbeam'e,
  Fairbeam'de, Fairbeam'den, Fairbeam'in, Fairbeam'le. Write them by hand; never add a suffix to the
  name mechanically in a Turkish string.
- The product name is **Fairbeam**: one word, capital F, never translated or hyphenated, in every
  language. It is lower case only where it is code: the command `fairbeam`, the Python module, the
  `fairbeam_` names and the `fairbeam.*` file-format ids. The previous app's name appears only in the
  importer's texts and on the migration page, where it takes back-vowel suffixes. A repository check
  enforces this.
- Numbers shown as text use the Turkish decimal comma (2,45 GHz) and digit grouping with a point
  (1.234.567 hücre), and a negative number starts with the typographic minus U+2212 (−10 dB), all
  three through the same helpers (`fmt` in `src/i18n`, `shown` in `src/designer/displayNumber.ts`,
  the Checks text in `src/designer/checkText.ts`), so one text never mixes "9.700" with "9,700".
  With General settings › Decimal separator set to a point, nothing is converted. Input fields and
  exported files (CSV, Touchstone, VBA macro, `.design.json`) always keep the decimal point, so
  engineering files stay machine-readable; the Design panel says so ("Sayıları her dilde ondalık nokta
  ile yazın") and a comma typed in an expression is answered with that hint.
- Labels the app writes into a design file in English ("Design frequency") are shown translated
  (`src/lib/paramLabel.ts`); a label the user typed is shown as typed.
- Correct Turkish letters everywhere: ç ğ ı İ ö ş ü (the IBM Plex fonts' latin-ext subset has them).

## Screens and workspace

| English | Türkçe | Note |
|---|---|---|
| Start (screen) | Ana ekran | "Başlangıç" is only the start of a range, a sweep or a port (the coordinate); a starting design is a "şablon" and a run setup choice a "hazır ayar" (below), never "başlangıç" |
| Home (ribbon tab) | Giriş | as in the Turkish Office ribbon; it holds the "Ana ekran" button, so the tab never repeats that name |
| 3D view / 2D-3D | 3B görünüm / 2B/3B | "3B" everywhere; "3D" stays only in file or product names |
| Design / the designer | Tasarım / tasarımcı | |
| Examples | Örnekler | |
| Results | Sonuçlar | tab, tree folder, dock; "2B/3B Sonuçlar" is the tree's field-map folder |
| Post (ribbon tab, run step) | Son işlem | processing after the solver |
| Result file (a run's saved `.json`) | Sonuç dosyası | what "Open result file…" opens; "Proje" is no longer used in the interface (see UI terms) |
| Workspace (folder) | Çalışma klasörü / çalışma alanı | |
| Ribbon | Şerit | as in Office |
| Tab | Sekme | |
| Navigation tree | Gezinti ağacı (ağaç) | |
| Properties (panel) | Özellikler | |
| Dock (bottom panel) | Alt panel | |
| Status bar | Durum çubuğu | |
| Settings / General settings | Ayarlar / Genel ayarlar | |
| Language / System | Dil / Sistem | |
| Theme: light, dark | Tema: açık, koyu | |
| Template / starter design | Şablon | the Start screen's choices; their names are translated too ("Boş tasarım", "Yama anten şablonu"); the "Start from" label reads "Şablon" |
| Run setup preset (Quick exploration, Balanced, …) | Hazır ayar | not "başlangıç ayarı" |
| History | Geçmiş | |
| Undo / Redo | Geri Al / Yinele | |
| Save / Save As… | Kaydet / Farklı Kaydet… | |
| Open / Close | Aç / Kapat | |
| Import / Export | İçe aktar / Dışa aktar | |
| Export package (the zip of a result: header button, dialog title, ribbon tooltip) | Paketi dışa aktar | one name everywhere; the ribbon button may use the short form "Paket" when its tooltip says "Paketi dışa aktar" |
| Preview | Önizleme | "Mesh önizlemesi" (not "Önizleme mesh'i") |
| Rendered (the View toggle) / Render image… / Rendered image (PNG)… | Render / Render görüntüsü… / Render görüntüsü (PNG)… | one term for the feature; its ribbon group is "Render", apart from the "Görünüm" tab |
| Run (verb / button, noun, list) | Çalıştır / Çalıştırma / Çalıştırmalar | one term for a simulation run, in every text ("Bu çalıştırma", "yeniden çalıştırın", the Çalıştırmalar tab); "koşu" and "koşturmak" are not used. Its saved file is the result file |
| Job | İş | |
| Run server | Çalıştırma sunucusu | `fairbeam serve` |
| Runtime | Çalışma ortamı | the managed Python + openEMS |
| Engine | Motor | CPU/GPU engine |
| Threads | İş parçacığı | |
| Report a problem / Suggest a feature | Sorun bildir / Özellik öner | |
| Usage statistics | Kullanım istatistikleri | |

## Modeling

| English | Türkçe | Note |
|---|---|---|
| Component (a group of solids) | Bileşen | the tree's folders |
| Solid (a named part with one material) | Katı | "part" and "parça" are no longer used in the interface |
| Solids (the tree heading over the solids and their components) | Katılar | the heading names its rows, like the Examples panel |
| Shape / primitive | Şekil | one brick, cylinder, polygon… inside a solid |
| Brick | Kutu | |
| Cylinder / Sphere / Cone / Torus | Silindir / Küre / Koni / Torus | |
| Polygon / extruded polygon | Çokgen / uzatılmış çokgen | |
| Sheet | Levha | a zero-thickness shape |
| Wire | Tel | |
| Transform | Dönüştür | |
| Translate / Rotate / Mirror / Scale | Ötele / Döndür / Aynala / Ölçekle | |
| Copies | Kopyalar | |
| Boolean: Add (union) / Subtract / Intersect | Boolean: Birleştir / Çıkar / Kesiştir | |
| Face / edge / vertex | Yüz / kenar / köşe | |
| Parameter | Parametre | |
| Expression | İfade | |
| Material / material library | Malzeme / malzeme kütüphanesi | |
| Dielectric | Dielektrik | |
| Conductor / metal | İletken / metal | |
| Perfect conductor (PEC) | Mükemmel iletken (PEC) | |
| Conductivity | İletkenlik | S/m |
| Relative permittivity | Bağıl dielektrik sabiti (εr) | |
| Loss tangent | Kayıp tanjantı (tan δ) | |
| Substrate | Alttaş (substrat) | |
| Ground plane | Toprak düzlemi | |
| Patch | Yama | |
| Probe port (a discrete port between the ground and the patch) | Sonda portu | the fix "Add a probe port between …" |
| Air padding | Hava payı | mesh › pad, and its check `air-pad` |
| Feed | Besleme | |
| Port / discrete port / waveguide port | Port / ayrık port / dalga kılavuzu portu | "Discrete port" is the name of the lumped port, "ayrık port" in every text including the Checks (never "toplu port"); the file format still says `lumped` |
| Lumped element (R, L, C) | Toplu eleman | "toplu" is only for these R/L/C elements, never for a port |
| Excitation | Uyarım | |
| Resistor | Direnç | |
| Axis | Eksen | |

## Simulation

| English | Türkçe | Note |
|---|---|---|
| Simulation settings | Simülasyon ayarları | |
| Solver | Çözücü | |
| Frequency / band | Frekans / bant | |
| Bandwidth | Bant genişliği | |
| Boundary conditions | Sınır koşulları | PML, PEC, PMC, MUR stay |
| Mur absorbing boundary | Mur emici sınır | the Examples solver card; never "Mur ABC" |
| Mesh / mesh line / cell | Mesh / mesh çizgisi / hücre | "ağ" is understood, "mesh" is what engineers say |
| Cells per wavelength (at f max) / Cells / λ | Dalga boyu başına hücre (f max'ta) / Hücre / λ | one mesh-density term; the short form is for the ribbon and tables |
| Mesh convergence | Mesh yakınsaması | |
| Run limit (mesh convergence: most densities run) / Within tolerance | Çalıştırma sınırı / Tolerans içinde | "Maximum runs" and "Within" before |
| End criterion | Durdurma ölçütü | energy decay in dB |
| Timestep | Zaman adımı | |
| Energy decay | Enerji sönümü | |
| Parameter sweep | Parametre taraması | |
| Optimization / optimizer / goal | Optimizasyon / optimizasyon aracı / hedef | |
| Secant (method) | Sekant | "Otomatik (Sekant)"; never "secant" or "Kesen" |
| Monitor / field plane | Monitör / alan düzlemi | |
| Checks (the list, dock tab, status) | Denetimler | the feature; "Tasarım denetimleri" in running text |
| to check (user instruction) | kontrol edin | "denetle" only where the app checks something (buttons, progress) or in fixed menu names (Güncellemeleri denetle) |
| UI controls | kontroller | never "denetim" for buttons/controls, to keep it free for Checks |
| Error / warning / info | Hata / uyarı / bilgi | |

## Results

| English | Türkçe | Note |
|---|---|---|
| S-parameters | S-parametreleri | S11, S21 stay |
| Reflection (coefficient) | Yansıma (katsayısı) | |
| Return loss | Geri dönüş kaybı | |
| VSWR | VSWR | (duran dalga oranı) |
| Impedance | Empedans | |
| Smith chart | Smith abağı | |
| Far field | Uzak alan | |
| Radiation pattern | Işıma örüntüsü | |
| Gain | Kazanç | |
| Realized gain | Gerçekleşen kazanç | |
| Directivity | Yönlülük | |
| Efficiency / radiation / total efficiency | Verimlilik / ışıma verimliliği / toplam verimlilik | |
| Surface current | Yüzey akımı | |
| E-field / H-field | E alanı / H alanı | |
| Resonance | Rezonans | |
| Marker | İşaretçi | |
| Polar / Cartesian | Kutupsal / Kartezyen | |
| Linear / dB | Doğrusal / dB | |
| Compare / reference data | Karşılaştır / referans verisi | |
| Δ vs A (a comparison's difference from its first run) | Δ (A ile) | "ile" fits every run letter, unlike a dative suffix (A'ya, B'ye); the exported Δ headers stay English |
| Percentage points (pp; efficiency difference) | puan | "+2,3 puan"; the Summary compare table's Δ view |
| Values (view of the compare table) | Değerler | |

## UI terms (English wording decisions)

The English interface uses one word per thing. The Turkish texts follow the same split.

| Thing | UI word | Not | Turkish |
|---|---|---|---|
| The editable model file (`*.design.json`) | design: "New design", "Close design", "Your designs", "Open as new design…", "Design ID" | project | tasarım |
| One simulation and what it produced | run: "Runs" tab, "Compare runs", "Run server" | project, simulation cell | çalıştırma |
| The saved `.json` of a run | result file: "Open result file…", "Result file" | project bundle, project | sonuç dosyası |
| A bundled read-only design with results | example: "Example: Patch antenna", "Open as new design…" | example project | örnek |
| The copy action on an example (app, docs and website) | "Open as new design…" | Open as new project | Yeni tasarım olarak aç |
| Parameter sweep (dialog title, ribbon button and docs) | "Parameter sweep", sentence case | Parametric sweep, Parameter Sweep | parametre taraması |
| The size of a sweep | runs ("12 runs · max 500"); mesh "cells" are only mesh cells | simulation cells | çalıştırma |
| Check button of the sweep dialog | "Validate" | Check (it repeats the live run count) | Doğrula |
| Frequency of the S11 minimum in the S11 summary | "Resonance" (Rezonans) | Band | rezonans |
| The radiation result and its adjective | "Far field" as a noun, "far-field" before a noun | Farfield, Far-field (as a noun) | uzak alan |
| Spelling | US English: modeling, center, color, optimize, maximize, meter | modelling, centre, colour, optimise, maximise | |
| Counts | pluralised with the `one`/`other` forms, never "part(s)" | 1 parts | |

Vocabulary: a Component groups solids (the tree folders), a Solid is one named body with a
material (`parts` in the file format), and a Discrete port is the lumped port; "Lumped" stays for
R/L/C elements. Code, file keys and Python messages keep the old words.
The design checks (`checks.msg.*`, `checks.explain.*`) still mirror the server's English text, which
keeps some British spellings ("centre"): they change together with `python/fairbeam/design_checks.py`
and `src/designer/checks.ts`, not here.

## Consistency rules used in tr.json

- "3B" (never "3D") in all Turkish texts, also "2B/3B Sonuçlar"; the English UI keeps 3D.
- Navigation paths in help texts ("Simülasyon › Monitörler › Uzak alan") use the exact Turkish labels
  of the ribbon tab, group and button, the tree folder or the dialog section they name. The native
  menus (`src-tauri/src/i18n.rs`) and the settings dialog names are the source for "Yardım › …" and
  "Ayarlar › Genel › …". `scripts/check-i18n.mjs` cannot verify these; re-read them when a label changes.
- "Denetimler" is the Checks list; "kontrol edin" is the instruction "check X"; "kontroller" are UI controls.
- Tooltips and help texts address the user with the polite imperative ("seçin", "kaydedin", "açın");
  button and menu labels stay bare imperatives ("Kaydet", "Aç"), and so does an icon button's name.
- A criterion and its value never break apart: a no-break space follows "≤" and separates a number from
  its unit ("≤ −60 dB"). A timestep count is a count ("29.073 zaman adımından sonra"), never an ordinal
  ("29.073. zaman adımında" reads as one number with a point).
- Numbers shown as text use the decimal comma; lists of coordinates and frequencies then separate with
  a semicolon ("0,5; 1,2; 3"), so a comma is never both a decimal and a separator.

## Terms with alternatives

Choices where a Turkish reader could reasonably prefer another word. Change one by searching for the
word in `src/i18n/tr.json` (and `src-tauri/src/i18n.rs` for menu labels).

| Term | Now | Alternatives | Why the current one |
|---|---|---|---|
| 3D | 3B | 3D | "3B" (3 boyutlu) is the standard Turkish abbreviation and matches "2B"; some CAD programs' Turkish UIs still print "3D", which is also understood. Switching back is one replace of `3B` -> `3D` in tr.json |
| Checks | Denetimler | Kontroller, Doğrulamalar | "Denetim" reads as an audit of the design; "kontrol" is kept for the verb and for UI controls so the two never collide |
| Component (tree folder) | Bileşen | Modül, Öğe, Grup | Literal translation of "component", as CAD tools use it; "Öğe" is used only for generic list items, "Eleman" for array elements |
| Solid | Katı | Parça, Gövde, Cisim | "Katı" is the CAD term for a solid body; "Şekil" is the primitive inside a solid |
| Discrete port | Ayrık port | Toplu port, Ayrı port | "Toplu" is kept for lumped R/L/C elements, so a port and an element never share a word |
| Sleeve dipole | Kılıflı dipol | Manşonlu dipol, Sleeve dipol | "Kılıf" is the sheath around the coax; "manşon" is a less familiar word for it |
| Post (processing) | Son işlem | Son işleme, İşlem sonrası, Post-processing | Short enough for a ribbon tab; read as "final step" in the run steps too |
| Far field | Uzak alan | Uzak bölge alanı, Far-field | Literal and widely understood |
| Realized gain | Gerçekleşen kazanç | Gerçekleştirilmiş kazanç, Realized gain | No fixed Turkish term; "Realized Gain" also stays in CSV headers and import column names |
| Directivity | Yönlülük | Direktivite, Yönlendiricilik | "Yönlülük" is the native word; "direktivite" is the loanword, shorter and common in industry talk |
| Mesh | mesh | Ağ, Izgara, Örgü | Engineers say "mesh"; "ağ" also means network (a Touchstone "ağ verisi" appears in one message). "Izgara" is used for grid (snap grid, frequency grid) only |
| Gain | Kazanç | Kazanım | Standard |
| Marker | İşaretçi | İmleç, Marker | "İmleç" is kept for the mouse cursor |
| Pattern | Örüntü (ışıma örüntüsü) | Desen, Diyagram | Descriptive; "Işıma diyagramı" is the other frequent name |
| Sheet | Levha | Sac, Yaprak | Zero-thickness metal; "sac" would suggest real sheet metal |
| Ribbon | Şerit | Kurdele, Ribbon | As in the Turkish Office UI |
