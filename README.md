# 🤖 Bot WhatsApp Pro
### 🚀 Auto Promotion Bot • AI & Downloader Features

> **Environment:** `🟢 Node.js v20` &nbsp;&nbsp;|&nbsp;&nbsp; **Core Library:** `⚡ Baileys` &nbsp;&nbsp;|&nbsp;&nbsp; **Status:** `👑 Active`

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
curl -o- https://githubusercontent.com | bash

# Reload konfigurasi shell
source ~/.bashrc

# Install & gunakan Node.js versi 20
nvm install 20
nvm use 20

# Set versi 20 sebagai default permanen
nvm alias default 20
```

#### 🔵 LANGKAH 2: Setup Proyek & Install Dependensi
Kloning repositori ini terlebih dahulu, lalu install library utama yang digunakan:

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

# Install Vidio Editor
npm install @napi-rs/canvas
sudo apt update
sudo apt install -y ffmpeg
```

#### 🟡 LANGKAH 3: Jalankan Bot
Untuk memulai bot dan memunculkan QR Code untuk di-scan, jalankan:
```bash
node index.js
```

---

### 📄 Lisensi
Proyek ini dilisensikan di bawah **MIT License**. Anda bebas mengembangkan dan memodifikasinya.
