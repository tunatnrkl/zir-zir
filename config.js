/*
 * ZIR ZIR – ortak veritabanı ayarı
 *
 * Boş bırakılırsa site "demo modunda" çalışır: veriler yalnızca o cihazın
 * tarayıcısında tutulur.
 *
 * Bütün arkadaşların aynı sıralamayı görmesi için (ücretsiz):
 *   1. https://supabase.com → yeni proje oluştur.
 *   2. SQL Editor → New query → repodaki supabase.sql dosyasının tamamını
 *      yapıştır → Run.
 *   3. Project Settings → API (Data API) bölümünden "Project URL" ve
 *      "anon public" anahtarını aşağıya yapıştır, kaydet.
 *
 * "anon" anahtarı herkese açık olacak şekilde tasarlanmıştır; yazma işlemleri
 * ve yönetici kodu kontrolü veritabanındaki fonksiyonlarda yapılır.
 * "service_role" anahtarını ASLA buraya koyma.
 */
window.ZIR_CONFIG = {
  supabaseUrl: 'https://zcrapbcrtvvfhfmeoijh.supabase.co',
  supabaseAnonKey: 'sb_publishable_575ZX3de1C8DQcYWZzhZuQ_4cjGMv0O',
};
