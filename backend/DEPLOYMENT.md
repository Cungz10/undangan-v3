# Panduan Deployment

Target domain: `https://wedding-gita-rendra.cungz.site/`

Backend memakai **PostgreSQL** lewat `DATABASE_URL` (contoh: Supabase). Tidak ada file database lokal yang perlu di-backup dari server aplikasi.

## Environment variable

Server membaca `backend/.env` (self-host) atau Environment Variables di dashboard hosting (Vercel). Jangan commit `.env`.

| Variable | Wajib (production) | Keterangan |
| --- | --- | --- |
| `NODE_ENV` | ya | Isi `production`. |
| `DATABASE_URL` | ya | Connection string PostgreSQL. Untuk Supabase di Vercel, pakai **pooler** (port 6543), bukan direct connection, supaya koneksi tidak habis di serverless. |
| `JWT_SECRET` | ya | Acak, minimal 32 karakter. Server menolak start di production jika kurang. |
| `ADMIN_EMAIL` | ya | Email akun admin awal. |
| `ADMIN_PASSWORD` | ya | Minimal 12 karakter. |
| `ADMIN_ACCESS_KEY` | ya | Acak, minimal 32 karakter. |
| `ADMIN_NAME` | tidak | Nama admin, default `Admin`. |
| `CHECKIN_USERNAME` | untuk check-in | Minimal 3 karakter. |
| `CHECKIN_PASSWORD` | untuk check-in | Minimal 12 karakter. Kredensial ini hanya bisa menerbitkan token check-in, tidak bisa akses endpoint admin. Jika kosong, login petugas mengembalikan error konfigurasi dan fitur lain tetap jalan. |
| `CORS_ORIGINS` | ya | Origin browser yang diizinkan, dipisah koma, lengkap dengan scheme (dan port jika ada). Untuk hosting satu origin, isi dengan domain undangan. |
| `TRUST_PROXY_HOPS` | tidak | Jumlah reverse proxy tepercaya di depan Node. Jika kosong, default 1 (cocok untuk Vercel). Ubah sesuai jumlah proxy yang sebenarnya untuk self-host. |
| `PORT` | tidak | Default `3000`. |

Contoh ada di [`.env.example`](.env.example).

## Seed admin (penting)

Akun admin dibuat **hanya saat tabel `users` masih kosong**, dari `ADMIN_EMAIL`, `ADMIN_PASSWORD`, dan `ADMIN_ACCESS_KEY`. Tidak ada rotasi otomatis jika database sudah pernah terisi.

Jika database sudah berisi akun demo (`admin@undangan.com` / `admin123`):

1. Login ke `/dashboard.html`, ganti email/password, lalu regenerasi access key.
2. Atau cek langsung: `SELECT email, access_key FROM users;`

## Access key dan `data-key`

Ubah `data-key` di `<body>` `index.html` agar **sama persis** dengan `ADMIN_ACCESS_KEY` (atau access key terbaru di database). Key ini sengaja publik karena dipakai tamu untuk mengirim ucapan. Jika bocor atau disalahgunakan, regenerasi dari dashboard lalu update `data-key`.

## Cara deploy

Ada dua jalur. Pilih salah satu.

### A. Vercel + Supabase

`vercel.json` menjalankan `backend/server.js` sebagai serverless function untuk `/api/*`, dan build statis (`npm run build` → folder `public/`) untuk frontend.

1. Set semua environment variable di atas di Project Settings → Environment Variables.
2. Deploy. Vercel melayani file statis dari `public/` langsung; `express.static` di `server.js` tidak terpakai di jalur ini (tidak berbahaya, hanya dipakai untuk self-host).
3. Saat cold start, API menunggu pembuatan tabel dan seed admin selesai sebelum memproses request pertama.

### B. Self-host (Node di belakang reverse proxy)

1. Jalankan `npm install` di root dan di `backend`.
2. Build frontend: `npm run build:production` dari root.
3. Jalankan `npm run start:production` dari root di bawah process manager (pm2, systemd, atau Docker).
4. Arahkan reverse proxy (Nginx, Cloudflare Tunnel, dll.) ke Node di port 3000 dan terminasi HTTPS di proxy. Set `TRUST_PROXY_HOPS` sesuai jumlah proxy.

Express hanya menyajikan folder `public/`. Kode sumber, `backend/`, dan `.env` tidak ikut terpublikasi.

## Verifikasi setelah deploy

- `/` , `/dashboard.html`, `/guests.html`, dan `/checkin.html` terbuka.
- `/api/health` mengembalikan `{"status":"ok"}`.
- `/backend/.env` dan `/backend/database.js` mengembalikan 404.
- Login admin berhasil dengan kredensial production, dan akun demo tidak bisa dipakai.
- Kamera untuk `/checkin.html` hanya berfungsi lewat HTTPS atau localhost.

## Frontend dan API beda origin

Jika API dipisah ke subdomain lain, set `data-url` di `<body>` setiap halaman HTML ke base URL API, dan tambahkan origin situs undangan ke `CORS_ORIGINS`. Jika satu origin, biarkan `data-url` kosong.
