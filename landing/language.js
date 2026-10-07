// One language state for the public landing page and its asynchronously loaded comparison.
// The desktop app stores its language choice in the same fairbeam.generalSettings record.
(() => {
  const SETTINGS_KEY = "fairbeam.generalSettings";

  // Exact source strings keep translations attached to copy while preserving inline markup,
  // equations, links, measured values, version numbers and commands.
  const pairs = [
    ["Third-party licenses", "Üçüncü taraf lisansları"],
    ["Skip to content", "İçeriğe geçin"],
    ["How it works", "Nasıl çalışır"], ["Examples", "Örnekler"], ["The designer", "Tasarım aracı"],
    ["Features", "Özellikler"], ["Results", "Sonuçlar"], ["Roadmap", "Yol haritası"],
    ["Download", "İndirin"], ["What to expect", "Neler bekleyebilirsiniz"], ["Demo", "Demo"],
    ["Site language", "Site dili"], ["Theme: system", "Tema: sistem"], ["Theme: light", "Tema: açık"], ["Theme: dark", "Tema: koyu"],
    ["Theme: system (click to change)", "Tema: sistem (değiştirmek için tıklayın)"],
    ["Theme: light (click to change)", "Tema: açık (değiştirmek için tıklayın)"],
    ["Theme: dark (click to change)", "Tema: koyu (değiştirmek için tıklayın)"],
    ["Antenna simulation workbench · openEMS FDTD", "Anten simülasyonu çalışma ortamı · openEMS FDTD"],
    ["Design antennas. See the fields.", "Anten tasarlayın. Alanları görün."],
    ["Download Fairbeam", "Fairbeam'i indirin"], ["Open the demo", "Demoyu açın"],
    ["Scroll: the patch is taken apart and simulated again", "Kaydırın: yamanın yapısını ve yeniden çalıştırılan simülasyonunu inceleyin"],
    ["From a model to fields, in one patch antenna", "Bir modelden alanlara: tek bir yama antende"],
    ["Model it", "Modelleyin"],
    ["Draw it in the designer, where every length is an expression over named parameters, or import a CST-compatible VBA macro. The same model can also be one Python file with a", "Tasarım aracında her uzunluğu adlandırılmış parametrelere bağlı bir ifade olarak tanımlayın veya CST uyumlu VBA makrosu içe aktarın. Aynı model, şu işlevi içeren tek bir Python dosyası da olabilir:"],
    ["that places metal, dielectrics and ports.", "metalleri, dielektrikleri ve portları yerleştirir."],

    ["Meshed for FDTD", "FDTD için mesh oluşturuldu"],

    ["Excited, the currents flow", "Uyarım uygulanınca akımlar oluşur"],

    ["It radiates", "Işıma yapar"],
    ["Near-to-far-field transform: 6.79 dBi broadside at 2.453 GHz, 96.5 % radiation efficiency. Radius and color both show directivity.", "Yakın alandan uzak alana dönüşüm: 2,453 GHz'de dik yönde 6,79 dBi, %96,5 ışıma verimliliği. Yarıçap ve renk, yönlülüğü gösterir."],
    ["Checked, then exported", "Denetlendi ve dışa aktarıldı"],

    ["Arrays", "Anten dizileri"], ["Four patches, one beam you can steer", "Dört yama, yönlendirebileceğiniz tek bir demet"],
    ["One patch becomes four", "Tek yama dörde dönüşür"],
    ["The same patch four times, half a wavelength apart (61.2 mm) on one 66 × 243.6 mm board, each with its own 50 Ω port. Fed in phase they reach 11.9 dBi broadside, about 5 dB above the single patch.", "Aynı yamadan dört tane, aralarında yarım dalga boyu (61,2 mm) olacak şekilde tek bir 66 × 243,6 mm kart üzerine yerleştirilir; her birinin 50 Ω portu vardır. Fazları eşit beslendiklerinde dik yönde 11,9 dBi'ye, tek yamadan yaklaşık 5 dB fazlasına ulaşırlar."],
    ["Steered by phase alone", "Yalnızca faz ile yönlendirme"],
    ["A phase that falls by k·d·sin θ", "Portlar arasında k·d·sin θ"],
    ["Your turn", "Sıra sizde"],

    ["Scan angle θ", "Tarama açısı θ"],
    ["Horns, helices, fractals and circuits", "Hornlar, helisler, fraktallar ve devreler"],
    ["Pyramidal horn, WR-90", "WR-90 piramidal horn"],
    ["An optimum-gain horn fed by a TE", "TE"],
    ["waveguide port, with PML boundaries: 15.5 dBi at 10 GHz and |S11| below −16 dB from 8 to 12 GHz.", "dalga kılavuzu portuyla beslenen, optimize edilmiş kazançlı horn; PML sınırlarıyla 10 GHz'de 15,5 dBi ve 8–12 GHz arasında −16 dB'nin altında |S11|."],
    ["Axial-mode helix", "Eksenel modlu helis"],
    ["A Kraus helix, seven turns at 13° pitch over a square ground plane: right-hand circular, 11.6 dBi at 2.4 GHz, an axial ratio of 0.9 dB on boresight and the cross-polarized LHCP 26 dB lower.", "Kare toprak düzlemi üzerindeki Kraus helisi: 13° eğimde yedi tur, sağ el dairesel polarizasyon, 2,4 GHz'de 11,6 dBi, ana doğrultuda 0,9 dB eksen oranı ve çapraz polarizasyondaki LHCP 26 dB daha düşük."],
    ["Minkowski fractal patch", "Minkowski fraktal yama"],
    ["The fractal edge lengthens the current path: 30 × 30 mm of copper resonates at 2.324 GHz, below the 32 × 40 mm plain patch at 2.453 GHz on the same substrate, at the price of bandwidth (0.8 %).", "Fraktal kenar akım yolunu uzatır: 30 × 30 mm bakır, aynı alttaştaki 32 × 40 mm düz yamanın 2,453 GHz değerinin altında, 2,324 GHz'de rezonansa girer; bunun karşılığında bant genişliği %0,8'e düşer."],
    ["Wilkinson divider", "Wilkinson bölücü"],
    ["Three ports and one lumped 100 Ω resistor: an equal split with S21 = S31 = −3.09 dB. One openEMS run per driven port gives the full S-matrix.", "Üç port ve tek bir toplu 100 Ω direnç: S21 = S31 = −3,09 dB ile eşit bölme. Her uyarılan port için bir openEMS çalıştırması, tam S-matrisini verir."],
    ["Branch-line coupler", "Dal kolu kuplörü"],
    ["A 90° hybrid: −3.21 and −2.99 dB to the two outputs at 2.40 GHz, 90.0° apart, with the reciprocity and passivity of the four-port matrix checked.", "90° hibrit: 2,40 GHz'de iki çıkışta −3,21 ve −2,99 dB; aralarındaki faz farkı 90,0°'dir. Dört portlu matrisin karşılıklılığı ve pasifliği denetlenmiştir."],
    ["Stepped-impedance low-pass", "Kademeli empedanslı alçak geçiren filtre"],
    ["Alternating wide and narrow line sections: the −3 dB point lands at 2.356 GHz, 5.2 % below the ideal line cascade, because the steps themselves add capacitance.", "Geniş ve dar hat bölümleri sırayla kullanılır. Kademelerin eklediği kapasitans nedeniyle −3 dB noktası, ideal hat zincirinden %5,2 düşük olan 2,356 GHz'e gelir."],

    ["The files, as they come out", "Üretilen dosyalar"],
    ["A3 drawing generated from the simulated geometry", "Simülasyonda kullanılan geometriden oluşturulan A3 teknik çizimi"],
    ["|S11| as a publication figure (8.8 cm)", "Yayın için |S11| grafiği (8,8 cm)"],
    ["Multi-port S-parameters, Wilkinson divider", "Çok portlu S-parametreleri: Wilkinson bölücü"],
    ["What Fairbeam does", "Fairbeam neler yapar"],
    ["Ribbon-based designer", "Şerit menülü tasarım aracı"],
    ["A one-row ribbon, a collapsible navigation tree, properties and dock, and a Python side panel. Bricks, cylinders, spheres, cones, tori, wires, polygons and extrusions; draw bricks in 3D, extrude a picked face, booleans, one Transform dialog, shortcuts, Undo, Redo and Save As.", "Tek satırlı şerit menü, daraltılabilir gezinti ağacı, özellikler ve alt panel ile Python yan paneli. Kutular, silindirler, küreler, koniler, toruslar, teller, çokgenler ve uzatılmış şekiller; 3B kutu çizimi, seçili yüzü uzatma, Boolean işlemleri, tek Dönüştür penceresi, kısayollar, Geri Al, Yinele ve Farklı Kaydet."],
    ["Import a VBA macro", "VBA makrosu içe aktarımı"],
    ["Reads a CST-compatible VBA macro or history list: parameters, materials, shapes, booleans, transforms, ports, resistors, monitors, the band, the boundaries and manual mesh lines. An import report lists every command that was skipped or changed, with its line.", "CST uyumlu VBA makrosunu veya geçmiş listesini okur: parametreler, malzemeler, şekiller, Boolean işlemleri, dönüşümler, portlar, dirençler, monitörler, bant, sınırlar ve elle tanımlanmış mesh çizgileri. İçe aktarma raporu atlanan veya değiştirilen her komutu satır numarasıyla listeler."],
    ["Parameters and checks", "Parametreler ve denetimler"],

    ["Start templates and examples", "Ana ekran şablonları ve örnekler"],
    ["Start from a half-wave dipole, a quarter-wave monopole, an open-ended waveguide, a printed sleeve dipole or a two-port microstrip line, or pick an example from a searchable list, which now includes a 2-element collinear and a 5-element Yagi for 867 MHz.", "Yarım dalga dipol, çeyrek dalga monopol, açık uçlu dalga kılavuzu, baskılı kılıflı dipol veya iki portlu mikroşerit hat ile başlayın. Aranabilir listedeki örnekler arasında 867 MHz için 2 elemanlı doğrusal dizi ve 5 elemanlı Yagi de bulunur."],
    ["Import PCB artwork", "PCB çizimini içe aktarın"],
    ["Home › Import PCB turns DXF, Gerber and Excellon files into a design;", "Giriş › PCB'yi İçe Aktar, DXF, Gerber ve Excellon dosyalarını tasarıma dönüştürür;"],
    ["does the same from the command line.", "komut satırından da aynı işlemi yapar."],
    ["Automatic meshing", "Otomatik mesh oluşturma"],
    ["Auto mode picks the mesh settings for each design, and every field can be overridden. Thin PCB copper is meshed as sheets, converted examples keep their own mesh lines, and the mesher lands within 0.1 % of converged hand meshes.", "Otomatik mod her tasarım için mesh ayarlarını seçer; her alanı elle değiştirebilirsiniz. İnce PCB bakırı levha olarak modellenir; dönüştürülen örnekler kendi mesh çizgilerini korur. Aşağıdaki dipol ve yama denetimlerinde rezonans, elle ayarlanmış yakınsamış meshlerden yaklaşık %0,1 veya daha az farklıdır."],
    ["Mesh convergence", "Mesh yakınsaması"],

    ["stop changing, and reports the density that converged. From the command line:", "artık değişmeyene kadar tasarımı giderek ince otomatik meshlerle çalıştırır ve yakınsayan yoğunluğu bildirir. Komut satırından:"],
    [".", "."],
    ["Run quality and one-click fixes", "Çalıştırma kalitesi ve tek tıkla düzeltmeler"],

    ["Parameter sweeps", "Parametre taramaları"],

    ["Goal-driven optimizer", "Hedef odaklı optimizasyon aracı"],
    ["Goals such as f", "f"], [", |S11| at a frequency, bandwidth, D", ", belirli bir frekansta |S11|, bant genişliği, D"],
    ["or |S", "veya |S"], ["| limits, over as many parameters as you vary. Secant, Nelder–Mead, Bayesian, CMA-ES, particle swarm, genetic and trust-region searches, with live progress; the best result is kept to open, apply or save.", "| sınırları, seçtiğiniz sayıda parametre boyunca belirlenebilir. Sekant, Nelder–Mead, Bayesçi, CMA-ES, parçacık sürüsü, genetik ve güven bölgesi aramaları ilerlemeyi anlık olarak gösterir; en iyi sonucu açabilir, uygulayabilir veya kaydedebilirsiniz."],
    ["Multi-port S-parameters", "Çok portlu S-parametreleri"],
    ["One openEMS run per driven port gives the full S-matrix of filters, dividers, couplers and arrays, with reciprocity and passivity checks, a picker for any S", "Uyarılan her port için bir openEMS çalıştırması; filtre, bölücü, kuplör ve dizilerin tam S-matrisini verir. Karşılıklılık ve pasiflik denetimleri, istenen S"],
    [", a Smith chart per port and Touchstone", ", her port için Smith abağı ve Touchstone"], ["export.", "dışa aktarımı sunulur."],
    ["Results with markers", "İşaretçili sonuçlar"],
    ["Result tabs: S-parameters, impedance, VSWR, Smith chart, efficiency and patterns, with markers for resonances and bandwidth, hover read-outs and your own markers. Runs are compared by the parameters that differ; Copy data and CSV in dB, phase, Re/Im or magnitude/phase.", "Sonuç sekmeleri: S-parametreleri, empedans, VSWR, Smith abağı, verimlilik ve örüntüler; rezonans ve bant genişliği işaretçileri, üzerine gelince bilgi ve kendi işaretçileriniz. Çalıştırmalar farklı parametrelere göre karşılaştırılır; veriyi ve CSV'yi dB, faz, Re/Im veya genlik/faz olarak kopyalayın."],
    ["Result summaries and comparison", "Sonuç özetleri ve karşılaştırma"],
    ["Headline numbers for each run in the tree and the Runs table, and Tables › Summary. A comparison table lists the parameters that differ between runs; copy it or save it as CSV.", "Ağaçta ve Çalıştırmalar tablosunda her çalıştırma için öne çıkan değerler, ayrıca Tablolar › Özet. Karşılaştırma tablosu çalıştırmalar arasındaki farklı parametreleri listeler; tabloyu kopyalayabilir veya CSV olarak kaydedebilirsiniz."],
    ["2D and 3D field maps", "2B ve 3B alan haritaları"],
    ["The Field map tab shows E and H planes as heat maps with a read-out and the model's outline.", "Alan Haritası sekmesi, E ve H düzlemlerini modelin dış çizgisi ve değer göstergesiyle ısı haritası olarak sunar."],
    ["Phase", "Faz"], ["and", "ve"], ["Animate", "Canlandır"],
    ["play a time-harmonic animation of the field, in 2D and in the 3D view.", "alanın zamana bağlı harmonik animasyonunu 2B'de ve 3B görünümde oynatır."],
    ["Far field, currents, beams", "Uzak alan, akımlar ve demetler"],
    ["3D patterns and polar cuts in directivity, gain, realized gain or RHCP/LHCP, with a card for D", "Yönlülük, kazanç, gerçekleşen kazanç veya RHCP/LHCP için 3B örüntüler ve kutupsal kesitler; D"],

    ["GPU engines", "GPU motorları"],

    ["VBA macro, drawings, fabrication", "VBA makrosu, teknik çizimler ve üretim"],

    ["Desktop app", "Masaüstü uygulaması"],
    ["For macOS and Windows, in English or Turkish (General settings › Language, native menus included, with a Decimal separator setting), with Save As, and a question before closing unsaved work. First start installs Python and openEMS for your user account; projects live in Documents/Fairbeam, and updates are offered in the app.", "macOS ve Windows için Türkçe veya İngilizce arayüz ve yerel menüler. Genel ayarlardan dil ve ondalık ayırıcı seçilebilir. Farklı Kaydet bulunur ve kaydedilmemiş çalışma kapatılırken sorulur. İlk açılışta Python ile openEMS hesabınıza kurulur; dosyalar Documents/Fairbeam içinde tutulur ve güncellemeler uygulamada sunulur."],

    ["Directivity of the patch at 2.453 GHz in both principal planes, as exported for a paper (8.8 cm column width).", "Yama antenin 2,453 GHz'deki iki ana düzlemde yönlülüğü; makale için dışa aktarılmıştır (8,8 cm sütun genişliği)."],
    ["Validation", "Doğrulama"], ["Against analytical results", "Analitik sonuçlarla karşılaştırma"],
    ["Check", "Denetim"], ["Fairbeam", "Fairbeam"], ["Reference", "Referans"],
    ["Dipole D", "Dipol D"], ["Patch resonance", "Yama rezonansı"],
    ["Dipole: three lengths, 50 to 66 mm, end criterion −60 dB. Patch: converged mesh, against a transmission-line model. Details and commands in the validation notes of the repository.", "Dipol: −60 dB durdurma ölçütüyle 50–66 mm arasında üç uzunluk. Yama: yakınsamış mesh ile elde edilen sonuçların iletim hattı modeliyle karşılaştırması. Ayrıntılar ve komutlar depodaki doğrulama notlarında."],
    ["Solver time in seconds", "Çözücü süresi (saniye)"],
    ["Apple M5 Pro: CPU engine with 4 threads and the optional Metal GPU engine. AMD Ryzen 9 7900X under Windows: CPU engine with 4 and all 24 threads, and the optional CUDA GPU engine on an NVIDIA RTX 3060", "Apple M5 Pro: 4 iş parçacıklı CPU motoru ve isteğe bağlı Metal GPU motoru. Windows üzerinde AMD Ryzen 9 7900X: 4 veya 24 iş parçacıklı CPU motoru ve NVIDIA RTX 3060 üzerinde isteğe bağlı CUDA GPU motoru."],
    ["Model", "Model"], ["Cells", "Hücreler"], ["Apple M5 Pro", "Apple M5 Pro"], ["Ryzen 9 7900X", "Ryzen 9 7900X"],
    ["CPU", "CPU"], ["GPU", "GPU"], ["4 threads", "4 iş parçacığı"], ["24 threads", "24 iş parçacığı"], ["CUDA", "CUDA"],
    ["Patch antenna, −60 dB", "Yama anten, −60 dB"], ["4 × 1 patch array (4 runs)", "4 × 1 yama dizisi (4 çalıştırma)"], ["Sierpinski monopole", "Sierpinski monopol"],

    ["Circuits and arrays", "Devreler ve diziler"], ["Multi-port models on 0.813 mm, ε", "0,813 mm ve ε"], ["3.38, GPU engine", "3,38 alttaş, GPU motoru"],
    ["Microstrip line Z", "Mikroşerit hat Z"], ["Wilkinson split S21 = S31", "Wilkinson bölme S21 = S31"],
    ["Branch-line S21 / S31", "Dal kolu S21 / S31"], ["Low-pass −3 dB point", "Alçak geçiren −3 dB noktası"], ["4×1 array S11 / S22", "4×1 dizi S11 / S22"],

    ["Optimizer", "Optimizasyon aracı"], ["Measured runs of", "Şu komutla yapılan çalıştırmalar:"], ["on the GPU engine", "GPU motorunda"],
    ["Task", "Görev"], ["Result", "Sonuç"], ["Cost", "Maliyet"], ["Dipole to f", "Dipolü f"], ["= 2.40 GHz", "= 2,40 GHz"],
    ["2 evaluations, 2.0 s", "2 değerlendirme, 2,0 sn"], ["Wilkinson: all ports ≤ −20 dB, S23 ≤ −25 dB", "Wilkinson: tüm portlar ≤ −20 dB, S23 ≤ −25 dB"],
    ["3 evaluations, 7.6 s", "3 değerlendirme, 7,6 sn"], ["Wilkinson: S23 ≤ −35 dB", "Wilkinson: S23 ≤ −35 dB"], ["4 evaluations, 3.6 s", "4 değerlendirme, 3,6 sn"],
    ["The isolation resistor went from the textbook 100 Ω to 73 Ω in about 11 s; with all ports driven, 73 Ω gives S23 = −39.9 dB and every port matched below −24 dB.", "Yalıtım direnci ders kitabındaki 100 Ω değerinden yaklaşık 11 sn'de 73 Ω'a indi. Tüm portlar uyarıldığında 73 Ω, S23 = −39,9 dB ve her portta −24 dB'nin altında uyum sağlar."],
    ["Automatic mesh", "Otomatik mesh"], ["Resonance with", "Rezonans:"], ["against converged hand-tuned meshes", "yakınsamış, elle ayarlanmış meshlerle karşılaştırma"],
    ["Automatic", "Otomatik"], ["Converged", "Yakınsamış"], ["Dipole", "Dipol"], ["Patch antenna", "Yama anten"],
    ["Development preview", "Geliştirme önizlemesi"],
    ["The designer, the solver pipeline and the results work end to end. The file formats are versioned (", "Tasarım aracı, çözücü işlem hattı ve sonuçlar baştan sona çalışır. Dosya biçimleri sürümlendirilir ("],
    [" for designs, ", " tasarımlar için,"], [" for results); breaking changes bump the version.", " sonuçlar için); uyumsuz değişiklikler sürümü artırır."],
    ["VBA macro export not yet validated", "VBA makrosu dışa aktarımı henüz doğrulanmadı"],
    ["The exported CST-compatible VBA macro and the macro import are not validated for every command or physical port formulation; the macro import reports the commands that it skips or changes. Check an exported model in the target program before relying on it.", "Dışa aktarılan CST uyumlu VBA makrosu ve makro içe aktarımı her komut veya fiziksel port formülasyonu için doğrulanmış değildir; makro içe aktarımı atladığı veya değiştirdiği komutları bildirir. Dışa aktarılan bir modele güvenmeden önce hedef programda kontrol edin."],
    ["Fabrication files not yet validated", "Üretim dosyaları henüz doğrulanmadı"],

    ["Wilkinson output match: open question", "Wilkinson çıkış uyumu: açık soru"],

    ["Licenses", "Lisanslar"],
    ["Fairbeam is GPL-3.0-or-later; openEMS is GPL-3.0-or-later and CSXCAD LGPL-3.0-or-later. The source code is on GitHub:", "Fairbeam GPL-3.0-or-later; openEMS GPL-3.0-or-later, CSXCAD ise LGPL-3.0-or-later lisanslıdır. Kaynak kodu GitHub'da:"],
    [". Project files are plain data produced by your own models.", ". Proje dosyaları, kendi modellerinizin ürettiği yalın verilerden oluşur."],
    ["New here?", "Yeni misiniz?"], ["Read the getting-started guide", "Başlangıç kılavuzunu okuyun"],
    ["Simulations by", "Simülasyonlar:"], ["Privacy", "Gizlilik"], ["by", "hazırlayan"],
    ["About", "Hakkında"], ["About Fairbeam", "Fairbeam hakkında"],
    ["Fairbeam is an independent open-source project for engineers, researchers and students working with antennas and RF circuits. It brings modeling, openEMS simulation and documented results into one workspace.", "Fairbeam, antenler ve RF devreleriyle çalışan mühendisler, araştırmacılar ve öğrenciler için bağımsız bir açık kaynak projesidir. Modellemeyi, openEMS simülasyonunu ve belgelenmiş sonuçları tek çalışma ortamında birleştirir."],
    ["Maintained by", "Projeyi sürdüren:"], [", with contributions from", "; katkıda bulunanlar:"], ["and the open-source community.", "ve açık kaynak topluluğu."],
    ["Project credits", "Katkılar"], ["Contact:", "İletişim:"], ["Report a problem", "Sorun bildirin"],
    ["The pyramidal horn in Fairbeam: the flared horn on its WR-90 feed with the 3D directivity pattern above it, and |S11| from 8 to 12 GHz below it.", "Fairbeam içindeki piramidal horn: WR-90 beslemesi üzerindeki genişleyen horn, üstte 3B yönlülük örüntüsü, altta 8–12 GHz aralığında |S11|."],
    ["The axial-mode helix in Fairbeam: the wire helix over its ground plane inside the 3D directivity pattern, with polar cuts and the far-field summary below.", "Fairbeam içindeki eksenel modlu helis: toprak düzlemi üzerindeki tel helis, çevresinde 3B yönlülük örüntüsü; altta kutupsal kesitler ve uzak alan özeti."],
    ["The Wilkinson divider in Fairbeam: the microstrip layout with its three ports and the 100 ohm resistor, and |S11|, |S21| and |S31| against frequency.", "Fairbeam içindeki Wilkinson bölücü: üç portlu mikroşerit yerleşim ve 100 ohm direnç; frekansa göre |S11|, |S21| ve |S31|."],
    ["A3 technical drawing of the rectangular patch antenna: top, front, side and isometric views with dimensions, a parameter table and a title block.", "Dikdörtgen yama antenin A3 teknik çizimi: ölçüler, parametre tablosu ve antetle birlikte üst, ön, yan ve izometrik görünümler."],
    ["Black-and-white publication chart of the patch antenna's |S11| in dB against frequency, with a dip near 2.45 GHz.", "Yama antenin frekansa göre dB cinsinden |S11| değerini ve 2,45 GHz civarındaki çukuru gösteren siyah-beyaz yayın grafiği."],
    ["Black-and-white publication chart of the Wilkinson divider's transmission: S21 and S31 near −3 dB and the isolation S23 against frequency.", "Wilkinson bölücünün iletimini gösteren siyah-beyaz yayın grafiği: frekansa göre −3 dB civarındaki S21 ve S31 ile yalıtım S23."],
    ["Black-and-white polar chart of the patch antenna's directivity at 2.453 GHz in the xz and yz planes, with a broadside maximum of 6.79 dBi.", "Yama antenin 2,453 GHz'de xz ve yz düzlemlerindeki yönlülüğünü, dik yönde 6,79 dBi maksimumla gösteren siyah-beyaz kutupsal grafik."],
    ["S11 chart", "S11 grafiği"],
    ["f (GHz)", "f (GHz)"], ["|S11| (dB)", "|S11| (dB)"], ["Port", "Port"], ["Phase", "Faz"], ["Active |Γ|", "Etkin |Γ|"],
    ["Port 1 driven, ports 2–4 terminated in 50 Ω", "1. port uyarılır, 2–4. portlar 50 Ω ile sonlandırılır"],
    ["All four ports fed in phase", "Dört portun tümü eş fazda beslenir"],
    ["Progressive phase −k·d·sin θ0 per element", "Eleman başına faz farkı −k·d·sin θ₀"], ["off", "kapalı"],
    ["Antenna case", "Anten modeli"], ["S11 response overlay", "S11 yanıt eğrileri"],
    ["f", "f"], ["FDTD mesh", "FDTD mesh"], ["New example projects", "Yeni örnek projeler"],
    ["Antenna simulation workbench", "Anten simülasyonu çalışma ortamı"],
    ["Roadmap by state", "Duruma göre yol haritası"], ["Available", "Kullanılabilir"], ["In development", "Geliştiriliyor"], ["Planned", "Planlandı"],
    ["In a release, or merged for the next one", "Yayımlanmış bir sürümde mevcut veya sonraki sürüm için birleştirilmiş"],
    ["Open pull requests and work under way", "Açık değişiklik istekleri ve devam eden çalıştırmalar"], ["Approved, not started yet", "Onaylandı, henüz başlanmadı"],
    ["Nothing here right now.", "Şu anda bu grupta öğe yok."], ["items", "öğe"], ["item", "öğe"],
    ["On GitHub: ", "GitHub üzerinde: "], ["Tracked as ", "Şu numaralarla izleniyor: "], ["Status: ", "Durum: "],
    ["Model, simulate and read the results in one window", "Modelleyin, simülasyonları çalıştırın ve sonuçları tek pencerede inceleyin"],
    ["Auto mode picks the mesh settings for each design, and every field can be overridden. Thin PCB copper is meshed as sheets, and converted examples keep their own mesh lines. In the dipole and patch checks below, resonance differs from converged hand-tuned meshes by about 0.1% or less.", "Otomatik mod her tasarım için mesh ayarlarını seçer; tüm alanları değiştirebilirsiniz. İnce PCB bakırı levha olarak modellenir; dönüştürülen örnekler kendi mesh çizgilerini korur. Aşağıdaki dipol ve yama denetimlerinde rezonans, elle ayarlanmış yakınsamış meshlerden elde edilen değerlerden yaklaşık %0,1 veya daha az sapar."],

    ["Against analytical results", "Analitik sonuçlarla karşılaştırma"],
    ["Dipole R", "Dipol R"], ["at resonance", "rezonansta"], ["Dipole D", "Dipol D"], ["Dipole to f", "Dipolü f"], ["Patch antenna", "Yama anten"],
    ["Microstrip line Z", "Mikroşerit hat Z"], ["Wilkinson split S21 = S31", "Wilkinson bölme S21 = S31"],
    ["Branch-line S21 / S31", "Dal kolu S21 / S31"], ["Low-pass −3 dB point", "Alçak geçiren −3 dB noktası"], ["4×1 array S11 / S22", "4×1 dizi S11 / S22"],
    ["Measured runs of", "Şu komutla yapılan çalıştırmalar:"], ["on the GPU engine", "GPU motorunda"], ["Dipole to f", "Dipolü f"],
    ["6.79 dBi", "6,79 dBi"],
    ["for designs,", " tasarımlar için,"], [" for results); breaking changes bump the version.", " sonuçlar için); uyumsuz değişiklikler sürümü artırır."],
    ["fairbeam-releases", "fairbeam-releases"],
    ["macOS", "macOS"], ["Windows", "Windows"], ["·", "·"], [". Every version is on the", ". Tüm sürümler"], ["releases page", "sürümler sayfasında"], [". Later versions are offered in the app.", ". Daha yeni sürümler uygulamada sunulur."],
    ["Read the getting-started guide", "Başlangıç kılavuzunu okuyun"],
    ["openEMS", "openEMS"],
    ["İsmail Akdağ", "İsmail Akdağ"],
    ["Where Fairbeam is, and where it is going", "Fairbeam'in mevcut durumu ve hedefleri"],
    ["Start from a half-wave dipole, a quarter-wave monopole, an open-ended waveguide, a printed sleeve dipole or a two-port microstrip line, or pick an example from a searchable list, which now includes a 2-element collinear and a 5-element Yagi for 867 MHz.", "Yarım dalga dipol, çeyrek dalga monopol, açık uçlu dalga kılavuzu, baskılı kılıflı dipol veya iki portlu mikroşerit hat ile başlayın. Aranabilir listedeki örnekler arasında 867 MHz için 2 elemanlı doğrusal dizi ve 5 elemanlı Yagi de bulunur."],
    ["Scan θ0", "Tarama θ₀"], ["Main beam", "Ana demet"], ["Dmax", "Dmax"],
    ["4 × 1 patch array · {frequency} GHz", "4 × 1 yama dizisi · {frequency} GHz"],
    // the redesigned pages: header, home, features, roadmap and docs
    ["Docs", "Belgeler"],
    ["Open the menu", "Menüyü açın"],
    ["Close the menu", "Menüyü kapatın"],
    ["Main", "Ana menü"],
    ["Site links", "Site bağlantıları"],
    ["Fairbeam, home", "Fairbeam, ana sayfa"],
    ["Getting started", "Başlangıç kılavuzu"],
    ["Releases", "Sürümler"],
    ["Source code", "Kaynak kod"],
    ["and CSXCAD. Fairbeam is free software under GPL-3.0-or-later.", "ve CSXCAD. Fairbeam, GPL-3.0-or-later lisanslı özgür yazılımdır."],
    ["Fairbeam is a free, open-source desktop app for antennas, microstrip circuits and arrays. Model them in a parametric 3D designer, simulate with the openEMS FDTD solver on the CPU or the GPU, and read S-parameters, far fields and surface currents next to the model.", "Fairbeam; antenler, mikroşerit devreler ve diziler için ücretsiz ve açık kaynaklı bir masaüstü uygulamasıdır. Parametrik 3B tasarım aracında modelleyin, openEMS FDTD çözücüsüyle CPU'da veya GPU'da simülasyonunu çalıştırın; S-parametrelerini, uzak alanları ve yüzey akımlarını modelin yanında inceleyin."],
    ["from port to port turns the beam. Each angle is the weighted sum of four embedded element patterns from four openEMS runs, so coupling is included and each port's active reflection moves with the beam.", "kadar azalan faz, demeti yönlendirir. Her açı, dört openEMS çalıştırmasından elde edilen dört gömülü eleman örüntüsünün ağırlıklı toplamıdır; böylece kuplaj hesaba katılır ve her portun etkin yansıması demetle birlikte değişir."],
    ["Views of the app", "Uygulamanın görünümleri"],
    ["Modeling", "Modelleme"],
    ["S-parameters", "S-parametreleri"],
    ["Far field", "Uzak alan"],
    ["Every dimension is an expression over named parameters, kept in a table under the 3D view.", "Her boyut, adlandırılmış parametrelere bağlı bir ifadedir; parametreler 3B görünümün altındaki tabloda yer alır."],
    ["Each run is kept under Results, with markers at resonance, the −10 dB bandwidth and a table you can copy.", "Her çalıştırma Sonuçlar altında saklanır: rezonanstaki işaretçiler, −10 dB bant genişliği ve kopyalanabilen bir tabloyla."],
    ["The 3D pattern over the model, with directivity, gain and the radiation, mismatch and total efficiency.", "Model üzerinde 3B örüntü; yönlülük, kazanç ve ışıma, uyumsuzluk ve toplam verimlilikle birlikte."],
    ["Fifty seconds of Fairbeam: a microstrip line drawn, a horn that radiates, an array beam steered, and the app on macOS and Windows.", "Elli saniyede Fairbeam: çizilen bir mikroşerit hat, ışıma yapan bir horn, yönlendirilen bir dizi demeti ve macOS ile Windows'ta uygulama."],
    ["The Fairbeam designer on the Modeling tab: the navigation tree with the substrate, ground plane and patch on the left, the patch antenna with its 50 ohm port in the 3D view, the patch's limits written as −W/2 and W/2 on the right, and the parameter table in the dock below.", "Modelleme sekmesinde Fairbeam tasarım aracı: solda alttaş, toprak düzlemi ve yamayla gezinti ağacı; 3B görünümde 50 ohm portlu yama anten; sağda −W/2 ve W/2 olarak yazılmış yama sınırları; alttaki panelde parametre tablosu."],
    ["A finished run of the patch antenna on the S-parameters tab: |S11| against frequency with an automatic marker at 2.435 GHz and −22.1 dB, the −10 dB band shaded, the marker table below and the run's summary on the right.", "Yama antenin tamamlanmış bir çalıştırması, S-parametreleri sekmesinde: frekansa göre |S11|, 2,435 GHz ve −22,1 dB'de otomatik işaretçi, gölgelendirilmiş −10 dB bandı, altta işaretçi tablosu ve sağda çalıştırmanın özeti."],
    ["The patch antenna's 3D directivity pattern at 2.45 GHz over the model, with a card listing Dmax 6.75 dBi, gain, realized gain and the radiation, mismatch and total efficiency.", "Yama antenin 2,45 GHz'deki 3B yönlülük örüntüsü model üzerinde; Dmax 6,75 dBi, kazanç, gerçekleşen kazanç ile ışıma, uyumsuzluk ve toplam verimliliği listeleyen bir kart."],
    ["Parametric 3D designer", "Parametrik 3B tasarım aracı"],
    ["Bricks, cylinders, polygons, wires, extrusions and booleans on a one-row ribbon. Every length is an expression over named parameters.", "Tek satırlık şerit menüde kutular, silindirler, çokgenler, teller, uzatılmış şekiller ve Boolean işlemleri. Her uzunluk, adlandırılmış parametrelere bağlı bir ifadedir."],
    ["openEMS on the CPU or the GPU", "CPU'da veya GPU'da openEMS"],

    ["Results beside the model", "Modelin yanında sonuçlar"],
    ["S-parameters with markers, Smith chart, impedance, VSWR, 3D patterns, field maps and animated surface currents.", "İşaretçili S-parametreleri, Smith abağı, empedans, VSWR, 3B örüntüler, alan haritaları ve canlandırılmış yüzey akımları."],
    ["Full S-matrices of filters, dividers and couplers, and array beams steered after the run.", "Filtre, bölücü ve kuplörlerin tam S-matrisleri; dizi demetleri çalıştırmadan sonra yönlendirilir."],
    ["Sweeps and an optimizer", "Taramalar ve optimizasyon aracı"],
    ["Sweeps over up to six parameters, and an optimizer that tunes any number of them towards your goals.", "En fazla altı parametre üzerinde taramalar ve istediğiniz sayıda parametreyi hedeflerinize göre ayarlayan bir optimizasyon aracı."],
    ["Import and export", "İçe ve dışa aktarma"],
    ["CST-compatible VBA macros and PCB artwork in; Touchstone, CST-compatible VBA macros, drawings, a PDF report and Gerber files out.", "İçe aktarılanlar: CST uyumlu VBA makroları ve PCB çizimleri. Dışa aktarılanlar: Touchstone, CST uyumlu VBA makroları, teknik çizimler, PDF rapor ve Gerber dosyaları."],
    ["All features, validation and benchmarks", "Tüm özellikler, doğrulama ve performans ölçümleri"],

    ["15.5 dBi at 10 GHz, |S11| below −16 dB from 8 to 12 GHz.", "10 GHz'de 15,5 dBi; 8–12 GHz arasında |S11| −16 dB'nin altında."],
    ["Right-hand circular, 11.6 dBi at 2.4 GHz, 0.9 dB axial ratio on boresight.", "Sağ el dairesel polarizasyon, 2,4 GHz'de 11,6 dBi, ana doğrultuda 0,9 dB eksen oranı."],
    ["Three ports and a 100 Ω resistor: an equal split, S21 = S31 = −3.09 dB.", "Üç port ve 100 Ω direnç: eşit bölme, S21 = S31 = −3,09 dB."],
    ["Free for macOS and Windows. On first start the app installs Python and openEMS for your user account, once and without admin rights: about 120–155 MB.", "macOS ve Windows için ücretsiz. İlk açılışta uygulama, Python'u ve openEMS'i kullanıcı hesabınıza bir kez ve yönetici yetkisi olmadan kurar: yaklaşık 120–155 MB."],
    ["0.7.0 · Apple silicon · macOS 27+ · .dmg · 11.7 MB", "0.7.0 · Apple silicon · macOS 27+ · .dmg · 11,7 MB"],
    ["0.7.0 · x64 · Windows 10/11 · installer · 8.6 MB", "0.7.0 · x64 · Windows 10/11 · kurulum dosyası · 8,6 MB"],
    ["Download ↓", "İndirin ↓"],

    ["The Windows installer is not code-signed. If SmartScreen warns, choose More info › Run anyway.", "Windows kurulum dosyası kod imzalı değildir. SmartScreen uyarı verirse “Ek bilgi › Yine de çalıştır” seçeneğini seçin."],
    ["Checksums are in", "Sağlama toplamları şu dosyada:"],
    ["Linux: no installer yet.", "Linux: henüz kurulum dosyası yok."],
    ["Run Fairbeam from the repository", "Fairbeam'i depodan çalıştırın"],
    [". To build it from source, see", ". Kaynaktan derlemek için:"],
    ["Running Fairbeam from source", "Fairbeam'i kaynaktan çalıştırma"],

    ["On this page", "Bu sayfada"],
    ["All features", "Tüm özellikler"],
    ["Example projects", "Örnek projeler"],
    ["Output files", "Çıktı dosyaları"],

    ["Windows installer not code-signed, macOS 27+", "Windows kurulum dosyası kod imzasız, macOS 27+"],
    ["Planned and finished work is on the", "Planlanan ve tamamlanan işler"],
    ["roadmap", "yol haritasında"],
    ["Known limits of the current version are under", "Mevcut sürümün bilinen sınırları için:"],
    [". Ideas and requests are welcome on the", ". Fikir ve isteklerinizi şuraya iletebilirsiniz:"],
    ["public tracker", "herkese açık takip sistemi"],
    // Documentation frames share these strings with the static site renderer.
    ["This page is not available in Turkish yet. The English version is shown below.", "Bu sayfanın Türkçe çevirisi henüz yok. Aşağıda İngilizce sürümü gösterilmektedir."],
    ["Fairbeam docs", "Fairbeam belgeleri"],
    ["Documentation", "Belgeler"], ["Overview", "Genel bakış"], ["Edit on GitHub", "GitHub'da düzenleyin"],
    ["Previous", "Önceki"], ["Next", "Sonraki"], ["Previous and next page", "Önceki ve sonraki sayfa"],
    ["Copy", "Kopyalayın"], ["Copied", "Kopyalandı"],
    ["Get started", "Başlarken"], ["Results and export", "Sonuçlar ve dışa aktarma"], ["Python and CLI", "Python ve komut satırı"],
    ["From source", "Kaynaktan kurulum"], ["On this site", "Sitede ayrıca"],
    ["Guides and reference for the Fairbeam desktop app, its Python models and the command line.", "Fairbeam masaüstü uygulaması, Python modelleri ve komut satırı için kılavuzlar ve başvuru belgeleri."],

    ["What each release added, and the work in development.", "Her sürümün getirdikleri ve geliştirilmekte olan işler."],

    ["The visual workspace: modeling, checks, simulation settings, the mesh, running and reading results, design files, and importing VBA macros and PCB artwork.", "Görsel çalışma alanı: modelleme, denetimler, simülasyon ayarları, mesh, çalıştırma ve sonuçları inceleme, tasarım dosyaları, VBA makrosu ve PCB çizimi içe aktarma."],
    ["Interface presets, accent colors, chart palettes and custom colors under General settings › Appearance.", "Genel ayarlar › Tema ve yazı tipi altındaki arayüz hazır ayarları, vurgu renkleri, grafik paletleri ve özel renkler."],
    ["Six 867 MHz antennas as designer files, with their parameters, results and how to scale them.", "Tasarım dosyalarıyla altı adet 867 MHz anten: parametreleri, sonuçları ve ölçekleme yöntemleri."],
    ["How the automatic mesh is built from the geometry: options, rules, the mesh report and checks against hand-made meshes.", "Otomatik mesh'in geometriden nasıl oluşturulduğu: seçenekler, kurallar, mesh raporu ve elle oluşturulmuş mesh'lerle karşılaştırmalar."],
    ["The local run server behind the Run panel: run setup, your own materials, optimization and comparing projects.", "Simülasyon çalıştır panelinin kullandığı yerel çalıştırma sunucusu: çalıştırma ayarları, kendi malzemeleriniz, optimizasyon ve sonuçları karşılaştırma."],
    ["Parameter sweeps, mesh convergence studies, the study file format and Touchstone export from the command line.", "Komut satırından parametre taramaları, mesh yakınsama çalışmaları, çalışma dosyası biçimi ve Touchstone dışa aktarımı."],
    ["Tuning a model or a design towards goals: parameters, goals, algorithms, the output and measured examples.", "Bir modeli veya tasarımı hedeflere göre ayarlama: parametreler, hedefler, algoritmalar, çıktı ve ölçülmüş örnekler."],
    ["One run per driven port, the S-matrix, and the S-parameter and array views in the viewer.", "Uyarılan her port için bir çalıştırma, S-matrisi ve görüntüleyicideki S-parametresi ve dizi görünümleri."],
    ["The optional GPU build of openEMS, Metal on Apple silicon and CUDA on Windows, with measured timings.", "openEMS'in isteğe bağlı GPU derlemesi: Apple silicon'da Metal, Windows'ta CUDA; ölçülmüş sürelerle."],
    ["The excitation, end criterion, S11, bands, far field, efficiency and gain, with notes on accuracy.", "Uyarım, durdurma ölçütü, S11, bantlar, uzak alan, verimlilik ve kazanç; doğruluk notlarıyla."],
    ["Embedded element patterns, normalization, beam steering and the 2 × 1 and 4 × 1 patch arrays.", "Gömülü eleman örüntüleri, normalizasyon, hüzme yönlendirme ve 2 × 1 ile 4 × 1 yama dizileri."],
    ["Screenshots, technical drawings, publication figures, the export package, the PDF report and fabrication files.", "Ekran görüntüleri, teknik çizimler, yayın grafikleri, dışa aktarma paketi, PDF raporu ve üretim dosyaları."],
    ["The Blender render package and the GLB model: what they contain and how to render them.", "Blender render paketi ve GLB modeli: içerikleri ve render işlemi."],
    ["Python model files, the included models, non-planar geometry and waveguide ports, the material library and editing models in the app.", "Python model dosyaları, hazır modeller, düzlemsel olmayan geometri ve dalga kılavuzu portları, malzeme kütüphanesi ve modelleri uygulamada düzenleme."],
    ["The fairbeam commands, the CPU and GPU engines, importing existing geometry and the raw simulation data.", "fairbeam komutları, CPU ve GPU motorları, mevcut geometriyi içe aktarma ve ham simülasyon verileri."],
    ["The project bundle, fairbeam.project/1, field by field.", "fairbeam.project/1 proje paketi biçiminin her alanının açıklaması."],
    ["Building openEMS and installing Fairbeam from the repository on macOS, a first run and the test suite.", "macOS'te openEMS'i derleme ve Fairbeam'i depodan kurma, ilk çalıştırma ve test paketi."],
    ["Running simulations locally on Windows 10 and 11: openEMS, the Python package, the run server and the viewer.", "Windows 10 ve 11'de simülasyonları yerel olarak çalıştırma: openEMS, Python paketi, çalıştırma sunucusu ve görüntüleyici."],
    ["The CPU solver, the run server and the viewer in a local browser on Linux, set up from source.", "Linux'ta kaynaktan kurulan CPU çözücüsü, çalıştırma sunucusu ve yerel tarayıcıda görüntüleyici."],
    ["Results compared with closed-form theory, mesh convergence and the recommended solver settings.", "Kapalı biçimli analitik çözümlerle karşılaştırılan sonuçlar, mesh yakınsaması ve önerilen çözücü ayarları."],
    ["The 14 example projects on reference machines under Windows and macOS: results and solver times.", "14 örnek projenin Windows ve macOS kullanan referans sistemlerdeki sonuçları ve çözücü süreleri."],
    ["openEMS lumped resistors measured at the element, and where an apparent error in a test fixture comes from.", "openEMS toplu dirençlerinin eleman üzerinde ölçümü ve bir test düzeneğinde görülen hatanın kaynağı."],
    ["How Fairbeam uses AI coding assistants, and what the project asks of AI-assisted contributions.", "Fairbeam'in yapay zekâ kodlama asistanlarını nasıl kullandığı ve yapay zekâ destekli katkılardan neler beklendiği."],
    ["Reporting problems, pull requests and the ground rules for contributions.", "Sorun bildirme, değişiklik istekleri ve katkıların temel kuralları."],
    // Measured values in the features page tables use the Turkish decimal comma.
    ["Scan θ", "Tarama θ"],
    ["2.13–2.15 dBi", "2,13–2,15 dBi"],
    ["2.11 dBi (theory)", "2,11 dBi (teori)"],
    ["2.455 GHz", "2,455 GHz"],
    ["2.513 GHz (TL model), −2.3 %", "2,513 GHz (iletim hattı modeli), −%2,3"],
    ["0.26 M", "0,26 M"],
    ["0.45 M", "0,45 M"],
    ["2.0 M", "2,0 M"],
    ["10.6", "10,6"],
    ["1.6", "1,6"],
    ["52.9", "52,9"],
    ["49.9", "49,9"],
    ["2.6", "2,6"],
    ["14.2", "14,2"],
    ["25.1", "25,1"],
    ["12.0", "12,0"],
    ["2.7", "2,7"],
    ["61.1", "61,1"],
    ["65.7", "65,7"],
    ["3.4", "3,4"],
    ["48.3 Ω", "48,3 Ω"],
    ["50.0 Ω (Hammerstad)", "50,0 Ω (Hammerstad)"],
    ["−3.09 dB", "−3,09 dB"],
    ["−3.01 dB (ideal)", "−3,01 dB (ideal)"],
    ["−3.21 / −2.99 dB", "−3,21 / −2,99 dB"],
    ["−3.01 dB each", "her biri −3,01 dB"],
    ["2.356 GHz", "2,356 GHz"],
    ["2.485 GHz (ideal)", "2,485 GHz (ideal)"],
    ["−23.5 / −17.0 dB", "−23,5 / −17,0 dB"],
    ["4 GPU runs, 18 s", "4 GPU çalıştırması, 18 sn"],
    ["2.4000 GHz", "2,4000 GHz"],
    ["2.4182 GHz", "2,4182 GHz"],
    ["2.4198 GHz, −0.07 %", "2,4198 GHz, −%0,07"],
    ["2.4525 GHz", "2,4525 GHz"],
    ["2.4550 GHz, −0.10 %", "2,4550 GHz, −%0,10"],
  ];

  const roadmapPairs = [
    ["Designer", "Tasarım aracı"], ["Simulation", "Simülasyon"], ["Performance & quality", "Performans ve kalite"],
    ["Visual designer", "Görsel tasarım aracı"], ["Draw a parametric model, set up the simulation, run it and read the results in one window.", "Parametrik modeli çizin, simülasyon ayarlarını yapın, çalıştırın ve sonuçları tek pencerede inceleyin."],
    ["One-row ribbon", "Tek satırlı şerit menü"], ["Home, Modeling, Transform, Simulation, Optimize and Post-processing on one row; the tree, dock and properties collapse, next to a Python side panel.", "Giriş, Modelleme, Dönüştür, Simülasyon, Optimizasyon ve Son işlem sekmeleri tek satırda; ağaç, panel ve özellikler daraltılabilir, yanlarında Python paneli bulunur."],
    ["Draw in 3D and extrude faces", "3B görünümde çizin ve yüzleri uzatın"], ["Draw a brick's base and then its height in the 3D view, or extrude a picked face into a new part.", "3B görünümde bir kutunun tabanını ve ardından yüksekliğini çizin ya da seçili yüzü uzatarak yeni bir katı oluşturun."],
    ["One Transform dialog", "Tek Dönüştür penceresi"], ["Translate, scale, rotate and mirror in one dialog (Ctrl+T), with a live preview.", "Canlı önizlemeli tek pencerede öteleyin, ölçekleyin, döndürün ve aynalayın (Ctrl+T)."],
    ["Booleans, polygons included", "Çokgenler dâhil Boolean işlemleri"], ["Add, subtract and intersect shapes, including polygons, with a colour-coded preview.", "Çokgenler dâhil şekilleri renk kodlu önizlemeyle birleştirin, çıkarın ve kesiştirin."],
    ["Pick points, align and measure", "Noktaları seçin, hizalayın ve ölçün"], ["Use vertices, edge midpoints and face centres for corners and origins; align parts and measure between points.", "Köşe ve başlangıç noktaları için köşeleri, kenar orta noktalarını ve yüz merkezlerini kullanın; katıları hizalayın ve noktalar arasını ölçün."],
    ["Shortcuts and modeling history", "Kısayollar ve modelleme geçmişi"], ["A sheet of the keyboard shortcuts, and the session's modeling history.", "Klavye kısayollarının özeti ve oturumun modelleme geçmişi."],
    ["A tree with context menus", "Bağlam menülü ağaç"], ["Right-click menus on every node, show and hide, and drag and drop of parts into components.", "Her düğümde sağ tık menüleri, gösterme ve gizleme, katıları bileşenlere sürükleyip bırakma."],
    ["Parameters in the dock", "Alt panelde parametreler"], ["A table of every parameter next to Checks, with CSV and JSON import and export.", "Denetimlerin yanında tüm parametreleri gösteren, CSV ve JSON içe/dışa aktarımı olan tablo."],
    ["Checks that explain themselves", "Kendini açıklayan denetimler"], ["Click a warning to see what was found, why it matters and how to fix it.", "Uyarının nedenini, önemini ve nasıl düzeltileceğini görmek için uyarıya tıklayın."],
    ["Ports that find their ground", "Toprak bağlantısını bulan portlar"], ["Add port here says what the port connects to and offers the other metals it found.", "“Buraya port ekle”, portun neye bağlandığını açıklar ve bulunan diğer metalleri sunar."],
    ["Import VBA macro", "VBA makrosunu içe aktarın"], ["A CST-compatible VBA macro or history list becomes a design, manual mesh lines included, with a report of what was skipped or changed.", "CST uyumlu VBA makrosu veya geçmiş listesi, elle tanımlanan mesh çizgileriyle birlikte tasarıma dönüşür; atlanan ve değiştirilenler raporlanır."],
    ["Save As", "Farklı Kaydet"], ["Save a design under a new name, in the app and from the File menu; Undo and Redo work from the menus too.", "Uygulamada veya Dosya menüsünden tasarımı yeni adla kaydedin; Geri Al ve Yinele menülerden de çalışır."],
    ["Checks for misplaced metal", "Yanlış yerdeki metaller için denetimler"], ["New warnings for metal that overhangs its substrate or floats off the structure.", "Alttaştan taşan veya yapıdan kopuk duran metaller için yeni uyarılar."],
    ["Surface current in the ribbon", "Şeritte yüzey akımı"], ["Simulation › Monitors has its own Surface current button, next to Far field.", "Simülasyon › Monitörler bölümünde Uzak alanın yanında Yüzey akımı düğmesi bulunur."],
    ["Start templates", "Ana ekran şablonları"], ["A half-wave dipole, a quarter-wave monopole, an open-ended waveguide, a printed sleeve dipole and a two-port microstrip line to start from.", "Başlamak için yarım dalga dipol, çeyrek dalga monopol, açık uçlu dalga kılavuzu, baskılı kılıflı dipol ve iki portlu mikroşerit hat."],
    ["Import PCB artwork", "PCB çizimini içe aktarın"], ["DXF, Gerber and Excellon files become a design: Home › Import PCB, or fairbeam import-pcb.", "DXF, Gerber ve Excellon dosyalarını tasarıma dönüştürün: Giriş › PCB'yi İçe Aktar veya fairbeam import-pcb."],
    ["One-click check fixes", "Denetimleri tek tıkla düzeltin"], ["Common design checks offer a fix you can apply with one click.", "Sık rastlanan tasarım denetimleri tek tıkla uygulanabilecek düzeltmeler sunar."],
    ["Automatic meshing", "Otomatik mesh oluşturma"], ["The FDTD mesh is built from the geometry, within 0.1 % of converged hand-tuned meshes.", "FDTD mesh geometriden oluşturulur. Dipol ve yama denetimlerinde rezonans, elle ayarlanmış yakınsamış meshlerden yaklaşık %0,1 veya daha az farklıdır."],
    ["Multi-port S-parameters", "Çok portlu S-parametreleri"], ["Full S-matrices of filters, dividers, couplers and arrays, with Touchstone export.", "Filtre, bölücü, kuplör ve dizilerin tam S-matrisleri; Touchstone dışa aktarımı."],
    ["Sweeps and optimizer", "Taramalar ve optimizasyon aracı"], ["Sweep one or two parameters, or let the optimizer tune them towards your goals.", "Bir veya iki parametreyi tarayın ya da optimizasyon aracının bunları hedeflerinize göre ayarlamasını sağlayın."],
    ["Metal GPU engine", "Metal GPU motoru"],
    ["CUDA GPU engine", "CUDA GPU motoru"],
    ["Thin copper as sheets", "İnce bakırın levha olarak modellenmesi"], ["Realistic 35 µm PCB copper is simulated as sheets, so runs keep a practical time step.", "Gerçekçi 35 µm PCB bakırı simülasyonda levha olarak modellenir; böylece pratik bir zaman adımı korunur."],
    ["Convergence checks", "Yakınsama denetimleri"],
    ["Thin copper in exported models", "Dışa aktarılan modellerde ince bakır"], ["A design exported to Python builds the same copper sheets as the designer's own run.", "Python'a aktarılan tasarım, tasarım aracındaki çalıştırmada kullanılan bakır levhaları oluşturur."],
    ["Auto mesh mode", "Otomatik mesh modu"], ["The mesh settings are picked for each design, and any field can be overridden.", "Her tasarım için mesh ayarları seçilir ve tüm alanlar değiştirilebilir."],
    ["Parameter sweeps", "Parametre taramaları"], ["Sequences over up to six parameters each, checked before they run, queued, and compared run by run.", "Her biri altı parametreye kadar kapsayan diziler önceden denetlenir, kuyruğa alınır ve çalıştırma bazında karşılaştırılır."],
    ["A stronger optimizer", "Daha güçlü optimizasyon aracı"], ["Live progress, the best result kept, any number of parameters, and Bayesian, CMA-ES, particle-swarm, genetic and trust-region searches.", "Canlı ilerleme, saklanan en iyi sonuç, istenen sayıda parametre ve Bayesçi, CMA-ES, parçacık sürüsü, genetik ve güven bölgesi aramaları."],
    ["No run without a port", "Port olmadan çalıştırma başlatılmaz"], ["A design with no port, or no excited port, is refused with a check instead of failing.", "Portu veya uyarılan portu olmayan tasarım hata vermek yerine denetimle reddedilir."],
    ["Examples keep their mesh", "Örnekler mesh'lerini korur"],
    ["Optimizer skips misplaced metal", "Optimizasyon aracı yanlış yerdeki metalleri atlar"], ["Candidates the design checks refuse are skipped without a simulation and shown as Skipped.", "Tasarım denetimlerinin reddettiği adaylar simülasyon yapılmadan atlanır ve “Atlandı” olarak gösterilir."],
    ["GPU build by default", "Varsayılan GPU derlemesi"], ["When the GPU build of openEMS is installed, the app starts with it and offers both engines; a general setting switches it.", "openEMS GPU derlemesi kuruluysa uygulama onunla başlar ve iki motoru da sunar; Genel ayarlardan seçim değiştirilebilir."],
    ["Mesh convergence", "Mesh yakınsaması"],
    ["Run-quality warnings", "Çalıştırma kalitesi uyarıları"], ["A run that did not converge, or whose numbers look suspicious, is flagged in the tree and on its results.", "Yakınsamayan veya şüpheli değerler veren çalıştırma, ağaçta ve sonuçlarında işaretlenir."],
    ["Far field, currents and beam steering", "Uzak alan, akımlar ve demet yönlendirme"], ["3D patterns, gain and efficiency, surface currents, and array beams steered after the run.", "3B örüntüler, kazanç ve verimlilik, yüzey akımları ve çalıştırma sonrasında yönlendirilen dizi demetleri."],
    ["Drawings, reports and fabrication files", "Teknik çizimler, raporlar ve üretim dosyaları"], ["Dimensioned drawings, publication figures, a PDF report, and Gerber and drill files.", "Ölçülendirilmiş çizimler, yayın grafikleri, PDF raporu, Gerber ve delik dosyaları."],
    ["VBA macro export", "VBA makrosu dışa aktarımı"],
    ["Solver times on reference machines", "Referans makinelerde çözücü süreleri"], ["See how long the same model takes on an Apple M5 Pro and a Ryzen 9 with CUDA.", "Aynı modelin Apple M5 Pro ve CUDA'lı Ryzen 9 üzerindeki süresini görün."],
    ["Every run kept", "Her çalıştırma saklanır"], ["Each run keeps its own result, and Results opens the newest run instead of the preview.", "Her çalıştırma kendi sonucunu saklar; Sonuçlar önizleme yerine en yeni çalıştırmayı açar."],
    ["Results in the design tree", "Tasarım ağacındaki sonuçlar"], ["Each run appears under its design, with its S-parameters, far fields, currents and log.", "Her çalıştırma tasarımının altında S-parametreleri, uzak alanları, akımları ve günlüğüyle görünür."],
    ["Post-processing tab", "Son işlem sekmesi"], ["Selecting a result opens its plot, compare and export tools in the ribbon.", "Bir sonuç seçildiğinde grafiği, karşılaştırma ve dışa aktarma araçları şeritte açılır."],
    ["Markers", "İşaretçiler"], ["Resonances, a two-marker bandwidth, hover read-outs and your own markers, with a table.", "Rezonanslar, iki işaretçili bant genişliği, üzerine gelince bilgi, kendi işaretçileriniz ve bir tablo."],
    ["Compare runs", "Çalıştırmaları karşılaştırın"], ["Runs side by side, with the parameters that differ marked; copy or save several runs at once.", "Farklı parametreleri işaretlenmiş çalıştırmaları yan yana görün; birkaç çalıştırmayı birlikte kopyalayın veya kaydedin."],
    ["Complex formats and Touchstone", "Karmaşık veri ve Touchstone"], ["Copy data and CSV in dB, phase, Re/Im or magnitude/phase, and Touchstone export.", "Veri ve CSV'yi dB, faz, Re/Im veya genlik/faz olarak kopyalayın; Touchstone dışa aktarın."],
    ["Result tabs", "Sonuç sekmeleri"], ["Results open as tabs in the main area, with an A/B/C table of the runs.", "Sonuçlar ana alanda sekmelerde açılır ve çalıştırmalar A/B/C tablosunda karşılaştırılır."],
    ["Animated surface currents", "Animasyonlu yüzey akımları"], ["Phase-resolved surface currents play as a smooth animation in the 3D view.", "Faz çözünürlüklü yüzey akımları 3B görünümde akıcı animasyon olarak oynatılır."],
    ["Gain and polarization in patterns", "Örüntülerde kazanç ve polarizasyon"], ["3D patterns and cuts in directivity, gain, realized gain, or RHCP and LHCP for circular polarization.", "Dairesel polarizasyon için yönlülük, kazanç, gerçekleşen kazanç, RHCP ve LHCP cinsinden 3B örüntüler ve kesitler."],
    ["Far-field card in the 3D view", "3B görünümde uzak alan kartı"], ["Dmax, gain, realized gain, radiation, mismatch and total efficiency and the main lobe, next to the pattern.", "Örüntünün yanında Dmax, kazanç, gerçekleşen kazanç, ışıma, uyumsuzluk ve toplam verimlilik ile ana lob."],
    ["Efficiency result", "Verimlilik sonucu"], ["1D Results › Efficiency: mismatch efficiency over the band, with the radiation and total efficiency, per driven port.", "1B Sonuçlar › Verimlilik: uyarılan her port için bant boyunca uyumsuzluk, ışıma ve toplam verimlilik."],
    ["Efficiency over the band", "Bant boyunca verimlilik"],
    ["Result summaries", "Sonuç özetleri"], ["Headline numbers for each run in the tree and the Runs table, Tables › Summary, and a comparison table of the parameters that differ, to copy or save as CSV.", "Ağaçta ve Çalıştırmalar tablosunda her çalıştırmanın öne çıkan değerleri, Tablolar › Özet ve farklı parametreleri gösteren, kopyalanabilir veya CSV olarak kaydedilebilir karşılaştırma tablosu."],
    ["2D field maps with phase and animation", "Fazlı ve animasyonlu 2B alan haritaları"], ["The Field map tab shows E and H planes as heat maps; Phase and Animate play a time-harmonic animation, in 2D and 3D.", "Alan Haritası sekmesi E ve H düzlemlerini ısı haritası olarak gösterir; Faz ve Canlandır, 2B ve 3B'de zamana bağlı harmonik animasyonu oynatır."],
    ["Desktop app for macOS and Windows", "macOS ve Windows için masaüstü uygulaması"], ["Installs its own Python and openEMS on first start, for your account, without admin rights.", "İlk açılışta Python ve openEMS'i yönetici izni olmadan hesabınıza kurar."],
    ["Updates in the app", "Uygulama içi güncellemeler"], ["With your confirmation, updates are installed after their payload signature is checked against the configured updater key. This is separate from Developer ID signing and Apple notarization.", "Onayınızla, güncelleme paketinin imzası yapılandırılmış güncelleyici anahtarıyla denetlendikten sonra güncelleme kurulur. Bu denetim, Developer ID imzasından ve Apple doğrulamasından ayrıdır."],
    ["Sturdier on Windows", "Windows'ta daha kararlı"],
    ["Clean updates and uninstall", "Temiz güncelleme ve kaldırma"],
    ["GPU preference on Windows", "Windows'ta GPU tercihi"], ["“Prefer the GPU build” on the setup screen now works on Windows too.", "Kurulum ekranındaki “GPU derlemesini tercih et” seçeneği artık Windows'ta da çalışır."],
    ["Sharp on scaled displays", "Ölçekli ekranlarda net görünüm"], ["Layouts fit 125 % and 150 % Windows scaling and follow each monitor's pixel density.", "Düzenler Windows'un %125 ve %150 ölçeklerine uyar ve her monitörün piksel yoğunluğunu izler."],
    ["Start, Design and Examples", "Ana ekran, Tasarım ve Örnekler"], ["Examples open read-only with their results; Open as new design makes an editable copy.", "Örnekler sonuçlarıyla salt okunur açılır; “Yeni tasarım olarak aç” düzenlenebilir bir kopya oluşturur."],
    ["Native menus and settings", "Yerel menüler ve ayarlar"], ["File, Edit, View, Window and Help menus, an About dialog, general settings and native Save As for exports.", "Dosya, Düzen, Görünüm, Pencere ve Yardım menüleri; Hakkında penceresi, genel ayarlar ve dışa aktarımlar için yerel Farklı Kaydet."], ["Closing a project, the window or the app asks to save, discard or cancel when there are unsaved changes.", "Kaydedilmemiş değişiklikler varsa proje, pencere veya uygulama kapatılırken kaydetme, değişiklikleri silme ya da iptal seçenekleri sorulur."],
    ["A window that fits", "Ekrana sığan pencere"], ["The window opens at a size that fits the screen, or maximized on smaller screens.", "Pencere ekrana sığan boyutta açılır; küçük ekranlarda büyütülmüş olarak başlar."],
    ["Turkish and English interface", "Türkçe ve İngilizce arayüz"], ["General settings › Language, native menus included, and a Decimal separator setting.", "Genel ayarlar › Dil ile arayüzün ve yerel menülerin dilini seçin; Ondalık ayırıcı ayarı da bulunur."],
    ["Searchable example picker", "Aranabilir örnek seçici"], ["Find an example by name, with new 867 MHz collinear and Yagi examples.", "Yeni 867 MHz doğrusal dizi ve Yagi örnekleri dâhil, ada göre örnek bulun."],
    ["Validated results", "Doğrulanmış sonuçlar"], ["Checked against analytical results.", "Analitik sonuçlarla karşılaştırılmıştır."],
    ["Benchmarks on Mac and Windows", "Mac ve Windows performans ölçümleri"],
    ["Honest efficiency figures", "Güvenilir verimlilik değerleri"], ["Efficiencies above 100 % are flagged, and runs report the end criterion they reached.", "%100'ü aşan verimlilik değerleri işaretlenir; çalıştırmalar ulaştıkları durdurma ölçütünü bildirir."],
    ["A faster, steadier designer", "Daha hızlı ve kararlı tasarım aracı"], ["The 3D view reuses its geometry, and edits survive slow loads, saves and previews.", "3B görünüm geometriyi yeniden kullanır; yavaş yükleme, kaydetme ve önizleme sırasında düzenlemeler korunur."],
    ["Keyboard access", "Klavye erişimi"],
    ["Projects open reliably", "Projeler güvenilir biçimde açılır"], ["A preview arriving mid-load can no longer replace the project you asked for.", "Yükleme sırasında gelen önizleme artık açılmasını istediğiniz projenin yerini alamaz."],
    ["Faster meshing of detailed designs", "Ayrıntılı tasarımlarda daha hızlı mesh"],
    ["A quicker designer", "Daha hızlı tasarım aracı"],
    ["Large designs stay responsive", "Büyük tasarımlarda akıcı kullanım"],
    ["Horn efficiency", "Horn verimliliği"],
  ];

  pairs.push(
    ["The FDTD mesh is built from the geometry. In the dipole and patch checks, resonance differs from converged hand-tuned meshes by about 0.1% or less.", "FDTD meshi geometriden oluşturulur. Dipol ve yama denetimlerinde rezonans, elle ayarlanmış yakınsamış meshlerden elde edilen değerlerden yaklaşık %0,1 veya daha az sapar."],
    ["4 GPU runs", "4 GPU çalıştırması"],
    ["A 50-second introduction to Fairbeam.", "Fairbeam için 50 saniyelik tanıtım."],
    ["For macOS (Apple silicon) and Windows. The browser demo opens 20 simulated example projects, read-only.", "macOS (Apple silicon) ve Windows için. Tarayıcı demosunda simülasyonu yapılmış 20 örnek proje salt okunur olarak açılır."],
    ["Scroll through the patch model and its recorded simulation results.", "Yama modelini ve kaydedilmiş simülasyon sonuçlarını kaydırarak inceleyin."],
    ["The viewer reconstructs the model geometry: a 32 × 40 mm patch on a 1.524 mm substrate with εr 3.38, a ground plane and a 50 Ω probe feed.", "Görüntüleyici model geometrisini yeniden oluşturur: 1,524 mm kalınlığında, εr = 3,38 olan alttaş üzerinde 32 × 40 mm yama, toprak düzlemi ve 50 Ω sonda beslemesi."],
    ["Fine cells at patch edges and in the substrate, coarser cells in air: 69 × 69 × 58 mesh lines, about 264 k cells.", "Yama kenarlarında ve alttaşta ince, havada daha kaba hücreler: 69 × 69 × 58 mesh çizgisi, yaklaşık 264 bin hücre."],
    ["A Gaussian-derivative pulse excites the patch. The recorded surface current is strongest near the middle and decreases toward the radiating edges, consistent with the fundamental patch mode.", "Gauss türevi bir darbe yamayı uyarır. Kaydedilmiş yüzey akımı ortada daha güçlüdür ve temel yama moduyla uyumlu olarak ışıma yapan kenarlara doğru azalır."],
    ["The recorded |S11| minimum is −34.5 dB at 2.4525 GHz. The resonance is about 0.1% below the finer-mesh value of 2.4550 GHz. Export the model, Touchstone data, drawings, a report and preview fabrication files.", "Kaydedilmiş |S11| minimumu 2,4525 GHz’de −34,5 dB’dir. Rezonans, daha ince meshteki 2,4550 GHz değerinden yaklaşık %0,1 düşüktür. Modeli, Touchstone verilerini, çizimleri, raporu ve önizleme niteliğindeki üretim dosyalarını dışa aktarın."],
    ["Steer the beam using valid amplitude and phase weights at a recorded frequency, and export the combined pattern.", "Kaydedilmiş bir frekansta geçerli genlik ve faz ağırlıklarıyla demeti yönlendirin ve birleştirilmiş örüntüyü dışa aktarın."],
    ["Optional Metal and CUDA engines are available. In the documented patch benchmark, solver time was 1.6 s on Metal and 10.6 s on a four-thread CPU build on an M5 Pro; times depend on the model and runtime.", "İsteğe bağlı Metal ve CUDA motorları kullanılabilir. Belgelenmiş yama ölçümünde M5 Pro üzerinde çözücü süresi Metal ile 1,6 sn, dört iş parçacıklı CPU derlemesiyle 10,6 sn idi; süreler modele ve çalışma ortamına bağlıdır."],
    ["Twenty simulated projects come with the app and are listed in the browser demo.", "Uygulamayla birlikte simülasyonu yapılmış yirmi proje gelir ve bu projeler tarayıcı demosunda listelenir."],
    ["Free for macOS and Windows. First-time setup downloads Python, openEMS and dependencies for your user account without admin rights. Estimated download: about 120–155 MB; installed size is larger. Setup and updates need internet access.", "macOS ve Windows için ücretsizdir. İlk kurulum Python’u, openEMS’i ve bağımlılıkları yönetici yetkisi olmadan kullanıcı hesabınıza indirir. Tahmini indirme yaklaşık 120–155 MB’tır; kurulu boyut daha büyüktür. Kurulum ve güncellemeler için internet erişimi gerekir."],
    ["Imports supported commands from CST-compatible VBA macros and history lists, with a report of unsupported or changed operations. Review the report and imported model before running.", "CST uyumlu VBA makrolarından ve geçmiş listelerinden desteklenen komutları içe aktarır; desteklenmeyen veya değiştirilen işlemler için rapor sunar. Çalıştırmadan önce raporu ve içe aktarılan modeli inceleyin."],
    ["Dimensions and frequencies can use named parameters. Live checks explain detected problems and block known invalid setups, including designs without an excited port. Convergence still needs to be checked after running.", "Boyutlarda ve frekanslarda adlandırılmış parametreleri kullanabilirsiniz. Canlı denetimler saptanan sorunları açıklar ve uyarılan portu bulunmayan tasarımlar dahil bilinen geçersiz kurulumları engeller. Yakınsamayı çalıştırma sonrasında da denetleyin."],
    ["Mesh convergence studies refine automatic meshes and compare resonance, |S11| and Dmax against tolerances, stopping at convergence or the configured run limit. Also available through fairbeam converge.", "Mesh yakınsaması otomatik meshi inceltir; rezonansı, |S11| ve Dmax değerlerini toleranslarla karşılaştırır ve yakınsama sağlandığında veya ayarlanan çalıştırma sınırında durur. fairbeam converge komutuyla da kullanılabilir."],
    ["Run-quality warnings and one-click fixes flag common problems. With calibrated waveguide-port power, the horn example has about 99.3% raw radiation efficiency at 10 GHz; its lossless-normalized result is 100%.", "Çalıştırma kalitesi uyarıları ve tek tıkla düzeltmeler yaygın sorunları belirtir. Dalga kılavuzu port gücü kalibre edildiğinde horn örneğinin 10 GHz’de ham ışıma verimliliği yaklaşık %99,3’tür; kayıpsız modele göre normalleştirilmiş sonuç %100’dür."],
    ["Queue checked sweep sequences over up to six parameters and compare selected runs, up to eight at a time, in one plot.", "En çok altı parametreyi kapsayan denetlenmiş tarama dizilerini kuyruğa alın ve seçilen çalıştırmaları aynı grafikte, bir seferde en çok sekiz çalıştırma olacak şekilde karşılaştırın."],
    ["View directivity, gain, realized gain, polarization, currents and steered array patterns. Optional radiation and total efficiency curves are computed after the solver finishes; additional post-processing time depends on the model and frequency count.", "Yönlülüğü, kazancı, gerçekleşen kazancı, polarizasyonu, akımları ve yönlendirilmiş dizi örüntülerini görüntüleyin. İsteğe bağlı ışıma ve toplam verimlilik eğrileri çözücü tamamlandıktan sonra hesaplanır; ek işlem süresi modele ve frekans sayısına bağlıdır."],
    ["Optional openEMS GPU builds support Metal on Apple silicon and CUDA on NVIDIA GPUs under Windows. Documented patch solver times were 1.6 s versus 10.6 s on an M5 Pro and 2.6 s versus 52.9 s on a Ryzen 9 7900X with RTX 3060, using the recorded runtimes. GPU startup preference can be changed; CPU remains available.", "İsteğe bağlı openEMS GPU derlemeleri Apple silicon’da Metal’i, Windows’ta NVIDIA GPU’larda CUDA’yı destekler. Belgelenmiş yama çözücü süreleri, kaydedilmiş çalışma ortamlarıyla M5 Pro’da 1,6 sn ve 10,6 sn; RTX 3060’lı Ryzen 9 7900X’te 2,6 sn ve 52,9 sn idi. GPU başlatma tercihini değiştirebilirsiniz; CPU kullanılabilir durumda kalır."],
    ["Export a CST-compatible VBA macro for supported geometry and settings; check the reconstructed model in the target program. Export Touchstone, CSV, drawings, figures, a PDF report and preview fabrication files.", "Desteklenen geometri ve ayarlar için CST uyumlu VBA makrosu dışa aktarın; yeniden oluşturulan modeli hedef programda denetleyin. Touchstone, CSV, çizim, grafik, PDF raporu ve önizleme niteliğinde üretim dosyaları dışa aktarabilirsiniz."],
    ["For the documented same-timestep Windows CPU / macOS Metal comparisons, S-parameter magnitudes above −30 dB agree within 0.1 dB and Dmax within 0.004 dB. Other comparisons have different bounds; see the benchmark notes. The optional GPU engine is a separate beta fork of openEMS.", "Belgelenmiş, aynı zaman adımında duran Windows CPU / macOS Metal karşılaştırmalarında −30 dB üzerindeki S-parametresi büyüklükleri 0,1 dB, Dmax ise 0,004 dB içinde uyuşur. Diğer karşılaştırmaların sınırları farklıdır; performans ölçümü notlarını inceleyin. İsteğe bağlı GPU motoru openEMS’in ayrı bir beta çatalıdır."],
    ["For the recorded 100 Ω Wilkinson example, output match and isolation are −18.4 and −22.0 dB. Resistor checks agree within 0.1% in their tested range; the divider discrepancy remains unresolved. The documented branch-line output phase difference is 90.0° at 2.40 GHz, and the low-pass cutoff is 5.2% below the ideal-line model.", "Kaydedilmiş 100 Ω Wilkinson örneğinde çıkış uyumu ve yalıtım −18,4 ve −22,0 dB’dir. Direnç denetimleri, incelenen aralıkta %0,1 içinde uyuşur; bölücüdeki fark henüz açıklanmamıştır. Belgelenmiş dal kolu çıkış faz farkı 2,40 GHz’de 90,0°’dir; alçak geçiren kesim frekansı ideal hat modelinden %5,2 düşüktür."],
    ["Selected fabrication fixtures are parsed back and checked against their geometry to 1 µm. These preview exports are not fab-validated. Check each export in an independent viewer and review clearances, footprints and fabrication tolerances before ordering.", "Seçilmiş üretim dosyası örnekleri yeniden ayrıştırılır ve geometrileriyle 1 µm toleransla karşılaştırılır. Bu önizleme çıktıları üretimde doğrulanmamıştır. Sipariş vermeden önce her çıktıyı bağımsız bir görüntüleyicide denetleyin; açıklıkları, ayak izlerini ve üretim toleranslarını inceleyin."],
    ["The 100 Ω Wilkinson example has output match and isolation below the analytical expectation. Tested resistor fixtures agree within 0.1%; the remaining layout and mesh discrepancy needs further investigation.", "100 Ω Wilkinson örneğinin çıkış uyumu ve yalıtımı analitik beklentinin gerisindedir. Denenen direnç düzenekleri %0,1 içinde uyuşur; yerleşimden veya meshten kaynaklanabilecek kalan fark daha fazla inceleme gerektirir."],
    ["The managed macOS solver requires macOS 27+ on Apple silicon. Windows installers are not code-signed and may trigger SmartScreen. Linux currently uses a source setup with compatible openEMS and CSXCAD versions; see the tested configuration and limits.", "Yönetilen macOS çözücüsü Apple silicon üzerinde macOS 27 veya üstünü gerektirir. Windows kurulum dosyaları kod imzalı değildir ve SmartScreen uyarısı verebilir. Linux’ta şu anda uyumlu openEMS ve CSXCAD sürümleriyle kaynaktan kurulum kullanılır; denenmiş yapılandırmayı ve sınırlarını inceleyin."],
    ["The optional Metal engine reduced solver time in the documented benchmarks; agreement depends on the model and stopping settings.", "İsteğe bağlı Metal motoru belgelenmiş ölçümlerde çözücü süresini azalttı; sonuçların uyuşması modele ve durdurma ayarlarına bağlıdır."],
    ["Optional CUDA builds support NVIDIA GPUs under Windows; solver times depend on the model and runtime.", "İsteğe bağlı CUDA derlemeleri Windows’ta NVIDIA GPU’ları destekler; çözücü süreleri modele ve çalışma ortamına bağlıdır."],
    ["Preflight checks block known invalid setups and flag some convergence risks; check convergence after the run.", "Ön denetimler bilinen geçersiz kurulumları engeller ve bazı yakınsama risklerini belirtir; çalıştırma sonrasında yakınsamayı denetleyin."],
    ["Supported example-to-design conversions preserve recorded mesh lines. Review conversion limits and compare a new run before relying on equivalence.", "Desteklenen örnekten tasarıma dönüşümler kaydedilmiş mesh çizgilerini korur. Eşdeğerliğe güvenmeden önce dönüşüm sınırlarını inceleyin ve yeni bir çalıştırmanın sonuçlarını karşılaştırın."],
    ["A compatible GPU runtime is preferred when the GPU startup preference is enabled; the CPU engine remains available.", "GPU başlatma tercihi etkinse uyumlu bir GPU çalışma ortamı tercih edilir; CPU motoru kullanılabilir durumda kalır."],
    ["Refine the automatic mesh until the comparison meets tolerances or reaches the run limit; the study may report Not converged.", "Karşılaştırma toleransları sağlanana veya çalıştırma sınırına ulaşılana kadar otomatik meshi inceltin; sonuç Yakınsamadı olabilir."],
    ["Export supported geometry and settings as a CST-compatible VBA macro; verify the reconstructed model in the target program.", "Desteklenen geometri ve ayarları CST uyumlu VBA makrosu olarak dışa aktarın; yeniden oluşturulan modeli hedef programda doğrulayın."],
    ["Optional radiation and total efficiency curves are computed after the solver finishes, with additional post-processing time.", "İsteğe bağlı ışıma ve toplam verimlilik eğrileri çözücü tamamlandıktan sonra ek işlem süresiyle hesaplanır."],
    ["Proxy settings are supported, verified downloads are reused on retry, partial downloads restart, and the app manages the run-server process tree.", "Proxy ayarları desteklenir; yeniden denemede doğrulanmış indirmeler kullanılır, kısmi indirmeler baştan başlar ve uygulama çalıştırma sunucusunun işlem ağacını yönetir."],
    ["On Windows, uninstall removes owned application resources. Runtime data and settings remain unless you select Delete the application data; workspaces remain in either case.", "Windows’ta kaldırma işlemi uygulamaya ait kaynakları siler. Uygulama verilerini sil seçeneğini işaretlemezseniz çalışma ortamı verileri ve ayarlar korunur; çalışma alanları her iki durumda da korunur."],
    ["Examples open read-only with their results. Supported examples can be copied to an editable design; unsupported geometry is explained.", "Örnekler sonuçlarıyla birlikte salt okunur açılır. Desteklenen örnekleri düzenlenebilir tasarıma kopyalayabilirsiniz; desteklenmeyen geometri açıklanır."],
    ["Unsaved-change prompts offer Save, Discard or Cancel during supported close actions.", "Desteklenen kapatma işlemlerinde kaydedilmemiş değişiklikler için Kaydet, Değişiklikleri at veya İptal seçenekleri sunulur."],
    ["Fourteen reference examples have recorded Windows and macOS timings, with differences and limitations documented.", "On dört referans örnek için Windows ve macOS süreleri kaydedilmiştir; farklar ve sınırlar belgelenmiştir."],
    ["Keyboard navigation and shortcuts are available; see the documented keyboard controls and limitations.", "Klavye ile gezinme ve kısayollar kullanılabilir; belgelenmiş klavye denetimlerini ve sınırlarını inceleyin."],
    ["Automatic meshing uses indexed geometry processing for detailed polygon designs.", "Otomatik mesh oluşturma, ayrıntılı çokgen tasarımlarda indekslenmiş geometri işleme kullanır."],
    ["The designer includes improvements to loading, checking and saving.", "Tasarım aracı yükleme, denetleme ve kaydetme iyileştirmeleri içerir."],
    ["Geometry processing and asynchronous state handling have been optimized; responsiveness depends on design size and hardware.", "Geometri işleme ve eşzamansız durum yönetimi iyileştirilmiştir; yanıt süresi tasarım boyutuna ve donanıma bağlıdır."],
    ["The horn has about 99.3% raw efficiency at 10 GHz; its lossless-normalized result is 100%.", "Hornun 10 GHz’de ham ışıma verimliliği yaklaşık %99,3’tür; kayıpsız modele göre normalleştirilmiş sonuç %100’dür."],
    ["Unsaved-change prompts", "Kaydedilmemiş değişiklik uyarıları"],
    ["Model geometry", "Model geometrisi"],
    ["Simulation results and recorded solver times", "Simülasyon sonuçları ve kaydedilmiş çözücü süreleri"],
    ["The macOS app is signed with a Developer ID and notarized by Apple.", "macOS uygulaması Developer ID ile imzalanmış ve Apple tarafından doğrulanmıştır."],
    ["The managed macOS solver requires macOS 27+ on Apple silicon. Windows installers are not code-signed and may trigger SmartScreen. Linux currently uses a source setup with compatible openEMS and CSXCAD versions; see the tested configuration and limits. The macOS app is signed with a Developer ID and notarized by Apple.", "Yönetilen macOS çözücüsü Apple silicon üzerinde macOS 27 veya üstünü gerektirir. Windows kurulum dosyaları kod imzalı değildir ve SmartScreen uyarısı verebilir. Linux’ta şu anda uyumlu openEMS ve CSXCAD sürümleriyle kaynaktan kurulum kullanılır; denenmiş yapılandırmayı ve sınırlarını inceleyin. macOS uygulaması Developer ID ile imzalanmış ve Apple tarafından doğrulanmıştır."],
    ["Third-party licenses and trademark notices", "Üçüncü taraf lisansları ve marka bildirimleri"],
    ["Usage counts and sign-in are built but OFF in Fairbeam 0.7.0. No usage counts are recorded or sent, and no usage-consent dialog appears.", "Kullanım sayımı ve oturum açma hazırdır, ancak Fairbeam 0.7.0’da kapalıdır. Kullanım sayıları kaydedilmez veya gönderilmez ve kullanım onayı penceresi gösterilmez."],
    ["Update checks contact GitHub (fairbeam-releases). App and runtime downloads come from GitHub and upstream hosts. This website is hosted on Vercel. These services see your IP address and request data as any web server does; request-log retention is set by the hosting provider.", "Güncelleme denetimleri GitHub’a (fairbeam-releases) bağlanır. Uygulama ve çalışma ortamı indirmeleri GitHub’dan ve bileşenlerin kaynak sunucularından gelir. Bu web sitesi Vercel’de barındırılır. Bu hizmetler, diğer web sunucuları gibi IP adresinizi ve istek verilerini görür; istek günlüklerinin saklama süresini barındırma sağlayıcısı belirler."],
    ["Startup update checks can be disabled in General settings. On Windows, the WebView2 component follows Microsoft’s own diagnostic-data settings.", "Açılışta güncelleme denetimlerini Genel ayarlar bölümünden kapatabilirsiniz. Windows’ta WebView2 bileşeni, Microsoft’un kendi tanılama verisi ayarlarına tabidir."],
    ["Before any usage counting is enabled, a full notice will be published identifying the controller, purposes, processors, retention periods, rights and transfer arrangements. For privacy questions or rights requests, contact ismail@fairbeam.org. Do not post personal information in public issues.", "Herhangi bir kullanım sayımı etkinleştirilmeden önce veri sorumlusunu, amaçları, veri işleyenleri, saklama sürelerini, hakları ve aktarım düzenlemelerini açıklayan tam bir bildirim yayımlanacaktır. Gizlilik sorularınız veya haklarınıza ilişkin talepleriniz için ismail@fairbeam.org adresine yazın. Herkese açık konularda kişisel bilgi paylaşmayın."],
    ["Current release", "Mevcut sürüm"],
    ["The following describes the optional implementation, which would require an enabled build and your consent. It sends at most one report per UTC day for a previous day of use.", "Aşağıdaki açıklama, etkin bir derleme ve onayınızı gerektirecek isteğe bağlı uygulamayı anlatır. Önceki bir kullanım günü için UTC günü başına en fazla bir rapor gönderir."],
    ["Reports use a resettable, random pseudonymous install ID, not your name or account. The server replaces it with a keyed pseudonym that can link counts from the same installation across days.", "Raporlar adınız veya hesabınız yerine sıfırlanabilir, rastgele bir takma kurulum kimliği kullanır. Sunucu bunu, aynı kurulumun farklı günlerdeki sayılarını ilişkilendirebilen anahtarlı bir takma kimlikle değiştirir."],
    ["View what would be sent shows the report format; in Fairbeam 0.7.0 it is an example only and is not sent.", "Gönderilecekleri görüntüle seçeneği rapor biçimini gösterir; Fairbeam 0.7.0’da bu yalnızca bir örnektir ve gönderilmez."],
    ["An enabled report contains schema, install_id, app_version, os, arch, gpu_available, day and counters. The accepted fields and counter names are defined in the published report schema.", "Etkin bir rapor schema, install_id, app_version, os, arch, gpu_available, day ve counters alanlarını içerir. Kabul edilen alanlar ve sayaç adları yayımlanmış rapor şemasında tanımlanır."],
    ["Report schema", "Rapor şeması"],
    ["Field", "Alan"],
    ["Meaning", "Anlamı"],
    ["Report format version", "Rapor biçiminin sürümü"],
    ["Resettable random installation identifier", "Sıfırlanabilir rastgele kurulum kimliği"],
    ["Fairbeam version", "Fairbeam sürümü"],
    ["Operating system and processor type", "İşletim sistemi ve işlemci türü"],
    ["Whether the openEMS build has the GPU engine", "openEMS derlemesinde GPU motorunun bulunup bulunmadığı"],
    ["UTC day the counts describe", "Sayıların ait olduğu UTC günü"],
    ["Integer counts under the published names", "Yayımlanmış adlar altında tam sayı sayaçları"],
    ["App counts cover starts, new installs and updates, including the previous version. Started and finished simulations are grouped by engine and model source. Failed simulations are grouped by engine and error category, canceled simulations by engine, and refused runs by reason. Finished runs also count duration and cell-count ranges; error messages are excluded.", "Uygulama sayaçları açılışları, yeni kurulumları ve önceki sürüm bilgisiyle güncellemeleri kapsar. Başlayan ve tamamlanan simülasyonlar motor ve model kaynağına göre gruplandırılır. Başarısız simülasyonlar motor ve hata kategorisine, iptal edilenler motora, reddedilenler nedene göre sayılır. Tamamlanan çalıştırmaların süre ve hücre sayısı aralıkları da sayılır; hata iletileri dahil edilmez."],
    ["Other counters cover far-field, surface-current, efficiency and field-plane monitors; sweep size ranges and optimizer methods; VBA macro import and export, Touchstone export and PDF reports.", "Diğer sayaçlar uzak alan, yüzey akımı, verimlilik ve alan düzlemi monitörlerini; tarama boyutu aralıklarını ve optimizasyon yöntemlerini; VBA makrosu içe ve dışa aktarımını, Touchstone dışa aktarımını ve PDF raporlarını kapsar."],
    ["Optional usage reports — disabled", "İsteğe bağlı kullanım raporları — devre dışı"],
    ["Usage-report bodies exclude file names, design contents, model names, parameter names and values, paths, error messages, email addresses, user names, computer names and IP addresses. The receiving infrastructure still processes the source IP address and request metadata. The endpoint rejects fields and counters outside its published schema.", "Kullanım raporlarının gövdesi dosya adlarını, tasarım içeriğini, model adlarını, parametre adlarını ve değerlerini, yolları, hata iletilerini, e-posta adreslerini, kullanıcı adlarını, bilgisayar adlarını ve IP adreslerini içermez. Alıcı altyapı kaynak IP adresini ve istek üst verilerini yine de işler. Uç nokta, yayımlanmış şemasının dışındaki alanları ve sayaçları reddeder."],
    ["Report contents and network metadata", "Rapor içeriği ve ağ üst verileri"],
    ["If enabled, reports would be sent over HTTPS to fairbeam.org/api/ping on Vercel, and count records stored through GitHub in a configured repository. The intended purpose is aggregate product-usage analysis. Access permissions and processor arrangements must be restricted and documented before collection begins.", "Etkinleştirilirse raporlar HTTPS üzerinden Vercel’deki fairbeam.org/api/ping adresine gönderilecek ve sayı kayıtları GitHub üzerinden yapılandırılmış bir depoda saklanacaktır. Amaç, toplu ürün kullanım analizidir. Veri toplama başlamadan önce erişim izinleri sınırlandırılmalı, bu izinler ve veri işleme düzenlemeleri belgelenmelidir."],
    ["Count records exclude IP addresses and exact timestamps. Hosting logs and storage metadata may contain network and timing information. Provider log retention is set by the hosting provider; count-record retention and transfer arrangements will be specified in the full notice before activation.", "Sayı kayıtları IP adreslerini ve kesin zaman damgalarını içermez. Barındırma günlükleri ve depolama üst verileri ağ ve zaman bilgileri içerebilir. Sağlayıcı günlüklerinin saklama süresini barındırma sağlayıcısı belirler; sayı kayıtlarının saklama süreleri ve aktarım düzenlemeleri etkinleştirmeden önce tam bildirimde belirtilecektir."],
    ["Future processing and retention", "Gelecekteki işleme ve saklama"],
    ["If usage counting is enabled in a future release, Settings › General › Usage statistics › Off stops counting and deletes unsent counts. Reset id creates a new random identifier; it does not delete records already uploaded.", "Gelecekteki bir sürümde kullanım sayımı etkinleştirilirse Ayarlar › Genel › Kullanım istatistikleri › Kapalı seçeneği sayımı durdurur ve gönderilmemiş sayıları siler. Kimliği sıfırla seçeneği yeni bir rastgele kimlik oluşturur; önceden yüklenmiş kayıtları silmez."],
    ["Set FAIRBEAM_NO_TELEMETRY=1 in the environment used to launch Fairbeam. It overrides consent and other usage-count settings for that process.", "Fairbeam’i başlattığınız ortamda FAIRBEAM_NO_TELEMETRY=1 ayarlayın. Bu değişken, söz konusu işlem için onayı ve diğer kullanım sayımı ayarlarını geçersiz kılar."],
    ["Controls in an enabled build", "Etkin bir derlemedeki denetimler"],
    ["The website source includes no analytics scripts or cookie-setting code. Theme and language preferences, and the browser demo’s settings and any drafts, are stored locally in your browser. Vercel hosting infrastructure still processes your IP address and request data, with retention set by the hosting provider.", "Web sitesinin kaynak kodu analiz betikleri veya çerez oluşturan kod içermez. Tema ve dil tercihleriniz ile tarayıcı demosunun ayarları ve varsa taslaklar tarayıcınızda yerel olarak saklanır. Vercel barındırma altyapısı IP adresinizi ve istek verilerinizi yine de işler; saklama süresini barındırma sağlayıcısı belirler."],
    ["The website", "Web sitesi"],
    ["Privacy and usage statistics", "Gizlilik ve kullanım istatistikleri"],
    ["Privacy sections", "Gizlilik bölümleri"],
    ["Privacy and usage statistics · Fairbeam", "Gizlilik ve kullanım istatistikleri · Fairbeam"],
    ["Usage counts and sign-in are built but OFF in Fairbeam 0.7.0. Network requests, hosting and future optional usage reports.", "Kullanım sayımı ve oturum açma hazırdır, ancak Fairbeam 0.7.0’da kapalıdır. Ağ istekleri, barındırma ve gelecekteki isteğe bağlı kullanım raporları."],
    ["Design and simulate antennas with openEMS; optional GPU runtimes and preview fabrication exports are available.", "Antenleri openEMS ile tasarlayın ve simüle edin; isteğe bağlı GPU çalışma ortamları ve önizleme niteliğinde üretim çıktıları kullanılabilir."],
    [": install the app, create a patch antenna, run it and inspect the results.", ": uygulamayı kurun, yama anten oluşturun, çalıştırın ve sonuçları inceleyin."],
    ["Feature overview: modeling, simulation, exports, example projects and their simulated results.", "Özelliklere genel bakış: modelleme, benzetim, dışa aktarımlar, örnek projeler ve simülasyon sonuçları."],
    ["Feature overview", "Özelliklere genel bakış"],
    ["Feature overview, simulation results, recorded solver times and known limitations.", "Özelliklere genel bakış, simülasyon sonuçları, kaydedilmiş çözücü süreleri ve bilinen sınırlar."],
    ["Simulated examples from", "Simülasyon örnekleri:"],
    ["Curated feature roadmap. Availability refers to the stated release; future plans may change.", "Düzenlenmiş özellik yol haritası. Kullanılabilirlik belirtilen sürümü ifade eder; gelecek planları değişebilir."],
    ["Availability refers to the stated release; future plans may change.", "Kullanılabilirlik belirtilen sürümü ifade eder; gelecek planları değişebilir."],
    ["Twenty simulated projects come with the app and are listed in the browser demo. Six of them:", "Uygulamayla birlikte simülasyonu yapılmış yirmi proje gelir ve bu projeler tarayıcı demosunda listelenir. Altı örnek:"],
    ["Open all 20 examples in the demo", "20 örneği demoda açın"],
    ["0.43 M", "0,43 M"],
    ["2 evaluations", "2 değerlendirme"],
    ["3 evaluations", "3 değerlendirme"],
    ["4 evaluations", "4 değerlendirme"],
    ["Install the desktop app, create a patch antenna, run it and inspect the results.", "Masaüstü uygulamasını kurun, yama anten oluşturun, çalıştırın ve sonuçları inceleyin."],
    ["Recorded results and solver times for the historical set of 14 reference projects under Windows and macOS.", "Geçmişte karşılaştırılan 14 referans projenin Windows ve macOS altında kaydedilmiş sonuçları ve çözücü süreleri."],
    ["Tuning a model or a design towards goals: parameters, goals, algorithms, the output and simulated examples.", "Bir modeli veya tasarımı hedeflere göre ayarlama: parametreler, hedefler, algoritmalar, çıktılar ve simülasyon örnekleri."],
    ["openEMS lumped resistors simulated at the element, and where an apparent error in a test fixture comes from.", "openEMS toplu dirençlerinin eleman üzerindeki simülasyonu ve bir test düzeneğindeki görünür hatanın kaynağı."],
    ["Import settings, workspaces and Python models, review backups and remove the old app.", "Ayarları, çalışma alanlarını ve Python modellerini içe aktarın, yedekleri inceleyin ve eski uygulamayı kaldırın."],
    ["The isolation resistor went from the textbook 100 Ω to 73 Ω in the documented optimization; with all ports driven, 73 Ω gives S23 = −39.9 dB and every port matched below −24 dB.", "Belgelenmiş optimizasyonda yalıtım direnci ders kitabındaki 100 Ω’dan 73 Ω’a ayarlandı; portlar sırayla uyarıldığında 73 Ω için S23 = −39,9 dB ve portların yansıması −24 dB’nin altında elde edildi."],
  );

  const TEXT = new Map([...pairs, ...roadmapPairs].map(([en, tr]) => [normalize(en), tr]));
  const ATTRIBUTE_TEXT = new Map([
    ["Fairbeam, back to top", "Fairbeam, başa dönün"], ["English", "English"], ["Türkçe", "Türkçe"],
    ["S11 chart", "S11 grafiği"], ["Roadmap by state", "Duruma göre yol haritası"],
  ]);
  const META_TEXT = new Map([
    ["Fairbeam: antenna simulation with openEMS", "Fairbeam: openEMS ile anten simülasyonu"],
    ["Fairbeam is a desktop workbench for antennas, microstrip circuits and arrays: model them in a ribbon-based 3D designer or import a CST-compatible VBA macro, simulate with openEMS FDTD on the CPU or a Metal or CUDA GPU, then read S-parameters with markers, far fields and surface currents, sweep and optimize, and export Touchstone, drawings, reports and fabrication files.", "Fairbeam; antenler, mikroşerit devreler ve diziler için masaüstü çalışma ortamıdır. Şerit menülü 3B tasarım aracında modelleyin veya CST uyumlu VBA makrosu içe aktarın; CPU'da ya da Metal/CUDA GPU'da openEMS FDTD ile simülasyonunu çalıştırın. İşaretçili S-parametrelerini, uzak alanları ve yüzey akımlarını inceleyin; tarama ve optimizasyon yapın, Touchstone, çizim, rapor ve üretim dosyalarını dışa aktarın."],
    ["A ribbon-based 3D designer, VBA macro import, the openEMS FDTD solver on CPU or GPU, and results in one window: S-parameters with markers, far field, surface currents, sweeps, an optimizer and exports.", "Şerit menülü 3B tasarım aracı, VBA makrosu içe aktarma, CPU veya GPU üzerinde openEMS FDTD çözücüsü ve tek pencerede sonuçlar: işaretçili S-parametreleri, uzak alan, yüzey akımları, taramalar, optimizasyon aracı ve dışa aktarımlar."],
    ["Features · Fairbeam", "Özellikler · Fairbeam"],

    ["Roadmap · Fairbeam", "Yol haritası · Fairbeam"],

    ["Documentation · Fairbeam", "Belgeler · Fairbeam"],
    ["Fairbeam documentation: getting started with the desktop app, the designer, simulation, results and exports, Python models and the command line, building from source, and validation.", "Fairbeam belgeleri: masaüstü uygulamasıyla başlangıç, tasarım aracı, simülasyon, sonuçlar ve dışa aktarımlar, Python modelleri ve komut satırı, kaynaktan kurulum ve doğrulama."],
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
  const docLanguage = document.documentElement.dataset.docLanguage;
  const requestedLanguage = new URLSearchParams(location.search).get("lang");
  let choice = requestedLanguage === "en" || requestedLanguage === "tr" ? requestedLanguage
    : docLanguage === "tr" ? "tr" : readChoice();
  let language = choice === "system" ? systemLanguage() : choice;
  const textRecords = new WeakMap();
  const attrRecords = new WeakMap();
  // Text under data-i18n="off" stays in its source language; the nearest data-i18n
  // attribute decides, so a control inside such text can follow the site language with data-i18n="on".
  const excluded = (element) => !element || !!element.closest("script, style, noscript") || element.closest("[data-i18n]")?.getAttribute("data-i18n") === "off";

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
    const summary = /^(\d+) features available, (\d+) in development and (\d+) planned\. Availability refers to the stated release; future plans may change\. Updated$/.exec(key);
    if (language === "tr" && summary) value = `${summary[1]} özellik kullanılabilir, ${summary[2]} özellik geliştiriliyor, ${summary[3]} özellik planlandı. Kullanılabilirlik belirtilen sürümü ifade eder; gelecek planları değişebilir. Güncelleme:`;
    if (language === "tr" && key.startsWith("4 × 1 patch array · ") && key.endsWith(" GHz")) value = key.replace("4 × 1 patch array · ", "4 × 1 yama dizisi · ");
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

  function updateMetadata() {
    const titleElement = document.querySelector("title");
    const originalTitle = titleElement?.dataset.languageOriginal ?? document.title;
    if (titleElement) titleElement.dataset.languageOriginal = originalTitle;
    document.title = language === "tr" ? (META_TEXT.get(originalTitle) ?? TEXT.get(normalize(originalTitle)) ?? originalTitle) : originalTitle;
    for (const meta of document.querySelectorAll('meta[name="description"],meta[property="og:title"],meta[property="og:description"]')) {
      const original = meta.dataset.languageOriginal ?? meta.content;
      meta.dataset.languageOriginal = original;
      const translated = META_TEXT.get(original) ?? TEXT.get(normalize(original));
      meta.content = language === "tr" ? (translated ?? original) : original;
    }
  }

  function updateRoadmapDates() {
    document.querySelectorAll(".rm-intro time[datetime], #roadmap-board time[datetime]").forEach((element) => {
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
    if (docLanguage && docLanguage !== language) {
      const target = new URL(location.href);
      target.pathname = language === "tr"
        ? target.pathname.replace(/\/docs\//, "/docs/tr/")
        : target.pathname.replace(/\/docs\/tr\//, "/docs/");
      target.searchParams.set("lang", language);
      location.replace(target.href);
      return;
    }
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
