# Saklanan ham veriden uzak alan hesabı

Normal bir çalıştırma, yakın alandan uzak alana dönüşüm (NF2FF) için ham E/H kayıtlarını
saklayabilir. Daha sonra FDTD yeniden çalıştırılmadan ek frekanslar hesaplanır. Saklama
isteğe bağlıdır ve varsayılan olarak kapalıdır. Model, mesh, faz merkezi ve çalışma ortamı
özgün kayıtla sabit kalır. Bu işlem yeni bir simülasyon veya yakınsama doğrulaması değildir.

## Tasarımcı ve görüntüleyici

Çalıştır penceresinde **Ek uzak alanlar için ham verileri sakla** seçeneğini etkinleştirin.
Önce Simülasyon ayarlarında uzak alan izleyicisi açık olmalıdır. Ham kayıtlar diskte önemli
miktarda yer kullanabilir.

Tamamlanan sonucun Işınım görünümünde **Ek uzak alan frekansları** bölümünü açın. Frekansları
GHz cinsinden virgülle ayırın; ondalık ayırıcı nokta olsun. Açı adımlarını derece cinsinden
girin. Aynı çalışma alanında bilinen, tamamlanmış ve ham verisi saklanmış kaynak iş gerekir.
İçe aktarılan dosya veya gerekli kaydı olmayan eski sonuç için yeniden çalıştırma açıklaması
gösterilir. Dönüşüm ayrı bir iş ve sonuç oluşturur; özgün sonucu değiştirmez.

## Komut satırı

```sh
fairbeam run model.design.json --name retained-example --retain-nf2ff --out results --sim-root raw
```

Tamamlanan çalıştırma ham klasörü ve manifest SHA-256 kimliğini yazdırır. Bu makbuzu saklayın.
Son işlem frekanslarını Hz cinsinden verin:

```sh
fairbeam farfield raw/retained-example --manifest-sha256 ORIGINAL_MANIFEST_SHA256 --frequency 2.4e9,2.45e9 --output results/additional-farfield.json
```

`--theta-step` ve `--phi-step` derece kullanır; varsayılanları 3 ve 5'tir. En çok 16 frekans,
frekans başına 65.536 ve uyarılan port başına toplam 262.144 açısal hücre kabul edilir.
Çıktı ham kaynak klasörünün dışında yeni bir `.json` dosyası olmalıdır. Kaynak veya önceki
türetilmiş sonuç üzerine yazılmaz.

Zaman alanı kayıtları özgün uyarım bandı ve örnekleme sınırı içindeki frekansları kabul eder.
Frekans alanı kayıtları yalnızca gerçekten kaydedilen frekansları destekler. Küçük açı adımı
özgün mesh veya alan yakınsamasını iyileştirmez. Eksik ya da değişmiş veri yeniden çalıştırma
gerektirir; eski rastgele ham klasörler otomatik olarak sahiplenilmez.

## Kaynak kimliği ve sınırlamalar

Manifest tam girdi baytlarını, çözümlenmiş parametreleri, özgün sonuç baytlarını, tam mesh'i,
ham E/H dosyalarını ve çalışma ortamı kimliğini bağlar. Dönüşümden önce ve sonra dosya
hash'leri doğrulanır. Dosyayı taşımak, değiştirmek veya silmek bu olanağı kaldırır.
`clean-sim` ve iş silme işlemleri etkin dönüşümün kaynak verisini korur.

Yalnızca `results.farfield` değiştirilir. Ağ verileri, gömülü eleman örüntüleri, verim taramaları,
özgün çalıştırma ve gereksinim kayıtları kaynaklarına bağlı kalır. Yeni frekanstaki port gücü
özgün taramadan doğrusal ara değerleme kullanır ve bu durum sonuçta belirtilir. Kazanç, özgün
simülasyonun sınırlarını taşır; yeni fiziksel doğrulama iddiası oluşturmaz.

API uçları ve ayrıntılı dosya sahipliği kuralları [İngilizce kılavuzdadır](../NF2FF-POSTPROCESS.md).
