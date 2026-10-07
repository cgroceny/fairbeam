# Blender modeli ve render dışa aktarımı

**Geometriyi dışa aktar** menüsünü açın, **Blender render paketi** seçin ve ZIP dosyasını bir klasöre çıkarın. Windows'ta `Render.cmd` dosyasına çift tıklayın. Betik, Blender 4.2'yi varsayılan kurulum konumunda veya PATH üzerindeki `blender` komutuyla bulur. Düzenlenebilir bir `model.blend` projesi ve saydam arka planlı `render.png` oluşturur, ardından PNG'yi açar. Blender hata bildirirse komut penceresi inceleyip yeniden deneyebilmeniz için açık kalır.

macOS veya Linux'ta çıkardığınız klasörde şunu çalıştırın:


```sh
blender --background --threads 4 --python-exit-code 1 --python blender-render.py
```

`model.glb` dosyasını Blender'da **File → Import → glTF 2.0** yoluyla da içe aktarabilirsiniz. GLB; görünümdeki üçgenlenmiş katıları afin dönüşümleri, bileşen adları ve malzeme renkleriyle içerir. Fiziksel boyutlar metreye çevrilir; Fairbeam'in yukarı yönü Z olan koordinat sistemi glTF'nin Y-yukarı sistemine dönüştürülür, Blender içe aktarıcısı Z-yukarı yönünü geri getirir. Yaklaşık sınırlayıcı kutu geometrisi katı olarak dışa aktarılmaz; işlem reddedilir.

Paket model geometrisini içerir; simülasyon alan katmanları, portlar, ızgaralar ve seçimler dahil değildir. Düz metal bir yüzey olarak kalır. Renkler, bileşen için belirlenen renklerden veya geçerli temanın sahne malzeme renklerinden alınır. Render betiği ortografik kamera ve üç stüdyo ışığı ekler; dört iş parçacığı ve 16 örnekle CPU Cycles kullanır, 640 × 480 piksel çıktı üretir. Projeyi açtıktan sonra bu ayarları Blender'da değiştirebilirsiniz.

Dönüştürücü bulut hizmeti veya ek JavaScript bağımlılığı gerektirmez. Dışa aktarımı doğrulamak için:


```sh
node --experimental-strip-types scripts/check-blender-export.mjs
```

Yerel Blender temel testi için bu denetime bir çıktı klasörü vererek dönüştürülmüş bakır test modelinin GLB'sini ve render betiğini yazdırın. Test; dönüştürülmüş sınırları, metre ölçeğini, eksen dönüşümünü, bileşen adlarını, rengi, GLB yapısını ve desteklenmeyen yaklaşımların reddedilmesini doğrular.

API başvuruları: [Three.js GLTFExporter](https://threejs.org/docs/pages/GLTFExporter.html), [Blender komut satırından render](https://docs.blender.org/manual/en/4.2/advanced/command_line/index.html).

## Doğrudan mesh dosyaları

Doğrudan GLB çıktısı metre ve glTF Y-yukarı düzenini kullanır; malzeme renklerini, bileşen klasörlerini ve katı adlarını korur. Doğrudan ikili STL çıktısı **milimetre ve Z-yukarı** kullanır. STL'de standart birim, malzeme veya bileşen hiyerarşisi alanları yoktur; CAD yazılımına veya dilimleyiciye aktarırken milimetre seçin. Her iki biçim de gerçek dönüştürülmüş geometriyi üçgenler; simülasyon katmanlarını, ızgaraları ve portları içermez. STL yüzey normalleri dışa aktarılan köşelerden hesaplanır; yansımalı dönüşümlerde köşe sırası doğru tutulur.

Sıfır kalınlıklı metal yüzey olarak aktarılır; dışa aktarım kalınlık eklemez ve kapalı, yazdırılabilir bir model garanti etmez. Boş sahne, yaklaşık geometri, eksik üçgenleme, sonlu olmayan köşe değerleri ve tekil dönüşümler reddedilir. Bir katı başarısız olursa eksik dosya üretmek yerine tüm işlem başarısız olur. Sonlu float32 aralığına sığmayan STL koordinatları da reddedilir.

Render sırasında, aynı düzlemdeki başka bir yüze temas eden düz metal yüzeylere yalnızca render için etkin bir değiştiriciyle, diğer katının merkezinden dışarı doğru çok küçük bir normal kaydırma uygulanır. Böylece aynı düzlemdeki bakır ve alttaş yüzeyleri çakışmaz; görünümdeki derinlik kaydırmasıyla uyum sağlanır. Özgün mesh köşeleri, fiziksel boyutlar ve görünüm geometrisi değişmez; levhalara kalınlık eklenmez. `renderBiasMeters` özel özelliği işaretli düzeltmeyi kaydeder. Tam çakışan yüzeyleri render etmek için Blender'da **Fairbeam render surface bias** seçeneğini kapatabilirsiniz.

İkili yüzey yapısı, sınırlar, normaller, yansıma, fiziksel birimler, levhalar, GLB hiyerarşisi ve geçersiz geometrinin reddedilmesini denetlemek için `npm run check:mesh-export` çalıştırın. Blender doğrulaması için kart/yama/yansıtılmış besleme test modeli oluşturmak üzere:


```sh
node --experimental-strip-types scripts/check-mesh-export.mjs /path/to/output-folder
```

Klasör `model.glb`, `model-mm.stl` ve `blender-render.py` içerir. Render betiği yukarıda belirtilen sınırlı ayarlarla gerçek bir Blender projesi ve PNG yazar.

Bu modeli render ettikten sonra `model.blend` dosyasını `scripts/check-blender-model.py` ile arka plan modunda yeniden açın. Bu denetim; özgün levha köşelerini, tam sahne sınırlarını, klasör hiyerarşisini, kamera kapsamını ve yalnızca render için dışa doğru kaydırmaları kontrol eder, ardından aynı sınırlı ayarlarla `render-bottom.png` oluşturur. Yalnızca yerel simülasyon çalışmıyorken çalıştırın.
