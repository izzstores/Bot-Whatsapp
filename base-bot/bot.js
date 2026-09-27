const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    delay,
    jidNormalizedUser,
    generateWAMessageFromContent,
    downloadContentFromMessage,
    prepareWAMessageMedia
} = require("@whiskeysockets/baileys");
const axios = require("axios");
const { fal } = require("@fal-ai/client");
const { GoogleGenAI } = require("@google/genai");
const { Downloader } = require("@tobyg74/tiktok-api-dl");
const pino = require("pino");
const fs = require("fs-extra");
const qrcode = require("qrcode-terminal");

// ===== DATABASE =====
const DB_PATH = {
    promo: "./promo.json",
    blacklist: "./blacklist.json",
    warning: "./warning.json"
};

const OWNER_NUMBERS = [
    "6282213283021",
    "30275375472747"
];

const MENU_IMAGE = "https://files.catbox.moe/sl2f84.jpg";

// ===== AI CONFIG =====
const GEMINI_API_KEY = "AIzaSyBGXWcdmfydVX998soTtY4mgG7ciuxMqec";
const PIXELCUT_API_KEY = "sk_4ef671f9512b4f8b8b9b5a82a182adb3";

const ai = new GoogleGenAI({
    apiKey: GEMINI_API_KEY
});

let aiMode = false;

const PUBLIC_BUTTONS = new Set([
    "menu_home",
    "menu_download",
    "download_tiktok_video",
    "download_tiktok_sound",
    "menu_ai",
    "menu_gambar",
    "menu_hd"
]);

const PUBLIC_COMMANDS = new Set([
    ".menu",
    ".download",
    ".modeai",
    ".hd"
]);

async function requireAiMode(sock, from) {
    if (aiMode) return true;

    await sock.sendMessage(from, {
        text:
            "🔴 Mode AI belum diaktifkan.\n\n" +
            "Owner harus membuka menu Mode AI, lalu memilih 🟢 ON."
    });

    return false;
}

let promoData = fs.existsSync(DB_PATH.promo)
    ? fs.readJsonSync(DB_PATH.promo)
    : { text: "🔥 Promo VPS Murah! 🔥" };

let blacklist = fs.existsSync(DB_PATH.blacklist)
    ? fs.readJsonSync(DB_PATH.blacklist)
    : [];

let warningData = fs.existsSync(DB_PATH.warning)
    ? fs.readJsonSync(DB_PATH.warning)
    : {};

const saveDB = () => {
    fs.writeJsonSync(DB_PATH.promo, promoData);
    fs.writeJsonSync(DB_PATH.blacklist, blacklist);
    fs.writeJsonSync(DB_PATH.warning, warningData);
};

let msgQueue = [];
let isProcessing = false;
let tiktokDownloadMode = {};

// ===== OWNER CHECK =====
function isOwner(sender) {
    const number = jidNormalizedUser(sender).split("@")[0].split(":")[0];
    return OWNER_NUMBERS.includes(number);
}

// ===== AMBIL TEXT =====
function getMessageText(msg) {
    const m = msg.message || {};

    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.buttonsResponseMessage?.selectedButtonId ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.templateButtonReplyMessage?.selectedId ||
        ""
    );
}

// ===== AMBIL ID BUTTON NATIVE FLOW =====
function getButtonId(msg) {
    const m = msg.message || {};

    // Native Flow / Interactive Response
    const params =
        m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;

    if (params) {
        try {
            const data = JSON.parse(params);
            return (
                data.id ||
                data.selected_id ||
                data.button_id ||
                data.selectedId ||
                ""
            );
        } catch (_) {}
    }

    // Cadangan format lama
    return (
        m.buttonsResponseMessage?.selectedButtonId ||
        m.templateButtonReplyMessage?.selectedId ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ""
    );
}

// ===== KIRIM NATIVE FLOW + FOTO =====
async function sendButtonMenu(sock, from, body, footer, buttons) {
    try {
        const media = await prepareWAMessageMedia(
            {
                image: {
                    url: MENU_IMAGE
                }
            },
            {
                upload: sock.waUploadToServer
            }
        );

        const nativeButtons = buttons.map((button) => ({
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: button.text,
                id: button.id
            })
        }));

        const interactiveMessage = {
            header: {
                title: "✨ ADMIN BOT PANEL V7 ✨",
                subtitle: "Anti-Spam & Broadcast System",
                hasMediaAttachment: true,
                imageMessage: media.imageMessage
            },

            body: {
                text: body
            },

            footer: {
                text: footer
            },

            nativeFlowMessage: {
                buttons: nativeButtons,
                messageParamsJson: "{}",
                messageVersion: 1
            }
        };

        const waMessage = generateWAMessageFromContent(
            from,
            {
                interactiveMessage
            },
            {
                userJid: sock.user.id
            }
        );

        const botNode = {
            tag: "bot",
            attrs: {
                biz_bot: "1"
            }
        };

        const bizNode = {
            tag: "biz",
            attrs: {},
            content: [
                {
                    tag: "interactive",
                    attrs: {
                        type: "native_flow",
                        v: "1"
                    },
                    content: [
                        {
                            tag: "native_flow",
                            attrs: {
                                v: "9",
                                name: "mixed"
                            }
                        }
                    ]
                },
                {
                    tag: "quality_control",
                    attrs: {
                        source_type: "third_party"
                    }
                }
            ]
        };

        await sock.relayMessage(
            from,
            waMessage.message,
            {
                messageId: waMessage.key.id,
                additionalNodes: [botNode, bizNode]
            }
        );

        console.log("✅ Menu button + gambar berhasil dikirim!");
    } catch (err) {
        console.log("❌ ERROR MENU BUTTON:", err);
    }
}

// ===== MENU UTAMA =====
async function sendMainMenu(sock, from, sender) {
    const owner = isOwner(sender);

    const body = owner
        ? "✨ *DASHBOARD CONTROL BOT* ✨\n\n" +
          "Selamat datang, Owner 👑\n\n" +
          "Silakan pilih menu di bawah:"
        : "✨ *MENU BOT* ✨\n\n" +
          "Silakan pilih fitur yang tersedia:";

    const buttons = owner
        ? [
              { text: "📢 PROMO", id: "menu_promo" },
              { text: "🚀 BROADCAST", id: "menu_broadcast" },
              { text: "🛡️ STATUS", id: "menu_status" },
              { text: "📥 DOWNLOAD", id: "menu_download" },
              { text: "🎨 BUAT GAMBAR", id: "menu_gambar" },
              { text: "🖼️ HD FOTO", id: "menu_hd" },
              { text: "🤖 MODE AI", id: "menu_ai" }
          ]
        : [
              { text: "📥 DOWNLOAD", id: "menu_download" },
              { text: "🤖 MODE AI", id: "menu_ai" },
              { text: "🖼️ HD FOTO", id: "menu_hd" },
              { text: "🎨 BUAT GAMBAR", id: "menu_gambar" }
          ];

    await sendButtonMenu(
        sock,
        from,
        body,
        owner
            ? "IZZ BOT • ADMIN PANEL V7"
            : "IZZ BOT • MENU PENGGUNA",
        buttons
    );
}

// ===== MENU PROMO =====
async function sendPromoMenu(sock, from) {
    await sendButtonMenu(
        sock,
        from,
        "📢 *MENU PROMO*\n\n" +
        "Pilih pengaturan promo yang ingin digunakan:",
        "IZZ BOT • PROMO",
        [
            { text: "📝 SET PROMO", id: "menu_setpromo" },
            { text: "🔍 CEK PROMO", id: "menu_cekpromo" },
            { text: "⬅️ KEMBALI", id: "menu_home" }
        ]
    );
}

// ===== MENU AI =====
async function sendAIMenu(sock, from, sender) {
    const owner = isOwner(sender);
    const status = aiMode ? "🟢 AKTIF" : "🔴 NONAKTIF";

    const buttons = owner
        ? [
              { text: "🟢 ON", id: "ai_on" },
              { text: "🔴 OFF", id: "ai_off" },
              { text: "⬅️ KEMBALI", id: "menu_home" }
          ]
        : [
              { text: "⬅️ KEMBALI", id: "menu_home" }
          ];

    await sendButtonMenu(
        sock,
        from,
        "🤖 *MODE AI*\n\n" +
            `Status AI saat ini: ${status}\n\n` +
            (owner
                ? "Owner dapat mengaktifkan atau menonaktifkan Mode AI."
                : "Fitur AI hanya dapat digunakan setelah Owner mengaktifkan Mode AI."),
        "IZZ BOT • AI SYSTEM",
        buttons
    );
}

// ===== MENU DOWNLOAD =====
async function sendDownloadMenu(sock, from) {
    await sendButtonMenu(
        sock,
        from,
        "📥 *MENU DOWNLOAD*\n\n" +
        "Pilih jenis media TikTok yang ingin didownload:",
        "IZZ BOT • DOWNLOAD",
        [
            { text: "🎬 VIDEO TIKTOK", id: "download_tiktok_video" },
            { text: "🎵 SOUND TIKTOK", id: "download_tiktok_sound" },
            { text: "⬅️ KEMBALI", id: "menu_home" }
        ]
    );
}

// ===== MENU STATUS =====
async function sendStatus(sock, from) {
    const groups = await sock.groupFetchAllParticipating();
    const totalGroups = Object.keys(groups).length;
    const blacklisted = blacklist.length;
    const activeGroups = Math.max(0, totalGroups - blacklisted);

    const statusText =
        "🛡️ *STATUS BOT*\n\n" +
        `👥 Total Grup: ${totalGroups}\n` +
        `🚫 Blacklist: ${blacklisted}\n` +
        `✅ Grup Aktif: ${activeGroups}\n\n` +
        "📢 *Jadwal Broadcast*\n" +
        "• 09:00\n" +
        "• 15:00\n" +
        "• 21:00\n\n" +
        "🔁 Frekuensi: 3x sehari\n" +
        "⏱️ Delay: 3 detik/grup\n" +
        "🛡️ Limit promo: 3x/user/grup/hari\n\n" +
        `📝 Promo aktif:\n${promoData.text}`;

    await sendButtonMenu(
        sock,
        from,
        statusText,
        "IZZ BOT • STATUS",
        [
            { text: "⬅️ KEMBALI", id: "menu_home" }
        ]
    );
}

// ===== SET PROMO =====
async function askSetPromo(sock, from) {
    await sock.sendMessage(from, {
        text:
            "📝 *SET PROMO*\n\n" +
            "Kirim pesan dengan format:\n\n" +
            "`.setpromo Isi promo kamu`\n\n" +
            "Contoh:\n" +
            "`.setpromo 🔥 Promo VPS Murah!`"
    });
}

// ===== CORE BOT =====
async function startBot() {
    console.log("🚀 Menghubungkan ke WhatsApp...");

    const { state, saveCreds } =
        await useMultiFileAuthState("auth_session");

    const { version } =
        await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        browser: ["Linux", "Chrome", "120.0.0"],
        markOnlineOnConnect: true
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const reason =
                lastDisconnect?.error?.output?.statusCode;

            if (reason !== DisconnectReason.loggedOut) {
                console.log(
                    "🔄 Koneksi terputus, mencoba reconnect..."
                );
                startBot();
            }
        }

        if (connection === "open") {
            console.log("✅ BOT ONLINE!");
            runScheduler(sock);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const msg = messages[0];

            if (!msg?.message) return;
            if (msg.key.remoteJid === "status@broadcast") return;

            const from = jidNormalizedUser(msg.key.remoteJid);
            const isGroup = from.endsWith("@g.us");

            const sender = jidNormalizedUser(
                msg.key.participant || msg.key.remoteJid
            );

            const text = getMessageText(msg);
            const trimmedText = text.trim();

            const primaryCommand = trimmedText
                .split(/\s+/)[0]
                .toLowerCase();

            // ==========================================
            // DETEKSI BUTTON
            // ==========================================
            let buttonId = "";

            const message = msg.message;

            if (message.buttonsResponseMessage) {
                buttonId =
                    message.buttonsResponseMessage
                        .selectedButtonId || "";
            }

            if (message.templateButtonReplyMessage) {
                buttonId =
                    message.templateButtonReplyMessage
                        .selectedId || "";
            }

            if (message.listResponseMessage) {
                buttonId =
                    message.listResponseMessage
                        .singleSelectReply
                        ?.selectedRowId || "";
            }

            if (message.interactiveResponseMessage) {
                try {
                    const nativeFlow =
                        message.interactiveResponseMessage
                            .nativeFlowResponseMessage;

                    if (nativeFlow?.paramsJson) {
                        const params = JSON.parse(
                            nativeFlow.paramsJson
                        );

                        buttonId =
                            params.id ||
                            params.selected_id ||
                            params.button_id ||
                            "";
                    }
                } catch (e) {
                    console.log(
                        "⚠️ Gagal membaca button:",
                        e.message
                    );
                }
            }

            // ==========================================
            // PUBLIC COMMAND
            // ==========================================
            const isPublicCommand =
                trimmedText.startsWith(".tanya ") ||
                trimmedText.startsWith(".gambar ") ||
                trimmedText.startsWith(".hd ") ||
                PUBLIC_COMMANDS.has(primaryCommand);

            // ==========================================
            // CEK BUTTON
            // ==========================================
            const hasButton = Boolean(buttonId);

            const isAllowedButton =
                hasButton &&
                (
                    isOwner(sender) ||
                    PUBLIC_BUTTONS.has(buttonId)
                );

            // ==========================================
            // CEK AKSES
            // ==========================================
            if (
                (trimmedText.startsWith(".") || hasButton) &&
                !isOwner(sender) &&
                !isPublicCommand &&
                !isAllowedButton
            ) {
                console.log(
                    `⛔ Command ditolak: ${sender}`
                );

                return;
            }

            if (hasButton) {
                console.log(
                    `🔘 Button: ${buttonId} | Sender: ${sender}`
                );
            }
            // ==============================
            // TIKTOK DOWNLOAD
            // ==============================

            const tiktokMode =
                tiktokDownloadMode[sender];

            if (
                tiktokMode &&
                /^https?:\/\/(www\.)?(tiktok\.com|vt\.tiktok\.com)/i.test(text.trim())
            ) {

                const tiktokUrl = text.trim();

                await downloadTikTok(
                    sock,
                    from,
                    tiktokUrl,
                    tiktokMode
                );

                delete tiktokDownloadMode[sender];

                return;
            }

            // ==============================
            // LIMITER PROMO
            // ==============================
            if (isGroup && !msg.key.fromMe) {
                const isPromo =
                    /https?:\/\/\S+|wa\.me|(?:[\+0-9]{8,15})|@\w{5,}|t\.me/gi
                        .test(text);

                if (isPromo) {
                    try {
                        const groupMetadata =
                            await sock.groupMetadata(from);

                        const participants =
                            groupMetadata.participants;

                        const botNumber =
                            jidNormalizedUser(sock.user.id);

                        const botPart =
                            participants.find(
                                (p) =>
                                    jidNormalizedUser(p.id) === botNumber
                            );

                        const senderPart =
                            participants.find(
                                (p) =>
                                    jidNormalizedUser(p.id) === sender
                            );

                        const isBotAdmin =
                            botPart?.admin ||
                            botPart?.ismadmin ||
                            false;

                        const isSenderAdmin =
                            senderPart?.admin ||
                            senderPart?.ismadmin ||
                            false;

                        if (isBotAdmin && !isSenderAdmin) {
                            const today =
                                new Date().toLocaleDateString("id-ID");

                            const userKey =
                                `${sender}_${from}_${today}`;

                            warningData[userKey] =
                                (warningData[userKey] || 0) + 1;

                            saveDB();

                            console.log(
                                `[PROMO] ${sender} di ${groupMetadata.subject} | ` +
                                `Frekuensi: ${warningData[userKey]}/3`
                            );

                            if (warningData[userKey] > 3) {
                                await sock.sendMessage(from, {
                                    delete: msg.key
                                });

                                const tagMessage =
                                    `⚠️ @${sender.split("@")[0]} ` +
                                    `kamu telah melewati batas limit 3 kali ` +
                                    `untuk promosi, lanjut besok ya kontooooll`;

                                await sock.sendMessage(from, {
                                    text: tagMessage,
                                    mentions: [sender]
                                });
                            }
                        }
                    } catch (e) {
                        console.log(
                            "Error Monitoring:",
                            e.message
                        );
                    }
                }
            }

            const senderNumber =
                sender.split("@")[0].split(":")[0];

            console.log(
                `[COMMAND] Sender: ${senderNumber} | ` +
                `Text: ${text || "(button)"} | ` +
                `Button: ${buttonId || "-"}`
            );

            // ==============================
            // BUTTON MENU
            // ==============================
            if (buttonId === "menu_home") {
                await sendMainMenu(sock, from, sender);
                return;
            }

            if (buttonId === "menu_gambar") {
                await sock.sendMessage(from, {
                    text:
                        "🎨 *BUAT GAMBAR AI*\n\n" +
                        "Kirim perintah:\n\n" +
                        "`.gambar <deskripsi>`\n\n" +
                        "Contoh:\n" +
                        "`.gambar kucing memakai jaket di kota futuristik`"
                });
                return;
            }

            if (buttonId === "menu_hd") {
                await sock.sendMessage(from, {
                    text:
                        "🖼️ *HD FOTO*\n\n" +
                        "Kirim foto lalu beri caption:\n\n" +
                        "`.hd`\n\n" +
                        "Atau reply/balas foto kemudian kirim:\n" +
                        "`.hd`"
                });
                return;
            }

            if (buttonId === "menu_download") {
                await sendDownloadMenu(sock, from);
                return;
            }

            if (buttonId === "download_tiktok_video") {

                tiktokDownloadMode[sender] = "video";

                await sock.sendMessage(from, {
                    text:
                        "🎬 *DOWNLOAD VIDEO TIKTOK*\n\n" +
                        "Sekarang kirim link TikTok.\n\n" +
                        "Contoh:\n" +
                        "https://vt.tiktok.com/xxxxxx"
                });

                return;
            }

            if (buttonId === "download_tiktok_sound") {

                tiktokDownloadMode[sender] = "sound";

                await sock.sendMessage(from, {
                    text:
                        "🎵 *DOWNLOAD SOUND TIKTOK*\n\n" +
                        "Sekarang kirim link TikTok.\n\n" +
                        "Contoh:\n" +
                        "https://vt.tiktok.com/xxxxxx"
                });

                return;
            }

            if (buttonId === "menu_ai") {
                await sendAIMenu(sock, from, sender);
                return;
            }

            if (buttonId === "ai_on") {
                if (!isOwner(sender)) {
                    await sock.sendMessage(from, {
                        text: "⛔ Hanya Owner yang dapat mengaktifkan Mode AI."
                    });
                    return;
                }

                aiMode = true;

                await sock.sendMessage(from, {
                    text:
                        "🤖 *MODE AI AKTIF*\n\n" +
                        "Sekarang fitur AI dapat digunakan oleh semua pengguna."
                });
                return;
            }

            if (buttonId === "ai_off") {
                if (!isOwner(sender)) {
                    await sock.sendMessage(from, {
                        text: "⛔ Hanya Owner yang dapat menonaktifkan Mode AI."
                    });
                    return;
                }

                aiMode = false;

                await sock.sendMessage(from, {
                    text:
                        "🔴 *MODE AI NONAKTIF*\n\n" +
                        "Fitur AI sementara tidak dapat digunakan."
                });
                return;
            }

            if (buttonId === "menu_promo") {
                await sendPromoMenu(sock, from);
                return;
            }

            if (buttonId === "menu_setpromo") {
                await askSetPromo(sock, from);
                return;
            }

            if (buttonId === "menu_cekpromo") {
                await sock.sendMessage(from, {
                    text:
                        `📢 *ISI PROMO:*\n\n${promoData.text}`
                });
                return;
            }

            if (buttonId === "menu_broadcast") {
                await sock.sendMessage(from, {
                    text:
                        "🚀 *BROADCAST DIMULAI*\n\n" +
                        "Promo sedang dikirim ke semua grup aktif."
                });

                await triggerBroadcast(sock);
                return;
            }

            if (buttonId === "menu_status") {
                await sendStatus(sock, from);
                return;
            }

            // ==============================
            // PUBLIC AI COMMAND
            // ==============================

            if (text.startsWith(".tanya ")) {
                if (!(await requireAiMode(sock, from))) {
                    return;
                }

                const promptInput =
                    text.slice(7).trim();

                if (!promptInput) {
                    await sock.sendMessage(from, {
                        text:
                            "🤖 Contoh:\n\n" +
                            "`.tanya jelaskan struktur data array`"
                    });
                    return;
                }

                await sock.sendMessage(from, {
                    text:
                        "🤖 Sedang memproses pertanyaan..."
                });

                try {
                    const response =
                        await ai.models.generateContent({
                            model: "gemini-3.6-flash",
                            contents:
                                `Kamu adalah asisten AI yang membantu pengguna ` +
                                `menjawab pertanyaan dengan jelas dan mudah dipahami.\n\n` +
                                `Pertanyaan:\n${promptInput}`
                        });

                    let hasilTeks = response.text;

                hasilTeks = hasilTeks
                    .replace(/\*\*/g, "")
                    .replace(/\*/g, "");

                await sock.sendMessage(from, {
                    text: hasilTeks
                }, { quoted: msg
                });
                } catch (error) {
                    console.log("❌ Gemini Error:", error.message);

                    await sock.sendMessage(from, {
                        text:
                            "❌ Gagal menghubungi AI."
                    });
                }

                return;
            }

            if (text.startsWith(".gambar ")) {
                if (!(await requireAiMode(sock, from))) {
                    return;
                }

                const promptGambar =
                    text.slice(8).trim();

                if (!promptGambar) {
                    await sock.sendMessage(from, {
                        text:
                            "🎨 Contoh:\n\n" +
                            "`.gambar perpustakaan futuristik`"
                    });
                    return;
                }

                await sock.sendMessage(from, {
                    text:
                        "🎨 Sedang membuat gambar AI...\n" +
                        "Mohon tunggu."
                });

                try {
                    const encodedPrompt =
                        encodeURIComponent(promptGambar);

                    const apiUrl =
                        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
                        `?width=1024&height=1024&model=flux&nologo=true`;

                    const response =
                        await axios.get(apiUrl, {
                            responseType: "arraybuffer"
                        });

                    const imageBuffer =
                        Buffer.from(response.data);

                    await sock.sendMessage(from, {
                        image: imageBuffer,
                        caption:
                            `✨ *HASIL AI*\n\n` +
                            `Prompt: ${promptGambar}`
                    });
                } catch (error) {
                    console.log(
                        "❌ Image AI Error:",
                        error.message
                    );

                    await sock.sendMessage(from, {
                        text:
                            "❌ Gagal membuat gambar."
                    });
                }

                return;
            }

            if (text.trim() === ".hd") {

    if (!(await requireAiMode(sock, from))) {
    return;
}

    const message = msg.message || {};

    // ==============================
    // CEK FOTO
    // ==============================

    // Foto langsung dengan caption .hd
    const isImage = !!message.imageMessage;

    // Foto yang di-reply lalu .hd
    const quoted =
        message.extendedTextMessage
            ?.contextInfo
            ?.quotedMessage;

    const isQuotedImage = !!quoted?.imageMessage;

    if (!isImage && !isQuotedImage) {
        await sock.sendMessage(from, {
            text:
                "🖼️ *CARA MENGGUNAKAN HD*\n\n" +
                "• Kirim foto dengan caption `.hd`\n" +
                "• Atau reply/balas foto lalu ketik `.hd`"
        });
        return;
    }

    const imageMessage = isImage
        ? message.imageMessage
        : quoted.imageMessage;

    await sock.sendMessage(from, {
        text: "⏳ Sedang meningkatkan kualitas foto..."
    });

    try {

        // ==============================
        // DOWNLOAD FOTO DARI WHATSAPP
        // ==============================

        const stream =
            await downloadContentFromMessage(
                imageMessage,
                "image"
            );

        const chunks = [];

        for await (const chunk of stream) {
            chunks.push(chunk);
        }

        const buffer = Buffer.concat(chunks);

        if (!buffer.length) {
            throw new Error(
                "Foto gagal didownload dari WhatsApp."
            );
        }

        console.log(
            `📥 Foto diterima: ${(buffer.length / 1024).toFixed(2)} KB`
        );

        // ==============================
        // CONVERT KE BASE64
        // ==============================

        const base64Image =
            `data:image/jpeg;base64,${buffer.toString("base64")}`;

        // ==============================
        // PIXELCUT UPSCALER
        // ==============================

        console.log(
            "🚀 Mengirim foto ke Pixelcut..."
        );

        const response = await axios.post(
            "https://api.developer.pixelcut.ai/v1/upscale",
            {
                image: base64Image,
                scale: 2
            },
            {
                headers: {
                    "X-API-KEY": PIXELCUT_API_KEY,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                timeout: 120000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        console.log(
            "✅ Pixelcut Response diterima."
        );

        // ==============================
        // AMBIL HASIL PIXELCUT
        // ==============================

        const resultData =
            response.data?.data ||
            response.data?.result_url ||
            response.data?.image_url ||
            response.data?.url;

        if (!resultData) {
            console.log(
                "❌ Response Pixelcut:",
                response.data
            );

            throw new Error(
                "Pixelcut tidak mengembalikan hasil gambar."
            );
        }

        let resultBuffer;

        // ==============================
        // HASIL BERUPA BASE64
        // ==============================

        if (
            typeof resultData === "string" &&
            resultData.startsWith("data:image/")
        ) {

            console.log(
                "🖼️ Pixelcut mengembalikan Base64."
            );

            const base64Data =
                resultData.split(",")[1];

            if (!base64Data) {
                throw new Error(
                    "Base64 Pixelcut tidak valid."
                );
            }

            resultBuffer =
                Buffer.from(
                    base64Data,
                    "base64"
                );
        }

        // ==============================
        // HASIL BERUPA URL
        // ==============================

        else if (
            typeof resultData === "string" &&
            /^https?:\/\//i.test(resultData)
        ) {

            console.log(
                "🔗 Pixelcut mengembalikan URL."
            );

            const resultImage =
                await axios.get(
                    resultData,
                    {
                        responseType:
                            "arraybuffer",
                        timeout: 120000,
                        maxContentLength:
                            Infinity,
                        maxBodyLength:
                            Infinity
                    }
                );

            resultBuffer =
                Buffer.from(
                    resultImage.data
                );
        }

        // ==============================
        // FORMAT TIDAK DIKENALI
        // ==============================

        else {
            console.log(
                "❌ Format hasil Pixelcut:",
                typeof resultData
            );

            throw new Error(
                "Format hasil Pixelcut tidak dikenali."
            );
        }

        // ==============================
        // VALIDASI HASIL
        // ==============================

        if (
            !resultBuffer ||
            !resultBuffer.length
        ) {
            throw new Error(
                "Hasil HD kosong."
            );
        }

        console.log(
            `📤 Hasil HD: ${(resultBuffer.length / 1024).toFixed(2)} KB`
        );

        // ==============================
        // KIRIM HASIL KE WHATSAPP
        // ==============================

        await sock.sendMessage(from, {
            image: resultBuffer,
            caption:
                "✨ *Foto berhasil di-HD-kan!*\n\n" +
                "🚀 Powered by Pixelcut AI"
        });

        console.log(
            "✅ Foto berhasil di-HD-kan menggunakan Pixelcut."
        );

    } catch (error) {

        console.error(
            "❌ Pixelcut HD Error:",
            error.response?.data ||
            error.message
        );

        await sock.sendMessage(from, {
            text:
                "❌ *Gagal memproses foto.*\n\n" +
                "Silakan coba lagi beberapa saat."
        });
    }

    return;
}
            // ==============================
            // COMMAND ADMIN
            // ==============================
            if (!text.startsWith(".")) return;

            const args = trimmedText.split(/\s+/);

            const command = args[0].toLowerCase();

            switch (command) {
                case ".menu":
                    await sendMainMenu(sock, from, sender);
                    break;

                case ".download":
                    await sendDownloadMenu(sock, from);
                    break;

                case ".modeai":
                    await sendAIMenu(sock, from, sender);
                    break;

                case ".setpromo": {
                    const input =
                        text.replace(/^\.setpromo\s*/, "").trim();

                    if (!input) {
                        await sock.sendMessage(from, {
                            text:
                                "❌ Isi teks promo!\n\n" +
                                "Contoh:\n" +
                                "`.setpromo 🔥 Promo VPS Murah!`"
                        });
                        break;
                    }

                    promoData.text = input;
                    saveDB();

                    await sock.sendMessage(from, {
                        text: "✅ Promo berhasil diperbarui!"
                    });
                    break;
                }

                case ".cekpromo":
                    await sock.sendMessage(from, {
                        text:
                            `📢 *ISI PROMO:*\n\n${promoData.text}`
                    });
                    break;

                case ".broadcast":
                    await sock.sendMessage(from, {
                        text:
                            "🚀 Menyiapkan antrean broadcast..."
                    });

                    await triggerBroadcast(sock);
                    break;

                case ".off":
                    if (
                        isGroup &&
                        !blacklist.includes(from)
                    ) {
                        blacklist.push(from);
                        saveDB();

                        await sock.sendMessage(from, {
                            text:
                                "🚫 Grup ini di-blacklist."
                        });
                    }
                    break;

                case ".on":
                    if (isGroup) {
                        blacklist =
                            blacklist.filter(
                                (id) => id !== from
                            );

                        saveDB();

                        await sock.sendMessage(from, {
                            text:
                                "✅ Grup ini diaktifkan."
                        });
                    }
                    break;
            }
        } catch (err) {
            console.log("❌ ERROR messages.upsert:", err);
        }
    });
}
// ===== TIKTOK DOWNLOADER =====

async function downloadTikTok(sock, from, tiktokUrl, type) {
    try {
        console.log(
            `🎵 TikTok ${type.toUpperCase()} request: ${tiktokUrl}`
        );

        // ==========================================
        // VIDEO = V3
        // SOUND = V2
        // ==========================================

        const version = type === "video" ? "v3" : "v2";

        const data = await Downloader(tiktokUrl, {
            version
        });

        console.log(
            `📦 Response TikTok diterima (${version})`
        );

        if (data.status !== "success" || !data.result) {
            throw new Error(
                data.message || "Downloader gagal mengambil data."
            );
        }

        // ==========================================
        // VIDEO TIKTOK
        // ==========================================

        if (type === "video") {

            // Prioritas HD
            const videoUrls = [
                data.result.videoHD,
                data.result.videoSD,
                data.result.videoWatermark
            ].filter(Boolean);

            if (videoUrls.length === 0) {
                throw new Error(
                    "URL video TikTok tidak ditemukan."
                );
            }

            let videoBuffer = null;
            let berhasilUrl = null;

            // Coba satu per satu
            for (const videoUrl of videoUrls) {

                try {
                    console.log(
                        "🔗 Mencoba URL video:",
                        videoUrl.substring(0, 80) + "..."
                    );

                    const response = await axios.get(videoUrl, {
                        responseType: "arraybuffer",
                        timeout: 120000,
                        maxContentLength: Infinity,
                        maxBodyLength: Infinity,
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
                            "Accept":
                                "video/mp4,video/*,*/*"
                        },
                        validateStatus: () => true
                    });

                    const buffer = Buffer.from(response.data);

                    console.log(
                        `📡 HTTP: ${response.status}`
                    );

                    console.log(
                        `📦 Content-Type: ${response.headers["content-type"] || "-"}`
                    );

                    console.log(
                        `📦 Ukuran response: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`
                    );

                    // Minimal 50 KB
                    if (
                        response.status >= 200 &&
                        response.status < 300 &&
                        buffer.length > 50 * 1024
                    ) {
                        videoBuffer = buffer;
                        berhasilUrl = videoUrl;
                        break;
                    }

                    console.log(
                        "⚠️ URL video ini tidak menghasilkan video yang valid."
                    );

                } catch (err) {
                    console.log(
                        "⚠️ Gagal download URL:",
                        err.message
                    );
                }
            }

            if (!videoBuffer) {
                throw new Error(
                    "Semua URL video TikTok gagal didownload."
                );
            }

            console.log(
                `📤 Video siap dikirim: ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB`
            );

            // ==========================================
            // KIRIM VIDEO KE WHATSAPP
            // ==========================================

            await sock.sendMessage(from, {
                video: videoBuffer,
                mimetype: "video/mp4",
                fileName: "tiktok.mp4",
                caption:
                    "🎬 *Video TikTok berhasil diunduh!*\n\n" +
                    "✨ Kualitas: HD/SD\n" +
                    "🤖 IZZ BOT"
            });

            console.log(
                "✅ Video TikTok berhasil dikirim."
            );

            return;
        }

        // ==========================================
        // SOUND TIKTOK
        // ==========================================

        if (type === "sound") {

            const soundUrl =
                data.result.music?.playUrl?.[0];

            if (!soundUrl) {
                throw new Error(
                    "URL sound TikTok tidak ditemukan."
                );
            }

            console.log(
                "📥 Mengunduh sound TikTok..."
            );

            const response = await axios.get(soundUrl, {
                responseType: "arraybuffer",
                timeout: 120000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
                }
            });

            const audioBuffer =
                Buffer.from(response.data);

            console.log(
                `📤 Sound siap dikirim: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`
            );

            if (audioBuffer.length < 10 * 1024) {
                throw new Error(
                    "File sound yang diterima terlalu kecil."
                );
            }

            await sock.sendMessage(from, {
                audio: audioBuffer,
                mimetype: "audio/mpeg",
                fileName: "tiktok_sound.mp3"
            });

            console.log(
                "✅ Sound TikTok berhasil dikirim."
            );

            return;
        }

    } catch (error) {

        console.error(
            `❌ TikTok ${type} Error:`,
            error.response?.data ||
            error.message
        );

        await sock.sendMessage(from, {
            text:
                `❌ *Gagal mengunduh ${type === "video" ? "video" : "sound"} TikTok.*\n\n` +
                "Coba kirim link TikTok lainnya."
        });
    }
}

// ===== BROADCAST =====
async function triggerBroadcast(sock) {
    try {
        const groups =
            await sock.groupFetchAllParticipating();

        for (const id in groups) {
            if (!blacklist.includes(id)) {
                msgQueue.push({
                    id,
                    name: groups[id].subject
                });
            }
        }

        console.log(
            `📋 Antrean broadcast: ${msgQueue.length} grup`
        );

        if (!isProcessing) {
            processQueue(sock);
        }
    } catch (e) {
        console.log(
            "❌ Fetch group error:",
            e.message
        );
    }
}

async function processQueue(sock) {
    if (
        isProcessing ||
        msgQueue.length === 0
    ) {
        return;
    }

    isProcessing = true;

    while (msgQueue.length > 0) {
        const item = msgQueue.shift();

        try {
            await sock.sendMessage(item.id, {
                text: promoData.text
            });

            console.log(
                `✔️ Terkirim ke: ${item.name}`
            );
        } catch (err) {
            console.log(
                `❌ Gagal ke ${item.name}:`,
                err.message
            );
        }

        if (msgQueue.length > 0) {
            await delay(3000);
        }
    }

    isProcessing = false;
}

// ===== SCHEDULER =====
function runScheduler(sock) {
    setInterval(() => {
        const jamMenit =
            new Date().toLocaleTimeString(
                "en-GB",
                {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false
                }
            );

        if (
            ["09:00", "15:00", "21:00"]
                .includes(jamMenit) &&
            !isProcessing
        ) {
            console.log(
                `⏰ Scheduler broadcast ${jamMenit}`
            );

            triggerBroadcast(sock);
        }

        if (jamMenit === "00:00") {
            warningData = {}; 
            saveDB();

            console.log(
                "♻️ Hitungan promosi harian direset."
            );
        }
    }, 60000);
}

startBot();
