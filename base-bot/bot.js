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
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const lastUserImages = new Map();
const IMAGE_CACHE_TIME =
    10 * 60 * 1000;

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
const PIXELCUT_API_KEY = "";

const {
    runAgent,
    approveStagedChanges
} = require("./ai-agent");


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


function getFileMime(file) {

    const ext =
        path.extname(file)
            .toLowerCase();

    const mime = {

        ".pdf":
            "application/pdf",

        ".docx":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

        ".pptx":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",

        ".xlsx":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

        ".txt":
            "text/plain",

        ".csv":
            "text/csv"
    };

    return (
        mime[ext] ||
        "application/octet-stream"
    );
}

async function downloadImageMessage(message) {

    try {

        let imageMessage = null;

        // Foto langsung
        if (message?.message?.imageMessage) {
            imageMessage =
                message.message.imageMessage;
        }

        // Foto yang dikirim sebagai viewOnce
        if (
            message?.message?.viewOnceMessage
                ?.message?.imageMessage
        ) {
            imageMessage =
                message.message
                    .viewOnceMessage
                    .message
                    .imageMessage;
        }

        // Foto viewOnce V2
        if (
            message?.message?.viewOnceMessageV2
                ?.message?.imageMessage
        ) {
            imageMessage =
                message.message
                    .viewOnceMessageV2
                    .message
                    .imageMessage;
        }

        if (!imageMessage) {
            return null;
        }

        const stream =
            await downloadContentFromMessage(
                imageMessage,
                "image"
            );

        const chunks = [];

        for await (const chunk of stream) {
            chunks.push(chunk);
        }

        const buffer =
            Buffer.concat(chunks);

        return buffer.toString("base64");

    } catch (error) {

        console.error(
            "❌ Download image error:",
            error
        );

        return null;
    }
}

async function requireAiMode(sock, from) {
    if (aiMode) return true;

    await sock.sendMessage(from, {
        text:
            "🔴 Mode AI belum diaktifkan.\n\n" +
            "Owner harus membuka menu Mode AI, lalu memilih 🟢 ON."
    });

    return false;
}

// ===== OLLAMA =====
const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const OLLAMA_MODEL = "qwen2.5vl:3b";

async function askOllama(prompt, imageBase64 = null) {
    const message = {
        role: "user",
        content: prompt
    };

    if (imageBase64) {
        message.images = [imageBase64];
    }

    const response = await axios.post(
        OLLAMA_URL,
        {
            model: OLLAMA_MODEL,
            messages: [message],
            stream: false,
            keep_alive: "1m",
            options: {
                num_ctx: 2048,
                temperature: 0.7
            }
        },
        {
            timeout: 180000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        }
    );

    const result = response.data;

    if (!result?.message?.content) {
        throw new Error("Ollama tidak memberikan jawaban.");
    }

    return result.message.content.trim();
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
let videoEditMode = {};

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
              { text: "🎬 EDIT VIDEO", id: "menu_edit_video" },
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

// ============================================================
// IZZ BOT - STORY VIDEO EDITOR V3
// Stable FFmpeg 4.2.x compatible version
// ============================================================


// ============================================================
// MENU EDIT VIDEO OWNER
// ============================================================

async function sendVideoEditMenu(sock, from) {
    await sendButtonMenu(
        sock,
        from,
        "🎬 *EDIT VIDEO OWNER*\n\n" +
        "Pilih fitur edit video yang ingin digunakan:",
        "IZZ BOT • OWNER VIDEO EDITOR",
        [
            {
                text: "🖼️ STORY EDIT",
                id: "edit_video_story"
            },
            {
                text: "⬅️ KEMBALI",
                id: "menu_home"
            }
        ]
    );
}


// ============================================================
// STATUS
// ============================================================

async function sendStatus(sock, from) {
    const groups =
        await sock.groupFetchAllParticipating();

    const totalGroups =
        Object.keys(groups).length;

    const blacklisted =
        Array.isArray(blacklist)
            ? blacklist.length
            : 0;

    const activeGroups =
        Math.max(
            0,
            totalGroups - blacklisted
        );

    const promoText =
        promoData &&
        promoData.text
            ? promoData.text
            : "Belum ada promo";

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

        `📝 Promo aktif:\n${promoText}`;

    await sendButtonMenu(
        sock,
        from,
        statusText,
        "IZZ BOT • STATUS",
        [
            {
                text: "⬅️ KEMBALI",
                id: "menu_home"
            }
        ]
    );
}


// ============================================================
// SET PROMO
// ============================================================

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


// ============================================================
// STORY CONFIG
// ============================================================

const STORY_STYLES = [
    "editorial",
    "cards",
    "minimal",
    "magazine"
];

const STORY_FONT =
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

const STORY_FONT_REGULAR =
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";


// ============================================================
// RUN FFMPEG / FFPROBE
// ============================================================

function runStoryCommand(command, args) {
    return new Promise((resolve, reject) => {

        const child =
            spawn(
                command,
                args,
                {
                    stdio: [
                        "ignore",
                        "ignore",
                        "pipe"
                    ]
                }
            );

        let stderr = "";

        child.stderr.on(
            "data",
            (chunk) => {
                stderr +=
                    chunk.toString();
            }
        );

        child.on(
            "error",
            (error) => {
                reject(error);
            }
        );

        child.on(
            "close",
            (code) => {

                if (code === 0) {
                    resolve();
                    return;
                }

                reject(
                    new Error(
                        `${command} gagal (${code}):\n` +
                        stderr.slice(-5000)
                    )
                );
            }
        );
    });
}


// ============================================================
// GET VIDEO DURATION
// ============================================================

function getStoryVideoDuration(inputPath) {
    return new Promise((resolve) => {

        const child =
            spawn(
                "ffprobe",
                [
                    "-v",
                    "error",

                    "-show_entries",
                    "format=duration",

                    "-of",
                    "default=" +
                    "noprint_wrappers=1:" +
                    "nokey=1",

                    inputPath
                ],
                {
                    stdio: [
                        "ignore",
                        "pipe",
                        "ignore"
                    ]
                }
            );

        let output = "";

        child.stdout.on(
            "data",
            (data) => {
                output +=
                    data.toString();
            }
        );

        child.on(
            "error",
            () => {
                resolve(10);
            }
        );

        child.on(
            "close",
            () => {

                const duration =
                    Number(
                        output.trim()
                    );

                if (
                    Number.isFinite(
                        duration
                    ) &&
                    duration > 0
                ) {
                    resolve(duration);
                } else {
                    resolve(10);
                }
            }
        );
    });
}


// ============================================================
// ESCAPE FFMPEG TEXT
// ============================================================

function storyEscapeText(value) {

    return String(
        value || ""
    )
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/:/g, "\\:")
        .replace(/,/g, "\\,")
        .replace(/;/g, "\\;")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/=/g, "\\=")
        .replace(/%/g, "\\%");
}


// ============================================================
// WRAP TEXT
// ============================================================

function storyWrapText(
    ctx,
    text,
    maxWidth,
    maxLines = 2
) {

    const words =
        String(text || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean);

    const lines = [];

    let current = "";

    for (const word of words) {

        const candidate =
            current
                ? `${current} ${word}`
                : word;

        if (
            ctx.measureText(
                candidate
            ).width <= maxWidth
        ) {
            current = candidate;
        } else {

            if (current) {
                lines.push(
                    current
                );
            }

            current = word;
        }
    }

    if (current) {
        lines.push(current);
    }

    return lines.slice(
        0,
        maxLines
    );
}


// ============================================================
// ROUNDED PATH
// ============================================================

function storyRoundedPath(
    ctx,
    x,
    y,
    width,
    height,
    radius
) {

    ctx.beginPath();

    if (
        typeof ctx.roundRect ===
        "function"
    ) {

        ctx.roundRect(
            x,
            y,
            width,
            height,
            radius
        );

    } else {

        ctx.rect(
            x,
            y,
            width,
            height
        );
    }
}


// ============================================================
// ROUNDED IMAGE
// ============================================================

function storyRoundedImage(
    ctx,
    image,
    x,
    y,
    width,
    height,
    radius
) {

    ctx.save();

    storyRoundedPath(
        ctx,
        x,
        y,
        width,
        height,
        radius
    );

    ctx.clip();

    const scale =
        Math.max(
            width / image.width,
            height / image.height
        );

    const drawWidth =
        image.width * scale;

    const drawHeight =
        image.height * scale;

    ctx.drawImage(
        image,

        x +
            (width - drawWidth) /
            2,

        y +
            (height - drawHeight) /
            2,

        drawWidth,
        drawHeight
    );

    ctx.restore();
}


// ============================================================
// CREATE STORY CARD
// ============================================================

function createStoryCard(
    image,
    number
) {

    const canvas =
        createCanvas(
            190,
            138
        );

    const ctx =
        canvas.getContext(
            "2d"
        );

    ctx.clearRect(
        0,
        0,
        190,
        138
    );


    // Shadow

    ctx.shadowColor =
        "rgba(0,0,0,.45)";

    ctx.shadowBlur = 16;

    ctx.shadowOffsetY = 7;


    // Card

    ctx.fillStyle =
        "rgba(255,255,255,.96)";

    storyRoundedPath(
        ctx,
        3,
        3,
        184,
        132,
        18
    );

    ctx.fill();


    ctx.shadowColor =
        "transparent";


    // Image

    storyRoundedImage(
        ctx,
        image,
        8,
        8,
        174,
        122,
        13
    );


    // Number

    ctx.fillStyle =
        "rgba(0,0,0,.55)";

    ctx.beginPath();

    ctx.arc(
        26,
        112,
        15,
        0,
        Math.PI * 2
    );

    ctx.fill();


    ctx.fillStyle =
        "#ffffff";

    ctx.font =
        "bold 15px Arial";

    ctx.textAlign =
        "center";

    ctx.textBaseline =
        "middle";

    ctx.fillText(
        String(number),
        26,
        112
    );


    return canvas.toBuffer(
        "image/png"
    );
}


// ============================================================
// DRAW TEXT FILTER
// ============================================================

function storyDrawText(
    text,
    x,
    y,
    size,
    options = {}
) {

    const font =
        options.font ||
        STORY_FONT;

    const color =
        options.color ||
        "white";

    const shadow =
        options.shadow === false
            ? ""
            :
                ":shadowcolor=black@0.60" +
                ":shadowx=2" +
                ":shadowy=2";

    const enable =
        options.enable
            ? `:enable='${options.enable}'`
            : "";

    const alpha =
        options.alpha
            ? `:alpha='${options.alpha}'`
            : "";

    return (
        `drawtext=` +
        `fontfile=${font}:` +
        `text='${storyEscapeText(text)}':` +
        `expansion=none:` +
        `fontsize=${size}:` +
        `fontcolor=${color}:` +
        `x=${x}:` +
        `y=${y}` +
        shadow +
        alpha +
        enable
    );
}


// ============================================================
// BUILD STORY FILTER
//
// PENTING:
// SEMUA FILTER DISAMBUNGKAN SATU PER SATU.
// Tidak ada lagi filter "mengambang".
// ============================================================

function storyBuildFilter(
    title,
    tags,
    style,
    duration
) {

    const graph = [];

    let current = "v0";
    let index = 1;

    const next = () => `v${index++}`;

    const safeTitle =
        String(title || "YOUR STORY")
            .trim()
            .slice(0, 42);

    const safeTags =
        Array.isArray(tags)
            ? tags
                .slice(0, 3)
                .map(x =>
                    String(x)
                        .trim()
                        .slice(0, 15)
                )
                .filter(Boolean)
            : [];

    // ========================================================
    // BASE VIDEO
    // ========================================================

    graph.push(
        `[0:v]` +
        `scale=480:864:` +
        `force_original_aspect_ratio=increase,` +
        `crop=480:864,` +
        `setsar=1` +
        `[${current}]`
    );


    // ========================================================
    // COLOR
    // ========================================================

    let n = next();

    graph.push(
        `[${current}]` +
        `eq=` +
        `contrast=1.05:` +
        `saturation=1.10:` +
        `brightness=-0.01` +
        `[${n}]`
    );

    current = n;


    // ========================================================
    // VIGNETTE
    // ========================================================

    n = next();

    graph.push(
        `[${current}]` +
        `vignette=PI/5` +
        `[${n}]`
    );

    current = n;


    // ========================================================
    // DARK CINEMATIC OVERLAY
    // ========================================================

    n = next();

    graph.push(
        `[${current}]` +
        `drawbox=` +
        `x=0:` +
        `y=0:` +
        `w=480:` +
        `h=864:` +
        `color=black@0.16:` +
        `t=fill` +
        `[${n}]`
    );

    current = n;


    // ========================================================
    // WHITE FRAME
    // ========================================================

    n = next();

    graph.push(
        `[${current}]` +
        `drawbox=` +
        `x=16:` +
        `y=16:` +
        `w=448:` +
        `h=832:` +
        `color=white@0.85:` +
        `t=2:` +
        `enable='gte(t,0.20)'` +
        `[${n}]`
    );

    current = n;


    // ========================================================
    // INTRO FLASH
    // ========================================================

    n = next();

    graph.push(
        `[${current}]` +
        `drawbox=` +
        `x=0:` +
        `y=0:` +
        `w=480:` +
        `h=864:` +
        `color=white@0.25:` +
        `t=fill:` +
        `enable='between(t,0,0.12)'` +
        `[${n}]`
    );

    current = n;


    // ========================================================
    // TAGS
    // ========================================================

    safeTags.forEach(
        (tag, i) => {

            const x =
                28 + i * 142;

            const start =
                0.35 + i * 0.15;


            // TAG BOX

            n = next();

            graph.push(
                `[${current}]` +

                `drawbox=` +
                `x=${x}:` +

                `y='30-` +
                `(1-min(` +
                `max((t-${start})/0.40,0),1` +
                `))*35':` +

                `w=128:` +
                `h=34:` +

                `color=black@0.58:` +
                `t=fill:` +

                `enable='gte(t,${start})'` +

                `[${n}]`
            );

            current = n;


            // TAG TEXT

            n = next();

            graph.push(
                `[${current}]` +

                `drawtext=` +
                `fontfile=${STORY_FONT_REGULAR}:` +
                `text='${storyEscapeText(tag)}':` +
                `expansion=none:` +
                `fontsize=15:` +
                `fontcolor=white:` +
                `x=${x + 11}:` +
                `y=53:` +
                `shadowcolor=black@0.3:` +
                `shadowx=1:` +
                `shadowy=1:` +
                `enable='gte(t,${start})'` +

                `[${n}]`
            );

            current = n;
        }
    );


    // ========================================================
    // SMALL LABEL
    // ========================================================

    const label =
        style === "magazine"
            ? "EDITORIAL STORY"
            : "YOUR STORY";

    n = next();

    graph.push(
        `[${current}]` +

        `drawtext=` +
        `fontfile=${STORY_FONT_REGULAR}:` +
        `text='${storyEscapeText(label)}':` +
        `expansion=none:` +
        `fontsize=15:` +
        `fontcolor=white@0.88:` +
        `x=32:` +
        `y=430:` +
        `shadowcolor=black@0.5:` +
        `shadowx=2:` +
        `shadowy=2:` +
        `enable='gte(t,0.55)'` +

        `[${n}]`
    );

    current = n;


    // ========================================================
    // TITLE TYPING EFFECT
    // ========================================================

    const canvas =
        createCanvas(
            480,
            864
        );

    const ctx =
        canvas.getContext("2d");

    const fontSize =
        style === "minimal"
            ? 46
            : 50;

    ctx.font =
        `bold ${fontSize}px Arial`;

    const lines =
        storyWrapText(
            ctx,
            safeTitle.toUpperCase(),
            410,
            2
        );


    lines.forEach(
        (line, lineIndex) => {

            let x = 32;

            [
                ...line
            ].forEach(
                (char, charIndex) => {

                    const width =
                        ctx.measureText(
                            char
                        ).width;

                    const start =
                        0.85 +
                        lineIndex * 0.65 +
                        charIndex * 0.055;

                    n = next();

                    graph.push(
                        `[${current}]` +

                        `drawtext=` +
                        `fontfile=${STORY_FONT}:` +
                        `text='${storyEscapeText(char)}':` +
                        `expansion=none:` +
                        `fontsize=${fontSize}:` +
                        `fontcolor=white:` +

                        `x='${x.toFixed(2)}+` +
                        `(1-min(` +
                        `max((t-${start.toFixed(3)})/0.22,0),1` +
                        `))*20':` +

                        `y=${485 + lineIndex * 56}:` +

                        `alpha='if(` +
                        `lt(t,${start.toFixed(3)}),` +
                        `0,` +
                        `min(` +
                        `1,` +
                        `(t-${start.toFixed(3)})/0.15` +
                        `))':` +

                        `shadowcolor=black@0.65:` +
                        `shadowx=2:` +
                        `shadowy=2` +

                        `[${n}]`
                    );

                    current = n;

                    x += width;
                }
            );
        }
    );


    // ========================================================
    // ACCENT LINE
    // ========================================================

    n = next();

    graph.push(
        `[${current}]` +

        `drawbox=` +
        `x=32:` +
        `y=625:` +
        `w='min(416,max(0,(t-2.0)*280))':` +
        `h=3:` +
        `color=white@0.92:` +
        `t=fill:` +
        `enable='gte(t,2.0)'` +

        `[${n}]`
    );

    current = n;


    // ========================================================
    // SEARCH BAR
    // ========================================================

    n = next();

    graph.push(
        `[${current}]` +

        `drawbox=` +
        `x=42:` +
        `y=748:` +
        `w=396:` +
        `h=54:` +
        `color=black@0.72:` +
        `t=fill:` +
        `enable='gte(t,2.35)'` +

        `[${n}]`
    );

    current = n;


    // SEARCH

    n = next();

    graph.push(
        `[${current}]` +

        `drawtext=` +
        `fontfile=${STORY_FONT_REGULAR}:` +
        `text='SEARCH':` +
        `expansion=none:` +
        `fontsize=14:` +
        `fontcolor=white@0.70:` +
        `x=65:` +
        `y=782:` +
        `enable='gte(t,2.55)'` +

        `[${n}]`
    );

    current = n;


    // SEARCH TITLE

    n = next();

    graph.push(
        `[${current}]` +

        `drawtext=` +
        `fontfile=${STORY_FONT_REGULAR}:` +
        `text='${storyEscapeText(
            safeTitle.slice(0, 25)
        )}':` +
        `expansion=none:` +
        `fontsize=17:` +
        `fontcolor=white@0.92:` +
        `x=145:` +
        `y=781:` +
        `enable='gte(t,2.62)'` +

        `[${n}]`
    );

    current = n;


    // ========================================================
    // MUSIC BAR
    // ========================================================

    n = next();

    graph.push(
        `[${current}]` +

        `drawbox=` +
        `x=42:` +
        `y=810:` +
        `w=396:` +
        `h=52:` +
        `color=black@0.82:` +
        `t=fill:` +
        `enable='gte(t,3.0)'` +

        `[${n}]`
    );

    current = n;


    // MUSIC

    n = next();

    graph.push(
        `[${current}]` +

        `drawtext=` +
        `fontfile=${STORY_FONT_REGULAR}:` +
        `text='MUSIC':` +
        `expansion=none:` +
        `fontsize=13:` +
        `fontcolor=white@0.80:` +
        `x=61:` +
        `y=833:` +
        `enable='gte(t,3.15)'` +

        `[${n}]`
    );

    current = n;


    // ORIGINAL SOUND

    n = next();

    graph.push(
        `[${current}]` +

        `drawtext=` +
        `fontfile=${STORY_FONT_REGULAR}:` +
        `text='original sound':` +
        `expansion=none:` +
        `fontsize=14:` +
        `fontcolor=white@0.90:` +
        `x=145:` +
        `y=833:` +
        `enable='gte(t,3.15)'` +

        `[${n}]`
    );

    current = n;


    // ========================================================
    // BRAND
    // ========================================================

    n = next();

    graph.push(
        `[${current}]` +

        `drawtext=` +
        `fontfile=${STORY_FONT_REGULAR}:` +
        `text='IZZ BOT • STORY EDIT':` +
        `expansion=none:` +
        `fontsize=10:` +
        `fontcolor=white@0.58:` +
        `x=145:` +
        `y=850:` +
        `enable='gte(t,3.20)'` +

        `[${n}]`
    );

    current = n;


    // ========================================================
    // FINAL OUTPUT
    // ========================================================

    graph.push(
        `[${current}]` +
        `format=yuv420p` +
        `[base]`
    );


    return graph.join(";");
}


// ============================================================
// RENDER STORY VIDEO
// ============================================================

async function renderStoryVideo(
    videoBuffer,
    options = {}
) {

    if (
        !Buffer.isBuffer(
            videoBuffer
        ) ||
        !videoBuffer.length
    ) {

        throw new Error(
            "Buffer video kosong atau tidak valid."
        );
    }


    // ========================================================
    // OPTIONS
    // ========================================================

    const title =
        String(
            options.title ||
            "Your Story"
        )
            .trim();

    const tags =
        Array.isArray(
            options.tags
        )
            ? options.tags
                .map(
                    (tag) =>
                        String(tag)
                            .trim()
                )
                .filter(Boolean)
            : [];


    const style =
        options.style &&
        STORY_STYLES.includes(
            options.style
        )
            ? options.style
            : STORY_STYLES[
                crypto.randomInt(
                    0,
                    STORY_STYLES.length
                )
            ];


    // ========================================================
    // TEMP DIRECTORY
    // ========================================================

    const tempDir =
        await fsp.mkdtemp(
            path.join(
                os.tmpdir(),
                "izz-story-v3-"
            )
        );


    const inputPath =
        path.join(
            tempDir,
            "input.mp4"
        );

    const outputPath =
        path.join(
            tempDir,
            "output.mp4"
        );

    const previewPath =
        path.join(
            tempDir,
            "preview.jpg"
        );

    const card1Path =
        path.join(
            tempDir,
            "card1.png"
        );

    const card2Path =
        path.join(
            tempDir,
            "card2.png"
        );

    const card3Path =
        path.join(
            tempDir,
            "card3.png"
        );


    try {

        // ====================================================
        // SAVE INPUT
        // ====================================================

        await fsp.writeFile(
            inputPath,
            videoBuffer
        );


        // ====================================================
        // GET VIDEO DURATION
        // ====================================================

        let duration =
            await getStoryVideoDuration(
                inputPath
            );

        duration =
            Math.max(
                4.5,
                duration
            );


        // ====================================================
        // CREATE PREVIEW IMAGE
        // ====================================================

        await runStoryCommand(
            "ffmpeg",
            [
                "-y",

                "-ss",
                "0.4",

                "-i",
                inputPath,

                "-frames:v",
                "1",

                "-vf",

                "scale=480:864:" +
                "force_original_aspect_ratio=increase," +
                "crop=480:864",

                previewPath
            ]
        );


        // ====================================================
        // LOAD PREVIEW
        // ====================================================

        const preview =
            await loadImage(
                previewPath
            );


        // ====================================================
        // CREATE CARDS
        // ====================================================

        await fsp.writeFile(
            card1Path,
            createStoryCard(
                preview,
                1
            )
        );

        await fsp.writeFile(
            card2Path,
            createStoryCard(
                preview,
                2
            )
        );

        await fsp.writeFile(
            card3Path,
            createStoryCard(
                preview,
                3
            )
        );


        // ====================================================
        // DEFAULT TAGS
        // ====================================================

        const tagsToUse =
            tags.length
                ? tags
                : [
                    "STORY",
                    "VIBES",
                    "ESCAPE"
                ];


        // ====================================================
        // BUILD FILTER GRAPH
        // ====================================================

        const filter =
            storyBuildFilter(
                title,
                tagsToUse,
                style,
                duration
            );


        // ====================================================
        // FINAL FFMPEG
        //
        // IMPORTANT:
        // [base] hanya dibuat SATU KALI.
        // ====================================================

        await runStoryCommand(
            "ffmpeg",
            [
                "-y",

                // Main video
                "-i",
                inputPath,

                // Card 1
                "-loop",
                "1",

                "-i",
                card1Path,

                // Card 2
                "-loop",
                "1",

                "-i",
                card2Path,

                // Card 3
                "-loop",
                "1",

                "-i",
                card3Path,


                // ==================================================
                // FILTER GRAPH
                // ==================================================

                "-filter_complex",

                filter +

                // Card inputs
                ";[1:v]format=rgba[c1]" +

                ";[2:v]format=rgba[c2]" +

                ";[3:v]format=rgba[c3]" +


                // ==================================================
                // CARD 1
                // ==================================================

                ";[base][c1]" +

                "overlay=" +

                "x='if(" +
                "lt(t,2.75)," +
                "-210+(235*(t-2.75)/0.42)," +
                "25" +
                ")':" +

                "y=275:" +

                "enable='gte(t,2.75)'" +

                "[cardout1]" +


                // ==================================================
                // CARD 2
                // ==================================================

                ";[cardout1][c2]" +

                "overlay=" +

                "x='if(" +
                "lt(t,3.10)," +
                "500-(235*(t-3.10)/0.42)," +
                "265" +
                ")':" +

                "y=275:" +

                "enable='gte(t,3.10)'" +

                "[cardout2]" +


                // ==================================================
                // CARD 3
                // ==================================================

                ";[cardout2][c3]" +

                "overlay=" +

                "x='if(" +
                "lt(t,3.45)," +
                "-210+(355*(t-3.45)/0.42)," +
                "145" +
                ")':" +

                "y=425:" +

                "enable='gte(t,3.45)'" +

                "[v]",


                // ==================================================
                // OUTPUT VIDEO
                // ==================================================

                "-map",
                "[v]",

                // Original audio
                "-map",
                "0:a?",


                "-c:v",
                "libx264",

                "-preset",
                "veryfast",

                "-crf",
                "20",

                "-pix_fmt",
                "yuv420p",


                "-c:a",
                "aac",

                "-b:a",
                "128k",


                "-movflags",
                "+faststart",


                "-shortest",

                outputPath
            ]
        );


        // ========================================================
        // READ OUTPUT
        // ========================================================

        const outputBuffer =
            await fsp.readFile(
                outputPath
            );


        if (
            !outputBuffer ||
            !outputBuffer.length
        ) {

            throw new Error(
                "FFmpeg selesai tetapi file output kosong."
            );
        }


        return {
            buffer:
                outputBuffer,

            style
        };


    } finally {

        // ========================================================
        // CLEAN TEMP
        // ========================================================

        await fsp.rm(
            tempDir,
            {
                recursive: true,
                force: true
            }
        ).catch(
            () => {}
        );
    }
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

            // ============================================================
            // SIMPAN FOTO TERAKHIR USER
            // ============================================================

            try {

                const imageBase64 =
                    await downloadImageMessage(msg);

                if (imageBase64) {

                    const senderId =
                        msg.key.participant ||
                        msg.key.remoteJid;

                    lastUserImages.set(
                        senderId,
                        {
                            image: imageBase64,
                            timestamp: Date.now()
                        }
                    );

                    console.log(
                        `🖼️ Foto tersimpan untuk ${senderId}`
                    );
                }

            } catch (error) {

                console.error(
                    "❌ Image cache error:",
                    error
                );
            }

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

            if (buttonId === "menu_edit_video") {
                if (!isOwner(sender)) {
                    await sock.sendMessage(from, {
                        text: "⛔ Fitur ini khusus Owner."
                    });
                    return;
                }

                await sendVideoEditMenu(sock, from);
                return;
            }

            if (buttonId === "edit_video_story") {
                if (!isOwner(sender)) return;

                videoEditMode[sender] = true;

                await sock.sendMessage(from, {
                    text:
                        "🖼️ *MODE STORY EDIT*\n\n" +
                        "Kirim video dengan caption:\n" +
                        "`.storyedit Judul | Tag 1, Tag 2, Tag 3`\n\n" +
                        "Contoh:\n" +
                        "`.storyedit The Waterfall Vibes | Healing, Nature, Escape`\n\n" +
                        "Template visual dipilih otomatis agar hasilnya bervariasi.\n" +
                        "Ketik `.batal` untuk membatalkan."
                });
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

            // ==============================
// OWNER STORY VIDEO EDITOR
// ==============================
if (videoEditMode[sender] && isOwner(sender)) {
    const videoMessage = message.videoMessage;
    const caption = getMessageText(msg).trim();

    // 1. Opsi pembatalan
    if (caption === ".batal") {
        delete videoEditMode[sender];
        await sock.sendMessage(from, { text: "✅ Mode Story Edit dibatalkan." });
        return;
    }

    // 2. Jika bukan video atau caption tidak diawali .storyedit, abaikan saja atau batalkan mode
    if (!videoMessage || !caption.toLowerCase().startsWith(".storyedit ")) {
        // PERBAIKAN: Jangan kirim pesan peringatan otomatis terus-menerus
        // Cukup biarkan (return) atau hapus mode edit agar tidak terjebak
        return; 
    }

    const storyInput = caption.slice(".storyedit ".length).trim();
    const [rawTitle, rawTags = ""] = storyInput.split("|");
    const storyTitle = rawTitle.trim();
    const storyTags = rawTags.split(",").map((tag) => tag.trim()).filter(Boolean);

    if (!storyTitle) {
        await sock.sendMessage(from, {
            text: "⚠️ Judul tidak boleh kosong.\n\nContoh:\n`.storyedit The Waterfall Vibes | Healing, Nature, Escape`"
        });
        return;
    }

    await sock.sendMessage(from, {
        text: "⏳ Story Edit sedang diproses...\nTemplate visual akan dipilih secara otomatis."
    });

    try {
        const stream = await downloadContentFromMessage(videoMessage, "video");
        const chunks = [];

        for await (const chunk of stream) {
            chunks.push(chunk);
        }

        const sourceBuffer = Buffer.concat(chunks);

        if (!sourceBuffer.length) {
            throw new Error("Video gagal didownload dari WhatsApp.");
        }

        const edited = await renderStoryVideo(sourceBuffer, {
            title: storyTitle,
            tags: storyTags
        });

        await sock.sendMessage(
            from,
            {
                video: edited.buffer,
                mimetype: "video/mp4",
                fileName: "story-edit.mp4",
                caption: `✅ *Story Edit berhasil!*\n\n🎨 Template: ${edited.style}\n👑 Fitur khusus Owner.`
            },
            { quoted: msg }
        );
    } catch (error) {
        console.error("❌ Story Edit Error:", error.message);
        await sock.sendMessage(from, {
            text: "❌ Gagal mengedit video.\n\nPastikan @napi-rs/canvas dan FFmpeg sudah terpasang di VPS."
        });
    } finally {
        // PERBAIKAN: Selalu bersihkan status videoEditMode agar tidak menggantung
        delete videoEditMode[sender];
    }

    return;
}

            // ==============================
            // PUBLIC AI COMMAND
            // ==============================

            if (
                text.trim() === ".approve"
            ) {

                if (!isOwner(sender)) {

                    await sock.sendMessage(from, {
                        text:
                            "⛔ Hanya Owner yang dapat menerapkan perubahan AI."
                    });

                    return;
                }

                await sock.sendMessage(from, {
                    text:
                        "🔐 Memeriksa perubahan AI..."
                });

                try {

                    const result =
                        await approveStagedChanges();

                    await sock.sendMessage(from, {
                        text:
                            result.message
                    });

                } catch (error) {

                    console.error(
                        "❌ AI APPROVE ERROR:",
                        error
                    );

                    await sock.sendMessage(from, {
                        text:
                            "❌ Gagal menerapkan perubahan AI.\n\n" +
                            error.message
                    });
                }

                return;
            }


            if (
                text.trim() === ".tanya"
            ) {

                await sock.sendMessage(from, {
                    text:
                        "🤖 *IZZ BOT AI*\n\n" +
                        "Gunakan:\n\n" +
                        ".tanya pertanyaan kamu\n\n" +
                        "Contoh:\n" +
                        ".tanya jelaskan linked list\n\n" +
                        "Owner juga dapat meminta AI memeriksa " +
                        "atau memperbaiki source code bot."
                });

                return;
            }


            if (text.startsWith(".tanya ")) {

                if (!(await requireAiMode(sock, from))) {
                    return;
                }

                const promptInput = text.slice(7).trim();

                if (!promptInput) {
                    return;
                }

                const senderId =
                    msg.key.participant ||
                    msg.key.remoteJid;

                let imageBase64 = null;

                // 1. Cek apakah .tanya adalah reply foto.
                const quotedMessage =
                    msg.message?.extendedTextMessage
                        ?.contextInfo
                        ?.quotedMessage;

                if (quotedMessage) {
                    imageBase64 =
                        await downloadImageMessage({
                            message: quotedMessage
                        });
                }

                // 2. Kalau bukan reply, gunakan foto terakhir user
                // yang masih berada di cache.
                if (!imageBase64) {
                    const cached = lastUserImages.get(senderId);

                    if (cached) {
                        const age =
                            Date.now() - cached.timestamp;

                        if (age <= IMAGE_CACHE_TIME) {
                            imageBase64 = cached.image;
                        } else {
                            lastUserImages.delete(senderId);
                        }
                    }
                }

                await sock.sendMessage(
                    from,
                    {
                        text:
                            imageBase64
                                ? "🤖 IZZ BOT AI sedang membaca gambar dan memproses permintaan..."
                                : "🤖 IZZ BOT AI sedang berpikir..."
                    },
                    {
                        quoted: msg
                    }
                );

                try {
                    const owner = isOwner(sender);

                    console.log(
                        "🧪 [AI DEBUG] imageBase64:",
                        imageBase64
                            ? `ADA (${imageBase64.length} chars)`
                            : "TIDAK ADA"
                    );

                    console.log(
                        "🧪 [AI DEBUG] sender:",
                        sender
                    );

                    console.log(
                        "🤖 [AI] Memproses:",
                        imageBase64 ? "TEXT + IMAGE + AGENT" : "TEXT + AGENT"
                    );

                    const result = await runAgent({
                        prompt: promptInput,
                        owner,
                        images: imageBase64 ? [imageBase64] : []
                    });

                    if (result?.text) {
                        await sock.sendMessage(
                            from,
                            {
                                text: result.text
                            },
                            {
                                quoted: msg
                            }
                        );
                    }

                    // Kirim file yang dibuat AI ke WhatsApp.
                    const generatedFiles = Array.isArray(result?.files)
                        ? result.files
                        : [];

                    for (const file of generatedFiles) {
                        try {
                            if (!file || !fs.existsSync(file)) {
                                console.log(
                                    "⚠️ File AI tidak ditemukan:",
                                    file
                                );
                                continue;
                            }

                            const stat = fs.statSync(file);

                            if (stat.size > 20 * 1024 * 1024) {
                                throw new Error(
                                    "File lebih besar dari batas pengiriman 20 MB."
                                );
                            }

                            const filename =
                                path.basename(file);

                            const mimetype =
                                getFileMime(file);

                            console.log(
                                `📎 [AI FILE] Mengirim ${filename} (${stat.size} bytes)`
                            );

                            await sock.sendMessage(
                                from,
                                {
                                    document:
                                        fs.readFileSync(file),
                                    mimetype,
                                    fileName: filename,
                                    caption:
                                        `📁 ${filename}\n` +
                                        `Dibuat oleh IZZ BOT AI`
                                },
                                {
                                    quoted: msg
                                }
                            );

                            // File temporary dihapus setelah berhasil dikirim.
                            try {
                                await fsp.unlink(file);
                                console.log(
                                    "🗑️ [AI FILE] Temporary file dihapus:",
                                    file
                                );
                            } catch (cleanupError) {
                                console.log(
                                    "⚠️ Gagal menghapus temporary file:",
                                    cleanupError.message
                                );
                            }

                        } catch (fileError) {
                            console.error(
                                "❌ [AI FILE] Gagal mengirim:",
                                fileError
                            );

                            await sock.sendMessage(
                                from,
                                {
                                    text:
                                        "❌ File berhasil dibuat tetapi gagal dikirim.\n\n" +
                                        fileError.message
                                },
                                {
                                    quoted: msg
                                }
                            );
                        }
                    }

                    // Bila AI tidak menghasilkan teks dan tidak menghasilkan file,
                    // beri informasi yang jelas.
                    if (
                        !result?.text &&
                        generatedFiles.length === 0
                    ) {
                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    "⚠️ AI selesai memproses tetapi tidak menghasilkan jawaban atau file."
                            },
                            {
                                quoted: msg
                            }
                        );
                    }

                } catch (error) {

                    console.error(
                        "❌ AI AGENT ERROR:",
                        error
                    );

                    await sock.sendMessage(
                        from,
                        {
                            text:
                                "❌ AI gagal memproses permintaan.\n\n" +
                                error.message
                        },
                        {
                            quoted: msg
                        }
                    );
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
