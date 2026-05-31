require("dotenv").config();
const express = require("express");
const { execFile } = require("child_process");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const YTDLP_PATH  = process.env.YTDLP_PATH  || "yt-dlp";
const FFMPEG_PATH = process.env.FFMPEG_PATH  || "ffmpeg";
const PORT        = process.env.PORT         || 3000;
const HOST        = process.env.HOST         || `http://localhost:${PORT}`;
const TTL_MS      = 2 * 60 * 1000; // 5 minutes

const DOWNLOAD_DIR = path.join(__dirname, "downloads");

// ─── Ensure downloads folder exists ──────────────────────────────────────────
async function ensureDownloadDir() {
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
}
ensureDownloadDir();

// ─── Serve files from /downloads (token-protected) ───────────────────────────
// Files are only accessible via their unique token filename — no directory listing
app.use("/downloads", express.static(DOWNLOAD_DIR, { index: false }));

// Block directory listing
app.get("/downloads", (_req, res) => res.status(403).json({ error: "Forbidden" }));

// ─── yt-dlp download ─────────────────────────────────────────────────────────
function ytdlpDownload(youtubeUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      youtubeUrl,
      "--cookies",
      "./cookies.txt",
      "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "-o", outputPath,
      "--no-playlist",
      "--no-warnings",
    ];

    if (FFMPEG_PATH && FFMPEG_PATH !== "ffmpeg") {
      args.push("--ffmpeg-location", FFMPEG_PATH);
    }

    execFile(YTDLP_PATH, args, { timeout: 300_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`yt-dlp failed: ${stderr || error.message}`));
      else resolve();
    });
  });
}

// ─── Schedule file deletion after TTL ────────────────────────────────────────
function scheduleDelete(filePath) {
  setTimeout(async () => {
    try {
      await fsp.unlink(filePath);
      console.log(`  🗑️  Deleted: ${path.basename(filePath)}`);
    } catch {
      // already gone
    }
  }, TTL_MS);
}

// ─── Startup: clean any leftover files from previous runs ────────────────────
async function cleanDownloadDir() {
  try {
    const files = await fsp.readdir(DOWNLOAD_DIR);
    await Promise.all(files.map(f => fsp.unlink(path.join(DOWNLOAD_DIR, f)).catch(() => {})));
    if (files.length) console.log(`🧹 Cleaned ${files.length} leftover file(s) from downloads/`);
  } catch {}
}
cleanDownloadDir();

// ─── Core logic ──────────────────────────────────────────────────────────────
async function processYouTubeUrl(youtubeUrl) {
  // Random token makes the URL unguessable
  const token    = crypto.randomBytes(16).toString("hex");
  const filename = `${token}.mp4`;
  const filePath = path.join(DOWNLOAD_DIR, filename);

  console.log(`  ⬇️  Downloading via yt-dlp...`);
  await ytdlpDownload(youtubeUrl, filePath);

  const stat = await fsp.stat(filePath);
  const fileSizeMB = +(stat.size / 1024 / 1024).toFixed(1);
  console.log(`  ✅ Downloaded: ${fileSizeMB} MB`);

  // Build the download URL
  const downloadUrl = `${HOST}/downloads/${filename}`;

  // Auto-delete after 5 min
  scheduleDelete(filePath);
  console.log(`  ⏳ File will be deleted in 2 minutes`);

  return {
    success:     true,
    downloadUrl,
    fileSizeMB,
    expiresIn:   "2 minutes",
    expiresAt:   new Date(Date.now() + TTL_MS).toISOString(),
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.post("/download", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "Missing 'url' in body" });

  console.log(`\n[${new Date().toISOString()}] POST /download → ${url}`);
  try {
    const result = await processYouTubeUrl(url);
    console.log(`  🎉 ${result.downloadUrl}`);
    res.json(result);
  } catch (err) {
    console.error(`  ❌ ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/download", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, error: "Missing 'url' query param" });

  console.log(`\n[${new Date().toISOString()}] GET /download → ${url}`);
  try {
    const result = await processYouTubeUrl(url);
    console.log(`  🎉 ${result.downloadUrl}`);
    res.json(result);
  } catch (err) {
    console.error(`  ❌ ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/", (_req, res) => res.json({ status: "ok", message: "YouTube Downloader API" }));

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀  http://localhost:${PORT}`);
  console.log(`📁  Serving files from: ./downloads/`);
  console.log(`⏳  Files auto-deleted after 2 minutes`);
  console.log(`📡  POST /download  { "url": "https://youtu.be/..." }`);
  console.log(`📡  GET  /download?url=https://youtu.be/...`);
});
