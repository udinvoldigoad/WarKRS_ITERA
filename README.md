# ⚔ WAR KRS — Auto-Enroll KRS SIAKAD ITERA

Auto-enroll mata kuliah KRS dengan **panel UI di browser**, dijalankan dari **terminal** (bukan console browser). Tahan refresh SIAKAD, lolos Cloudflare, dan progres tersimpan otomatis.

> **DISCLAIMER**: Untuk keperluan edukasi. Gunakan secara bertanggung jawab sesuai peraturan ITERA. Script ini hanya **menambah matkul ke draft KRS**, tidak menyimpan/finalisasi KRS.

## Fitur

- 🖥 **Panel UI** — cari & klik `+` untuk tambah matkul, pantau status real-time, tanpa perlu ngetik command
- 🛡 **Anti-deteksi Cloudflare** (`puppeteer-extra-plugin-stealth`)
- 🌐 **Pilih browser** — Edge / Chrome / Brave, pakai profil asli kamu
- ⚔ **War otomatis** — retry + jitter acak, cooldown anti-bot, stop saat error permanen (periode belum buka / SKS penuh / bentrok)
- 📊 **Deteksi SKS** — hentikan otomatis saat SKS penuh
- 💬 **Notifikasi Telegram** (opsional)
- 💾 **State tersimpan di file** — tahan restart, lanjut dari yang belum berhasil

## Persyaratan

- **Node.js** v18+ (disarankan v20+)
- **Chrome / Edge / Brave** terpasang

## Instalasi

```bash
git clone https://github.com/<username>/warkrs.git
cd warkrs
npm install
```

## Cara Pakai (paling cepat)

```bash
npm start          # atau double-click KLIK-UNTUK-WAR.bat
```

1. **Tutup browser kamu** (profil asli terkunci saat browser jalan).
2. Browser otomatis terbuka dengan 2 tab: **Panel** (`http://127.0.0.1:8765`) + **SIAKAD**.
3. Kalau belum login → buka tab SIAKAD → login sekali (tersimpan).
4. Di panel: klik **Pindai** → ketik di kolom cari → klik **+** pada matkul tujuan.
5. Klik **MULAI WAR** — pantau status di panel, lihat SIAKAD di tab sebelah.

> **Penting**: Jangan tutup browser saat war berjalan. Kalau sesi kedaluwarsa, login ulang di tab SIAKAD dan war lanjut otomatis.

## Perintah Terminal

| Perintah | Fungsi |
|---|---|
| `npm start` / `node warkrs-bot.js panel` | Buka panel UI |
| `node warkrs-bot.js doctor` | Diagnostik (browser, login, periode KRS) |
| `node warkrs-bot.js scan [filter]` | Pindai daftar kelas |
| `node warkrs-bot.js add "Nama - Kelas"` | Tambah target |
| `node warkrs-bot.js list` | Lihat target |
| `node warkrs-bot.js war` | MULAI WAR (CLI) |
| `node warkrs-bot.js config set KEY VALUE` | Ubah config |

Format input `add` fleksibel — semuanya jalan:
```
Kapita Selekta - RA
43106
IF25-21008 - Jaringan Komputer - RA
43106  IF25-21008 - Jaringan Komputer - RA   (copy dari hasil scan)
```

## Konfigurasi

Config disimpan di `warkrs-config.json` (dibuat otomatis). Key penting:

| Key | Default | Fungsi |
|---|---|---|
| `BROWSER` | `auto` | `auto` / `edge` / `chrome` / `brave` |
| `USE_REAL_PROFILE` | `true` | Pakai profil asli browser (harus tutup browser dulu) |
| `RETRY_DELAY_MS` | `5000` | Jeda antar percobaan |
| `RETRY_JITTER_MS` | `3000` | Variasi acak |
| `SPAM_LIMIT` | `0` | 0 = tanpa batas |
| `SECURITY_COOLDOWN_MS` | `60000` | Cooldown saat kena proteksi |
| `AUTO_STOP_SKS` | `true` | Hentikan otomatis saat SKS penuh |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | `""` | Notifikasi Telegram (opsional) |

## Keamanan untuk Developer

⚠️ **JANGAN commit file ini** (sudah di `.gitignore`):
- `warkrs-config.json` — berisi **cookie sesi login** kamu
- `warkrs-state.json` — target & data pribadi
- `.warkrs-profile-*` — profil browser berisi sesi login

Untuk pengguna baru: file config/state dibuat otomatis dengan nilai default — tidak perlu disertakan di repo.

## Troubleshooting

| Gejala | Solusi |
|---|---|
| `Brave/Chrome masih terbuka! Profil asli terkunci` | Tutup browser dulu (termasuk proses background), lalu ulangi |
| `Sesi login kedaluwarsa` | Login ulang di tab SIAKAD → war lanjut otomatis |
| Cloudflare `Pemeriksaan Keamanan` berulang | Cek browser otomatis, pastikan lolos; perbesar delay |
| Kode prodi salah / `tidak ditemukan` | Gunakan idkelas **numerik** (dari hasil scan), bukan kode `IF25-...` |

## Lisensi

MIT
