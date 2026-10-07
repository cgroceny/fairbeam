# Usage and download counts

Usage counting remains OFF in default builds (`default = []` in Cargo.toml). This change prepares an opt-in implementation; it does not enable collection. Review the draft legal notices with a lawyer and verify processor arrangements before activation.

## Download counts

Run `node scripts/stats-summary.mjs --releases-only`. Public GitHub REST data from `ismailakdag/fairbeam-releases` needs no token or login; all release pages are read. The script sums asset `download_count` per version and platform, showing update metadata, signatures/checksums and other assets separately. Installer and update assets are combined within a platform. Downloads are requests, not unique people or installs; retries and updates can increase totals. This requires no app change or opt-in usage reports.

## Minimal report and consent

```json
{"schema":"fairbeam.ping/2","app_version":"0.7.0","os":"macos","arch":"aarch64"}
```

Only these four fields are sent. There is no install ID, GPU flag, client date, feature counter or Python counting hook. In an enabled desktop build, the dialog asks once; No or dismissing it records denial. Until consent is granted, nothing is sent. Settings › General › Usage statistics can withdraw or grant consent at any time. `FAIRBEAM_NO_TELEMETRY=1` overrides consent. Browser/demo usage sends nothing.

The local telemetry `state.json` contains only `consent` and `last_sent` (Unix seconds, the last request date). A request is attempted at most once per seven elapsed days while the app is open. The date is saved before transmission; failures also wait seven days. Clock rollback delays sending. Toggling consent does not reset the date. An empty `state.lock` file holds an OS lock (Rust 1.89 or later); it stores no report data. Sending and consent changes share this lock across app processes and a process mutex, so no request can start after withdrawal completes. HTTP redirects are disabled. The compiled-out build has no telemetry HTTP client and does not read or write telemetry state. Enabled builds discard previous identifiers and counter files and require fresh consent for the new report.

## API and retention

`api/ping.js` is disabled without `STATS_GITHUB_TOKEN`. Set `STATS_REPO=owner/repository` (prefer a restricted repository) and optionally `STATS_BRANCH` (default `main`). Scope the token to that repository's Contents write access. No salt is used. No payload, IP address, user agent or exception details are logged by the handler. Provider infrastructure logging is separate and must be reviewed before deployment; do not claim providers retain no logs.

The handler validates size, content type, fields and values. Old schemas remain accepted for compatibility, but their identifier, GPU flag, date and counters are discarded before storage. They contribute one report to the receiving week's total, so older clients may inflate totals. The only persisted records are `data/YYYY-Www--version--os--arch.json`, containing `week`, `app_version`, `os`, `arch`, `count`. GitHub SHA conflicts are retried; storage errors return 503. Git history contains aggregate totals only. Fairbeam creates no raw event log. Aggregates are retained without a scheduled deletion date.

Without identifiers, the API cannot deduplicate retries, enforce a per-install rate limit or measure unique installations. The weekly restriction is local, and the public API can receive fabricated reports. Use totals only as approximate platform usage. Restrict repository access; if any previous raw logs exist, remove them and their history/backups before activation under a reviewed retention process.

Read aggregates with `node scripts/stats-summary.mjs --dir /path/to/stats/data --no-releases`, or `node scripts/stats-summary.mjs --gh --repo owner/repository --no-releases` (private repository access needs gh authentication). Historical raw `.jsonl` logs are not read.

## Verification

`npm run check:telemetry` tests API validation and aggregate storage, release totals and pagination, and the Rust scheduling core in a temporary crate without building the desktop app. For the consent and Settings flows, run `FAIRBEAM_USAGE_URL=http://127.0.0.1:5353 node scripts/check-telemetry-ui.mjs` against an existing dev server. It uses a fake native bridge and saves English/Turkish screenshots to `/tmp`.

## Draft notices for legal review

The English and Turkish notices below match the optional usage section on [the privacy page](https://fairbeam.org/privacy.html#collected). This is draft text for the maintainer to review with a lawyer, not an assertion of compliance. In particular, recurring weekly overseas requests need a valid transfer mechanism; the current KVKK Article 9 consent exception for incidental transfers may not apply.

### English

If you turn on usage counts

Draft KVKK information notice and GDPR-style privacy notice. The maintainer must review this text with a lawyer before enabling usage counts.

Controller: İsmail Akdağ. Contact: ismail@fairbeam.org.

Purpose: estimate installations using each version and operating system to prioritize platform support. Totals count reports, not unique people or verified installations.

Data and collection: with your explicit consent, the desktop app sends only the report schema, app version, operating system and CPU architecture over HTTPS to fairbeam.org/api/ping, at most once every seven days. No install ID, account, feature counters, designs, files or paths are sent.

The hosting provider transiently processes your IP address to deliver the request. Fairbeam does not store IP addresses or user agents. Provider infrastructure may keep its own request logs under its policies; this draft does not promise that providers keep no logs.

Legal basis: explicit consent under KVKK Article 5 and consent under GDPR Article 6(1)(a), where applicable. Sharing is optional and does not affect app functionality. Choose Off in Settings › General › Usage statistics to withdraw at any time. Withdrawal stops future requests without affecting the lawfulness of earlier processing.

Recipients and processors: Vercel hosts the website and usage API; GitHub hosts releases, updates and the aggregate statistics repository. Only aggregate counts reach the repository. Their roles, contracts and infrastructure logging must be confirmed before activation.

International transfer: requests are delivered to servers outside Türkiye. This draft proposes explicit consent for the transfer under KVKK Article 9, with information about the risks of transfer without an adequacy decision or appropriate safeguards. The current Article 9 consent exception is limited to incidental transfers; recurring weekly requests may not qualify. Counsel must establish a valid transfer mechanism under KVKK and, where applicable, GDPR Chapter V before activation. No valid mechanism is asserted by this draft.

Retention: Fairbeam keeps aggregate totals by UTC week, version, operating system and architecture for platform planning, without a scheduled deletion date. No raw event log is created. Locally, only the consent choice and last request date are stored for usage counting; that date also limits retries after failures.

Rights: KVKK Article 11 includes learning about processing, its purpose and recipients, seeking correction or deletion, notification to recipients, objecting to adverse automated decisions and seeking compensation for unlawful processing. GDPR Articles 15–21 provide access, rectification, erasure, restriction, portability and objection where applicable. There are no automated decisions based on usage reports.

To exercise your rights, write to ismail@fairbeam.org with your request. Do not send designs or post personal information in public issues. Reasonable identity verification may be needed. Totals have no installation identifier, so a particular installation’s contribution cannot be located or removed. You may complain to the KVKK Kurulu or your EU supervisory authority, subject to applicable procedures.

### Türkçe — taslak aydınlatma metni

Kullanım sayımını açarsanız

Taslak KVKK aydınlatma metni ve GDPR kapsamında gizlilik bildirimi. Kullanım sayımı etkinleştirilmeden önce proje sorumlusu bu metni bir avukatla incelemelidir.

Veri sorumlusu: İsmail Akdağ. İletişim: ismail@fairbeam.org.

Amaç: platform desteğine öncelik vermek için her sürümün ve işletim sisteminin kullanıldığı kurulumları yaklaşık olarak saymak. Toplamlar, tekil kişileri veya doğrulanmış kurulumları değil, raporları sayar.

Veriler ve toplama yöntemi: açık rızanızla masaüstü uygulaması HTTPS üzerinden fairbeam.org/api/ping adresine en fazla yedi günde bir yalnızca rapor şemasını, uygulama sürümünü, işletim sistemini ve işlemci mimarisini gönderir. Kurulum kimliği, hesap, özellik sayaçları, tasarımlar, dosyalar veya yollar gönderilmez.

Barındırma sağlayıcısı isteği iletmek için IP adresinizi geçici olarak işler. Fairbeam IP adreslerini veya kullanıcı aracısı bilgilerini saklamaz. Sağlayıcı altyapısı kendi politikaları kapsamında istek günlükleri tutabilir; bu taslak sağlayıcıların hiç günlük tutmadığını taahhüt etmez.

Hukuki sebep: KVKK’nın 5. maddesi uyarınca açık rıza ve uygulanabildiği ölçüde GDPR’nin 6(1)(a) maddesi uyarınca rıza. Paylaşım isteğe bağlıdır ve uygulamanın işlevlerini etkilemez. Rızanızı dilediğiniz zaman geri almak için Ayarlar › Genel › Kullanım istatistikleri bölümünde Kapalı seçeneğini seçin. Rızanın geri alınması önceki işlemenin hukuka uygunluğunu etkilemeden gelecekteki istekleri durdurur.

Alıcılar ve veri işleyenler: Vercel web sitesini ve kullanım API’sini; GitHub sürümleri, güncellemeleri ve toplu istatistik deposunu barındırır. Depoya yalnızca toplu sayılar ulaşır. Tarafların rolleri, sözleşmeleri ve altyapı günlükleri etkinleştirmeden önce doğrulanmalıdır.

Yurt dışına aktarım: istekler Türkiye dışındaki sunuculara iletilir. Bu taslak, yeterlilik kararı veya uygun güvenceler olmadan aktarımın riskleri hakkında bilgilendirmeyle KVKK’nın 9. maddesi kapsamında aktarım için açık rıza alınmasını önerir. Güncel 9. maddedeki rıza istisnası arızi aktarımlarla sınırlıdır; haftalık tekrarlanan istekler bu kapsama girmeyebilir. Etkinleştirmeden önce bir avukat KVKK ve uygulanabildiği ölçüde GDPR’nin V. Bölümü kapsamında geçerli bir aktarım mekanizması belirlemelidir. Bu taslak geçerli bir mekanizma bulunduğunu ileri sürmez.

Saklama: Fairbeam platform planlaması için UTC haftası, sürüm, işletim sistemi ve mimariye göre toplu sayıları belirlenmiş bir silme tarihi olmadan saklar. Ham olay günlüğü oluşturulmaz. Kullanım sayımı için yerelde yalnızca rıza tercihi ve son istek tarihi saklanır; bu tarih başarısız isteklerden sonraki yeniden denemeleri de sınırlar.

Haklar: KVKK’nın 11. maddesi kapsamında işleme, amaç ve alıcılar hakkında bilgi edinme, düzeltme veya silme isteme, alıcılara bildirim, aleyhinize otomatik kararlara itiraz ve hukuka aykırı işleme nedeniyle zararınızın giderilmesini talep etme hakları bulunur. GDPR’nin 15–21. maddeleri, uygulanabildiği ölçüde erişim, düzeltme, silme, kısıtlama, taşınabilirlik ve itiraz hakları sağlar. Kullanım raporlarına dayalı otomatik karar alınmaz.

Haklarınızı kullanmak için talebinizi ismail@fairbeam.org adresine iletin. Tasarım göndermeyin veya herkese açık konularda kişisel bilgi paylaşmayın. Makul bir kimlik doğrulaması gerekebilir. Toplamlarda kurulum kimliği bulunmadığından belirli bir kurulumun katkısı bulunamaz veya çıkarılamaz. Geçerli usuller kapsamında KVKK Kuruluna veya AB’deki denetim makamınıza şikâyette bulunabilirsiniz.

### Short consent copy (English / Türkçe)

With your explicit consent, send only the app version, operating system, CPU architecture and report schema at most once every seven days to estimate platform usage.

Açık rızanızla platform kullanımını yaklaşık olarak saymak için en fazla yedi günde bir yalnızca uygulama sürümünü, işletim sistemini, işlemci mimarisini ve rapor şemasını gönderin.

No install ID, feature counters, designs or files. The hosting provider processes your IP address to deliver the request; Fairbeam stores neither IP addresses nor user agents. Only weekly aggregate totals are retained.

Kurulum kimliği, özellik sayaçları, tasarımlar veya dosyalar gönderilmez. Barındırma sağlayıcısı isteği iletmek için IP adresinizi işler; Fairbeam IP adreslerini veya kullanıcı aracısı bilgilerini saklamaz. Yalnızca haftalık toplu sayılar saklanır.

Controller: İsmail Akdağ (ismail@fairbeam.org). Vercel hosts the API; GitHub stores aggregates. Requests go to servers outside Türkiye. The draft privacy notice describes the proposed consent-based transfer and the legal review needed before activation.

Veri sorumlusu: İsmail Akdağ (ismail@fairbeam.org). API Vercel’de barındırılır; toplu sayılar GitHub’da saklanır. İstekler Türkiye dışındaki sunuculara gider. Taslak gizlilik bildirimi, önerilen rızaya dayalı aktarımı ve etkinleştirmeden önce gereken hukuki incelemeyi açıklar.

Optional and off by default. Withdraw consent at any time in Settings › General › Usage statistics › Off. This stops future requests; earlier aggregate totals cannot be linked to your installation.

İsteğe bağlıdır ve varsayılan olarak kapalıdır. Rızanızı dilediğiniz zaman geri almak için Ayarlar › Genel › Kullanım istatistikleri › Kapalı seçeneğini seçin. Bu işlem gelecekteki istekleri durdurur; önceki toplu sayılar kurulumunuzla ilişkilendirilemez.

### Review sources

- [KVKK law, including Articles 5, 9 and 11](https://www.kvkk.gov.tr/Icerik/6649/Personal-Data-Protection-Law).
- [GDPR regulation, including Articles 6 and 15–21 and Chapter V](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng).
