// One language state for the public landing page and its asynchronously loaded comparison.
// The desktop app stores its language choice in the same fairbeam.generalSettings record.
(() => {
  const SETTINGS_KEY = "fairbeam.generalSettings";

  // Exact source strings keep translations attached to copy while preserving inline markup,
  // equations, links, measured values, version numbers and commands.
  const pairs = [
    ["Skip to content", "İçeriğe geç"], ["Page sections", "Sayfa bölümleri"],
    ["Open section navigation", "Bölüm gezintisini aç"], ["Close section navigation", "Bölüm gezintisini kapat"],
    ["How it works", "Nasıl çalışır"], ["Examples", "Örnekler"], ["The designer", "Tasarım aracı"],
    ["Features", "Özellikler"], ["Results", "Sonuçlar"], ["Solver comparison", "Çözücü karşılaştırması"], ["Roadmap", "Yol haritası"],
    ["Download", "İndir"], ["What to expect", "Neler beklemeli"], ["Guide", "Kılavuz"], ["Demo", "Demo"],
    ["Site language", "Site dili"], ["Theme: system", "Tema: sistem"], ["Theme: light", "Tema: açık"], ["Theme: dark", "Tema: koyu"],
    ["Theme: system (click to change)", "Tema: sistem (değiştirmek için tıklayın)"],
    ["Theme: light (click to change)", "Tema: açık (değiştirmek için tıklayın)"],
    ["Theme: dark (click to change)", "Tema: koyu (değiştirmek için tıklayın)"],
    ["Antenna simulation workbench · openEMS FDTD", "Antenna simülasyon çalışma ortamı · openEMS FDTD"],
    ["Design antennas. See the fields.", "Anten tasarlayın. Alanları görün."],
    ["Draw an antenna, a microstrip circuit or an array in a ribbon-based 3D designer, or import a CST-compatible VBA macro. Fairbeam meshes it, runs the open-source openEMS solver on the CPU or the GPU, and shows the results next to the model: S-parameters with markers, radiation patterns, surface currents, sweeps, an optimizer, and exports for Touchstone, CST-compatible VBA macros and PCB fabrication.", "Şerit menülü 3B tasarım aracında anten, mikroşerit devre veya dizi çizin ya da CST uyumlu VBA makrosu içe aktarın. Fairbeam ağı oluşturur, açık kaynaklı openEMS çözücüsünü CPU'da veya GPU'da çalıştırır ve sonuçları modelin yanında gösterir: işaretçilerle S-parametreleri, ışınım örüntüleri, yüzey akımları, taramalar, eniyileyici ve Touchstone, CST uyumlu VBA makrosu ile PCB üretimi için dışa aktarımlar."],
    ["Download Fairbeam", "Fairbeam'i indirin"], ["Open the demo", "Demoyu açın"],
    ["Free desktop app for macOS (Apple silicon) and Windows. The browser demo is read-only and opens 14 example projects that were simulated beforehand.", "macOS (Apple silicon) ve Windows için ücretsiz masaüstü uygulaması. Tarayıcı demosu salt okunurdur ve önceden benzetilmiş 14 örnek projeyi açar."],
    ["Scroll: the patch is taken apart and simulated again", "Kaydırın: yama parçalara ayrılır ve yeniden benzetilir"],
    ["From a model to fields, in one patch antenna", "Bir modelden alanlara: tek bir yama antende"],
    ["Model it", "Modelleyin"],
    ["Draw it in the designer, where every length is an expression over named parameters, or import a CST-compatible VBA macro. The same model can also be one Python file with a", "Tasarım aracında her uzunluğu adlandırılmış parametrelere bağlı bir ifade olarak tanımlayın veya CST uyumlu VBA makrosu içe aktarın. Aynı model, şu işlevi içeren tek bir Python dosyası da olabilir:"],
    ["that places metal, dielectrics and ports.", "metal parçaları, dielektrikleri ve portları yerleştirir."],
    ["Exact geometry", "Kesin geometri"],
    ["The viewer rebuilds every primitive exactly: a 32 × 40 mm patch on 1.524 mm of ε", "Görüntüleyici her temel şekli tam ölçüleriyle yeniden kurar: 1,524 mm kalınlığında ε"],
    ["3.38, the ground plane and a 50 Ω probe feed.", "3,38 alt tabaka üzerinde 32 × 40 mm yama, toprak düzlemi ve 50 Ω prob beslemesi."],
    ["Meshed for FDTD", "FDTD için ağ oluşturuldu"],
    ["Fine cells at the patch edges and in the substrate, coarse ones in the air: 69 × 69 × 58 mesh lines, 263 k cells.", "Yama kenarlarında ve alt tabakada ince, havada kaba hücreler: 69 × 69 × 58 ağ çizgisi, 263 bin hücre."],
    ["Excited, the currents flow", "Uyarım uygulanınca akımlar oluşur"],
    ["A Gaussian pulse at the feed rings the patch. This is the surface current openEMS recorded at resonance: strongest in the middle of the patch and falling to zero at the two radiating edges, as the TM", "Beslemedeki Gauss darbesi yamayı titreştirir. Bu, openEMS'in rezonans noktasında kaydettiği yüzey akımıdır: TM"],
    ["mode predicts.", "modunun öngördüğü gibi yamanın ortasında en yüksek düzeydedir ve ışınım yapan iki kenarda sıfıra iner."],
    ["It radiates", "Işınım yapar"],
    ["Near-to-far-field transform: 6.79 dBi broadside at 2.453 GHz, 96.5 % radiation efficiency. Radius and color both show directivity.", "Yakın alandan uzak alana dönüşüm: 2,453 GHz'de dik yönde 6,79 dBi, %96,5 ışınım verimi. Yarıçap ve renk, yönlülüğü gösterir."],
    ["Checked, then exported", "Denetlendi ve dışa aktarıldı"],
    ["|S11| dips to −34.5 dB at 2.453 GHz, within 0.1 % of the converged mesh. Then everything goes out: a CST-compatible VBA macro, Touchstone, drawings, a report, Gerber files.", "|S11|, 2,453 GHz'de −34,5 dB'ye iner; yakınsamış ağdan farkı %0,1'dir. Ardından her şey dışa aktarılır: CST uyumlu VBA makrosu, Touchstone, teknik çizimler, rapor ve Gerber dosyaları."],
    ["Arrays", "Anten dizileri"], ["Four patches, one beam you can steer", "Dört yama, yönlendirebileceğiniz tek bir demet"],
    ["One patch becomes four", "Tek yama dörde dönüşür"],
    ["The same patch four times, half a wavelength apart (61.2 mm) on one 66 × 243.6 mm board, each with its own 50 Ω port. Fed in phase they reach 11.9 dBi broadside, about 5 dB above the single patch.", "Aynı yamadan dört tane, aralarında yarım dalga boyu (61,2 mm) olacak şekilde tek bir 66 × 243,6 mm kart üzerine yerleştirilir; her birinin 50 Ω portu vardır. Fazları eşit beslendiklerinde dik yönde 11,9 dBi'ye, tek yamadan yaklaşık 5 dB fazlasına ulaşırlar."],
    ["Steered by phase alone", "Yalnızca faz ile yönlendirme"],
    ["A phase that falls by k·d·sin θ", "Portlar arasında k·d·sin θ"],
    ["from port to port turns the beam. openEMS ran once per port with the other three terminated in 50 Ω (four runs, 18 s on the GPU engine), so every angle here is the weighted sum of four embedded element patterns: coupling included, and each port's active reflection moves with the beam.", "kadar azalan faz, demeti yönlendirir. openEMS her port için bir kez çalıştı; diğer üç port 50 Ω ile sonlandırıldı (GPU motorunda dört çalışma, 18 sn). Bu nedenle her açı, kuplajı içeren dört gömülü eleman örüntüsünün ağırlıklı toplamıdır; her portun etkin yansıması demetle birlikte değişir."],
    ["Your turn", "Sıra sizde"],
    ["Steer it. The app does the same for any amplitudes and phases, and exports the steered pattern.", "Demeti yönlendirin. Uygulama, istediğiniz genlik ve fazlarla aynı işlemi yapar ve yönlendirilmiş örüntüyü dışa aktarır."],
    ["Scan angle θ", "Tarama açısı θ"],
    ["Horns, helices, fractals and circuits", "Hornlar, helisler, fraktallar ve devreler"],
    ["Pyramidal horn, WR-90", "WR-90 piramidal horn"],
    ["An optimum-gain horn fed by a TE", "TE"],
    ["waveguide port, with PML boundaries: 15.5 dBi at 10 GHz and |S11| below −16 dB from 8 to 12 GHz.", "dalga kılavuzu portuyla beslenen, eniyilenmiş kazançlı horn; PML sınırlarıyla 10 GHz'de 15,5 dBi ve 8–12 GHz arasında −16 dB'nin altında |S11|."],
    ["Axial-mode helix", "Eksenel modlu helis"],
    ["A Kraus helix, seven turns at 13° pitch over a square ground plane: right-hand circular, 11.6 dBi at 2.4 GHz, an axial ratio of 0.9 dB on boresight and the cross-polarized LHCP 26 dB lower.", "Kare toprak düzlemi üzerindeki Kraus helisi: 13° eğimde yedi tur, sağ el dairesel polarizasyon, 2,4 GHz'de 11,6 dBi, ana doğrultuda 0,9 dB eksen oranı ve çapraz polarizasyondaki LHCP 26 dB daha düşük."],
    ["Minkowski fractal patch", "Minkowski fraktal yama"],
    ["The fractal edge lengthens the current path: 30 × 30 mm of copper resonates at 2.324 GHz, below the 32 × 40 mm plain patch at 2.453 GHz on the same substrate, at the price of bandwidth (0.8 %).", "Fraktal kenar akım yolunu uzatır: 30 × 30 mm bakır, aynı alt tabakadaki 32 × 40 mm düz yamanın 2,453 GHz değerinin altında, 2,324 GHz'de rezonansa girer; bunun karşılığında bant genişliği %0,8'e düşer."],
    ["Wilkinson divider", "Wilkinson bölücü"],
    ["Three ports and one lumped 100 Ω resistor: an equal split with S21 = S31 = −3.09 dB. One openEMS run per driven port gives the full S-matrix.", "Üç port ve tek bir yığılmış 100 Ω direnç: S21 = S31 = −3,09 dB ile eşit bölme. Her uyarılan port için bir openEMS çalışması, tam S-matrisini verir."],
    ["Branch-line coupler", "Dal kolu kuplörü"],
    ["A 90° hybrid: −3.21 and −2.99 dB to the two outputs at 2.40 GHz, 90.0° apart, with the reciprocity and passivity of the four-port matrix checked.", "90° hibrit: 2,40 GHz'de iki çıkışta −3,21 ve −2,99 dB; aralarındaki faz farkı 90,0°'dir. Dört portlu matrisin karşılıklılığı ve pasifliği denetlenmiştir."],
    ["Stepped-impedance low-pass", "Kademeli empedanslı alçak geçiren filtre"],
    ["Alternating wide and narrow line sections: the −3 dB point lands at 2.356 GHz, 5.2 % below the ideal line cascade, because the steps themselves add capacitance.", "Geniş ve dar hat bölümleri sırayla kullanılır. Kademelerin eklediği kapasitans nedeniyle −3 dB noktası, ideal hat zincirinden %5,2 düşük olan 2,356 GHz'e gelir."],
    ["Open all 14 examples in the demo", "14 örneğin tümünü demoda açın"],
    ["Real outputs", "Gerçek çıktılar"], ["The files, as they come out", "Üretilen dosyalar"],
    ["A3 drawing generated from the simulated geometry", "Benzetilmiş geometriden oluşturulan A3 teknik çizimi"],
    ["|S11| as a publication figure (8.8 cm)", "Yayın için |S11| grafiği (8,8 cm)"],
    ["Multi-port S-parameters, Wilkinson divider", "Çok portlu S-parametreleri: Wilkinson bölücü"],
    ["What Fairbeam does", "Fairbeam neler yapar"],
    ["Ribbon-based designer", "Şerit menülü tasarım aracı"],
    ["A one-row ribbon, a collapsible navigation tree, properties and dock, and a Python side panel. Bricks, cylinders, spheres, cones, tori, wires, polygons and extrusions; draw bricks in 3D, extrude a picked face, booleans, one Transform dialog, shortcuts, Undo, Redo and Save As.", "Tek satırlı şerit menü, daraltılabilir gezinme ağacı, özellikler ve panel, Python yan paneli. Prizmalar, silindirler, küreler, koniler, toruslar, teller, çokgenler ve ekstrüzyonlar; 3B prizma çizimi, yüzey ekstrüzyonu, Boole işlemleri, tek Dönüştür penceresi, kısayollar, Geri Al, Yinele ve Farklı Kaydet."],
    ["Import a VBA macro", "VBA makrosu içe aktarımı"],
    ["Reads a CST-compatible VBA macro or history list: parameters, materials, shapes, booleans, transforms, ports, resistors, monitors, the band, the boundaries and manual mesh lines. An import report lists every command that was skipped or changed, with its line.", "CST uyumlu VBA makrosunu veya geçmiş listesini okur: parametreler, malzemeler, şekiller, Boole işlemleri, dönüşümler, portlar, dirençler, monitörler, bant, sınırlar ve elle tanımlanmış ağ çizgileri. İçe aktarma raporu atlanan veya değiştirilen her komutu satır numarasıyla listeler."],
    ["Parameters and checks", "Parametreler ve denetimler"],
    ["Every length and frequency is an expression over named parameters. Checks run as you edit and explain what they found; a design without an excited port, or one that cannot converge, is refused before any solver time is spent.", "Her uzunluk ve frekans, adlandırılmış parametrelerle tanımlanan bir ifadedir. Siz düzenlerken denetimler çalışır ve bulguları açıklar; etkin bir portu olmayan veya yakınsamayan tasarım, çözücü çalıştırılmadan reddedilir."],
    ["Start templates and examples", "Başlangıç şablonları ve örnekler"],
    ["Start from a half-wave dipole, a quarter-wave monopole, an open-ended waveguide, a printed sleeve dipole or a two-port microstrip line, or pick an example from a searchable list, which now includes a 2-element collinear and a 5-element Yagi for 867 MHz.", "Yarım dalga dipol, çeyrek dalga monopol, açık uçlu dalga kılavuzu, baskılı kılıf dipol veya iki portlu mikroşerit hat ile başlayın. Aranabilir listedeki örnekler arasında 867 MHz için 2 elemanlı doğrusal dizi ve 5 elemanlı Yagi de bulunur."],
    ["Import PCB artwork", "PCB çizimini içe aktarın"],
    ["Home › Import PCB turns DXF, Gerber and Excellon files into a design;", "Giriş › PCB'yi İçe Aktar, DXF, Gerber ve Excellon dosyalarını tasarıma dönüştürür;"],
    ["does the same from the command line.", "komut satırından da aynı işlemi yapar."],
    ["Automatic meshing", "Otomatik ağ oluşturma"],
    ["Auto mode picks the mesh settings for each design, and every field can be overridden. Thin PCB copper is meshed as sheets, converted examples keep their own mesh lines, and the mesher lands within 0.1 % of converged hand meshes.", "Otomatik mod her tasarım için ağ ayarlarını seçer; her alanı elle değiştirebilirsiniz. İnce PCB bakırı levha olarak ağlanır, dönüştürülen örnekler kendi ağ çizgilerini korur ve otomatik ağ, elle yakınsatılmış ağlardan %0,1 içinde kalır."],
    ["Mesh convergence", "Ağ yakınsaması"],
    ["Simulation › Mesh convergence… runs the design at finer automatic meshes until the resonance, |S11| and D", "Benzetim › Ağ Yakınsaması… rezonans, |S11| ve D"],
    ["stop changing, and reports the density that converged. From the command line:", "artık değişmeyene kadar tasarımı giderek ince otomatik ağlarla çalıştırır ve yakınsayan yoğunluğu bildirir. Komut satırından:"],
    [".", "."],
    ["Run quality and one-click fixes", "Çalıştırma kalitesi ve tek tıkla düzeltmeler"],
    ["A run that did not converge, or whose numbers look suspicious, is flagged in the tree and on its results. Common design checks offer a fix in one click. Waveguide-port power is calibrated, so the pyramidal horn's efficiency reads about 99 %.", "Yakınsamayan veya şüpheli sonuç veren çalışma, ağaçta ve sonuçlarında işaretlenir. Sık rastlanan tasarım denetimleri tek tıkla düzeltme sunar. Dalga kılavuzu portunun gücü kalibre edildiğinden piramidal hornun verimi yaklaşık %99 görünür."],
    ["Parameter sweeps", "Parametre taramaları"],
    ["Sequences, each over up to six parameters as ranges or value lists, checked before anything runs. The runs are queued, and every run of the sweep can be compared in one plot.", "Her biri aralık veya değer listesi biçiminde en çok altı parametreyi kapsayan diziler çalıştırılmadan önce denetlenir. Çalışmalar kuyruğa alınır ve taramadaki tüm sonuçlar tek grafikte karşılaştırılabilir."],
    ["Goal-driven optimizer", "Hedef odaklı eniyileyici"],
    ["Goals such as f", "f"], [", |S11| at a frequency, bandwidth, D", ", belirli bir frekansta |S11|, bant genişliği, D"],
    ["or |S", "veya |S"], ["| limits, over as many parameters as you vary. Secant, Nelder–Mead, Bayesian, CMA-ES, particle swarm, genetic and trust-region searches, with live progress; the best result is kept to open, apply or save.", "| sınırları, seçtiğiniz sayıda parametre boyunca belirlenebilir. Sekant, Nelder–Mead, Bayesçi, CMA-ES, parçacık sürüsü, genetik ve güven bölgesi aramaları canlı ilerlemeyle çalışır; en iyi sonucu açabilir, uygulayabilir veya kaydedebilirsiniz."],
    ["Multi-port S-parameters", "Çok portlu S-parametreleri"],
    ["One openEMS run per driven port gives the full S-matrix of filters, dividers, couplers and arrays, with reciprocity and passivity checks, a picker for any S", "Uyarılan her port için bir openEMS çalıştırması; filtre, bölücü, kuplör ve dizilerin tam S-matrisini verir. Karşılıklılık ve pasiflik denetimleri, istenen S"],
    [", a Smith chart per port and Touchstone", ", her port için Smith grafiği ve Touchstone"], ["export.", "dışa aktarımı sunulur."],
    ["Results with markers", "İşaretçili sonuçlar"],
    ["Result tabs: S-parameters, impedance, VSWR, Smith chart, efficiency and patterns, with markers for resonances and bandwidth, hover read-outs and your own markers. Runs are compared by the parameters that differ; Copy data and CSV in dB, phase, Re/Im or magnitude/phase.", "Sonuç sekmeleri: S-parametreleri, empedans, VSWR, Smith grafiği, verim ve örüntüler; rezonans ve bant genişliği işaretçileri, üzerine gelince bilgi ve kendi işaretçileriniz. Çalışmalar farklı parametrelere göre karşılaştırılır; veriyi ve CSV'yi dB, faz, Re/Im veya genlik/faz olarak kopyalayın."],
    ["Result summaries and comparison", "Sonuç özetleri ve karşılaştırma"],
    ["Headline numbers for each run in the tree and the Runs table, and Tables › Summary. A comparison table lists the parameters that differ between runs; copy it or save it as CSV.", "Ağaçta ve Çalışmalar tablosunda her çalışma için öne çıkan değerler, ayrıca Tablolar › Özet. Karşılaştırma tablosu çalışmalar arasındaki farklı parametreleri listeler; tabloyu kopyalayabilir veya CSV olarak kaydedebilirsiniz."],
    ["2D and 3D field maps", "2B ve 3B alan haritaları"],
    ["The Field map tab shows E and H planes as heat maps with a read-out and the model's outline.", "Alan Haritası sekmesi, E ve H düzlemlerini modelin dış çizgisi ve değer göstergesiyle ısı haritası olarak sunar."],
    ["Phase", "Faz"], ["and", "ve"], ["Animate", "Canlandır"],
    ["play a time-harmonic animation of the field, in 2D and in the 3D view.", "alanın zamana bağlı harmonik animasyonunu 2B'de ve 3B görünümde oynatır."],
    ["Far field, currents, beams", "Uzak alan, akımlar ve demetler"],
    ["3D patterns and polar cuts in directivity, gain, realized gain or RHCP/LHCP, with a card for D", "Yönlülük, kazanç, gerçekleşen kazanç veya RHCP/LHCP için 3B örüntüler ve kutupsal kesitler; D"],
    [", gains, radiation, mismatch and total efficiency and the main lobe. Optionally, the radiation and total efficiency over the whole band, computed after the run (about 0.3 s for 21 frequencies on the patch; the solver time does not change). Animated surface currents, and array beams steered after the run.", ", kazanç, ışınım, uyumsuzluk ve toplam verim ile ana lob kartı. İsteğe bağlı olarak tüm banttaki ışınım ve toplam verim, çalışma bittikten sonra hesaplanır (yama için 21 frekansta yaklaşık 0,3 sn; çözücü süresi değişmez). Animasyonlu yüzey akımları ve çalışma sonrasında yönlendirilen dizi demetleri."],
    ["GPU engines", "GPU motorları"],
    ["Optional GPU builds of openEMS: Metal on Apple silicon and CUDA on NVIDIA cards under Windows. The patch antenna takes 1.6 s instead of 10.6 s on an M5 Pro, and 2.6 s instead of 53 s on a Ryzen 9 with an RTX 3060. When a GPU build is installed it is the default, and the CPU engine stays available.", "İsteğe bağlı openEMS GPU derlemeleri: Apple silicon'da Metal, Windows'ta NVIDIA kartlarda CUDA. Yama anten, M5 Pro'da 10,6 sn yerine 1,6 sn; RTX 3060'lı Ryzen 9'da 53 sn yerine 2,6 sn sürer. GPU derlemesi kuruluysa varsayılan olarak kullanılır; CPU motoru da kullanılabilir."],
    ["VBA macro, drawings, fabrication", "VBA makrosu, teknik çizimler ve üretim"],
    ["A CST-compatible VBA macro rebuilds the model in the target program, and Touchstone or CSV files can be compared against the run. Dimensioned drawings, publication figures, a PDF report, and Gerber, drill and DXF files (preview).", "CST uyumlu VBA makrosu modeli hedef programda yeniden kurar; Touchstone veya CSV dosyaları çalıştırma sonuçlarıyla karşılaştırılabilir. Ölçülendirilmiş teknik çizimler, yayın grafikleri, PDF raporu, Gerber, delik ve DXF dosyaları (önizleme)."],
    ["Desktop app", "Masaüstü uygulaması"],
    ["For macOS and Windows, in English or Turkish (General settings › Language, native menus included, with a Decimal separator setting), with Save As, and a question before closing unsaved work. First start installs Python and openEMS for your user account; projects live in Documents/Fairbeam, and updates are offered in the app.", "macOS ve Windows için Türkçe veya İngilizce; yerel menüler ve Ondalık ayırıcı ayarı Genel ayarlar › Dil bölümündedir. Farklı Kaydet bulunur ve kaydedilmemiş çalışma kapatılırken sorulur. İlk açılışta Python ile openEMS hesabınıza kurulur; projeler Documents/Fairbeam içinde tutulur ve güncellemeler uygulamada sunulur."],
    ["Measured, with the source of every number", "Her sayının kaynağıyla birlikte doğrulandı"],
    ["Directivity of the patch at 2.453 GHz in both principal planes, as exported for a paper (8.8 cm column width).", "Yama antenin 2,453 GHz'deki iki ana düzlemde yönlülüğü; makale için dışa aktarılmıştır (8,8 cm sütun genişliği)."],
    ["Validation", "Doğrulama"], ["Against analytical results", "Analitik sonuçlarla karşılaştırma"],
    ["Check", "Denetim"], ["Fairbeam", "Fairbeam"], ["Reference", "Referans"],
    ["Dipole D", "Dipol D"], ["Patch resonance", "Yama rezonansı"],
    ["Dipole: three lengths, 50 to 66 mm, end criterion −60 dB. Patch: converged mesh, against a transmission-line model. Details and commands in the validation notes of the repository.", "Dipol: −60 dB sonlandırma ölçütüyle 50–66 mm arasında üç uzunluk. Yama: yakınsamış ağ, iletim hattı modeline karşı. Ayrıntılar ve komutlar depodaki doğrulama notlarında."],
    ["Solver time in seconds", "Çözücü süresi (saniye)"],
    ["Apple M5 Pro: CPU engine with 4 threads and the optional Metal GPU engine. AMD Ryzen 9 7900X under Windows: CPU engine with 4 and all 24 threads, and the optional CUDA GPU engine on an NVIDIA RTX 3060", "Apple M5 Pro: 4 iş parçacıklı CPU motoru ve isteğe bağlı Metal GPU motoru. Windows üzerinde AMD Ryzen 9 7900X: 4 veya 24 iş parçacıklı CPU motoru ve NVIDIA RTX 3060 üzerinde isteğe bağlı CUDA GPU motoru."],
    ["Model", "Model"], ["Cells", "Hücreler"], ["Apple M5 Pro", "Apple M5 Pro"], ["Ryzen 9 7900X", "Ryzen 9 7900X"],
    ["CPU", "CPU"], ["GPU", "GPU"], ["4 threads", "4 iş parçacığı"], ["24 threads", "24 iş parçacığı"], ["CUDA", "CUDA"],
    ["Patch antenna, −60 dB", "Yama anten, −60 dB"], ["4 × 1 patch array (4 runs)", "4 × 1 yama dizisi (4 çalışma)"], ["Sierpinski monopole", "Sierpinski monopol"],
    ["The same models give the same results on both platforms. Runs that stop at the same timestep agree within 0.1 dB in every S-parameter and 0.004 dB in D", "Aynı modeller iki platformda da aynı sonuçları verir. Aynı zaman adımında duran çalışmalar, her S-parametresinde 0,1 dB ve D"],
    [". The older Mac CPU runs checked the end criterion on a wall-clock schedule and stop at a different timestep, which moves only very deep |S11| nulls. The GPU engine is a separate openEMS fork (SeanMollet/openEMS, GPL-3.0, beta) built side by side; the CPU build stays the reference. The M5 Pro CPU time of the patch was re-measured on 2026-09-25 with the current model. Details and commands in the benchmark notes of the repository.", ". için 0,004 dB içinde uyuşur. Eski Mac CPU çalışmaları sonlandırma ölçütünü gerçek zamanlı aralıklarla denetlediğinden farklı zaman adımlarında durur; yalnızca çok derin |S11| çukurları değişir. GPU motoru, CPU derlemesi referans kalırken yan yana derlenen ayrı bir openEMS çatalıdır (SeanMollet/openEMS, GPL-3.0, beta). Yama antenin M5 Pro CPU süresi, güncel modelle 2026-09-25'te yeniden ölçüldü. Ayrıntılar ve komutlar depodaki performans notlarında."],
    ["Circuits and arrays", "Devreler ve diziler"], ["Multi-port models on 0.813 mm, ε", "0,813 mm ve ε"], ["3.38, GPU engine", "3,38 alt tabaka, GPU motoru"],
    ["Microstrip line Z", "Mikroşerit hat Z"], ["Wilkinson split S21 = S31", "Wilkinson bölme S21 = S31"],
    ["Branch-line S21 / S31", "Dal kolu S21 / S31"], ["Low-pass −3 dB point", "Alçak geçiren −3 dB noktası"], ["4×1 array S11 / S22", "4×1 dizi S11 / S22"],
    ["Wilkinson with the textbook 100 Ω resistor: output match and isolation stall at −18.4 and −22.0 dB, because the odd-mode impedance at the outputs is about 34 Ω. The lumped resistor itself is exact; the cause is still an open question. Branch-line at 2.40 GHz: 90.0° between the outputs. Low-pass: the step discontinuities pull the cutoff 5.2 % below the ideal line cascade, as expected for this filter type.", "Ders kitabındaki 100 Ω dirençli Wilkinson'da çıkış uyumu ve yalıtım, çıkışlardaki tek mod empedansı yaklaşık 34 Ω olduğundan −18,4 ve −22,0 dB'de kalır. Yığılmış direnç modeli tamdır; neden hâlâ açık bir sorudur. Dal kolu: 2,40 GHz'de çıkışlar arasında 90,0°. Alçak geçiren filtrede kademe süreksizlikleri kesim frekansını ideal hat zincirinin %5,2 altına çeker; bu filtre türü için beklenen davranıştır."],
    ["Optimizer", "Eniyileyici"], ["Measured runs of", "Şu komutla ölçülen çalışmalar:"], ["on the GPU engine", "GPU motorunda"],
    ["Task", "Görev"], ["Result", "Sonuç"], ["Cost", "Maliyet"], ["Dipole to f", "Dipolü f"], ["= 2.40 GHz", "= 2,40 GHz"],
    ["2 evaluations, 2.0 s", "2 değerlendirme, 2,0 sn"], ["Wilkinson: all ports ≤ −20 dB, S23 ≤ −25 dB", "Wilkinson: tüm portlar ≤ −20 dB, S23 ≤ −25 dB"],
    ["3 evaluations, 7.6 s", "3 değerlendirme, 7,6 sn"], ["Wilkinson: S23 ≤ −35 dB", "Wilkinson: S23 ≤ −35 dB"], ["4 evaluations, 3.6 s", "4 değerlendirme, 3,6 sn"],
    ["The isolation resistor went from the textbook 100 Ω to 73 Ω in about 11 s; with all ports driven, 73 Ω gives S23 = −39.9 dB and every port matched below −24 dB.", "Yalıtım direnci ders kitabındaki 100 Ω değerinden yaklaşık 11 sn'de 73 Ω'a indi. Tüm portlar uyarıldığında 73 Ω, S23 = −39,9 dB ve her portta −24 dB'nin altında uyum sağlar."],
    ["Automatic mesh", "Otomatik ağ"], ["Resonance with", "Rezonans:"], ["against converged hand-tuned meshes", "yakınsamış, elle ayarlanmış ağlarla karşılaştırma"],
    ["Automatic", "Otomatik"], ["Converged", "Yakınsamış"], ["Dipole", "Dipol"], ["Patch antenna", "Yama anten"],
    ["Try the viewer here", "Görüntüleyiciyi burada deneyin"], ["The read-only example viewer of the app, as on", "Uygulamanın salt okunur örnek görüntüleyicisi;"],
    [", with the 14 example projects; the designer and the solver need the desktop app. It loads three.js and one example project: about 1 MB, roughly 350 KB compressed.", ", 14 örnek projeyle. Tasarım aracı ve çözücü için masaüstü uygulaması gerekir. three.js ve tek bir örnek proje yüklenir: yaklaşık 1 MB, sıkıştırılmış hâli yaklaşık 350 KB."],
    ["Load the demo in this page", "Demoyu bu sayfada yükle"],
    ["Status", "Durum"], ["Development preview", "Geliştirme önizlemesi"],
    ["The designer, the solver pipeline and the results work end to end. The file formats are versioned (", "Tasarım aracı, çözücü işlem hattı ve sonuçlar baştan sona çalışır. Dosya biçimleri sürümlendirilir ("],
    [" for designs, ", " tasarımlar için, "], [" for results); breaking changes bump the version.", " sonuçlar için); uyumsuz değişiklikler sürüm numarasını artırır."],
    ["VBA macro export not yet validated", "VBA makrosu dışa aktarımı henüz doğrulanmadı"],
    ["The exported CST-compatible VBA macro and the macro import are not validated for every command or physical port formulation; the macro import reports the commands that it skips or changes. Check an exported model in the target program before relying on it.", "Dışa aktarılan CST uyumlu VBA makrosu ve makro içe aktarımı her komut veya fiziksel port formülasyonu için doğrulanmış değildir; makro içe aktarımı atladığı veya değiştirdiği komutları bildirir. Dışa aktarılan bir modele güvenmeden önce hedef programda denetleyin."],
    ["Fabrication files not yet validated", "Üretim dosyaları henüz doğrulanmadı"],
    ["The Gerber, drill and DXF files are parsed back and checked against the geometry to 1 µm, but have not been opened in a Gerber viewer or sent to a fab. The simulation uses zero-thickness copper; clearances and footprints are yours to check.", "Gerber, delik ve DXF dosyaları yeniden ayrıştırılır ve geometriyle 1 µm hassasiyetinde karşılaştırılır; ancak Gerber görüntüleyicide açılmamış veya üretime gönderilmemiştir. Benzetimde bakır kalınlığı sıfırdır; açıklık ve ayak izlerini denetlemeniz gerekir."],
    ["Wilkinson output match: open question", "Wilkinson çıkış uyumu: açık soru"],
    ["With the textbook 100 Ω resistor the divider's output match and isolation fall short of theory. The resistor model is exact, so the cause is either the layout or the staircase mesh at the resistor node; a finer mesh at the resistor node will tell.", "Ders kitabındaki 100 Ω dirençle bölücünün çıkış uyumu ve yalıtımı teorinin gerisinde kalır. Direnç modeli tamdır; neden yerleşim veya direnç düğümündeki basamaklı ağ olabilir. Direnç düğümünde daha ince bir ağ bunu gösterecektir."],
    ["Unsigned installers, macOS 27+", "İmzalanmamış kurulum dosyaları, macOS 27+"],
    ["The macOS app is signed and notarized by Apple. The Windows installer is not code-signed, so Windows SmartScreen warns (More info › Run anyway). The macOS openEMS build needs macOS 27 or newer on Apple silicon. Linux has no installer yet; the Python package works with any openEMS installation whose Python bindings import.", "macOS uygulaması Apple tarafından imzalanmış ve noter onaylıdır. Windows kurulum dosyası kod imzalı olmadığından Windows SmartScreen uyarı verir (Ek bilgi › Yine de çalıştır). macOS openEMS derlemesi Apple silicon üzerinde macOS 27 veya üstünü gerektirir. Linux için henüz kurulum dosyası yoktur; Python paketi, bağlayıcıları içe aktarılabilen her openEMS kurulumu ile çalışır."],
    ["Licenses", "Lisanslar"],
    ["Fairbeam is GPL-3.0-or-later; openEMS is GPL-3.0-or-later and CSXCAD LGPL-3.0-or-later. The source code is on GitHub:", "Fairbeam GPL-3.0-or-later; openEMS GPL-3.0-or-later, CSXCAD ise LGPL-3.0-or-later lisanslıdır. Kaynak kodu GitHub'da:"],
    [". Project files are plain data produced by your own models.", ". Proje dosyaları, kendi modellerinizin ürettiği yalın verilerden oluşur."],
    ["Free desktop app. On first start it installs its runtime once for your user account: Python, the Python packages and openEMS. That is about 120–155 MB to download and 20–30 s on a fast connection, with no admin rights and nothing installed system-wide. You can also point it at an existing openEMS installation. Windows includes CPU support and offers optional NVIDIA GPU setup in Settings; no separate app installer is needed.", "Ücretsiz masaüstü uygulaması. İlk açılışta Python, Python paketleri ve openEMS çalışma ortamı kullanıcı hesabınıza bir kez kurulur. Hızlı bağlantıda indirme yaklaşık 120–155 MB ve 20–30 sn sürer; yönetici izni veya sistem geneline kurulum gerekmez. Mevcut bir openEMS kurulumunu da gösterebilirsiniz. Windows sürümü CPU desteği içerir ve Ayarlar'da isteğe bağlı NVIDIA GPU kurulumu sunar; ayrı bir uygulama kurulum dosyası gerekmez."],
    ["Apple silicon · macOS 27+", "Apple silicon · macOS 27+"], ["Download .dmg ↓", ".dmg dosyasını indir ↓"],
    ["0.7.0 · x64 · Windows 10/11", "0.7.0 · x64 · Windows 10/11"], ["Download .exe ↓", ".exe dosyasını indir ↓"],
    ["First start sets up the runtime", "İlk açılış çalışma ortamını kurar"],
    ["Python 3.13, the Python packages and openEMS, each pinned by SHA-256 and installed once into your user folder: 120–155 MB, about 20 s on a fast connection. An existing openEMS installation works too.", "Python 3.13, Python paketleri ve openEMS; her biri SHA-256 özetiyle sabitlenir ve kullanıcı klasörünüze bir kez kurulur: 120–155 MB, hızlı bağlantıda yaklaşık 20 sn. Mevcut openEMS kurulumunuz da kullanılabilir."],
    ["Examples in your Documents", "Örnekler Documents klasörünüzde"], ["The workspace is", "Çalışma alanı"],
    [": the example projects, their models and templates are copied there, and your designs sit next to them. Examples open read-only; Open as new project turns one into a design you can edit.", ": örnek projeler, modelleri ve şablonları buraya kopyalanır; tasarımlarınız yanlarında tutulur. Örnekler salt okunur açılır; Yeni proje olarak aç seçeneği düzenleyebileceğiniz bir tasarıma dönüştürür."],
    ["Press Run", "Çalıştır'a basın"],
    ["The Run dialog offers the CPU engine and, when one is installed, the GPU engine; the dock shows live progress, the field energy and the time left. The patch antenna takes 10.6 s on four CPU threads of an Apple M5 Pro, or 1.6 s with the optional Metal GPU engine, and about 53 s on four threads of a Ryzen 9 7900X under Windows.", "Çalıştır penceresi CPU motorunu ve kuruluysa GPU motorunu sunar; panel canlı ilerlemeyi, alan enerjisini ve kalan süreyi gösterir. Yama anten Apple M5 Pro'da dört CPU iş parçacığıyla 10,6 sn, isteğe bağlı Metal GPU motoruyla 1,6 sn; Windows'ta Ryzen 9 7900X'in dört iş parçacığıyla yaklaşık 53 sn sürer."],
    ["Available installers", "Kullanılabilir kurulum dosyaları"], ["checksums", "sağlama toplamları"],
    ["Per-user install · no admin rights · updates are offered in the app", "Kullanıcıya özel kurulum · yönetici izni gerekmez · güncellemeler uygulamada sunulur"],
    ["Install the runtime", "Çalışma ortamını kur"], ["Every download is checked against its SHA-256 · nothing is installed system-wide", "Her indirme SHA-256 ile doğrulanır · sistem geneline kurulum yapılmaz"],
    ["Run · patch-antenna", "Çalıştır · patch-antenna"], ["openEMS · CPU · 4 threads · 263 k cells", "openEMS · CPU · 4 iş parçacığı · 263 bin hücre"],
    ["mesh 69 × 69 × 58 lines", "ağ 69 × 69 × 58 çizgi"], ["field energy −60 dB: converged", "alan enerjisi −60 dB: yakınsadı"],
    ["near-to-far field at 2.453 GHz: D", "2,453 GHz'de yakın alandan uzak alana: D"],
    ["|S11| −34.5 dB at 2.453 GHz · project written", "2,453 GHz'de |S11| −34,5 dB · proje yazıldı"],
    ["Download the installer", "Kurulum dosyasını indirin"],
    ["It installs for your user account, without admin rights.", "Yönetici izni olmadan kullanıcı hesabınıza kurulur."],
    ["New here?", "Yeni misiniz?"], ["Read the getting-started guide", "Başlangıç kılavuzunu okuyun"], [": install, a first design, the run and its results in about five minutes.", ": yaklaşık beş dakikada kurulum, ilk tasarım, çalıştırma ve sonuçları öğrenin."],
    ["Simulations by", "Benzetimler:"], ["downloads", "indirmeler"], ["source code", "kaynak kod"], ["Privacy", "Gizlilik"], ["by", "hazırlayan"],
    ["CST and CST Studio Suite are trademarks or registered trademarks of Dassault Systèmes or its subsidiaries. Fairbeam is an independent open-source project and is not affiliated with, sponsored by or endorsed by Dassault Systèmes.", "CST ve CST Studio Suite, Dassault Systèmes'in veya bağlı şirketlerinin ticari markaları ya da tescilli ticari markalarıdır. Fairbeam bağımsız, açık kaynaklı bir projedir; Dassault Systèmes ile bağlantılı değildir, onun tarafından desteklenmez veya onaylanmaz."],
    ["The pyramidal horn in Fairbeam: the flared horn on its WR-90 feed with the 3D directivity pattern above it, and |S11| from 8 to 12 GHz below it.", "Fairbeam içindeki piramidal horn: WR-90 beslemesi üzerindeki genişleyen horn, üstte 3B yönlülük örüntüsü, altta 8–12 GHz aralığında |S11|."],
    ["The axial-mode helix in Fairbeam: the wire helix over its ground plane inside the 3D directivity pattern, with polar cuts and the far-field summary below.", "Fairbeam içindeki eksenel modlu helis: toprak düzlemi üzerindeki tel helis, çevresinde 3B yönlülük örüntüsü; altta kutupsal kesitler ve uzak alan özeti."],
    ["The Minkowski fractal patch in Fairbeam: the cross-shaped fractal copper on its substrate, and the input impedance on a Smith chart.", "Fairbeam içindeki Minkowski fraktal yama: alt tabaka üzerindeki haç biçimli fraktal bakır ve Smith grafiğinde giriş empedansı."],
    ["The Wilkinson divider in Fairbeam: the microstrip layout with its three ports and the 100 ohm resistor, and |S11|, |S21| and |S31| against frequency.", "Fairbeam içindeki Wilkinson bölücü: üç portlu mikroşerit yerleşim ve 100 ohm direnç; frekansa göre |S11|, |S21| ve |S31|."],
    ["The branch-line coupler in Fairbeam: the square microstrip ring with four ports, and |S11|, |S21| and |S31| against frequency.", "Fairbeam içindeki dal kolu kuplörü: dört portlu kare mikroşerit halka; frekansa göre |S11|, |S21| ve |S31|."],
    ["The stepped-impedance low-pass filter in Fairbeam: the microstrip line with its wide and narrow sections, and |S11| and |S21| up to 6 GHz.", "Fairbeam içindeki kademeli empedanslı alçak geçiren filtre: geniş ve dar bölümleri olan mikroşerit hat; 6 GHz'e kadar |S11| ve |S21|."],
    ["The Fairbeam designer with the Modeling ribbon tab: the navigation tree with components, materials and ports on the left, the branch-line coupler in the 3D view with its four 50 ohm ports, and the selected part's dimensions on the right.", "Modelleme şeridi açık Fairbeam tasarım aracı: solda bileşen, malzeme ve portların gezinme ağacı; 3B görünümde dört 50 ohm portlu dal kolu kuplörü; sağda seçili parçanın boyutları."],
    ["The Fairbeam designer with the Post-processing ribbon tab: the 4 by 1 patch array with its 3D directivity pattern at 2.453 GHz, and the run listed under Results in the navigation tree.", "Son işleme şeridi açık Fairbeam tasarım aracı: 2,453 GHz'de 3B yönlülük örüntüsüyle 4'e 1 yama dizisi; gezinme ağacındaki Sonuçlar altında listelenen çalışma."],
    ["The S-parameters result tab of the 4 by 1 patch array: |S11|, |S21| and |S31| against frequency with automatic markers, the marker table below, and Copy data, CSV and Touchstone buttons above.", "4'e 1 yama dizisinin S-parametreleri sonuç sekmesi: otomatik işaretçilerle frekansa göre |S11|, |S21| ve |S31|; altta işaretçi tablosu, üstte Veriyi kopyala, CSV ve Touchstone düğmeleri."],
    ["A3 technical drawing of the rectangular patch antenna: top, front, side and isometric views with dimensions, a parameter table and a title block.", "Dikdörtgen yama antenin A3 teknik çizimi: ölçüler, parametre tablosu ve antetle birlikte üst, ön, yan ve izometrik görünümler."],
    ["Black-and-white publication chart of the patch antenna's |S11| in dB against frequency, with a dip near 2.45 GHz.", "Yama antenin frekansa göre dB cinsinden |S11| değerini ve 2,45 GHz civarındaki çukuru gösteren siyah-beyaz yayın grafiği."],
    ["Black-and-white publication chart of the Wilkinson divider's transmission: S21 and S31 near −3 dB and the isolation S23 against frequency.", "Wilkinson bölücünün iletimini gösteren siyah-beyaz yayın grafiği: frekansa göre −3 dB civarındaki S21 ve S31 ile yalıtım S23."],
    ["Black-and-white polar chart of the patch antenna's directivity at 2.453 GHz in the xz and yz planes, with a broadside maximum of 6.79 dBi.", "Yama antenin 2,453 GHz'de xz ve yz düzlemlerindeki yönlülüğünü, dik yönde 6,79 dBi maksimumla gösteren siyah-beyaz kutupsal grafik."],
    ["S11 chart", "S11 grafiği"], ["/app", "/app"],
    ["f (GHz)", "f (GHz)"], ["|S11| (dB)", "|S11| (dB)"], ["Port", "Port"], ["Phase", "Faz"], ["Active |Γ|", "Etkin |Γ|"],
    ["Port 1 driven, ports 2–4 terminated in 50 Ω", "1. port uyarılır, 2–4. portlar 50 Ω ile sonlandırılır"],
    ["All four ports fed in phase", "Dört portun tümü eş fazda beslenir"],
    ["Progressive phase −k·d·sin θ0 per element", "Eleman başına ilerleyen faz −k·d·sin θ₀"], ["off", "kapalı"],
    ["Antenna case", "Anten modeli"], ["S11 response overlay", "S11 yanıt eğrileri"],
    ["f", "f"], ["FDTD mesh", "FDTD ağı"], ["New example projects", "Yeni örnek projeler"],
    ["Antenna simulation workbench", "Anten simülasyon çalışma ortamı"],
    ["Roadmap by state", "Duruma göre yol haritası"], ["Available", "Kullanılabilir"], ["In development", "Geliştiriliyor"], ["Planned", "Planlandı"],
    ["In a release, or merged for the next one", "Bir sürümde veya sonraki sürüm için birleştirildi"],
    ["Open pull requests and work under way", "Açık çekme istekleri ve devam eden çalışmalar"], ["Approved, not started yet", "Onaylandı, henüz başlanmadı"],
    ["Nothing here right now.", "Şu anda burada bir öğe yok."], ["items", "öğe"], ["item", "öğe"],
    ["On GitHub: ", "GitHub üzerinde: "], ["Tracked as ", "Şu numaralarla izleniyor: "], ["Status: ", "Durum: "],
    ["Model, simulate and read the results in one window", "Modelleyin, benzetin ve sonuçları tek pencerede inceleyin"],
    ["A ribbon on one row", "Tek sıralı şerit menü"],
    ["Home, Modeling, Transform, Simulation, Optimize and Post-processing on one row. Draw bricks in 3D, extrude a picked face, combine shapes with booleans, and move, rotate, mirror or scale them in one Transform dialog (Ctrl+T).", "Giriş, Modelleme, Dönüştürme, Benzetim, Eniyileme ve Son İşleme tek satırda. 3B'de prizma çizin, seçili yüzeyi ekstrüde edin, şekilleri Boole işlemleriyle birleştirin; tek Dönüştür penceresinde taşıyın, döndürün, aynalayın veya ölçekleyin (Ctrl+T)."],
    ["Tree and properties", "Ağaç ve özellikler"],
    ["Components, materials, ports, lumped elements, mesh and results in a navigation tree with drag and drop. The panels collapse, Undo, Redo and a modeling history keep track of the edits, and a Python panel sits alongside.", "Bileşenler, malzemeler, portlar, yığılmış elemanlar, ağ ve sonuçlar sürükle-bırak destekli gezinme ağacındadır. Paneller daraltılabilir; Geri Al, Yinele ve modelleme geçmişi düzenlemeleri izler; yan tarafta Python paneli bulunur."],
    ["Runs under the design", "Tasarımın altındaki çalışmalar"],
    ["Every run is listed under Results with its S-parameters, far fields and surface currents. Picking one shows it in the 3D view: here the 4 × 1 array's pattern over its geometry.", "Her çalışma S-parametreleri, uzak alanları ve yüzey akımlarıyla Sonuçlar altında listelenir. Birini seçtiğinizde 3B görünümde açılır: burada geometrisi üzerinde 4 × 1 dizinin örüntüsü gösterilir."],
    ["Markers on every plot", "Her grafikte işaretçiler"],
    ["Resonances and their bandwidth are marked, with a hover read-out, a two-marker bandwidth, your own markers and a table you can copy. Runs are compared by the parameters that differ.", "Rezonanslar ve bant genişlikleri işaretlenir; üzerine gelince bilgi, iki işaretçili bant genişliği, kendi işaretçileriniz ve kopyalanabilir bir tablo bulunur. Çalışmalar farklı parametrelere göre karşılaştırılır."],
    ["One click out", "Tek tıkla dışa aktarın"],
    ["Copy data or CSV in dB, phase, Re/Im or magnitude/phase, and Touchstone files. The ribbon adds a PDF report, an export package and the Python model, the header a CST-compatible VBA macro.", "Veriyi veya CSV'yi dB, faz, Re/Im ya da genlik/faz olarak kopyalayın; Touchstone dosyaları alın. Şeritten PDF raporu, dışa aktarma paketi ve Python modelini; üst menüden CST uyumlu VBA makrosunu kaydedin."],
    ["Auto mode picks the mesh settings for each design, and every field can be overridden. Thin PCB copper is meshed as sheets, converted examples keep their own mesh lines, and the mesher lands within 0.1 % of converged hand meshes.", "Otomatik mod her tasarım için ağ ayarlarını seçer; tüm alanları değiştirebilirsiniz. İnce PCB bakırı levha olarak ağlanır, dönüştürülen örnekler kendi ağ çizgilerini korur ve otomatik ağ elle yakınsatılmış ağlardan %0,1 içinde kalır."],
    ["A run that did not converge, or whose numbers look suspicious, is flagged in the tree and on its results. Common design checks offer a fix in one click. Waveguide-port power is calibrated, so the pyramidal horn's efficiency reads about 99 %.", "Yakınsamayan veya şüpheli sonuç veren çalışma, ağaçta ve sonuçlarında işaretlenir. Sık rastlanan tasarım denetimleri tek tıkla düzeltme sunar. Dalga kılavuzu portunun gücü kalibre edildiğinden piramidal hornun verimi yaklaşık %99 görünür."],
    [", gains, radiation, mismatch and total efficiency and the main lobe. Optionally, the radiation and total efficiency over the whole band, computed after the run (about 0.3 s for 21 frequencies on the patch; the solver time does not change). Animated surface currents, and array beams steered after the run.", ", kazanç, ışınım, uyumsuzluk ve toplam verim ile ana lob kartı. İsteğe bağlı olarak tüm banttaki ışınım ve toplam verim, çalışma sonrasında hesaplanır (yama için 21 frekansta yaklaşık 0,3 sn; çözücü süresi değişmez). Animasyonlu yüzey akımları ve çalışma sonrasında yönlendirilen dizi demetleri."],
    ["Optional GPU builds of openEMS: Metal on Apple silicon and CUDA on NVIDIA cards under Windows. The patch antenna takes 1.6 s instead of 10.6 s on an M5 Pro, and 2.6 s instead of 53 s on a Ryzen 9 with an RTX 3060. When a GPU build is installed it is the default, and the CPU engine stays available.", "İsteğe bağlı openEMS GPU derlemeleri: Apple silicon'da Metal ve Windows'ta NVIDIA kartlarda CUDA. Yama anten M5 Pro'da 10,6 sn yerine 1,6 sn, RTX 3060'lı Ryzen 9'da 53 sn yerine 2,6 sn sürer. GPU derlemesi kuruluysa varsayılan olarak kullanılır; CPU motoru da kullanılabilir."],
    ["Against analytical results", "Analitik sonuçlarla karşılaştırma"],
    ["Dipole R", "Dipol R"], ["at resonance", "rezonansta"], ["Dipole D", "Dipol D"], ["Dipole to f", "Dipolü f"], ["Patch antenna", "Yama anten"],
    ["Microstrip line Z", "Mikroşerit hat Z"], ["Wilkinson split S21 = S31", "Wilkinson bölme S21 = S31"],
    ["Branch-line S21 / S31", "Dal kolu S21 / S31"], ["Low-pass −3 dB point", "Alçak geçiren −3 dB noktası"], ["4×1 array S11 / S22", "4×1 dizi S11 / S22"],
    ["Measured runs of", "Şu komutla ölçülen çalışmalar:"], ["on the GPU engine", "GPU motorunda"], ["Dipole to f", "Dipolü f"],
    ["The read-only example viewer of the app, as on", "Uygulamanın salt okunur örnek görüntüleyicisi;"],
    ["The board is rendered from landing/roadmap.json when the site is built.", "Yol haritası panosu, site derlenirken landing/roadmap.json dosyasından oluşturulur."],
    ["Examples in your Documents", "Örnekler Documents klasörünüzde"], ["Available installers", "Kullanılabilir kurulum dosyaları"], ["Install the runtime", "Çalışma ortamını kur"],
    ["Every download is checked against its SHA-256 · nothing is installed system-wide", "Her indirme SHA-256 ile doğrulanır · sistem geneline kurulum yapılmaz"],
    ["mesh 69 × 69 × 58 lines", "ağ 69 × 69 × 58 çizgi"], ["field energy −60 dB: converged", "alan enerjisi −60 dB: yakınsadı"], ["6.79 dBi", "6,79 dBi"],
    ["for designs,", " tasarımlar için,"], [" for results); breaking changes bump the version.", " sonuçlar için); uyumsuz değişiklikler sürümü artırır."],
    ["fairbeam-releases", "fairbeam-releases"],
    ["macOS 0.7.0: macOS 27 or newer; the app is signed and notarized. Windows 0.7.0: Windows 10/11, per-user install; SmartScreen warns because the installer has no Authenticode certificate (More info → Run anyway). Checksums:", "macOS 0.7.0: macOS 27 veya üzeri; uygulama imzalı ve noter onaylıdır. Windows 0.7.0: Windows 10/11, kullanıcıya özel kurulum; Authenticode sertifikası olmadığından SmartScreen uyarır (Daha fazla bilgi → Yine de çalıştır). Sağlama toplamları:"],
    ["macOS", "macOS"], ["Windows", "Windows"], ["·", "·"], [". Every version is on the", ". Tüm sürümler"], ["releases page", "sürümler sayfasında"], [". Later versions are offered in the app.", ". Daha yeni sürümler uygulamada sunulur."],
    ["no installer yet. With a clone of the repository,", "henüz kurulum dosyası yoktur. Depoyu klonladıysanız,"],
    ["builds openEMS (CPU) in your user folder and", "openEMS'i (CPU) kullanıcı klasörünüzde derler ve"],
    ["opens Fairbeam in your browser. Tested on Debian 13 x86_64; see docs/LINUX.md.", "Fairbeam'i tarayıcıda açar. Debian 13 x86_64 üzerinde denenmiştir; docs/LINUX.md dosyasına bakın."],
    ["Read the getting-started guide", "Başlangıç kılavuzunu okuyun"], [": install, a first design, the run and its results in about five minutes.", ": yaklaşık beş dakikada kurulum, ilk tasarım, çalıştırma ve sonuçları öğrenin."],
    ["openEMS", "openEMS"], ["and CSXCAD. Fairbeam is GPL-3.0-or-later;", "ve CSXCAD. Fairbeam GPL-3.0-or-later lisanslıdır;"],
    ["İsmail Akdağ", "İsmail Akdağ"],
    ["Where Fairbeam is, and where it is going", "Fairbeam'in mevcut durumu ve hedefleri"],
    ["From download to a first simulation", "İndirmeden ilk benzetiminize"],
    ["Start from a half-wave dipole, a quarter-wave monopole, an open-ended waveguide, a printed sleeve dipole or a two-port microstrip line, or pick an example from a searchable list, which now includes a 2-element collinear and a 5-element Yagi for 867 MHz.", "Yarım dalga dipol, çeyrek dalga monopol, açık uçlu dalga kılavuzu, baskılı kılıf dipol veya iki portlu mikroşerit hat ile başlayın. Aranabilir listedeki örnekler arasında 867 MHz için 2 elemanlı doğrusal dizi ve 5 elemanlı Yagi de bulunur."],
    ["Linux (preview):", "Linux (önizleme):"],
    ["Fairbeam · Pyramidal horn (WR-90, 10 GHz)", "Fairbeam · WR-90 piramidal horn (10 GHz)"],
    ["Fairbeam · Axial-mode helix (2.4 GHz, RHCP)", "Fairbeam · Eksenel modlu helis (2,4 GHz, RHCP)"],
    ["Fairbeam · Minkowski fractal patch", "Fairbeam · Minkowski fraktal yama"],
    ["Fairbeam · Wilkinson divider (2.4 GHz)", "Fairbeam · Wilkinson bölücü (2,4 GHz)"],
    ["Fairbeam · Branch-line coupler (2.4 GHz)", "Fairbeam · Dal kolu kuplörü (2,4 GHz)"],
    ["Fairbeam · Stepped-impedance low-pass filter", "Fairbeam · Kademeli empedanslı alçak geçiren filtre"],
    ["Fairbeam · Branch-line coupler · Modeling", "Fairbeam · Dal kolu kuplörü · Modelleme"],
    ["Fairbeam · Patch array 4 × 1 · 3D pattern", "Fairbeam · 4 × 1 yama dizisi · 3B örüntü"],
    ["Fairbeam · Patch array 4 × 1 · S-parameters", "Fairbeam · 4 × 1 yama dizisi · S-parametreleri"],
    ["Scan θ0", "Tarama θ₀"], ["Main beam", "Ana demet"], ["Dmax", "Dmax"],
    ["4 × 1 patch array · {frequency} GHz", "4 × 1 yama dizisi · {frequency} GHz"],
    ["# From source: macOS, Homebrew, Xcode CLT, Python 3.10+, Node.js 20+", "# Kaynak koddan: macOS, Homebrew, Xcode CLT, Python 3.10+, Node.js 20+"],
    ["# 1. Build openEMS + CSXCAD into ~/opt/openEMS and install Fairbeam into its venv (5–10 min)", "# 1. openEMS + CSXCAD'yi ~/opt/openEMS içine derleyin; Fairbeam'i sanal ortama kurun (5–10 dk)"],
    ["# 2. Run a model: writes public/projects/<slug>.json", "# 2. Modeli çalıştırın: public/projects/<slug>.json dosyasını yazar"],
    ["# 3. Start the viewer on http://127.0.0.1:5310, and the run server", "# 3. Görüntüleyiciyi http://127.0.0.1:5310 adresinde ve çalışma sunucusunu başlatın"],
    ["# Linux (preview, CPU): build openEMS into your user folder, then open Fairbeam in the browser", "# Linux (önizleme, CPU): openEMS'i kullanıcı klasörünüzde derleyin, Fairbeam'i tarayıcıda açın"],
    ["# the desktop app from source", "# masaüstü uygulamasını kaynak koddan derleyin"],
  ];

  const roadmapPairs = [
    ["Designer", "Tasarım aracı"], ["Simulation", "Benzetim"], ["Performance & quality", "Performans ve kalite"],
    ["Visual designer", "Görsel tasarım aracı"], ["Draw a parametric model, set up the simulation, run it and read the results in one window.", "Parametrik modeli çizin, benzetimi kurun, çalıştırın ve sonuçları tek pencerede inceleyin."],
    ["One-row ribbon", "Tek satırlı şerit menü"], ["Home, Modeling, Transform, Simulation, Optimize and Post-processing on one row; the tree, dock and properties collapse, next to a Python side panel.", "Giriş, Modelleme, Dönüştürme, Benzetim, Eniyileme ve Son İşleme tek satırda; ağaç, panel ve özellikler daraltılabilir, yanlarında Python paneli bulunur."],
    ["Draw in 3D and extrude faces", "3B'de çizin ve yüzeyleri ekstrüde edin"], ["Draw a brick's base and then its height in the 3D view, or extrude a picked face into a new part.", "3B görünümde bir prizmanın tabanını ve yüksekliğini çizin ya da seçili yüzeyi yeni bir parçaya ekstrüde edin."],
    ["One Transform dialog", "Tek Dönüştür penceresi"], ["Translate, scale, rotate and mirror in one dialog (Ctrl+T), with a live preview.", "Canlı önizlemeli tek pencerede taşıyın, ölçekleyin, döndürün ve aynalayın (Ctrl+T)."],
    ["Booleans, polygons included", "Çokgenler dâhil Boole işlemleri"], ["Add, subtract and intersect shapes, including polygons, with a colour-coded preview.", "Çokgenler dâhil şekilleri renk kodlu önizlemeyle birleştirin, çıkarın ve kesiştirin."],
    ["Pick points, align and measure", "Noktaları seçin, hizalayın ve ölçün"], ["Use vertices, edge midpoints and face centres for corners and origins; align parts and measure between points.", "Köşe ve başlangıç noktaları için tepe, kenar orta noktası ve yüzey merkezini kullanın; parçaları hizalayın ve noktalar arasını ölçün."],
    ["Shortcuts and modeling history", "Kısayollar ve modelleme geçmişi"], ["A sheet of the keyboard shortcuts, and the session's modeling history.", "Klavye kısayollarının özeti ve oturumun modelleme geçmişi."],
    ["A tree with context menus", "Bağlam menülü ağaç"], ["Right-click menus on every node, show and hide, and drag and drop of parts into components.", "Her düğümde sağ tık menüleri, gösterme ve gizleme, parçaları bileşenlere sürükleyip bırakma."],
    ["Parameters in the dock", "Paneldeki parametreler"], ["A table of every parameter next to Checks, with CSV and JSON import and export.", "Denetimlerin yanında tüm parametreleri gösteren, CSV ve JSON içe/dışa aktarımı olan tablo."],
    ["Checks that explain themselves", "Kendini açıklayan denetimler"], ["Click a warning to see what was found, why it matters and how to fix it.", "Bulunanı, neden önemli olduğunu ve nasıl düzeltileceğini görmek için uyarıya tıklayın."],
    ["Ports that find their ground", "Toprak bağlantısını bulan portlar"], ["Add port here says what the port connects to and offers the other metals it found.", "Buraya port ekle, portun neye bağlandığını açıklar ve bulunan diğer metalleri sunar."],
    ["Import VBA macro", "VBA makrosunu içe aktar"], ["A CST-compatible VBA macro or history list becomes a design, manual mesh lines included, with a report of what was skipped or changed.", "CST uyumlu VBA makrosu veya geçmiş listesi, elle tanımlanan ağ çizgileriyle birlikte tasarıma dönüşür; atlanan ve değiştirilenler raporlanır."],
    ["Save As", "Farklı Kaydet"], ["Save a design under a new name, in the app and from the File menu; Undo and Redo work from the menus too.", "Uygulamada veya Dosya menüsünden tasarımı yeni adla kaydedin; Geri Al ve Yinele menülerden de çalışır."],
    ["Checks for misplaced metal", "Yanlış yerdeki metaller için denetimler"], ["New warnings for metal that overhangs its substrate or floats off the structure.", "Alt tabakadan taşan veya yapıdan kopuk duran metaller için yeni uyarılar."],
    ["Surface current in the ribbon", "Şeritte yüzey akımı"], ["Simulation › Monitors has its own Surface current button, next to Far field.", "Benzetim › Monitörler bölümünde Uzak alanın yanında Yüzey akımı düğmesi bulunur."],
    ["Start templates", "Başlangıç şablonları"], ["A half-wave dipole, a quarter-wave monopole, an open-ended waveguide, a printed sleeve dipole and a two-port microstrip line to start from.", "Başlangıç için yarım dalga dipol, çeyrek dalga monopol, açık uçlu dalga kılavuzu, baskılı kılıf dipol ve iki portlu mikroşerit hat."],
    ["Import PCB artwork", "PCB çizimini içe aktar"], ["DXF, Gerber and Excellon files become a design: Home › Import PCB, or fairbeam import-pcb.", "DXF, Gerber ve Excellon dosyalarını tasarıma dönüştürün: Giriş › PCB'yi İçe Aktar veya fairbeam import-pcb."],
    ["One-click check fixes", "Denetimleri tek tıkla düzeltin"], ["Common design checks offer a fix you can apply with one click.", "Sık rastlanan tasarım denetimleri tek tıkla uygulanabilecek düzeltmeler sunar."],
    ["Automatic meshing", "Otomatik ağ oluşturma"], ["The FDTD mesh is built from the geometry, within 0.1 % of converged hand-tuned meshes.", "FDTD ağı geometriye göre oluşturulur ve elle yakınsatılmış ağlardan %0,1 içinde kalır."],
    ["Multi-port S-parameters", "Çok portlu S-parametreleri"], ["Full S-matrices of filters, dividers, couplers and arrays, with Touchstone export.", "Filtre, bölücü, kuplör ve dizilerin tam S-matrisleri; Touchstone dışa aktarımı."],
    ["Sweeps and optimizer", "Taramalar ve eniyileyici"], ["Sweep one or two parameters, or let the optimizer tune them towards your goals.", "Bir veya iki parametreyi tarayın ya da eniyileyicinin hedeflerinize göre ayarlamasını sağlayın."],
    ["Metal GPU engine", "Metal GPU motoru"], ["An optional Metal build of openEMS on Apple silicon: several times faster, same results.", "Apple silicon için isteğe bağlı Metal openEMS derlemesi: aynı sonuçlarla birkaç kat daha hızlı."],
    ["CUDA GPU engine", "CUDA GPU motoru"], ["An optional NVIDIA engine on Windows, in the Run panel: the patch in 2.6 s instead of 53 s.", "Windows'ta Çalıştır panelinde isteğe bağlı NVIDIA motoru: yamayı 53 sn yerine 2,6 sn'de çözer."],
    ["Thin copper as sheets", "İnce bakır levha olarak"], ["Realistic 35 µm PCB copper is simulated as sheets, so runs keep a practical time step.", "Gerçekçi 35 µm PCB bakırı levha olarak benzetilir; böylece pratik bir zaman adımı korunur."],
    ["Convergence checks", "Yakınsama denetimleri"], ["A run that cannot converge is stopped before it starts, with the reason and a fix.", "Yakınsamayacak çalışma başlamadan durdurulur; nedeni ve düzeltme önerisi gösterilir."],
    ["Thin copper in exported models", "Dışa aktarılan modellerde ince bakır"], ["A design exported to Python builds the same copper sheets as the designer's own run.", "Python'a aktarılan tasarım, tasarım aracındaki çalışmayla aynı bakır levhaları oluşturur."],
    ["Auto mesh mode", "Otomatik ağ modu"], ["The mesh settings are picked for each design, and any field can be overridden.", "Her tasarım için ağ ayarları seçilir ve tüm alanlar değiştirilebilir."],
    ["Parameter sweeps", "Parametre taramaları"], ["Sequences over up to six parameters each, checked before they run, queued, and compared run by run.", "Her biri altı parametreye kadar kapsayan diziler önceden denetlenir, kuyruğa alınır ve çalışma bazında karşılaştırılır."],
    ["A stronger optimizer", "Daha güçlü eniyileyici"], ["Live progress, the best result kept, any number of parameters, and Bayesian, CMA-ES, particle-swarm, genetic and trust-region searches.", "Canlı ilerleme, saklanan en iyi sonuç, sınırsız parametre ve Bayesçi, CMA-ES, parçacık sürüsü, genetik ve güven bölgesi aramaları."],
    ["No run without a port", "Portsuz çalışma başlatılmaz"], ["A design with no port, or no excited port, is refused with a check instead of failing.", "Portu veya uyarılan portu olmayan tasarım hata vermek yerine denetimle reddedilir."],
    ["Examples keep their mesh", "Örnekler ağlarını korur"], ["An example opened as a new project keeps its exact mesh lines, so it gives the same results.", "Yeni proje olarak açılan örnek, aynı sonuçları vermesi için ağ çizgilerini aynen korur."],
    ["Optimizer skips misplaced metal", "Eniyileyici yanlış yerdeki metalleri atlar"], ["Candidates the design checks refuse are skipped without a simulation and shown as Skipped.", "Tasarım denetimlerinin reddettiği adaylar benzetim yapılmadan atlanır ve Atlandı olarak gösterilir."],
    ["GPU build by default", "Varsayılan GPU derlemesi"], ["When the GPU build of openEMS is installed, the app starts with it and offers both engines; a general setting switches it.", "openEMS GPU derlemesi kuruluysa uygulama onunla başlar ve iki motoru da sunar; Genel ayarlar'dan seçim değiştirilebilir."],
    ["Mesh convergence", "Ağ yakınsaması"], ["Simulation › Mesh convergence… refines the automatic mesh until the results stop changing; fairbeam converge does the same from the command line.", "Benzetim › Ağ Yakınsaması… sonuçlar değişmeyene kadar otomatik ağı inceltir; fairbeam converge komut satırında aynı işlemi yapar."],
    ["Run-quality warnings", "Çalıştırma kalitesi uyarıları"], ["A run that did not converge, or whose numbers look suspicious, is flagged in the tree and on its results.", "Yakınsamayan veya şüpheli değerler veren çalışma, ağaçta ve sonuçlarında işaretlenir."],
    ["Far field, currents and beam steering", "Uzak alan, akımlar ve demet yönlendirme"], ["3D patterns, gain and efficiency, surface currents, and array beams steered after the run.", "3B örüntüler, kazanç ve verim, yüzey akımları ve çalışma sonrasında yönlendirilen dizi demetleri."],
    ["Drawings, reports and fabrication files", "Teknik çizimler, raporlar ve üretim dosyaları"], ["Dimensioned drawings, publication figures, a PDF report, and Gerber and drill files.", "Ölçülendirilmiş çizimler, yayın grafikleri, PDF raporu, Gerber ve delik dosyaları."],
    ["VBA macro export", "VBA makrosu dışa aktarımı"], ["A CST-compatible VBA macro rebuilds the model in the target program.", "CST uyumlu VBA makrosu modeli hedef programda yeniden kurar."],
    ["Solver times on reference machines", "Referans makinelerde çözücü süreleri"], ["See how long the same model takes on an Apple M5 Pro and a Ryzen 9 with CUDA.", "Aynı modelin Apple M5 Pro ve CUDA'lı Ryzen 9 üzerindeki süresini görün."],
    ["Every run kept", "Her çalışma saklanır"], ["Each run keeps its own result, and Results opens the newest run instead of the preview.", "Her çalışma kendi sonucunu saklar; Sonuçlar önizleme yerine en yeni çalışmayı açar."],
    ["Results in the design tree", "Tasarım ağacındaki sonuçlar"], ["Each run appears under its design, with its S-parameters, far fields, currents and log.", "Her çalışma tasarımının altında S-parametreleri, uzak alanları, akımları ve günlüğüyle görünür."],
    ["Post-processing tab", "Son İşleme sekmesi"], ["Selecting a result opens its plot, compare and export tools in the ribbon.", "Bir sonuç seçildiğinde grafiği, karşılaştırma ve dışa aktarma araçları şeritte açılır."],
    ["Markers", "İşaretçiler"], ["Resonances, a two-marker bandwidth, hover read-outs and your own markers, with a table.", "Rezonanslar, iki işaretçili bant genişliği, üzerine gelince bilgi, kendi işaretçileriniz ve bir tablo."],
    ["Compare runs", "Çalışmaları karşılaştırın"], ["Runs side by side, with the parameters that differ marked; copy or save several runs at once.", "Farklı parametreleri işaretlenmiş çalışmaları yan yana görün; birkaç çalışmayı birlikte kopyalayın veya kaydedin."],
    ["Complex formats and Touchstone", "Karmaşık veri ve Touchstone"], ["Copy data and CSV in dB, phase, Re/Im or magnitude/phase, and Touchstone export.", "Veri ve CSV'yi dB, faz, Re/Im veya genlik/faz olarak kopyalayın; Touchstone dışa aktarın."],
    ["Result tabs", "Sonuç sekmeleri"], ["Results open as tabs in the main area, with an A/B/C table of the runs.", "Sonuçlar ana alanda sekmelerde açılır ve çalışmalar A/B/C tablosunda karşılaştırılır."],
    ["Animated surface currents", "Animasyonlu yüzey akımları"], ["Phase-resolved surface currents play as a smooth animation in the 3D view.", "Faz çözünürlüklü yüzey akımları 3B görünümde akıcı animasyon olarak oynatılır."],
    ["Gain and polarization in patterns", "Örüntülerde kazanç ve polarizasyon"], ["3D patterns and cuts in directivity, gain, realized gain, or RHCP and LHCP for circular polarization.", "Dairesel polarizasyon için yönlülük, kazanç, gerçekleşen kazanç, RHCP ve LHCP cinsinden 3B örüntüler ve kesitler."],
    ["Far-field card in the 3D view", "3B görünümde uzak alan kartı"], ["Dmax, gain, realized gain, radiation, mismatch and total efficiency and the main lobe, next to the pattern.", "Örüntünün yanında Dmax, kazanç, gerçekleşen kazanç, ışınım, uyumsuzluk ve toplam verim ile ana lob."],
    ["Efficiency result", "Verim sonucu"], ["1D Results › Efficiency: mismatch efficiency over the band, with the radiation and total efficiency, per driven port.", "1B Sonuçlar › Verim: uyarılan her port için bant boyunca uyumsuzluk, ışınım ve toplam verim."],
    ["Efficiency over the band", "Bant boyunca verim"], ["Optional radiation and total efficiency across the band from Simulation › Monitors › Efficiency, computed after the run without changing the solver time.", "Benzetim › Monitörler › Verim bölümünde isteğe bağlı bant boyunca ışınım ve toplam verim; çalışma sonrasında hesaplanır ve çözücü süresini değiştirmez."],
    ["Result summaries", "Sonuç özetleri"], ["Headline numbers for each run in the tree and the Runs table, Tables › Summary, and a comparison table of the parameters that differ, to copy or save as CSV.", "Ağaçta ve Çalışmalar tablosunda her çalışmanın öne çıkan değerleri, Tablolar › Özet ve farklı parametreleri gösteren, kopyalanabilir veya CSV kaydedilebilir karşılaştırma tablosu."],
    ["2D field maps with phase and animation", "Fazlı ve animasyonlu 2B alan haritaları"], ["The Field map tab shows E and H planes as heat maps; Phase and Animate play a time-harmonic animation, in 2D and 3D.", "Alan Haritası sekmesi E ve H düzlemlerini ısı haritası olarak gösterir; Faz ve Canlandır, 2B ve 3B'de zamana bağlı harmonik animasyonu oynatır."],
    ["Desktop app for macOS and Windows", "macOS ve Windows için masaüstü uygulaması"], ["Installs its own Python and openEMS on first start, for your account, without admin rights.", "İlk açılışta Python ve openEMS'i yönetici izni olmadan hesabınıza kurar."],
    ["Updates in the app", "Uygulama içi güncellemeler"], ["New versions are offered in the app, checked against their signature, and install themselves.", "Yeni sürümler uygulamada sunulur, imzaları denetlenir ve kendiliğinden kurulur."],
    ["Sturdier on Windows", "Windows'ta daha dayanıklı"], ["Proxies are honoured, interrupted downloads resume, and the server always stops with the app.", "Proxy ayarları kullanılır, kesilen indirmeler sürdürülür ve sunucu uygulamayla birlikte kapanır."],
    ["Clean updates and uninstall", "Temiz güncelleme ve kaldırma"], ["On Windows, an update replaces the old files and uninstalling removes the whole folder.", "Windows'ta güncelleme eski dosyaları değiştirir; kaldırma işlemi tüm klasörü siler."],
    ["GPU preference on Windows", "Windows'ta GPU tercihi"], ["“Prefer the GPU build” on the setup screen now works on Windows too.", "Kurulum ekranındaki “GPU derlemesini tercih et” seçeneği artık Windows'ta da çalışır."],
    ["Sharp on scaled displays", "Ölçekli ekranlarda net görünüm"], ["Layouts fit 125 % and 150 % Windows scaling and follow each monitor's pixel density.", "Düzenler Windows'un %125 ve %150 ölçeklerine uyar ve her monitörün piksel yoğunluğunu izler."],
    ["Start, Design and Examples", "Başlangıç, Tasarım ve Örnekler"], ["Examples open read-only with their results; Open as new project turns one into a design.", "Örnekler sonuçlarıyla salt okunur açılır; Yeni proje olarak aç seçeneği örneği tasarıma dönüştürür."],
    ["Native menus and settings", "Yerel menüler ve ayarlar"], ["File, Edit, View, Window and Help menus, an About dialog, general settings and native Save As for exports.", "Dosya, Düzen, Görünüm, Pencere ve Yardım menüleri; Hakkında penceresi, genel ayarlar ve dışa aktarımlar için yerel Farklı Kaydet."],
    ["No lost work", "Çalışmanız kaybolmasın"], ["Closing a project, the window or the app asks to save, discard or cancel when there are unsaved changes.", "Kaydedilmemiş değişiklikler varsa proje, pencere veya uygulama kapatılırken kaydetme, atma ya da iptal seçenekleri sorulur."],
    ["A window that fits", "Ekrana sığan pencere"], ["The window opens at a size that fits the screen, or maximized on smaller screens.", "Pencere ekrana sığan boyutta açılır; küçük ekranlarda büyütülmüş olarak başlar."],
    ["Turkish and English interface", "Türkçe ve İngilizce arayüz"], ["General settings › Language, native menus included, and a Decimal separator setting.", "Genel ayarlar › Dil; yerel menüler ve Ondalık ayırıcı ayarı dâhil."],
    ["Searchable example picker", "Aranabilir örnek seçici"], ["Find an example by name, with new 867 MHz collinear and Yagi examples.", "Yeni 867 MHz doğrusal dizi ve Yagi örnekleri dâhil, ada göre örnek bulun."],
    ["Validated results", "Doğrulanmış sonuçlar"], ["Checked against analytical results.", "Analitik sonuçlarla karşılaştırılmıştır."],
    ["Benchmarks on Mac and Windows", "Mac ve Windows performans ölçümleri"], ["All 14 examples timed on both platforms, with matching results.", "14 örneğin tümü iki platformda ölçüldü ve sonuçları karşılaştırıldı."],
    ["Honest efficiency figures", "Güvenilir verim değerleri"], ["Efficiencies above 100 % are flagged, and runs report the end criterion they reached.", "%100'ü aşan verimler işaretlenir; çalışmalar ulaştıkları sonlandırma ölçütünü bildirir."],
    ["A faster, steadier designer", "Daha hızlı ve kararlı tasarım aracı"], ["The 3D view reuses its geometry, and edits survive slow loads, saves and previews.", "3B görünüm geometriyi yeniden kullanır; yavaş yükleme, kaydetme ve önizleme sırasında düzenlemeler korunur."],
    ["Keyboard access", "Klavye erişimi"], ["Designer commands stay visible and every control can be reached from the keyboard.", "Tasarım aracı komutları görünür kalır ve her denetime klavyeyle erişilebilir."],
    ["Projects open reliably", "Projeler güvenilir biçimde açılır"], ["A preview arriving mid-load can no longer replace the project you asked for.", "Yükleme sırasında gelen önizleme artık açılmasını istediğiniz projenin yerini alamaz."],
    ["Faster meshing of detailed designs", "Ayrıntılı tasarımlarda daha hızlı ağ"], ["Automatic meshing of polygon designs and arrays runs 4 to 64 times faster.", "Çokgenli tasarımlar ve diziler için otomatik ağ oluşturma 4–64 kat hızlandı."],
    ["A quicker designer", "Daha hızlı tasarım aracı"], ["The Start screen opens in half the time, and checks and saves answer sooner.", "Başlangıç ekranı yarı sürede açılır; denetim ve kaydetme daha çabuk tamamlanır."],
    ["Large designs stay responsive", "Büyük tasarımlar hızlı kalır"], ["Big polygon designs edit, preview and check faster, with identical results.", "Büyük çokgenli tasarımlar aynı sonuçlarla daha hızlı düzenlenir, önizlenir ve denetlenir."],
    ["Horn efficiency", "Horn verimi"], ["Waveguide-port power is calibrated, so the pyramidal horn's radiation efficiency reads about 99 %.", "Dalga kılavuzu portunun gücü kalibre edildiğinden piramidal hornun ışınım verimi yaklaşık %99 görünür."],
  ];

  pairs.push(["macOS 0.7.0: macOS 27 or newer; the app is signed and notarized. Windows 0.7.0: Windows 10/11, per-user install; SmartScreen warns because the installer has no Authenticode certificate (More info → Run anyway). Checksums are in", "macOS 0.7.0: macOS 27 veya üzeri; uygulama imzalı ve noter onaylıdır. Windows 0.7.0: Windows 10/11, kullanıcıya özel kurulum; Authenticode sertifikası olmadığından SmartScreen uyarır (Daha fazla bilgi → Yine de çalıştır). Sağlama toplamları şu dosyada:"]);
  pairs.push(...[
  [
    "Fairbeam: the open electromagnetic workbench",
    "Fairbeam: açık kaynak elektromanyetik çalışma ortamı"
  ],
  [
    "Open-source electromagnetic workbench",
    "Açık kaynak elektromanyetik çalışma ortamı"
  ],
  [
    "Design antennas and RF circuits.",
    "Antenleri ve RF devrelerini tasarlayın."
  ],
  [
    "Design in 3D or Python, simulate with openEMS on the CPU or GPU, and explore the results. Create plots, drawings and reports from the same model.",
    "3B ortamda veya Python ile tasarlayın, CPU veya GPU üzerinde openEMS ile benzetin ve sonuçları inceleyin. Aynı modelden grafikler, çizimler ve raporlar oluşturun."
  ],
  [
    "Platform requirements and installer signing",
    "Platform gereksinimleri ve kurulum imzaları"
  ],
  [
    "Dipole: three lengths, 50 to 66 mm, end criterion −60 dB. Patch: converged mesh, against a transmission-line model.",
    "Dipol: −60 dB sonlandırma ölçütüyle 50–66 mm arasında üç uzunluk. Yama: yakınsamış ağ, iletim hattı modeline karşı."
  ],
  [
    "For the compared models that stop at the same timestep, S-parameters above −30 dB agree within 0.1 dB, and maximum directivity within 0.004 dB (D",
    "Karşılaştırılan modellerde aynı zaman adımında duran çalışmaların −30 dB üzerindeki S-parametreleri 0,1 dB, en yüksek yönlülükleri ise 0,004 dB içinde uyuşur (D"
  ],
  [
    "). Older Mac CPU runs stop at different timesteps, which can move deep |S11| nulls. The optional GPU engine is a separate openEMS fork (SeanMollet/openEMS, GPL-3.0, beta); the CPU build stays the reference. The M5 Pro patch CPU time was re-measured on 2026-09-25 with the current model.",
    "). Eski Mac CPU çalışmaları farklı zaman adımlarında durur; bu durum derin |S11| çukurlarını kaydırabilir. İsteğe bağlı GPU motoru ayrı bir openEMS çatallamasıdır (SeanMollet/openEMS, GPL-3.0, beta); CPU derlemesi referans olarak kalır. M5 Pro yama CPU süresi, güncel modelle 2026-09-25 tarihinde yeniden ölçüldü."
  ],
  [
    "Auto mode picks the mesh settings for each design, and every field can be overridden. Thin PCB copper is meshed as sheets, and converted examples keep their own mesh lines. In the dipole and patch checks below, resonance differs from converged hand-tuned meshes by about 0.1% or less.",
    "Otomatik mod her tasarım için ağ ayarlarını seçer; tüm alanlar değiştirilebilir. İnce PCB bakırı levha olarak ağlanır ve dönüştürülen örnekler kendi ağ çizgilerini korur. Aşağıdaki dipol ve yama denetimlerinde rezonans, elle ayarlanmış yakınsamış ağlardan yaklaşık %0,1 veya daha az farklıdır."
  ],
  [
    "About Fairbeam",
    "Fairbeam hakkında"
  ],
  [
    "Fairbeam is an independent open-source project for engineers, researchers and students working with antennas and RF circuits. It brings modeling, openEMS simulation and documented results into one workspace.",
    "Fairbeam, antenler ve RF devreleriyle çalışan mühendisler, araştırmacılar ve öğrenciler için bağımsız bir açık kaynak projesidir. Modellemeyi, openEMS benzetimini ve belgelenmiş sonuçları tek çalışma ortamında birleştirir."
  ],
  [
    "Maintained by",
    "Bakımcı:"
  ],
  [
    ", with contributions from",
    "; katkıda bulunanlar:"
  ],
  [
    "and the open-source community.",
    "ve açık kaynak topluluğu."
  ],
  [
    "Project credits",
    "Katkılar"
  ],
  [
    "Contact:",
    "İletişim:"
  ],
  [
    "Report a problem",
    "Sorun bildirin"
  ],
  [
    "Validation methods and commands",
    "Doğrulama yöntemleri ve komutları"
  ],
  [
    "Hardware, benchmark methods and commands",
    "Donanım, ölçüm yöntemleri ve komutları"
  ],
  [
    "2.11 dBi (theory)",
    "2,11 dBi (teori)"
  ],
  [
    "−3.01 dB each",
    "her biri −3,01 dB"
  ],
  [
    "4 GPU runs, 18 s",
    "4 GPU çalışması, 18 sn"
  ]
]);

  pairs.push(["About", "Hakkında"], ["The FDTD mesh is built from the geometry. In the dipole and patch checks, resonance differs from converged hand-tuned meshes by about 0.1% or less.", "FDTD ağı geometriden oluşturulur. Dipol ve yama denetimlerinde rezonans, elle ayarlanmış yakınsamış ağlardan yaklaşık %0,1 veya daha az farklıdır."]);

  const TEXT = new Map([...pairs, ...roadmapPairs].map(([en, tr]) => [normalize(en), tr]));
  const ATTRIBUTE_TEXT = new Map([
    ["Fairbeam, back to top", "Fairbeam, başa dön"], ["English", "English"], ["Türkçe", "Türkçe"],
    ["S11 chart", "S11 grafiği"], ["Roadmap by state", "Duruma göre yol haritası"],
    ["Fairbeam demo viewer", "Fairbeam demo görüntüleyicisi"],
  ]);
  const META_TEXT = new Map([
    ["Fairbeam: the open electromagnetic workbench", "Fairbeam: açık kaynak elektromanyetik çalışma ortamı"],
    ["Fairbeam is an open-source desktop workbench for antennas and RF circuits. Design in 3D or Python, simulate with openEMS, and create plots, drawings and reports.", "Fairbeam, antenler ve RF devreleri için açık kaynak masaüstü çalışma ortamıdır. 3B ortamda veya Python ile tasarlayın, openEMS ile benzetin; grafik, çizim ve rapor oluşturun."],
    ["Fairbeam: antenna simulation with openEMS", "Fairbeam: openEMS ile anten benzetimi"],
    ["Fairbeam is a desktop workbench for antennas, microstrip circuits and arrays: model them in a ribbon-based 3D designer or import a CST-compatible VBA macro, simulate with openEMS FDTD on the CPU or a Metal or CUDA GPU, then read S-parameters with markers, far fields and surface currents, sweep and optimize, and export Touchstone, drawings, reports and fabrication files.", "Fairbeam; antenler, mikroşerit devreler ve diziler için masaüstü çalışma ortamıdır. Şerit menülü 3B tasarım aracında modelleyin veya CST uyumlu VBA makrosu içe aktarın; CPU'da ya da Metal/CUDA GPU'da openEMS FDTD ile benzetin. İşaretçili S-parametrelerini, uzak alanları ve yüzey akımlarını inceleyin; tarama ve eniyileme yapın, Touchstone, çizim, rapor ve üretim dosyalarını dışa aktarın."],
    ["A ribbon-based 3D designer, VBA macro import, the openEMS FDTD solver on CPU or GPU, and results in one window: S-parameters with markers, far field, surface currents, sweeps, an optimizer and exports.", "Şerit menülü 3B tasarım aracı, VBA makrosu içe aktarma, CPU veya GPU üzerinde openEMS FDTD çözücüsü ve tek pencerede sonuçlar: işaretçili S-parametreleri, uzak alan, yüzey akımları, taramalar, eniyileyici ve dışa aktarımlar."],
  ]);

  function normalize(value) { return String(value ?? "").replace(/\s+/gu, " ").trim(); }
  function readChoice() {
    try {
      const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}").language;
      return value === "en" || value === "tr" || value === "system" ? value : "system";
    } catch { return "system"; }
  }
  function systemLanguage() {
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
    return languages.some((value) => /^tr(?:[-_]|$)/i.test(String(value))) ? "tr" : "en";
  }
  let choice = readChoice();
  let language = choice === "system" ? systemLanguage() : choice;
  const textRecords = new WeakMap();
  const attrRecords = new WeakMap();
  const excluded = (element) => !element || element.closest("script, style, noscript");

  function translateTextNode(node) {
    if (!(node instanceof Text) || excluded(node.parentElement)) return;
    let record = textRecords.get(node);
    if (!record) { record = { original: node.nodeValue, last: null }; textRecords.set(node, record); }
    else if (record.last !== null && node.nodeValue !== record.last) record.original = node.nodeValue;
    const original = record.original ?? "";
    const key = normalize(original);
    let value = language === "tr" ? TEXT.get(key) : undefined;
    if (language === "tr" && /^Released in \d+\.\d+\.\d+( and earlier)?$/.test(key)) value = key.replace("Released in ", "Yayımlandığı sürüm: ").replace(" and earlier", " ve önceki sürümler");
    if (language === "tr" && /^Coming in \d+\.\d+\.\d+$/.test(key)) value = key.replace("Coming in ", "Gelecek sürüm: ");
    if (language === "tr" && /^\d+\.\d+\.\d+ · next$/.test(key)) value = key.replace(" · next", " · sonraki sürüm");
    if (language === "tr" && key === "Next release") value = "Sonraki sürüm";
    if (language === "tr" && key.startsWith("4 × 1 patch array · ") && key.endsWith(" GHz")) value = key.replace("4 × 1 patch array · ", "4 × 1 yama dizisi · ");
    const summary = key.match(/^(\d+) features available, (\d+) in development and (\d+) planned, from the project's issues and pull requests\. Updated$/);
    if (language === "tr" && summary) value = `Projenin issue ve PR kayıtlarına göre ${summary[1]} özellik hazır, ${summary[2]} özellik geliştiriliyor ve ${summary[3]} özellik planlandı. Güncelleme:`;
    const leading = original.match(/^\s*/u)?.[0] ?? "";
    const trailing = original.match(/\s*$/u)?.[0] ?? "";
    const next = value ? `${leading}${value}${trailing}` : original;
    if (node.nodeValue !== next) node.nodeValue = next;
    record.last = next;
  }

  function translateAttribute(element, name) {
    if (excluded(element)) return;
    let byName = attrRecords.get(element);
    if (!byName) { byName = new Map(); attrRecords.set(element, byName); }
    let record = byName.get(name);
    if (!record) { record = { original: element.getAttribute(name), last: null }; byName.set(name, record); }
    else if (record.last !== null && element.getAttribute(name) !== record.last) record.original = element.getAttribute(name);
    const original = record.original ?? "";
    const value = language === "tr" ? (ATTRIBUTE_TEXT.get(normalize(original)) ?? TEXT.get(normalize(original))) : undefined;
    const next = value ?? original;
    if (element.getAttribute(name) !== next) element.setAttribute(name, next);
    record.last = next;
  }

  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) { translateTextNode(node); return; }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
    if (node.nodeType === Node.ELEMENT_NODE && excluded(node)) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) translateTextNode(text);
    const elements = node.nodeType === Node.DOCUMENT_NODE ? [document.documentElement, ...document.querySelectorAll("*")] : [node, ...node.querySelectorAll("*")];
    for (const element of elements) {
      if (excluded(element)) continue;
      for (const name of ["aria-label", "aria-description", "title", "alt", "placeholder", "data-title"]) {
        if (element.hasAttribute(name)) translateAttribute(element, name);
      }
    }
  }

  const originalTitle = document.title;
  function updateMetadata() {
    document.title = language === "tr" ? (META_TEXT.get(originalTitle) ?? originalTitle) : originalTitle;
    for (const meta of document.querySelectorAll('meta[name="description"],meta[property="og:title"],meta[property="og:description"]')) {
      const original = meta.dataset.languageOriginal ?? meta.content;
      meta.dataset.languageOriginal = original;
      const translated = META_TEXT.get(original);
      meta.content = language === "tr" ? (translated ?? original) : original;
    }
  }

  function updateRoadmapDates() {
    document.querySelectorAll("#roadmap time[datetime]").forEach((element) => {
      const date = new Date(`${element.dateTime}T12:00:00Z`);
      if (Number.isFinite(date.valueOf())) {
        const formatted = new Intl.DateTimeFormat(language === "tr" ? "tr-TR" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
        if (element.textContent !== formatted) element.textContent = formatted;
      }
    });
  }

  function apply(nextChoice = choice, notify = true) {
    choice = nextChoice === "en" || nextChoice === "tr" || nextChoice === "system" ? nextChoice : "system";
    language = choice === "system" ? systemLanguage() : choice;
    document.documentElement.lang = language;
    visit(document);
    updateMetadata();
    updateRoadmapDates();
    const group = document.querySelector(".site-language-switch");
    group?.setAttribute("aria-label", language === "tr" ? "Site dili" : "Site language");
    for (const button of document.querySelectorAll("[data-site-language]")) {
      const selected = button.dataset.siteLanguage === language;
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", button.dataset.siteLanguage === "tr" ? "Türkçe" : "English");
    }
    window.fairbeamSiteLanguage = api;
    if (notify) window.dispatchEvent(new CustomEvent("fairbeam:site-language-change", { detail: { language, choice } }));
  }

  function setLanguage(next) {
    if (next !== "en" && next !== "tr") return;
    try {
      let settings = {};
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) settings = saved;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, language: next }));
    } catch { /* language still changes for this page when storage is unavailable */ }
    apply(next);
  }

  const api = Object.freeze({ getLanguage: () => language, getChoice: () => choice, setLanguage });
  window.fairbeamSiteLanguage = api;
  document.querySelectorAll("[data-site-language]").forEach((button) => button.addEventListener("click", () => setLanguage(button.dataset.siteLanguage)));
  window.addEventListener("storage", (event) => { if (event.key === SETTINGS_KEY) apply(readChoice()); });
  window.addEventListener("languagechange", () => { if (choice === "system") apply("system"); });
  apply(choice, false);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") translateTextNode(record.target);
      else if (record.type === "attributes") translateAttribute(record.target, record.attributeName);
      else for (const added of record.addedNodes) visit(added);
    }
    updateRoadmapDates();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "aria-description", "title", "alt", "placeholder", "data-title"] });
})();
