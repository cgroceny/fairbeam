# Görünümü özelleştirme

Genel ayarlar → Tema ve yazı tipi, arayüz yüzeyleri için beş hazır ayar sunar: Mevcut, Okyanus, Orman, Erik ve Yüksek kontrast. Vurgu rengi bağımsızdır (Bakır, Mavi, Yeşil mavi, Mor). Grafik kontrollerinden ortak sekiz seri paletini ve çizgi kalınlığını (1,5; 2 veya 3) seçebilirsiniz. Görünüm kontrollerinden arka plan ve ızgara paletini seçebilirsiniz.

Vurgu, birincil grafik çizgisi, görünüm arka planı veya ızgara rengini değiştirmek için Özel renkler bölümünü genişletin. Seçili hazır ayara dönmek için ilgili özel rengi kapatın. Özel vurgu renginde düğme metni okunaklı kontrast için siyah veya beyaz olur; özel çizgi ve ızgara renklerini siz seçersiniz, bu nedenle arka planda görünür kalan renkler kullanın. Bu kontroller ortak görüntüleme değerlerini etkiler; geometriyi, malzemeleri, simülasyon girdilerini veya dışa aktarılan model verilerini değiştirmez.

Seçimler, açık/koyu tema değişimleri de dahil olmak üzere yerel olarak saklanır. Saklanan veya içe aktarılan ayarlar yalnızca desteklenen seçenek değerlerini ve altı basamaklı onaltılık renkleri kabul eder. Geçersiz görünüm alanları, geçerli genel ayarları silmeden birbirinden bağımsız olarak varsayılanlarına döner.

Üst çubuk ve Ayarlar bölümündeki tema kontrolleri eşzamanlı kalır: grafik veya görünüm seçeneğini değiştirmek, yeniden başlatmada eski bir temayı geri getirmez. Daha güçlü kontrast ve Yumuşak renkler grafik paletleri açık modda daha güçlü çizgi kontrastı sunar. Özgün varsayılan açık palet, üçüncü, dördüncü ve beşinci çizgi renklerinin daha düşük kontrastı da dahil olmak üzere bilinçli olarak korunmuştur.

Her hazır ayar satırının ayrı bir sıfırlama kontrolü vardır. Özel renkleri, ilgili özel renk seçeneğini kapatarak ayrı ayrı sıfırlayabilirsiniz. Görünümü sıfırla, temayı ve yazı tiplerini de sıfırlar. Varsayılan Mevcut/Bakır ayarları, mevcut grafik/görünüm paletleri, 2 kalınlığı, kapalı özel renkler ve Plex yazı tipleri özgün stil değerlerini değiştirmez.

Doğrulama: `node --experimental-strip-types scripts/check-appearance-presets.mjs`, mevcut genel ayarlar/i18n/tür denetimleri ve dar görünümde İngilizce ve Türkçe S13 tarayıcı senaryosu.
