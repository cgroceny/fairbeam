# Fairbeam'e katkıda bulunma

Yardımınız için teşekkür ederiz. Hata bildirimleri, belge düzeltmeleri, modeller, testler ve kod katkıları kabul edilir.

## Sorun bildirme

Uygulamada **Yardım › Sorun bildir** seçeneğini kullanın veya [fairbeam-releases](https://github.com/ismailakdag/fairbeam-releases/issues) deposunda bir sorun kaydı açın. Uygulamadaki formlar sürüm ve işletim sistemi bilgilerini doldurur. Mümkünse tasarım dosyasını veya modeli ekleyin.

## Çekme istekleri

1. Küçük bir düzeltmeden daha kapsamlı değişikliklerde, yaklaşım üzerinde anlaşabilmek için önce bir sorun kaydı açın.
2. Depoyu [docs/FROM-SOURCE.md](docs/FROM-SOURCE.md) belgesindeki gibi hazırlayın. Windows için [docs/WINDOWS.md](docs/WINDOWS.md) belgesine bakın.
3. Her çekme isteğini tek konuyla sınırlayın; değiştirdiğiniz davranış için bir denetim ekleyin veya mevcut denetimi genişletin. Depoda `scripts/check-*.mjs` altında betik denetimleri, `python/tests` altında Python testleri bulunur.
4. Değişiklikleri göndermeden önce en az şu komutları çalıştırın:
   ```bash
   npm run typecheck
   npm run check:legal
   npm run check:exports
   cd python && python -m unittest discover -s tests   # if you touched Python
   ```
   Ardından dosyalarınızı kapsayan `npm run check:*` betiklerini çalıştırın (`package.json` dosyasına bakın).
5. İngilizce ve Türkçe arayüz metinlerini eş zamanlı güncelleyin (`src/i18n/en.json` ve `tr.json`).
6. Çekme isteğinde neyi değiştirdiğinizi, nasıl test ettiğinizi ve yapay zekâ desteği kullanıp kullanmadığınızı belirtin. Beklentiler [yapay zekâ politikasında](AI_POLICY.md) açıklanır.

## Temel kurallar

- **Tescilli simülatörlerle performans karşılaştırması yapmayın.** Fairbeam'in CST uyumlu VBA makrolarına yaptığı atıflar yalnızca dosya uyumluluğunu belirtir. Tescilli simülatörlerle doğruluk veya hız karşılaştırmaları, bu simülatörlerin ürettiği veriler veya Fairbeam'i bunlardan biri örnek alınarak geliştirilmiş gibi gösteren ifadeler eklemeyin. Bunun yerine analitik referanslar ve açık araçlarla doğrulama yapın. `npm run check:legal`, yaygın ifadeleri denetler.
- **Lisans.** Katkıda bulunarak katkınızın projenin lisansı olan GPL-3.0-or-later kapsamında lisanslanmasını kabul edersiniz.
