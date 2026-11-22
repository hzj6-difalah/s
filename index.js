const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  MessageFlags,
} = require("discord.js");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const ffmpegStatic = require("ffmpeg-static");

const TOKEN = process.env.TOKEN || "YOUR_BOT_TOKEN_HERE";
const WATERMARK_TEXT = "Deep Vault";

function resolveFfmpegBin() {
  try {
    const sysBin = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
    if (sysBin) return sysBin;
  } catch (_) {}
  return ffmpegStatic;
}

const ffmpegPath = resolveFfmpegBin();
console.log("Using FFmpeg binary:", ffmpegPath);

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("OK");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP server listening on ${PORT}`);
  });

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const commands = [
  new SlashCommandBuilder()
    .setName("rights")
    .setDescription("إضافة حقوق Deep Vault وعبارة تزيين على فيديو أو صورة")
    .addAttachmentOption((option) =>
      option
        .setName("media")
        .setDescription("ارفق مقطع فيديو أو صورة")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("decoration")
        .setDescription("عبارة تزيين إضافية (اختياري)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("say")
    .setDescription("إرسال كلام مع إمكانية إرفاق صورة بدون حقوق")
    .addStringOption((option) =>
      option
        .setName("text")
        .setDescription("الكلام المطلوب إرساله")
        .setRequired(true)
    )
    .addAttachmentOption((option) =>
      option
        .setName("image")
        .setDescription("صورة اختيارية بدون حقوق")
        .setRequired(false)
    ),
].map((cmd) => cmd.toJSON());

function downloadFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(new Error("عدد كبير جداً من التحويلات أثناء تحميل الملف"));
    }

    const clientHttp = url.startsWith("https://") ? https : http;
    const file = fs.createWriteStream(destPath);

    const req = clientHttp.get(url, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        file.close();
        fs.unlink(destPath, () => {});
        return downloadFile(res.headers.location, destPath, redirects + 1)
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`فشل التحميل - الحالة ${res.statusCode}`));
      }

      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });

    req.setTimeout(30000, () => {
      req.destroy(new Error("انتهت مهلة تحميل الملف"));
    });

    req.on("error", (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function escapeDrawtext(str) {
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%");
}

function findFontFile() {
  const candidates = [
    path.join(__dirname, "font.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "C:\\Windows\\Fonts\\arialbd.ttf",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function detectMediaType(attachment) {
  const name = attachment.name || "";
  const type = attachment.contentType || "";

  if (type.startsWith("video/") || /\.(mp4|mov|mkv|avi|webm)$/i.test(name)) {
    return "video";
  }
  if (type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(name)) {
    return "image";
  }
  return null;
}

function buildFilterChain(decorationText, useFontFile, isVideo) {
  const safeMain = escapeDrawtext(WATERMARK_TEXT);
  const fontFile = useFontFile ? findFontFile() : null;
  const fontOpt = fontFile ? `fontfile='${escapeDrawtext(fontFile)}':` : "";

  const middleY = isVideo
    ? "(h-text_h)/2+(h*0.14)*sin(2*PI*t/3)"
    : "(h-text_h)/2";

  const top = `drawtext=${fontOpt}text='${safeMain}':fontcolor=white@0.85:fontsize=h*0.045:borderw=2:bordercolor=black@0.8:x=(w-text_w)/2:y=h*0.07`;
  const middle = `drawtext=${fontOpt}text='${safeMain}':fontcolor=white@0.92:fontsize=h*0.055:borderw=2.5:bordercolor=black@0.85:x=(w-text_w)/2:y=${middleY}`;
  const bottom = `drawtext=${fontOpt}text='${safeMain}':fontcolor=white@0.85:fontsize=h*0.045:borderw=2:bordercolor=black@0.8:x=(w-text_w)/2:y=h*0.88-text_h`;

  const list = [top, middle, bottom];

  if (decorationText && decorationText.trim().length > 0) {
    const safeDeco = escapeDrawtext(`* ${decorationText.trim()} *`);
    const deco = `drawtext=${fontOpt}text='${safeDeco}':fontcolor=white@0.8:fontsize=h*0.032:borderw=1.5:bordercolor=black@0.75:x=(w-text_w)/2:y=h*0.135`;
    list.push(deco);
  }

  return list.join(",");
}

function execFfmpegOnce(inputPath, outputPath, filterChain, isVideo) {
  return new Promise((resolve, reject) => {
    const args = isVideo
      ? [
          "-y",
          "-i",
          inputPath,
          "-vf",
          filterChain,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "26",
          "-threads",
          "1",
          "-max_muxing_queue_size",
          "1024",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-movflags",
          "+faststart",
          outputPath,
        ]
      : [
          "-y",
          "-i",
          inputPath,
          "-vf",
          filterChain,
          "-frames:v",
          "1",
          "-q:v",
          "3",
          outputPath,
        ];

    const proc = spawn(ffmpegPath, args);
    let stderr = "";

    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("error", (err) => reject(err));

    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        reject(new Error(stderr.slice(-800) || `FFmpeg exit code ${code}`));
      }
    });
  });
}

async function runFfmpegWatermark(inputPath, outputPath, decorationText, isVideo) {
  try {
    await execFfmpegOnce(
      inputPath,
      outputPath,
      buildFilterChain(decorationText, true, isVideo),
      isVideo
    );
  } catch (firstErr) {
    console.error("FFmpeg attempt 1 failed:", firstErr.message);
    await execFfmpegOnce(
      inputPath,
      outputPath,
      buildFilterChain(decorationText, false, isVideo),
      isVideo
    );
  }
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "say") {
    const text = interaction.options.getString("text", true);
    const image = interaction.options.getAttachment("image");

    if (image) {
      const okType =
        (image.contentType && image.contentType.startsWith("image/")) ||
        /\.(png|jpe?g|gif|webp)$/i.test(image.name || "");
      if (!okType) {
        return interaction.reply({
          content: "المرفق في /say لازم يكون صورة.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    try {
      const files = image
        ? [
            new AttachmentBuilder(image.url, {
              name: image.name || "image.png",
            }),
          ]
        : [];

      await interaction.channel.send({ content: text, files });
      await interaction.reply({
        content: "تم",
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      console.error("Error in /say:", err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "تعذر إرسال الرسالة، تأكد من صلاحيات البوت في الروم.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }
    return;
  }

  if (interaction.commandName === "rights") {
    const media = interaction.options.getAttachment("media", true);
    const decoration = interaction.options.getString("decoration") || "";
    const mediaType = detectMediaType(media);

    if (!mediaType) {
      return interaction.reply({
        content:
          "ارفق ملف فيديو (mp4, mov, mkv, webm) أو صورة (png, jpg, jpeg, webp).",
        flags: MessageFlags.Ephemeral,
      });
    }

    const isVideo = mediaType === "video";
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const baseTmp = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
    const workDir = fs.mkdtempSync(path.join(baseTmp, "dv-"));
    const ext =
      path.extname(media.name || (isVideo ? ".mp4" : ".png")) ||
      (isVideo ? ".mp4" : ".png");
    const inFile = path.join(workDir, `in${ext}`);
    const outFile = path.join(workDir, isVideo ? "out.mp4" : "out.png");

    try {
      await downloadFile(media.url, inFile);
      await runFfmpegWatermark(inFile, outFile, decoration, isVideo);

      const file = new AttachmentBuilder(outFile, {
        name: isVideo
          ? `Deep_Vault_${Date.now()}.mp4`
          : `Deep_Vault_${Date.now()}.png`,
      });

      const replyText = isVideo
        ? decoration
          ? `تمت إضافة حقوق **${WATERMARK_TEXT}** وعبارة التزيين (**${decoration}**) على الفيديو.`
          : `تمت إضافة حقوق **${WATERMARK_TEXT}** (فوق، وسط متحركة فوق وتحت، وتحت) على الفيديو.`
        : decoration
          ? `تمت إضافة حقوق **${WATERMARK_TEXT}** وعبارة التزيين (**${decoration}**) على الصورة.`
          : `تمت إضافة حقوق **${WATERMARK_TEXT}** (فوق، وسط، وتحت) على الصورة.`;

      try {
        await interaction.channel.send({
          content: replyText,
          files: [file],
        });
      } catch (sendErr) {
        console.error("Failed sending /rights output to channel:", sendErr);
        await interaction.editReply({
          content:
            "تمت معالجة الملف لكن تعذر إرساله في الروم، تأكد من صلاحيات البوت.",
        });
        return;
      }

      await interaction.editReply({
        content: "تم",
      });
    } catch (err) {
      console.error("Error in /rights:", err.message || err);
      await interaction.editReply({
        content:
          "فشلت معالجة الملف. تأكد أن الملف غير تالف وحجمه مناسب لموارد الاستضافة.",
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
});

client.login(TOKEN);
