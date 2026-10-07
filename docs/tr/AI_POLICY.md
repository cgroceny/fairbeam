# Yapay zekâ politikası

Fairbeam, yapay zekâ kodlama yardımcılarıyla geliştirilmektedir; yapay zekâ desteğiyle hazırlanan katkılara da açıktır. Bu sayfa, projede yapay zekânın nasıl kullanıldığını ve bu araçları kullanan katkıcılardan neler beklendiğini açıklar.

## Fairbeam nasıl geliştiriliyor?

- **Yönlendirmeyi proje sorumlusu yapar.** Fairbeam'in bakımını [İsmail Akdağ](https://akdag.dev) üstlenir; nelerin geliştirileceğine ve hangi değişikliklerin birleştirileceğine karar verir.
- **Çalışmanın önemli bir bölümü yapay zekâ desteklidir.** Kodun, testlerin ve belgelerin büyük bölümü yapay zekâ kodlama yardımcılarıyla yazılır. Bu şekilde hazırlanan commit'lerde modelin adını belirten bir `Co-Authored-By:` satırı bulunur.
- **Her değişiklik birleştirilmeden önce kontrol edilir.** Deponun otomatik denetimlerinden (`npm run check:*`, Python test paketi) geçer ve incelenir. Kullanıcıya yansıyan değişiklikler uygulamada da denenir.
- **Sayısal sonuçlar modellerin söylediklerine değil, çalıştırmalara dayanır.** Belgelerdeki sonuçlar, doğrulama değerleri ve süreler, herkesin tekrarlayabileceği simülasyonlardan elde edilir. Proje paketi, üreticiyi, sürümleri ve çalıştırma ayarlarını kaydeder. Bir yapay zekâ modelinin ifadesi hiçbir zaman kanıt sayılmaz.
- **Depodaki ve sürümlerdeki her şeyin sorumluluğu proje sorumlusundadır;** içeriği kimin veya neyin yazdığı bunu değiştirmez.

## Yapay zekâ desteğiyle katkıda bulunma

Uygun gördüğünüz herhangi bir yapay zekâ aracını veya modelini kullanabilirsiniz. Kullanıyorsanız:

1. **Çekme isteğinde bunu belirtin.** Aracı ve modeli adlandırın; kod, test veya metin mi yazdığını, yoksa yalnızca inceleme veya açıklama mı yaptığını belirtin. Çekme isteği şablonu bu bilgiyi ister.
2. **Test edin.** İlgili denetimleri çalıştırın; ne çalıştırdığınızı ve ne gözlemlediğinizi yazın. Fizik veya sayısal yöntem değişikliklerinde tekrarlanabilir bir karşılaştırma ekleyin: model, ayarları ve değişiklik öncesi ile sonrası sonuçlar.
3. **Kapsamı dar tutun.** Her çekme isteği tek bir konuyu ele alsın. İncelenmemiş büyük yeniden yazımlar, toplu biçim değişiklikleri ve topluca üretilen ilgisiz “iyileştirmeler” kapatılır.
4. **Lisanslara ve veri haklarına uyun.**
   - Fairbeam, GPL-3.0-or-later lisanslıdır. Uyumsuz bir lisansa sahip üçüncü taraf kodunu yeniden üreten kod göndermeyin.
   - Lisanslı ticari yazılımlardan dışa aktarılan sonuçlar, özel ölçümler veya başkalarının tasarımları gibi paylaşma hakkınız olmayan verileri göndermeyin.
   - Başkalarının özel bilgilerini yapay zekâ araçlarına yapıştırmayın.
5. **Yayımladığınız içeriği kontrol edin.** Yapay zekânın sizin için yazdığı her sorun kaydını, yorumu ve incelemeyi yayımlamadan önce okuyun. Otomatik veya toplu üretilen sorun kayıtları, yorumlar ve çekme istekleri kapatılır.

Proje sorumluları, bu kurallara uymayan katkıları kapatabilir ve incelemeden önce değişiklik isteyebilir. Bu depoda çalışan kodlama yardımcıları ayrıca [AGENTS.md](AGENTS.md) dosyasını okur.

## Güvenlik

Güvenlik sorunlarını herkese açık bir sorun kaydında değil, proje sorumlusuna özel olarak bildirin. İletişim bilgileri <https://akdag.dev> adresindedir.
