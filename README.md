<p align="center">
  <img src="https://demolab.com🤖+WhatsApp+Bot+Pro;🚀+Auto+Promotion+Bot;✨+AI+%26+Downloader+Features" alt="Typing SVG" />
</p>

<p align="center">
  <img src="https://shields.io" alt="Node.js">
  <img src="https://shields.io" alt="Baileys">
  <img src="https://shields.io" alt="Status">
</p>

---

### 📖 Deskripsi Proyek
Solusi otomatisasi pemasaran terbaik untuk WhatsApp. **Bot WhatsApp** ini dirancang khusus untuk membantu Anda **berpromosi secara otomatis ke semua grup** secara berkala tanpa perlu mengetik manual. Dilengkapi dengan sistem pintar **Blacklist Group** untuk menghindari promosi ke grup sensitif atau grup tertentu, serta dilengkapi menu hiburan berbasis **AI** dan **Downloader**.

---

### ✨ Fitur-Fitur Unggulan

| Fitur | 🛠️ Detail Kemampuan |
| :--- | :--- |
| **🏪 Marketplace (Auto Promo)** | • Auto-promosi terjadwal ke semua grup **3x sehari**.<br>• Pengaturan teks promosi suka-suka secara dinamis.<br>• Fitur **Blacklist Group** untuk mengecualikan grup tertentu. |
| **📥 Downloader** | • Download video TikTok tanpa watermark dengan cepat.<br>• Download audio/sound TikTok langsung jadi file audio. |
| **🤖 Artificial Intelligence (AI)** | • **Text-to-Image:** Membuat foto estetik berbasis AI.<br>• **Image Upscaler:** Meng-HD-kan foto yang buram/blur.<br>• **AI Chat:** Tanya jawab cerdas berbasis prompt AI. |

---

### 🚀 Panduan Instalasi di VPS

Ikuti langkah-langkah di bawah ini untuk memasang bot di server VPS Anda.

#### 🟢 LANGKAH 1: Install Node.js v20 (via NVM)
Jalankan perintah ini secara berurutan di terminal VPS Anda:

```bash
# Update package dan install base npm
apt update && apt install nodejs npm -y

# Install NVM (Node Version Manager)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Reload konfigurasi shell
source ~/.bashrc

# Install & gunakan Node.js versi 20
nvm install 20
nvm use 20

# Set versi 20 sebagai default permanen
nvm alias default 20
```

#### 🔵 LANGKAH 2: Setup Proyek & Install Dependensi
Kloning repositori ini terlebih dahulu, lalu install library utama yang dibutuhkan:

```bash
# Install Git dan inisialisasi folder
apt update && apt install git -y
npm init -y

# Install Baileys dan dependensi WhatsApp Core
npm install @whiskeysockets/baileys pino fs-extra qrcode-terminal

# Install dependensi API AI & HTTP Client
npm install axios @fal-ai/serverless-client @google/genai

# Install TikTok Downloader API
npm i @tobyg74/tiktok-api-dl
```

#### 🟡 LANGKAH 3: Jalankan Bot
Untuk memulai bot dan memunculkan QR Code untuk di-scan, jalankan:
```bash
node index.js
```
*(Catatan: Sesuaikan `index.js` dengan nama file utama aplikasi Anda).*

---

### 📸 Tampilan Menu Bot (Preview)

> 💡 *Tips: Anda bisa meletakkan screenshot bot Anda di dalam tabel ini agar calon pengguna bisa melihat estetikanya.*

| 📱 Menu Utama | 🤖 Fitur AI & Downloader |
| :---: | :---: |
| <img src="https://ubuntu.com" width="100%" alt="Menu Promo"> | <img src="https://ubuntu.com" width="100%" alt="Menu AI"> |

---

### 📄 Lisensi
Proyek ini dilisensikan di bawah **MIT License**. Anda bebas mengembangkan dan memodifikasinya.
