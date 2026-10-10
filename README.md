# WAR KRS ITERA

Aplikasi desktop Windows untuk membantu pengambilan KRS di SIAKAD ITERA.
Persiapan dilakukan melalui tiga langkah: login di browser khusus, pilih mata
kuliah dan kelas, lalu jalankan WAR sambil memantau hasilnya.

## Pilih cara instalasi

| Kebutuhan | Panduan |
| --- | --- |
| Menggunakan aplikasi tanpa mengubah kode | [Installer Windows](#instal-dari-installer-windows) |
| Menjalankan aplikasi dari kode sumber | [Kode sumber](#instal-dari-kode-sumber) |
| Membuat installer untuk dibagikan | [Build installer](#build-installer-windows) |

## Instal dari installer Windows

**Persyaratan:** komputer Windows x64, koneksi internet untuk mengakses SIAKAD,
dan akun SIAKAD ITERA.

1. Siapkan file `WAR-KRS-Setup-1.0.0.exe` dari hasil build aplikasi.
   Installer tidak disimpan di Git; clone atau unduh ZIP repo tidak menyertakan
   file `.exe`. Jika belum punya installer, gunakan panduan kode sumber di bawah.
2. Klik dua kali file installer, pilih folder instalasi, lalu selesaikan prosesnya.
3. Buka **WAR KRS** melalui shortcut desktop atau Start Menu.
4. Ikuti [panduan penggunaan](#cara-menggunakan-aplikasi).

Installer sudah menyertakan Electron dan Chrome for Testing. Pengguna installer
tidak perlu memasang Node.js, npm, atau browser tambahan. Installer belum
ditandatangani secara digital.

## Instal dari kode sumber

### 1. Siapkan alat

- Windows x64 untuk menjalankan dan membangun aplikasi desktop ini.
- **Node.js minimal 22.12.0** beserta npm, tersedia di
  [halaman unduhan resmi Node.js](https://nodejs.org/en/download). Pilih installer
  untuk Windows x64 dan ikuti langkah instalasinya. Batas versi ini mengikuti
  kebutuhan Electron dan Puppeteer yang dipakai proyek.
- [Git for Windows](https://git-scm.com/install/windows) untuk mengambil kode
  melalui terminal. Unduh installer x64 dan selesaikan instalasi dengan opsi
  bawaan. Jika memakai ZIP repo, ekstrak
  terlebih dahulu dan buka terminal di folder hasil ekstraksi.
- Koneksi internet untuk mengunduh dependensi, runtime Electron, dan browser.

Buka PowerShell, lalu periksa alat yang terpasang:

```powershell
node --version
npm --version
git --version
```

Jika salah satu perintah tidak dikenali, pasang alat tersebut dan buka ulang
PowerShell. Pemeriksaan Git dapat dilewati jika menggunakan ZIP.

### 2. Ambil kode

```powershell
git clone https://github.com/udinvoldigoad/WarKRS_ITERA.git
cd WarKRS_ITERA
```

Semua perintah berikut dijalankan dari folder repo yang berisi `package.json`.

### 3. Pasang dependensi dan siapkan browser

```powershell
npm ci
npm run prepare:runtime
npm run prepare:browser
```

`npm ci` memasang versi dependensi sesuai `package-lock.json`. Perintah ini
mengganti isi `node_modules` jika folder tersebut sudah ada.
`prepare:runtime` memastikan executable Electron tersedia. `prepare:browser`
mengunduh Chrome for Testing ke `build/browser/`; browser yang sudah tersedia
di folder tersebut akan dipakai kembali.

Tunggu sampai setiap perintah selesai tanpa error sebelum melanjutkan.
Unduhan pertama bisa memerlukan waktu lebih lama.

### 4. Jalankan aplikasi

```powershell
npm start
```

Dashboard WAR KRS akan terbuka. Biarkan terminal tetap terbuka selama aplikasi
digunakan. Untuk penggunaan berikutnya, cukup buka terminal di folder repo dan
jalankan `npm start` lagi.

## Cara menggunakan aplikasi

1. Buka **Persiapan WAR**, lalu klik **Buka browser SIAKAD**.
2. Login langsung di jendela browser tersebut dan selesaikan verifikasi manusia
   jika diminta. Password dimasukkan di SIAKAD.
3. Kembali ke aplikasi, klik **Periksa login & lanjut**.
4. Klik **Pindai kelas**, cari mata kuliah, lalu klik **Tambah** pada kelas yang
   diinginkan. Periksa kode, nama, dan kelas sebelum menambah target.
5. Klik **Tinjau & mulai WAR**, periksa antrean, lalu klik **MULAI WAR**.
6. Pantau progres di halaman **Mulai WAR** atau **Aktivitas**. Gunakan
   **HENTIKAN WAR** jika ingin berhenti; jangan tutup browser saat proses berjalan.
7. Periksa daftar KRS di SIAKAD untuk memastikan hasil pengambilan.

Menu **Settings** mengatur notifikasi Windows, suara, jeda dan variasi percobaan,
batas percobaan per target, penghentian saat SKS penuh, serta bantuan verifikasi
Cloudflare dan cooldown proteksi. Klik **Simpan pengaturan** setelah mengubahnya.
Hentikan WAR sebelum mengubah pengaturan. Batas percobaan `0` berarti terus
mencoba sampai berhasil, gagal permanen, atau dihentikan.

Verifikasi Cloudflare bergantung pada server dan tidak dijamin selesai otomatis.
Jika diperlukan, lakukan verifikasi langsung di browser khusus aplikasi.

## Build installer Windows

Setelah instalasi kode sumber selesai, jalankan di Windows x64:

```powershell
npm test
npm run test:smoke
npm run build:installer
```

Build menyiapkan runtime Electron dan browser, lalu membuat installer NSIS.
Build pertama membutuhkan internet untuk mengunduh komponen yang belum tersedia.
Hasil untuk versi saat ini:

```text
dist/WAR-KRS-Setup-1.0.0.exe
```

Nama file mengikuti versi di `package.json`. Bagikan file installer tersebut;
pengguna tidak memerlukan folder kode sumber. Folder `build/` dan `dist/`
diabaikan Git. Pertahankan `build/browser/` agar browser tidak perlu diunduh
ulang pada build berikutnya.

## Perintah pengembangan

| Perintah | Fungsi |
| --- | --- |
| `npm start` / `npm run desktop` | Membuka aplikasi Electron |
| `npm run prepare:runtime` | Memastikan runtime Electron tersedia |
| `npm run prepare:browser` | Menyiapkan Chrome for Testing Windows x64 |
| `npm test` / `npm run test:desktop` | Menguji mesin desktop dengan data sementara |
| `npm run test:smoke` | Menguji Electron, IPC, dan alur UI tanpa login SIAKAD |
| `npm run preview:ui` | Membuat screenshot UI dengan data contoh di `build/` |
| `npm run build:installer` | Membuat installer Windows x64 di `dist/` |
| `npm run menu` | Membuka menu terminal untuk penggunaan lanjutan |
| `npm run doctor` | Membuka browser untuk diagnosis SIAKAD, login, dan periode KRS |
| `node src/bot.js help` | Menampilkan bantuan perintah terminal |

Smoke test dan preview UI memerlukan runtime/browser yang sudah disiapkan.
Mode terminal mendeteksi Chrome atau Brave yang terpasang di komputer dan memakai
data terpisah dari aplikasi desktop. `doctor` mengakses SIAKAD, sehingga
memerlukan koneksi internet dan mungkin interaksi login.

## Struktur repo

```text
src/
  bot.js                 Mesin browser, perintah terminal, dan proses WAR KRS
  desktop/
    main.js              Proses utama Electron dan komunikasi dengan mesin
    preload.js           Jembatan IPC untuk renderer
    engine.js            Penanganan aksi desktop
    index.html           Dashboard dan wizard persiapan
    renderer.js          Interaksi antarmuka
    styles.css           Tampilan aplikasi
scripts/                 Persiapan runtime/browser, smoke test, dan preview UI
tests/                   Pengujian mesin desktop
data/legacy/             Data mode terminal (diabaikan Git)
build/                   Browser dan screenshot pengembangan (diabaikan Git)
dist/                    Installer hasil build (diabaikan Git)
```

## Penyimpanan data

- **Desktop:** `%APPDATA%\warkrs`, terpisah dari folder instalasi.
- **Terminal:** `data/legacy/` di dalam repo.
- Konfigurasi, target/progres, dan profil browser disimpan lokal. Uninstall
  aplikasi desktop mempertahankan data tersebut.
- Folder data, profil browser, konfigurasi lokal, dan file sesi diabaikan Git.
  Jangan membagikan isinya karena dapat memuat sesi login dan data pribadi.

## Mengatasi masalah instalasi

| Masalah | Langkah penyelesaian |
| --- | --- |
| `node`, `npm`, atau `git` tidak dikenali | Pastikan alat terpasang dan tersedia di PATH, lalu buka ulang terminal. |
| PowerShell menolak menjalankan `npm.ps1` | Gunakan `npm.cmd` sebagai pengganti `npm`, misalnya `npm.cmd ci` dan `npm.cmd start`. |
| Error versi Node.js / `EBADENGINE` | Pastikan `node --version` minimal `22.12.0`, lalu jalankan ulang `npm ci`. |
| Unduhan dependensi/runtime/browser gagal | Periksa koneksi dan akses unduhan melalui jaringan/proxy, lalu ulangi perintah yang gagal. |
| Runtime Electron tidak ditemukan | Jalankan `npm run prepare:runtime`; jika dependensi belum lengkap, jalankan `npm ci` terlebih dahulu. |
| Browser tidak ditemukan saat menjalankan kode sumber | Jalankan `npm run prepare:browser`, lalu buka ulang aplikasi. |
| Browser tidak ditemukan pada aplikasi hasil instalasi | Instal ulang dari installer yang menyertakan browser. |
| Login belum terdeteksi | Selesaikan login di browser khusus, lalu klik **Periksa login & lanjut**. |
| Daftar kelas kosong | Pastikan login sudah diperiksa dan halaman/periode KRS tersedia, lalu klik **Pindai kelas** lagi. |

## Batasan

Target diproses berurutan. Status berhasil masih berasal dari interpretasi
respons server dan belum diverifikasi otomatis terhadap daftar KRS. Kelas
cadangan, antrean bergiliran, dan auto-update belum tersedia. Selalu periksa
hasil akhir di SIAKAD.

## Lisensi

Proyek ini menggunakan [lisensi MIT](LICENSE).
