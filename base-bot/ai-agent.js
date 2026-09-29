"use strict";

const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const {
    Document,
    Packer,
    Paragraph,
    HeadingLevel
} = require("docx");
const PptxGenJS = require("pptxgenjs");
const PDFDocument = require("pdfkit");

const execFileAsync = promisify(execFile);

const OLLAMA_URL =
    process.env.OLLAMA_URL ||
    "http://127.0.0.1:11434";

const TEXT_MODEL =
    process.env.OLLAMA_TEXT_MODEL ||
    "qwen3:4b";

const VISION_MODEL =
    process.env.OLLAMA_VISION_MODEL ||
    "qwen2.5vl:3b";

const BOT_DIR =
    process.env.BOT_DIR ||
    "/opt/wa-bot";

const STAGING_DIR =
    path.join(BOT_DIR, ".ai-staging");

const BACKUP_DIR =
    path.join(BOT_DIR, ".ai-backups");

const MAX_FILE_SIZE =
    500 * 1024;

fs.ensureDirSync(STAGING_DIR);
fs.ensureDirSync(BACKUP_DIR);

// ============================================================
// SECURITY
// ============================================================

function safeProjectPath(relativePath) {
    if (!relativePath) {
        throw new Error("Path kosong.");
    }

    const normalized =
        path.normalize(String(relativePath))
            .replace(/^(\.\.(\/|\\|$))+/, "");

    const full =
        path.resolve(BOT_DIR, normalized);

    const root =
        path.resolve(BOT_DIR);

    if (
        full !== root &&
        !full.startsWith(root + path.sep)
    ) {
        throw new Error(
            "Path berada di luar project."
        );
    }

    return full;
}

function cleanAIText(text) {
    return String(text || "")
        .replace(/\*\*/g, "")
        .replace(/```[\w-]*\n?/g, "")
        .replace(/```/g, "")
        .trim();
}

function normalizeToolArguments(args) {
    if (!args) return {};

    if (typeof args === "object") {
        return args;
    }

    if (typeof args === "string") {
        try {
            return JSON.parse(args);
        } catch {
            return {};
        }
    }

    return {};
}

// ============================================================
// OLLAMA
// ============================================================

async function ollamaChat({
    messages,
    model,
    tools
}) {
    const payload = {
        model,
        messages,
        stream: false,
        keep_alive: "1m",
        options: {
            num_ctx: 2048,
            temperature: 0.4
        }
    };

    if (tools) {
        payload.tools = tools;
    }

    const response =
        await axios.post(
            `${OLLAMA_URL}/api/chat`,
            payload,
            {
                timeout: 10 * 60 * 1000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

    return response.data;
}

// Vision dipisahkan dari agent tool-calling.
// Ini penting untuk VPS 4 GB: vision membaca gambar,
// kemudian model teks menangani action seperti create_pdf.
async function analyzeImage(imageBase64, userPrompt) {
    const response =
        await ollamaChat({
            model: VISION_MODEL,
            messages: [
                {
                    role: "user",
                    content:
                        `Baca dan analisis gambar ini untuk membantu permintaan pengguna.

Permintaan pengguna:
${userPrompt}

Jelaskan informasi penting yang terlihat pada gambar secara akurat.
Jika ada teks/soal, salin bagian yang relevan.
Jika ada bagian yang tidak terbaca, katakan dengan jelas.
Jangan mengarang informasi.`,
                    images: [imageBase64]
                }
            ]
        });

    return response?.message?.content?.trim() || "";
}

// ============================================================
// PROJECT TOOLS
// ============================================================

async function listProjectFiles() {
    const result = [];

    async function walk(dir, relative = "") {
        const entries =
            await fs.readdir(
                dir,
                { withFileTypes: true }
            );

        for (const entry of entries) {
            if (
                entry.name === "node_modules" ||
                entry.name === ".git" ||
                entry.name === ".ai-staging" ||
                entry.name === ".ai-backups"
            ) {
                continue;
            }

            const rel =
                path.join(
                    relative,
                    entry.name
                );

            const full =
                path.join(
                    dir,
                    entry.name
                );

            if (entry.isDirectory()) {
                await walk(full, rel);
            } else {
                result.push(rel);
            }
        }
    }

    await walk(BOT_DIR);

    return result.slice(0, 1000);
}

async function readProjectFile(relativePath) {
    const full =
        safeProjectPath(relativePath);

    const stat =
        await fs.stat(full);

    if (stat.size > MAX_FILE_SIZE) {
        throw new Error(
            "File terlalu besar untuk dibaca AI."
        );
    }

    return await fs.readFile(
        full,
        "utf8"
    );
}

async function readPM2Log() {
    const candidates = [
        "/root/.pm2/logs/wabot-error.log",
        "/root/.pm2/logs/wabot-out.log"
    ];

    let output = "";

    for (const file of candidates) {
        if (!await fs.pathExists(file)) {
            continue;
        }

        const content =
            await fs.readFile(
                file,
                "utf8"
            );

        output +=
            `\n===== ${file} =====\n` +
            content.slice(-20000);
    }

    return output ||
        "Log PM2 tidak ditemukan.";
}

// ============================================================
// STAGING / CODE FIX
// ============================================================

async function stageFile(relativePath, content) {
    safeProjectPath(relativePath);

    if (!content) {
        throw new Error(
            "Isi file kosong."
        );
    }

    const stageName =
        String(relativePath)
            .replace(/[\/\\]/g, "__");

    const staged =
        path.join(
            STAGING_DIR,
            stageName
        );

    await fs.writeFile(
        staged,
        content,
        "utf8"
    );

    return {
        relativePath,
        staged,
        size: Buffer.byteLength(content)
    };
}

async function testNodeSyntax(relativePath) {
    const full =
        safeProjectPath(relativePath);

    const ext =
        path.extname(full)
            .toLowerCase();

    if (ext !== ".js" && ext !== ".cjs") {
        return {
            ok: true,
            message:
                "Bukan file JavaScript, syntax check dilewati."
        };
    }

    try {
        await execFileAsync(
            "node",
            ["--check", full],
            {
                timeout: 60000
            }
        );

        return {
            ok: true,
            message:
                "Syntax JavaScript valid."
        };

    } catch (error) {
        return {
            ok: false,
            message:
                error.stderr ||
                error.message
        };
    }
}

async function applyStagedFile(relativePath) {
    const full =
        safeProjectPath(relativePath);

    const stageName =
        String(relativePath)
            .replace(/[\/\\]/g, "__");

    const staged =
        path.join(
            STAGING_DIR,
            stageName
        );

    if (!await fs.pathExists(staged)) {
        throw new Error(
            "Tidak ada perubahan yang menunggu approval."
        );
    }

    const backupName =
        `${Date.now()}-${path.basename(relativePath)}`;

    const backup =
        path.join(
            BACKUP_DIR,
            backupName
        );

    if (await fs.pathExists(full)) {
        await fs.copy(
            full,
            backup
        );
    }

    await fs.copy(
        staged,
        full
    );

    return {
        relativePath,
        backup
    };
}

async function restartPM2() {
    try {
        const result =
            await execFileAsync(
                "pm2",
                ["restart", "wabot"],
                {
                    timeout: 120000
                }
            );

        return {
            ok: true,
            output:
                result.stdout ||
                "PM2 restart berhasil."
        };

    } catch (error) {
        return {
            ok: false,
            output:
                error.stderr ||
                error.message
        };
    }
}

// ============================================================
// DOCUMENT GENERATORS
// ============================================================

async function createDOCX(title, sections) {
    const children = [];

    children.push(
        new Paragraph({
            text:
                title ||
                "Dokumen",
            heading:
                HeadingLevel.TITLE
        })
    );

    for (const section of sections || []) {
        if (section.heading) {
            children.push(
                new Paragraph({
                    text:
                        section.heading,
                    heading:
                        HeadingLevel.HEADING_1
                })
            );
        }

        if (section.text) {
            const paragraphs =
                String(section.text)
                    .split(/\n+/);

            for (const paragraph of paragraphs) {
                if (paragraph.trim()) {
                    children.push(
                        new Paragraph({
                            text:
                                paragraph.trim()
                        })
                    );
                }
            }
        }
    }

    const doc =
        new Document({
            sections: [{
                properties: {},
                children
            }]
        });

    const buffer =
        await Packer.toBuffer(doc);

    const filename =
        `izz-ai-${Date.now()}.docx`;

    const output =
        path.join(
            os.tmpdir(),
            filename
        );

    await fs.writeFile(
        output,
        buffer
    );

    return output;
}

async function createPPTX(title, slides) {
    const pptx =
        new PptxGenJS();

    pptx.author =
        "IZZ BOT AI";

    pptx.subject =
        title ||
        "Presentasi";

    pptx.title =
        title ||
        "Presentasi";

    for (const slideData of slides || []) {
        const slide =
            pptx.addSlide();

        slide.addText(
            slideData.title || "",
            {
                x: 0.6,
                y: 0.4,
                w: 12,
                h: 0.7,
                fontSize: 28,
                bold: true
            }
        );

        slide.addText(
            slideData.content || "",
            {
                x: 0.8,
                y: 1.4,
                w: 11.5,
                h: 5,
                fontSize: 18,
                valign: "top",
                margin: 0.05
            }
        );
    }

    const filename =
        `izz-ai-${Date.now()}.pptx`;

    const output =
        path.join(
            os.tmpdir(),
            filename
        );

    await pptx.writeFile({
        fileName: output
    });

    return output;
}

async function createPDF(title, sections) {
    const filename =
        `izz-ai-${Date.now()}.pdf`;

    const output =
        path.join(
            os.tmpdir(),
            filename
        );

    const doc =
        new PDFDocument({
            margin: 60
        });

    const stream =
        fs.createWriteStream(output);

    doc.pipe(stream);

    doc.fontSize(22)
        .text(
            title ||
            "Dokumen",
            {
                align: "center"
            }
        );

    doc.moveDown();

    for (const section of sections || []) {
        if (section.heading) {
            doc.fontSize(16)
                .text(section.heading);

            doc.moveDown(0.4);
        }

        if (section.text) {
            doc.fontSize(11)
                .text(
                    section.text,
                    {
                        align: "justify"
                    }
                );

            doc.moveDown();
        }
    }

    doc.end();

    await new Promise(
        (resolve, reject) => {
            stream.on("finish", resolve);
            stream.on("error", reject);
        }
    );

    return output;
}

// ============================================================
// TOOLS
// ============================================================

const TOOLS = [
    {
        type: "function",
        function: {
            name: "list_project_files",
            description:
                "Melihat daftar file project IZZ BOT. Gunakan untuk debugging owner.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "read_project_file",
            description:
                "Membaca source code project IZZ BOT. Khusus owner.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description:
                            "Path relatif terhadap /opt/wa-bot"
                    }
                },
                required: ["path"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "read_pm2_log",
            description:
                "Membaca log PM2 wabot. Khusus owner.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "stage_code_change",
            description:
                "Menyiapkan perubahan source code untuk approval owner. Jangan langsung menerapkan.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string"
                    },
                    content: {
                        type: "string"
                    },
                    reason: {
                        type: "string"
                    }
                },
                required: [
                    "path",
                    "content",
                    "reason"
                ]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "test_node_syntax",
            description:
                "Memeriksa syntax JavaScript.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string"
                    }
                },
                required: ["path"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "create_docx",
            description:
                "WAJIB digunakan jika pengguna meminta membuat file Word/DOCX.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    sections: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                heading: {
                                    type: "string"
                                },
                                text: {
                                    type: "string"
                                }
                            }
                        }
                    }
                },
                required: [
                    "title",
                    "sections"
                ]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "create_pptx",
            description:
                "WAJIB digunakan jika pengguna meminta membuat file PowerPoint/PPT/PPTX.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    slides: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                title: {
                                    type: "string"
                                },
                                content: {
                                    type: "string"
                                }
                            }
                        }
                    }
                },
                required: [
                    "title",
                    "slides"
                ]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "create_pdf",
            description:
                "WAJIB digunakan jika pengguna meminta membuat, menghasilkan, atau mengirim file PDF. Jangan hanya memberi langkah mencari PDF.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    sections: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                heading: {
                                    type: "string"
                                },
                                text: {
                                    type: "string"
                                }
                            }
                        }
                    }
                },
                required: [
                    "title",
                    "sections"
                ]
            }
        }
    }
];

async function executeTool(name, args) {
    args =
        normalizeToolArguments(args);

    switch (name) {
        case "list_project_files":
            return await listProjectFiles();

        case "read_project_file":
            return await readProjectFile(
                args.path
            );

        case "read_pm2_log":
            return await readPM2Log();

        case "stage_code_change":
            return await stageFile(
                args.path,
                args.content
            );

        case "test_node_syntax":
            return await testNodeSyntax(
                args.path
            );

        case "create_docx":
            return {
                file:
                    await createDOCX(
                        args.title,
                        args.sections
                    )
            };

        case "create_pptx":
            return {
                file:
                    await createPPTX(
                        args.title,
                        args.slides
                    )
            };

        case "create_pdf":
            return {
                file:
                    await createPDF(
                        args.title,
                        args.sections
                    )
            };

        default:
            throw new Error(
                `Tool tidak dikenal: ${name}`
            );
    }
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt({ owner }) {
    return `
Kamu adalah IZZ BOT AI.

Kamu adalah asisten AI pribadi yang terhubung langsung
dengan bot WhatsApp IZZ BOT.

GAYA JAWAB:
- Bahasa Indonesia.
- Santai tetapi jelas.
- Jangan menggunakan markdown berlebihan.
- Jangan menggunakan ** untuk penekanan.
- Jangan mengarang hasil pemeriksaan.
- Jika diminta membuat file, benar-benar gunakan tool pembuat file.

KEMAMPUAN:
1. Menjawab pertanyaan.
2. Membantu tugas kuliah.
3. Menganalisis hasil pembacaan gambar.
4. Membantu memahami source code.
5. Membuat DOCX/Word.
6. Membuat PPTX/PowerPoint.
7. Membuat PDF.

ATURAN FILE:
- Jika pengguna meminta PDF, WAJIB memanggil create_pdf.
- Jika pengguna meminta Word/DOCX, WAJIB memanggil create_docx.
- Jika pengguna meminta PPT/PowerPoint/PPTX, WAJIB memanggil create_pptx.
- Jangan menyuruh pengguna mencari file di internet jika pengguna meminta kamu membuat file.
- Setelah tool berhasil, berikan jawaban singkat bahwa file dibuat.
- Jangan mengklaim file dibuat jika tool belum berhasil.

${owner ? `
MODE OWNER AKTIF.

Owner adalah developer IZZ BOT.

Owner dapat meminta:
- memeriksa bot
- membaca source code
- membaca PM2 log
- mencari error
- memperbaiki kode
- menambahkan fitur
- melakukan refactor

ATURAN DEVELOPER:
1. Jangan menebak.
2. Gunakan list_project_files.
3. Baca file yang relevan.
4. Jika perlu baca PM2 log.
5. Cari akar masalah.
6. Buat perubahan.
7. Gunakan stage_code_change.
8. Jalankan test_node_syntax.
9. Jangan menganggap perubahan sudah aktif.
10. Beritahu owner bahwa perubahan menunggu .approve.

JANGAN PERNAH:
- menghapus seluruh project
- menghapus database tanpa instruksi jelas
- mengubah credentials secara sembarangan
- mengklaim perubahan aktif sebelum approval

Jika owner meminta fitur baru:
- pahami struktur bot terlebih dahulu
- pertahankan fitur lama
- integrasikan dengan struktur yang sudah ada
- jangan membuat bot baru dari nol
- stage perubahan
- lakukan syntax check
- tunggu .approve
` : `
MODE USER.

Kamu hanya boleh membantu:
- pertanyaan
- coding umum
- analisis gambar
- dokumen
- tugas
- PPT
- PDF

Kamu TIDAK boleh membaca atau mengubah source code internal
IZZ BOT.
`}

Jika pengguna meminta makalah:
buat struktur yang wajar seperti judul, pendahuluan,
pembahasan, kesimpulan, dan daftar pustaka jika diminta.

Jika pengguna meminta PPT:
buat slide yang tidak terlalu penuh.

Jika pengguna meminta PDF:
buat materi yang benar-benar berguna dan terstruktur,
bukan sekadar menyarankan mencari PDF.
`;
}

// ============================================================
// MAIN AGENT
// ============================================================

async function runAgent({
    prompt,
    owner = false,
    images = []
}) {
    let workingPrompt = prompt;

    // Vision selalu dilakukan terpisah.
    // Hasil vision kemudian diberikan ke model teks/tool-calling.
    if (images.length) {
        const visionText =
            await analyzeImage(
                images[0],
                prompt
            );

        workingPrompt =
            `${prompt}

HASIL ANALISIS GAMBAR:
${visionText}

Gunakan hasil analisis gambar di atas sebagai konteks.
Jika pengguna meminta membuat file, gunakan tool file yang sesuai.`;
    }

    const messages = [
        {
            role: "system",
            content:
                buildSystemPrompt({ owner })
        },
        {
            role: "user",
            content: workingPrompt
        }
    ];

    const availableTools =
        owner
            ? TOOLS
            : TOOLS.filter(tool => [
                "create_docx",
                "create_pptx",
                "create_pdf"
            ].includes(
                tool.function.name
            ));

    const files = [];

    for (let round = 0; round < 8; round++) {
        const response =
            await ollamaChat({
                model: TEXT_MODEL,
                messages,
                tools: availableTools
            });

        const message =
            response?.message;

        if (!message) {
            throw new Error(
                "Ollama tidak mengembalikan message."
            );
        }

        messages.push(message);

        const toolCalls =
            message.tool_calls || [];

        if (!toolCalls.length) {
            return {
                text:
                    cleanAIText(
                        message.content
                    ),
                files
            };
        }

        for (const call of toolCalls) {
            const name =
                call.function?.name;

            const args =
                normalizeToolArguments(
                    call.function?.arguments
                );

            console.log(
                `🤖 AI TOOL: ${name}`,
                args
            );

            try {
                const result =
                    await executeTool(
                        name,
                        args
                    );

                if (
                    result &&
                    result.file
                ) {
                    files.push(
                        result.file
                    );
                }

                messages.push({
                    role: "tool",
                    content:
                        JSON.stringify(result)
                });

            } catch (error) {
                console.error(
                    `❌ AI TOOL ERROR: ${name}`,
                    error
                );

                messages.push({
                    role: "tool",
                    content:
                        JSON.stringify({
                            error:
                                error.message
                        })
                });
            }
        }

        // Setelah tool dijalankan, model wajib mendapat
        // kesempatan untuk memberikan respons akhir.
    }

    return {
        text:
            "AI berhenti setelah batas proses tool tercapai.",
        files
    };
}

// ============================================================
// APPROVAL
// ============================================================

async function approveStagedChanges() {
    const files =
        await fs.readdir(
            STAGING_DIR
        );

    if (!files.length) {
        return {
            ok: false,
            message:
                "Tidak ada perubahan AI yang menunggu approval."
        };
    }

    const applied = [];

    for (const file of files) {
        const separator = "__";

        const relativePath =
            file.split(separator)
                .join(path.sep);

        const result =
            await applyStagedFile(
                relativePath
            );

        applied.push(result);
    }

    const syntaxResults = [];

    for (const item of applied) {
        syntaxResults.push(
            await testNodeSyntax(
                item.relativePath
            )
        );
    }

    const invalid =
        syntaxResults.some(
            result => !result.ok
        );

    if (invalid) {
        return {
            ok: false,
            message:
                "Perubahan tidak dijalankan karena syntax check gagal.",
            applied,
            syntaxResults
        };
    }

    const restart =
        await restartPM2();

    return {
        ok:
            restart.ok,
        message:
            restart.ok
                ? "Perubahan diterapkan dan PM2 berhasil direstart."
                : "Perubahan diterapkan tetapi restart PM2 gagal.",
        applied,
        restart
    };
}

module.exports = {
    runAgent,
    approveStagedChanges,
    readPM2Log
};
