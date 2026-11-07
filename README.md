# ZIR ZIR – FC 27 ELO Ligi

FC 27 oynayan arkadaş grubu için ELO sıralama sitesi. Karanlık, neon yeşil, Ultimate Team kartlı tasarım; masaüstü ve telefonda çalışır.

## Çalıştırma

Gereksinim: **Node.js 22.13+** (harici paket yok; veritabanı Node'un yerleşik SQLite'ı).

```bash
npm start            # http://localhost:3000
npm test             # ELO motoru + API testleri
```

Ortam değişkenleri:

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `3000` | Sunucu portu |
| `DB_FILE` | `./data/zirzir.db` | SQLite dosyası (kalıcı diskte olmalı) |
| `ADMIN_CODE` | — | Verilirse yönetici kodunu değiştirir (özeti saklanır) |
| `TRUST_PROXY` | — | Ters proxy arkasındaysa `1` (deneme sınırı gerçek IP'yi görsün) |

Docker:

```bash
docker build -t zirzir .
docker run -p 3000:3000 -v zirzir-data:/data zirzir
```

## Kullanım

1. **Ayarlar** → yönetici kodunu gir → oyuncuları ekle (herkes 1000 ELO ile başlar).
2. **Maç Ekle** → iki oyuncuyu seç → kazananı (veya beraberliği) seç → Kaydet. Skor isteğe bağlıdır; girilirse sonuç otomatik seçilir. Butonlarda olası puan değişimi önceden görünür.
3. Sıralama, podyum, profiller ve maç geçmişi bütün açık tarayıcılarda anında güncellenir (Server-Sent Events + 30 sn yedek yoklama).

## ELO sistemi

- Beklenen skor standart Elo: `E = 1 / (1 + 10^((Rb − Ra) / 400))`, değişim `K × (S − E)`.
- **K faktörü** (yükseldikçe puan kazanmak zorlaşır): ilk 10 maç 40 · <1400: 32 · 1400–1799: 24 · 1800–2099: 20 · 2100+: 16.
- **Lig dengesi:** Grup ortalaması 1600'ün altındaysa kazanana küçük bir bonus verilir (beraberlikte yarısı iki tarafa): `bonus = (1600 − ortalama) / 20` (en fazla +25, K ile ölçeklenir). Ortalama 1600'ü geçerse bonus negatife döner. Böylece ortalama zamanla ~1600'de dengelenir. 4, 6 ve 10 kişilik simülasyonlar testlerde doğrulanıyor.
- Kazanan her zaman puan kazanır, kaybeden her zaman kaybeder; taban puan 100.
- Puanlar saklanmaz, **olay geçmişinden yeniden hesaplanır** (oyuncu katılımı, maçlar, manuel düzeltmeler zaman sırasıyla). Bir maç düzeltilince veya silinince, sonraki bütün puanlar otomatik ve tutarlı şekilde yeniden hesaplanır.

## Yönetici

- Kod **sunucuda** doğrulanır. Kaynakta yalnızca kodun scrypt özeti vardır; kod büyük/küçük harf ve baştaki/sondaki boşluklara duyarsızdır.
- Giriş başarılı olunca 12 saatlik rastgele bir oturum anahtarı verilir. Veritabanında yalnızca anahtarın SHA-256 özeti tutulur. 15 dakikada 8 yanlış deneme yapılırsa giriş kilitlenir.
- Panelden ELO artırılıp azaltılabilir (±), oyuncu eklenip silinip yeniden adlandırılabilir, **Maçlar** sekmesinden maçlar düzeltilip silinebilir.
- Bütün manuel ELO değişiklikleri ve yönetici işlemleri `audit_log` tablosunda silinmeden saklanır ve panelde listelenir.
- Oyuncu silindiğinde maçları da silinir ve sıralama yeniden hesaplanır (panel önce uyarır).
