#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
let Tesseract = null;
try {
  Tesseract = require("tesseract.js");
} catch (e) {}

// ─── READLINE BERSAMA (satu instance untuk semua prompt) ─────────────────────
// Penting: jangan buat readline baru per prompt — dua interface di stdin yang
// sama bikin ketikan dobel ("1" jadi "11") dan menu tiba-tiba keluar.
let __rl = null;
function getAsk() {
  const readline = require("readline");
  if (!__rl) {
    __rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return (q) => new Promise((r) => __rl.question(q, r));
}

// ─── FILE PENYIMPANAN ───────────────────────────────────────────────────────
const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, "warkrs-config.json");
const STATE_FILE = path.join(DIR, "warkrs-state.json");

const DEFAULT_CONFIG = {
  BASE_URL: "https://siakad.itera.ac.id",
  KRS_PAGE: "/mahasiswa/krsbaru/pilihmk",     // Langkah-2 wizard KRS (dropdown matkul) — verified
  ENDPOINT: "/mahasiswa/krsbaru/simpanKRS",  // Endpoint daftar KRS (verified, form tanpa CSRF)
  COURSE_ID_FIELD: "idkelas",                // Field ID kelas di payload (verified)
  EXTRA_FIELDS: "",                          // Field tambahan payload, mis: "foo=bar&x=1"
  RETRY_DELAY_MS: 5000,                      // Jeda antar percobaan (ms)
  RETRY_JITTER_MS: 3000,                     // Jitter acak biar tidak terlihat bot (ms)
  SPAM_LIMIT: 0,                             // 0 = spam terus sampai sukses/Ctrl+C
  BATCH_DELAY_MS: 2000,                      // Jeda antar matkul berbeda (ms)
  SECURITY_COOLDOWN_MS: 45000,               // Cooldown awal kalau kena challenge (ms)
  RELOAD_EVERY_ATTEMPTS: 15,                 // Reload halaman tiap N percobaan (refresh token)
  HTTP_TIMEOUT_MS: 60000,                    // Timeout halaman (ms)
  SOUND_ON: true,                            // Beep saat berhasil
  TELEGRAM_BOT_TOKEN: "",                    // Isi jika pakai notif Telegram
  TELEGRAM_CHAT_ID: "",                      // Chat ID / user ID Telegram kamu
  BROWSER_PATH: "",                          // Path browser manual (kosongkan = pakai BROWSER)
  BROWSER: "auto",                           // Pilihan browser: auto | chrome | brave
  USE_REAL_PROFILE: true,                    // true = pakai profil asli (harus tutup browser dulu), false = profil terpisah
  DEBUG_RESPONSE: false,                     // true = simpan respons mentah gagal ke warkrs-debug.txt
  AUTO_STOP_SKS: true,                       // true = hentikan war otomatis saat SKS sudah penuh
  SIAKAD_USERNAME: "",                       // NIM/login SIAKAD (untuk login ulang otomatis)
  SIAKAD_PASSWORD: "",                       // Password SIAKAD (untuk login ulang otomatis)
};

// ─── LOAD / SAVE ────────────────────────────────────────────────────────────
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function saveJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    log(`Gagal menulis ${path.basename(file)}: ${e.message}`, "error");
  }
}

const CONFIG = Object.assign({}, DEFAULT_CONFIG, loadJson(CONFIG_FILE, {}));
const state = Object.assign(
  { courses: [], available: [], aborted: false },
  loadJson(STATE_FILE, {})
);

function persist() {
  saveJson(STATE_FILE, {
    courses: state.courses,
    available: state.available,
    updatedAt: new Date().toISOString(),
  });
}

function saveConfig() {
  saveJson(CONFIG_FILE, CONFIG);
}

// ─── TERMINAL OUTPUT (ANSI colors) ──────────────────────────────────────────
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
const TYPE_COLOR = { info: ANSI.cyan, success: ANSI.green, warn: ANSI.yellow, error: ANSI.red };

function ts() {
  return new Date().toLocaleTimeString("id-ID");
}

// Baris status live (overwrite sendiri, tidak menumpuk log)
let statusLine = "";

// ── Panel mode (UI di browser) ─────────────────────────────────────────────
const PANEL_PORT = 8765;
const PANEL_URL = `http://127.0.0.1:${PANEL_PORT}/`;
let panelLogs = [];
let panelLogSeq = 0;
let panelLastStatus = "";
let panelSks = {};
let panelBrowser = null;
let panelPage = null;
let warActive = false;
let securityStrike = 0; // jumlah kenangan Cloudflare beruntun → backoff bertahap

// Cooldown Cloudflare naik bertahap tiap kena beruntun (45s → 90s → 180s → …,
// maks 5 menit). Strike pertama = cooldown DASAR (bukan 2×), reset ke 0
// setelah challenge berhasil dilewati atau ada respons normal.
function securityCooldownMs() {
  const base = CONFIG.SECURITY_COOLDOWN_MS || 45000;
  const mult = Math.pow(2, Math.min(Math.max(securityStrike - 1, 0), 3));
  return Math.min(base * mult, 300000);
}

function pushPanelLog(type, msg, sound) {
  panelLogs.push({ seq: ++panelLogSeq, ts: ts(), type, msg, sound: sound || "" });
  if (panelLogs.length > 500) panelLogs.splice(0, panelLogs.length - 500);
}

function log(msg, type = "info", opts) {
  clearStatus();
  pushPanelLog(type, msg, opts && opts.sound);
  if (opts && opts.sound) playSound(opts.sound);
  const c = TYPE_COLOR[type] || ANSI.reset;
  console.log(c + msg + ANSI.reset);
}

function renderStatus(text) {
  panelLastStatus = String(text || "");
  if (statusLine.length) process.stdout.write("\r" + " ".repeat(statusLine.length) + "\r");
  process.stdout.write(text);
  statusLine = text;
}

function clearStatus() {
  if (statusLine.length) {
    process.stdout.write("\r" + " ".repeat(statusLine.length) + "\r");
    statusLine = "";
  }
}

function shortMessage(s) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > 70 ? s.slice(0, 70) + "…" : s;
}

// ─── SOUND NOTIFIKASI (lintas platform) ─────────────────────────────────────
// Pola nada: [frekuensi Hz, durasi ms] berurutan. Diputar sebagai:
//   win32   → PowerShell [console]::beep
//   darwin  → afplay (suara sistem macOS)
//   linux   → generate WAV → paplay / pw-play / aplay / ffplay
const SOUND_PATTERNS = {
  success: [[660, 180], [880, 240]],
  cloudflare: [[400, 200], [400, 200], [320, 320]],
  error: [[280, 350]],
};

function makeWav(notes) {
  const sr = 16000;
  const samples = [];
  for (const [freq, ms] of notes) {
    const n = Math.floor((sr * ms) / 1000);
    for (let i = 0; i < n; i++) {
      samples.push(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 12000));
    }
    const gap = Math.floor((sr * 40) / 1000);
    for (let i = 0; i < gap; i++) samples.push(0);
  }
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  samples.forEach((s, i) => buf.writeInt16LE(s, 44 + i * 2));
  return buf;
}

function playSound(type) {
  if (!CONFIG.SOUND_ON) return;
  const notes = SOUND_PATTERNS[type] || SOUND_PATTERNS.error;
  try {
    const cp = require("child_process");
    if (process.platform === "win32") {
      const cmd = notes.map(([f, d]) => `[console]::beep(${f},${d})`).join(";");
      const p = cp.spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { stdio: "ignore", detached: true });
      p.on("error", () => {});
      p.unref();
    } else if (process.platform === "darwin") {
      const sound = type === "success"
        ? "/System/Library/Sounds/Glass.aiff"
        : type === "cloudflare"
          ? "/System/Library/Sounds/Sosumi.aiff"
          : "/System/Library/Sounds/Basso.aiff";
      const p = cp.spawn("afplay", [sound], { stdio: "ignore", detached: true });
      p.on("error", () => {});
      p.unref();
    } else {
      const os = require("os");
      const tmp = path.join(os.tmpdir(), `warkrs-sound-${Date.now()}.wav`);
      fs.writeFileSync(tmp, makeWav(notes));
      for (const player of ["paplay", "pw-play", "aplay", "ffplay"]) {
        const p = cp.spawn(player, [tmp], { stdio: "ignore", detached: true });
        p.on("error", () => {});
        p.unref();
        break;
      }
    }
  } catch (e) {}
}

function beep() {
  playSound("success");
}

// ─── UTIL ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sleepAbortable(ms) {
  const step = 200;
  let t = 0;
  while (t < ms && !state.aborted) {
    await sleep(Math.min(step, ms - t));
    t += step;
  }
}

// ─── PARSING INPUT TARGET ───────────────────────────────────────────────────
/**
 *   "43254 - Kapita Selekta - RA"   (idkelas diketahui)
 *   "Kapita Selekta - RA"           (nama + kelas → cari idkelas dari hasil scan)
 *   "IF25-41031 - RA"               (kode + kelas → cari idkelas dari hasil scan)
 */
function parseLine(line) {
  const cleanKelas = (s) => s.replace(/\s*[-–—]\s*$/, "").trim().toUpperCase();
  line = String(line || "").replace(/\s+/g, " ").trim();
  if (!line) return null;

  let id = "", kode = "", name = "", kelas = "";

  // Format hasil scan: "43106  IF25-21008 - Jaringan Komputer - RA"
  // → ambil idkelas numerik di awal (kalau ada), sisanya diproses sebagai label.
  const m = line.match(/^(\d[\d,]*)\s+(.+)$/);
  if (m) {
    id = m[1];
    line = m[2];
  }

  // Pecah label: "KODE - Nama - Kelas" / "Nama - Kelas" / "Nama"
  const parts = line.split(/\s*[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) {
    kode = parts[0];
    name = parts.slice(1, -1).join(" ");
    kelas = cleanKelas(parts[parts.length - 1]);
  } else if (parts.length === 2) {
    name = parts[0];
    kelas = cleanKelas(parts[1]);
  } else if (parts.length === 1) {
    if (/^\d[\d,]*$/.test(parts[0])) id = parts[0];
    else name = parts[0];
  }

  if (id && !/^[\d,]+$/.test(id)) id = "";
  return { id, kode, name, kelas };
}

function findAvailable(query, kelas) {
  const q = query.toLowerCase();
  const k = (kelas || "").toLowerCase();
  return state.available.filter((c) => {
    const matchQ =
      c.nama.toLowerCase().includes(q) ||
      c.kode.toLowerCase().includes(q) ||
      c.label.toLowerCase().includes(q);
    const matchK = !k || c.kelas.toLowerCase() === k;
    return matchQ && matchK;
  });
}

function courseLabel(course) {
  return course.kelas ? `${course.name} ${course.kelas}` : course.name;
}

function statusLabel(s) {
  return { antri: "⏳ antri", proses: "🔄 proses", berhasil: "✅ OK", gagal: "❌ gagal" }[s] || s;
}
// ─── ERROR ──────────────────────────────────────────────────────────────────
class WarError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "SESSION_EXPIRED" | "SECURITY" | "NETWORK" | "BROWSER"
  }
}

// ─── PARSING HTML SIAKAD ────────────────────────────────────────────────────
// Error permanen = spam tidak akan menyelesaikannya → matkul harus di-stop.
function isPermanentText(t) {
  return /(periode|pengisian).{0,30}(belum|tidak)|belum dibuka|masa pengisian|melebihi.{0,20}sks|sks.{0,20}(maksimal|terpenuhi|penuh)|jatah.{0,20}sks|bentrok|prasyarat|tidak ditemukan/i.test(
    String(t || "")
  );
}

/**
 * Analisis respons POST simpanKRS.
 * `signals` berisi hasil parsing DOMParser dari browser (alerts, modal, img).
 */
function analyzeEnrollResponse(status, contentType, text, finalUrl, signals) {
  if (/login/i.test(finalUrl || "") && !/csrf|simpan/i.test(finalUrl || "")) {
    return { sessionExpired: true, message: "Redirect ke halaman login." };
  }
  if (status === 419) {
    return { tokenExpired: true, message: "CSRF token kedaluwarsa (HTTP 419)." };
  }
  if (looksLikeSecurityPage(status, text)) {
    return { security: true, message: `Kena proteksi/Cloudflare (HTTP ${status}).` };
  }

  if (contentType.includes("json")) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { success: false, message: `HTTP ${status} | JSON tidak valid` };
    }
    const msg = json.message || json.msg || JSON.stringify(json);
    if (/csrf|token mismatch/i.test(msg)) return { tokenExpired: true, message: msg };
    const ok =
      json.status === "success" ||
      json.success === true ||
      json.result === "success" ||
      json.status === "berhasil" ||
      (status >= 200 && status < 300 && !json.error);
    if (ok) return { success: true, message: msg };
    return { success: false, permanent: isPermanentText(msg), message: msg };
  }

  // "Sudah terdaftar" = matkul sudah masuk KRS → SUKSES (stop spam)
  if (status === 200 && /sudah terdaftar|sudah diambil|sudah ada di krs/i.test(text)) {
    return { success: true, message: "Sudah terdaftar di KRS." };
  }

  // ── Analisis DOM (lebih andal): flash alert + modal yang benar-benar muncul
  const sig = signals || {};
  for (const a of sig.alerts || []) {
    if (/\balert-success\b/i.test(a.cls) && a.text) {
      return { success: true, message: "OK: " + a.text };
    }
  }
  for (const a of sig.alerts || []) {
    if (/\balert-danger\b|\balert-error\b/i.test(a.cls) && a.text) {
      return { success: false, permanent: isPermanentText(a.text), message: a.text };
    }
  }
  for (const m of sig.imgContexts || []) {
    if (m.ancestorStyle && /display\s*:\s*none/i.test(m.ancestorStyle)) continue; // modal tersembunyi
    if (m.kind === "error" && m.text) return { success: false, permanent: isPermanentText(m.text), message: m.text };
    if (m.kind === "success" && m.text) return { success: true, message: "OK: " + m.text };
  }
  for (const m of sig.modals || []) {
    if (m.displayNone) continue; // template modal tersembunyi → bukan error
    if (m.hasErrorImg && m.text) return { success: false, permanent: isPermanentText(m.text), message: m.text };
    if (m.hasSuccessImg && m.text) return { success: true, message: "OK: " + m.text };
  }

  const fullPage = /<html|<!doctype/i.test(text) && text.length > 5000;

  if (!fullPage) {
    // Fragmen pendek → aman scan kata kunci kegagalan
    const hasError =
      /kuota habis|kelas penuh|penuh|gagal|terbatas|tidak dapat|tidak bisa|melebihi|bentrok/i.test(text);
    if (/error\.png|alert-danger/i.test(text) || hasError) {
      return { success: false, permanent: isPermanentText(text), message: describeHtmlResponse(status, text) };
    }
    if (status === 200) return { success: true, message: "OK (HTML response)" };
    return { success: false, permanent: isPermanentText(text), message: describeHtmlResponse(status, text) };
  }

  // Full page tanpa flash error yang terlihat → POST redirect balik (sukses).
  if (status === 200) return { success: true, message: "OK (redirect ke halaman KRS)" };
  return { success: false, permanent: isPermanentText(text), message: describeHtmlResponse(status, text) };
}

function looksLikeSecurityPage(status, html) {
  const t = String(html || "");
  if (status === 403 || status === 429 || status === 503) return true;
  if (/Pemeriksaan Keamanan|Memverifikasi Browser|Memeriksa Keamanan Browser/i.test(t)) return true;
  // Marker Cloudflare Turnstile / challenge (berbagai bahasa & versi)
  return /cf-chl|cf_chl_|challenge-platform|turnstile|cf-mitigated|attention required|checking your browser|verify you are human|verifying you are human|just a moment|enable javascript and cookies/i.test(t);
}

function describeHtmlResponse(status, text) {
  let title = "";
  const t = text.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (t) title = t[1].trim();

  const keys = ["penuh", "gagal", "error", "sudah terdaftar", "terbatas", "tidak dapat", "alert", "jatah"];
  let snippet = "";
  for (const k of keys) {
    const idx = text.toLowerCase().indexOf(k);
    if (idx !== -1) {
      snippet = extractAlertText(text) || text.slice(Math.max(0, idx - 60), idx + 180).replace(/\s+/g, " ").trim();
      break;
    }
  }

  const parts = [`HTTP ${status}`];
  if (title) parts.push(`title="${title}"`);
  if (snippet) parts.push(`"...${snippet}..."`);
  return parts.join(" | ");
}

function extractAlertText(text) {
  const m = text.match(/error\.png[\s\S]{0,1200}?<\/div>\s*<\/div>\s*<\/div>/i);
  const region = m ? m[0] : text;
  const h2 = region.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  const p = region.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const title = h2 ? h2[1].replace(/<[^>]+>/g, "").trim() : "";
  const para = p ? p[1].replace(/<[^>]+>/g, "").trim() : "";
  const msg = (title + " — " + para).replace(/\s+/g, " ").trim();
  return msg.length > 8 ? msg : "";
}

// ─── TELEGRAM ───────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CONFIG.TELEGRAM_CHAT_ID,
          text: `🎓 WAR KRS ITERA\n${text}`,
          parse_mode: "HTML",
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
  } catch (e) {
    log("Telegram error: " + e.message, "warn");
  }
}
// ─── BROWSER (Chrome/Brave via puppeteer-core) ──────────────────────────────
// Path lintas platform: Windows (Program Files / LOCALAPPDATA),
// macOS (/Applications/*.app), Linux (/usr/bin, /opt, snap, flatpak).
const BROWSER_LABELS = { chrome: "Chrome", brave: "Brave" };

function platform() {
  return process.platform; // "win32" | "darwin" | "linux"
}

function browserRoots() {
  if (platform() === "darwin") {
    return ["/Applications", process.env.HOME ? path.join(process.env.HOME, "Applications") : ""];
  }
  if (platform() === "linux") {
    return [
      "/usr/bin",
      "/usr/local/bin",
      "/opt/google/chrome",
      "/opt/brave.com/brave",
      process.env.HOME ? path.join(process.env.HOME, ".local/bin") : "",
      process.env.HOME ? path.join(process.env.HOME, ".local/share/applications") : "",
    ];
  }
  // Windows
  return [
    process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
    process.env.PROGRAMFILES || "C:\\Program Files",
    process.env.LOCALAPPDATA || "",
  ];
}

// Nama file executable browser per platform.
function browserExe(name) {
  const mac = {
    chrome: "Google Chrome.app/Contents/MacOS/Google Chrome",
    brave: "Brave Browser.app/Contents/MacOS/Brave Browser",
  };
  const linux = {
    chrome: "google-chrome",
    brave: "brave-browser",
  };
  const win = {
    chrome: "Google\\Chrome\\Application\\chrome.exe",
    brave: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  };
  const map = platform() === "darwin" ? mac : platform() === "linux" ? linux : win;
  return map[name] || "";
}

function findByName(name) {
  const rel = browserExe(name);
  if (!rel) return "";
  for (const root of browserRoots()) {
    const p = root ? path.join(root, rel) : "";
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

function detectBrowsers() {
  const found = [];
  for (const name of Object.keys(BROWSER_LABELS)) {
    if (findByName(name)) found.push(name);
  }
  return found;
}

function findBrowser() {
  if (CONFIG.BROWSER_PATH && fs.existsSync(CONFIG.BROWSER_PATH)) return CONFIG.BROWSER_PATH;
  const wanted = (CONFIG.BROWSER || "auto").toLowerCase();
  if (wanted === "auto") {
    for (const name of ["chrome", "brave"]) {
      const p = findByName(name);
      if (p) return p;
    }
    return "";
  }
  return findByName(wanted);
}

function currentBrowserLabel() {
  if (CONFIG.BROWSER_PATH && fs.existsSync(CONFIG.BROWSER_PATH)) return "Manual: " + CONFIG.BROWSER_PATH;
  if (CONFIG.BROWSER && CONFIG.BROWSER !== "auto" && BROWSER_LABELS[CONFIG.BROWSER]) {
    return BROWSER_LABELS[CONFIG.BROWSER];
  }
  const p = findBrowser();
  if (!p) return "(tidak ditemukan)";
  return path.basename(p).replace(/\.exe$/i, "");
}

// Profil asli browser (yang biasa kamu pakai sehari-hari)
function realProfilePath(name) {
  const mac = {
    chrome: "Google/Chrome",
    brave: "BraveSoftware/Brave-Browser",
  };
  const linux = {
    chrome: "google-chrome",
    brave: "brave-browser",
  };
  const win = {
    chrome: "Google\\Chrome\\User Data",
    brave: "BraveSoftware\\Brave-Browser\\User Data",
  };
  if (platform() === "darwin") {
    const root = process.env.HOME ? path.join(process.env.HOME, "Library/Application Support") : "";
    return root && mac[name] ? path.join(root, mac[name]) : "";
  }
  if (platform() === "linux") {
    const root = process.env.HOME ? path.join(process.env.HOME, ".config") : "";
    return root && linux[name] ? path.join(root, linux[name]) : "";
  }
  const root = process.env.LOCALAPPDATA || "";
  return root && win[name] ? path.join(root, win[name]) : "";
}

function guessBrowserName(executablePath) {
  const base = (executablePath || "").toLowerCase();
  if (base.includes("brave")) return "brave";
  if (base.includes("chrome")) return "chrome";
  return (CONFIG.BROWSER && BROWSER_LABELS[CONFIG.BROWSER]) ? CONFIG.BROWSER : "chrome";
}

// Profil browser terpisah per browser (fallback bila tidak pakai profil asli)
function profileDirForBrowser() {
  const name = (CONFIG.BROWSER || "auto").toLowerCase();
  let base = "chrome";
  if (name === "auto") {
    const p = findBrowser();
    if (p) base = guessBrowserName(p);
  } else {
    base = name;
  }
  return path.join(DIR, ".warkrs-profile-" + base);
}

// Deteksi proses browser yang sedang berjalan (bukan cuma lock file).
// Windows: browser "startup boost" berjalan di background TANPA lock file yang
// terdeteksi, sehingga puppeteer.launch bisa HANG selamanya (hand-off ke
// instance yang sudah jalan) → kita deteksi lebih awal biar langsung fallback.
const childProcess = require("child_process");
function isBrowserProcessRunning(browserName) {
  try {
    const procs = platform() === "win32"
      ? childProcess.execFileSync("tasklist", ["/FI", `IMAGENAME eq ${browserName}.exe`, "/NH"], { encoding: "utf8", timeout: 5000 })
      : childProcess.execFileSync("pgrep", ["-f", browserName], { encoding: "utf8", timeout: 5000 });
    return /(chrome|brave)\.exe/i.test(procs) || /^\d+\s*$/m.test(procs);
  } catch (e) {
    return false;
  }
}

async function launchBrowser() {
  const executablePath = findBrowser();
  if (!executablePath) {
    throw new WarError(
      "BROWSER",
      "Browser tidak ditemukan. Install Chrome/Brave, atau atur pilihan browser lewat menu [B], atau set BROWSER_PATH manual."
    );
  }

  const browserName = guessBrowserName(executablePath);
  const label = BROWSER_LABELS[browserName] || browserName;

  // Pakai profil ASLI browser (default) → sesi login & data kamu ikut terbuka.
  // Syarat: browser harus ditutup dulu (profil terkunci saat browser berjalan).
  // Kalau profil asli tidak tersedia / terkunci / prosesnya berjalan → FALLBACK
  // otomatis ke profil terpisah supaya panel tetap terbuka (bukan gagal total
  // atau jendela blank/about:blank yang tidak bisa dikontrol).
  const launchOpts = (dir) => ({
    executablePath,
    headless: false,
    userDataDir: dir,
    defaultViewport: null, // ikut ukuran jendela asli (bukan dipaksa kecil)
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--start-maximized", // buka jendela full-screen/maximized
    ],
  });

  // Timeout keamanan: kalau launch tidak selesai (hang), anggap gagal.
  async function launchWithTimeout(dir, ms = 20000) {
    return Promise.race([
      puppeteer.launch(launchOpts(dir)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout menunggu browser (kemungkinan proses lama masih berjalan)")), ms)),
    ]);
  }

  let userDataDir, usingReal = false;
  if (CONFIG.USE_REAL_PROFILE !== false) {
    const real = realProfilePath(browserName);
    // Lock file: Windows=SingletonLock, macOS/Linux=SingletonCookie+SingletonSocket
    const locks = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
    const lockHits = real ? locks.map((l) => path.join(real, l)).filter((p) => fs.existsSync(p)) : [];
    const procRunning = isBrowserProcessRunning(browserName);
    if (procRunning) {
      log(`⚠ ${label} masih berjalan di background — pakai profil terpisah agar panel tidak blank.`, "warn");
      log('   (Mau pakai profil asli berisi sesi login? Tutup dulu SEMUA jendela & proses ' + label + '. Atau: config set USE_REAL_PROFILE false)', "dim");
      userDataDir = profileDirForBrowser();
    } else if (!real || !fs.existsSync(real)) {
      log(`⚠ Profil asli ${label} tidak ditemukan — pakai profil terpisah.`, "warn");
      userDataDir = profileDirForBrowser();
    } else if (lockHits.length) {
      log(`⚠ ${label} sedang berjalan (profil asli terkunci) — otomatis pakai profil terpisah.`, "warn");
      userDataDir = profileDirForBrowser();
    } else {
      userDataDir = real;
      usingReal = true;
    }
  } else {
    userDataDir = profileDirForBrowser();
  }

  try {
    return await launchWithTimeout(userDataDir);
  } catch (e) {
    // Profil asli gagal dibuka (throw ATAU hang/timeout) → fallback ke profil
    // terpisah, bukan langsung error.
    if (usingReal) {
      log(`⚠ Profil asli ${label} tidak bisa dipakai (${String(e.message).slice(0, 120)}) — fallback ke profil terpisah.`, "warn");
      try {
        return await launchWithTimeout(profileDirForBrowser());
      } catch (e2) {
        throw new WarError("BROWSER", `Gagal membuka ${label}: ${e2.message}`);
      }
    }
    throw new WarError("BROWSER", `Gagal membuka ${label}: ${e.message}`);
  }
}

async function getPage(browser) {
  const pages = await browser.pages();
  if (pages.length) return pages[0];
  return browser.newPage();
}

// Tunggu sampai halaman Cloudflare "Pemeriksaan Keamanan" hilang. Karena ini
// browser asli, challenge biasanya teratasi otomatis dalam beberapa detik.
async function waitOutChallenge(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const flagged = await page
      .evaluate(() => {
        const b = document.body;
        const txt = (document.title || "") + " " + (b ? b.innerText || "" : "");
        return /Pemeriksaan Keamanan|Memverifikasi Browser|Memeriksa Keamanan Browser/i.test(txt);
      })
      .catch(() => false);
    if (!flagged) return true;
    await sleep(1500);
  }
  return false;
}

// Klik checkbox Cloudflare Turnstile ("ceklis verifikasi manusia") yang muncul
// sebagai iframe/elemen di halaman. Cek SEMUA frame (termasuk halaman utama),
// cocokkan aria-label "Verify you are human" / teks verifikasi. Browser asli
// akan otomatis lolos setelah checkbox diklik.
const TURNSTILE_LABEL_RE = /verify you are human|i'?m not a robot|are you human|verif|manusia|robot|captcha/i;

// Cari checkbox turnstile dalam sebuah frame. Kembalikan ElementHandle biar bisa
// diklik dengan mouse asli (elementHandle.click() → boundingBox + mouse events).
// Hanya menerima checkbox yang jelas-jelas Turnstile: label/aria-label cocok,
// ATAU checkbox apa pun di dalam iframe challenges.cloudflare.com.
async function findTurnstileCheckbox(frame) {
  try {
    const url = (frame.url() || "").toLowerCase();
    const isCfIframe = /challenges\.cloudflare\.com|cdn-cgi|turnstile/.test(url);
    const handle = await frame.evaluateHandle(
      (reSrc, cf) => {
        const re = new RegExp(reSrc, "i");
        const cands = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"], [aria-checked]'));
        const byLabel = cands.filter((cb) =>
          re.test(cb.getAttribute("aria-label") || "") ||
          re.test(cb.getAttribute("title") || "") ||
          re.test(cb.getAttribute("aria-describedby") || "")
        );
        if (byLabel.length) return byLabel[0];
        // Dalam iframe Cloudflare: checkbox apa pun yang terlihat = Turnstile.
        if (cf && cands.length) return cands[0];
        return null;
      },
      TURNSTILE_LABEL_RE.source,
      isCfIframe
    );
    const isNull = await handle.evaluate((el) => el === null).catch(() => true);
    if (isNull) return null;
    return handle;
  } catch (e) {
    return null;
  }
}

// Klik checkbox via mouse asli + JS click (kadang salah satu saja tidak cukup).
// Gerakan mouse dibuat bertahap + jeda singkat sebelum klik → lebih "manusiawi"
// sehingga Cloudflare tidak menolak (klik instan terdeteksi sebagai bot).
async function clickCheckboxReal(handle) {
  let clicked = false;
  try {
    const box = await handle.boundingBox();
    if (box && box.width > 0 && box.height > 0) {
      const page = handle.executionContext().frame().page();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const startX = Math.max(0, cx - (40 + Math.random() * 40));
      const startY = Math.max(0, cy - (15 + Math.random() * 25));
      await page.mouse.move(startX, startY);
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await page.mouse.move(startX + (cx - startX) * t, startY + (cy - startY) * t);
        await sleep(15 + Math.random() * 25);
      }
      await sleep(120 + Math.random() * 150);
      await page.mouse.down();
      await sleep(60 + Math.random() * 80);
      await page.mouse.up();
      clicked = true;
    }
  } catch (e) {}
  if (!clicked) {
    try { await handle.evaluate((el) => { if (el && !el.checked) el.click(); }); } catch (e) {}
  }
}

async function solveTurnstile(page, timeoutMs = 30000) {
  const start = Date.now();
  let verified = false;
  while (Date.now() - start < timeoutMs) {
    const frames = page.frames();

    let clicked = false;
    let isChecked = false;
    let anyFound = false;
    for (const f of frames) {
      const handle = await findTurnstileCheckbox(f);
      if (!handle) continue;
      anyFound = true;
      let checked = false;
      try { checked = await handle.evaluate((el) => !!(el && el.checked)); } catch (e) {}
      if (!checked) {
        log(`✅ Turnstile: checkbox ditemukan (${f === page.mainFrame() ? "halaman utama" : "iframe " + f.url().slice(0, 60)}) — mengklik...`, "info");
        await clickCheckboxReal(handle);
        clicked = true;
      } else {
        isChecked = true;
      }
      try { await handle.dispose(); } catch (e) {}
    }

    if (isChecked) verified = true;

    // Status halaman setelah klik: masih adakah iframe challenge / teks verifikasi?
    const state = await page
      .evaluate((labelRe) => {
        const hasIframe = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[src*="cdn-cgi"]');
        const b = document.body;
        const txt = (b ? b.innerText || "" : "") + " " + (document.title || "");
        const verifying = /memverifikasi|verifying|periksa keamanan|memeriksa keamanan|checking your browser|just a moment|are you human/i.test(txt);
        const mainCheckbox = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')).some((cb) =>
          new RegExp(labelRe, "i").test(cb.getAttribute("aria-label") || cb.getAttribute("title") || "")
        );
        return { hasIframe, verifying, mainCheckbox };
      }, TURNSTILE_LABEL_RE.source)
      .catch(() => ({ hasIframe: false, verifying: false, mainCheckbox: false }));

    // Lolos BERSIH: tidak ada iframe Turnstile, tidak ada teks verifying, tidak
    // ada checkbox → halaman sudah normal, aman untuk kirim POST.
    if (!state.hasIframe && !state.verifying && !state.mainCheckbox) return true;
    // Tercentang + iframe sudah HILANG → verifikasi selesai, lolos.
    if (verified && !state.hasIframe && !state.mainCheckbox) return true;
    // Tidak ada elemen ditemukan & tidak verifying & tidak ada iframe → lolos.
    if (!anyFound && !state.verifying && !state.hasIframe) return true;

    if (clicked) await sleep(1500);
    else await sleep(700);
  }
  return false;
}

async function isLoggedIn(page) {
  return page
    .evaluate(() => {
      const u = (location.href || "").toLowerCase();
      const b = document.body ? document.body.innerText : "";
      if (/\/login/i.test(u)) return false;
      if (!!document.querySelector('input[type="password"]')) return false;
      // Sinyal sudah-login: ada link logout/keluar/dashboard di menu
      if (/keluar|logout|\/dashboard/i.test(u + " " + b)) return true;
      // Tidak yakin → anggap BELUM login (aman: memicu login manual)
      return false;
    })
    .catch(() => false);
}

// Buka halaman KRS, tunggu Cloudflare, pastikan masih login.
async function ensureKrsPage(page) {
  const url = CONFIG.BASE_URL + CONFIG.KRS_PAGE;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: CONFIG.HTTP_TIMEOUT_MS });
  } catch (e) {} // timeout navigasi bukan masalah selama challenge belum selesai
  let ok = await waitOutChallenge(page);
  if (!ok) {
    // Challenge masih muncul — kemungkinan ada checkbox Turnstile → klik otomatis.
    ok = await solveTurnstile(page);
    if (!ok) ok = await waitOutChallenge(page, 45000);
  }
  // Setelah challenge hilang, kadang Turnstile baru muncul → pastikan lolos.
  await solveTurnstile(page);
  if (!ok) {
    throw new WarError("SECURITY", "Cloudflare challenge tidak teratasi otomatis. Cek jendela browser.");
  }
  if (!(await isLoggedIn(page))) {
    throw new WarError("SESSION_EXPIRED", "Belum login di jendela browser.");
  }
}

async function getCsrf(page) {
  // Token kadang baru muncul setelah AJAX memuat form KRS → tunggu sebentar
  await page
    .waitForFunction(
      () => {
        const m = document.querySelector('meta[name="csrf-token"]');
        if (m && m.content) return true;
        return !!document.querySelector('input[name="_token"]');
      },
      { timeout: 15000, polling: 1000 }
    )
    .catch(() => {});
  return page
    .evaluate(() => {
      const m = document.querySelector('meta[name="csrf-token"]');
      if (m && m.content) return m.content;
      const i = document.querySelector('input[name="_token"]');
      return i ? i.value : "";
    })
    .catch(() => "");
}

// Scan dropdown daftar matkul di halaman KRS.
async function scanAvailable(page) {
  // Tunggu dropdown matkul dimuat (konten KRS sering dimuat via AJAX)
  await page
    .waitForFunction(
      () => {
        let found = false;
        document.querySelectorAll("select").forEach((sel) => {
          const arr = Array.from(sel.options || []).filter((o) => o.value);
          if (arr.filter((o) => (o.textContent || "").includes("-")).length > 0) found = true;
        });
        return found;
      },
      { timeout: 20000, polling: 1500 }
    )
    .catch(() => {});
  const raw = await page
    .evaluate(() => {
      let best = null;
      document.querySelectorAll("select").forEach((sel) => {
        const arr = Array.from(sel.options || []).filter((o) => o.value);
        const dashy = arr.filter((o) => (o.textContent || "").includes("-")).length;
        if (dashy > (best ? best.count : 0)) best = { sel, count: dashy };
      });
      if (!best) return [];
      return Array.from(best.sel.options)
        .filter((o) => o.value)
        .map((o) => ({
          value: o.value.trim(),
          label: (o.textContent || "").trim().replace(/\s+/g, " "),
        }));
    })
    .catch(() => []);
  return raw.map((o) => {
    const parts = o.label.replace(/-\s*$/, "").split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
    return { idkelas: o.value, label: o.label, kode: parts[0] || "", nama: parts[1] || "", kelas: parts[2] || "" };
  });
}

// Baca info SKS dari halaman langkah-2 (SKS Maksimal & SKS terisi jika ada).
async function parseSksInfo(page) {
  const info = await page
    .evaluate(() => {
      const body = document.body ? document.body.innerText : "";
      const cap = body.match(/SKS\s*Maksimal\s*:?\s*(\d+)/i);
      const used = body.match(/(?:Total\s+SKS|Jumlah\s+SKS|SKS\s+Terisi|SKS\s+Terpakai)\s*:?\s*(\d+)/i);
      return {
        cap: cap ? parseInt(cap[1], 10) : null,
        used: used ? parseInt(used[1], 10) : null,
      };
    })
    .catch(() => ({ cap: null, used: null }));
  return info;
}

// POST simpanKRS dilakukan DI DALAM halaman → cookie & TLS browser asli.
// Form asli SIAKAD: action=".../simpanKRS" method="post" dengan satu field
// idkelas (TANPA token CSRF) — terverifikasi dari halaman langkah-2.
async function enrollCourse(page, course) {
  const url = /^https?:\/\//i.test(CONFIG.ENDPOINT) ? CONFIG.ENDPOINT : CONFIG.BASE_URL + CONFIG.ENDPOINT;
  const p = new URLSearchParams();
  p.append(CONFIG.COURSE_ID_FIELD, course.id);
  if (CONFIG.EXTRA_FIELDS) {
    try {
      new URLSearchParams(CONFIG.EXTRA_FIELDS).forEach((v, k) => p.append(k, v));
    } catch (e) {}
  }
  const body = p.toString();

  const result = await page
    .evaluate(
      async (url, body) => {
        try {
          const res = await fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Accept": "*/*",
              "Sec-Fetch-Site": "same-origin",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Dest": "empty",
            },
            body: body,
          });
          const text = await res.text();

          // Analisis struktur DOM respons (lebih akurat dari regex):
          // bedakan modal/flash yang BENAR-BENAR muncul vs template tersembunyi.
          const signals = {};
          try {
            const doc = new DOMParser().parseFromString(text, "text/html");
            signals.alerts = Array.from(doc.querySelectorAll(".alert")).map((el) => ({
              cls: el.className || "",
              text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
            }));
            signals.modals = Array.from(doc.querySelectorAll('[class*="modal"]')).map((el) => ({
              cls: el.className || "",
              hasErrorImg: /error\.png/i.test(el.innerHTML),
              hasSuccessImg: /success\.png/i.test(el.innerHTML),
              displayNone: /display\s*:\s*none/i.test(el.getAttribute("style") || ""),
              text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
            }));
            signals.imgContexts = Array.from(doc.querySelectorAll("img"))
              .filter((i) => /(error|success)\.png/i.test(i.getAttribute("src") || ""))
              .map((i) => {
                let anc = i.parentElement;
                for (let k = 0; k < 4 && anc; k++) {
                  if (anc && /modal|alert/i.test(anc.className || "")) break;
                  anc = anc.parentElement;
                }
                return {
                  kind: /error\.png/i.test(i.getAttribute("src") || "") ? "error" : "success",
                  ancestorClass: anc ? anc.className || "" : "",
                  ancestorStyle: anc ? anc.getAttribute("style") || "" : "",
                  text: (anc ? anc.textContent || "" : "").replace(/\s+/g, " ").trim().slice(0, 300),
                };
              });
          } catch (e) {}
          return { status: res.status, contentType: res.headers.get("content-type") || "", url: res.url, text, signals };
        } catch (e) {
          return { error: String(e && e.message) };
        }
      },
      url,
      body
    )
    .catch((e) => ({ error: "Halaman ditutup/error: " + e.message }));

  if (result.error) {
    throw new WarError("BROWSER", "fetch di dalam halaman gagal: " + result.error);
  }
  const analyzed = analyzeEnrollResponse(result.status, result.contentType, result.text, result.url, result.signals);
  analyzed.rawText = result.text; // untuk debug
  return analyzed;
}

// Tunggu sampai user login di jendela browser (dipakai saat sesi kedaluwarsa).
async function waitForLogin(page, timeoutMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isLoggedIn(page)) return true;
    await sleep(3000);
  }
  return false;
}

// Baca gambar captcha → teks soal. Gambar di-fetch DI DALAM halaman (cookie/
// TLS browser asli ikut) supaya server SSO menghitung jawabannya di sesi yang
// sama. Hasil dijadikan data-URL lalu di-OCR dengan tesseract.js.
let __ocrWorker = null;

// Ambil gambar captcha & buat beberapa varian preprocessing (perbesar 4x +
// binarize/grayscale/invert) biar digit bersih & tesseract tidak salah baca.
// Hasil: { originals:[dataUrl asli], variants:[bw,bw2,gray,inv] }
async function fetchCaptchaVariants(page) {
  return page
    .evaluate(async () => {
      const img = document.querySelector('img[src*="cpch"], img[src*="captcha"], img[alt*="captcha" i]');
      if (!img) return { originals: [], variants: [] };
      const src = img.currentSrc || img.src;
      if (!src) return { originals: [], variants: [] };
      const blob = await fetch(src, { credentials: "same-origin" })
        .then((r) => r.blob())
        .catch(() => null);
      if (!blob) return { originals: [], variants: [] };
      const bmp = await createImageBitmap(blob).catch(() => null);
      if (!bmp) return { originals: [], variants: [] };
      const originals = [];
      try { originals.push(bmp.toDataURL ? bmp.toDataURL() : ""); } catch (e) {}
      const W = bmp.width, H = bmp.height, scale = 4;
      const make = (mode) => {
        const c = document.createElement("canvas");
        c.width = W * scale; c.height = H * scale;
        const ctx = c.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        const id = ctx.getImageData(0, 0, c.width, c.height);
        const d = id.data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (mode === "bw") { const v = lum > 128 ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; }
          else if (mode === "bw2") { const v = lum > 100 ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; }
          else if (mode === "gray") { d[i] = d[i + 1] = d[i + 2] = lum; }
          else { const v = lum > 128 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; }
        }
        ctx.putImageData(id, 0, 0);
        return c.toDataURL("image/png");
      };
      return {
        originals,
        variants: [make("bw"), make("bw2"), make("gray"), make("inv")],
      };
    })
    .catch(() => ({ originals: [], variants: [] }));
}

function ocrBuffer(buf) {
  return __ocrWorker.recognize(buf).then((r) => String(r.data.text || "").trim()).catch(() => "");
}

// Simpan gambar captcha untuk debugging (asal + varian preprocessing).
function saveCaptchaDebug(originals, variants, tag) {
  try {
    const dir = path.join(DIR, "captcha-debug");
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${tag || "x"}`;
    const all = [...originals, ...variants];
    all.forEach((d, i) => {
      if (!d || !d.startsWith("data:")) return;
      const ext = (d.split(";")[0] || "").split("/")[1] || "png";
      fs.writeFileSync(path.join(dir, `${name}-${i}.${ext}`), Buffer.from(d.split(",")[1] || "", "base64"));
    });
  } catch (e) {}
}

// Cari jawaban captcha: OCR semua varian preprocessing, lalu VOTING — jawaban
// yang paling sering muncul dari banyak varian dianggap benar. Lebih tahan
// terhadap salah baca satu varian.
async function solveCaptcha(page, tag) {
  const { originals, variants } = await fetchCaptchaVariants(page);
  if (!variants.length) return { text: "", answer: "" };
  try {
    if (!Tesseract) return { text: "", answer: "" };
    if (!__ocrWorker) {
      __ocrWorker = await Tesseract.createWorker("eng", 1, { logger: () => {} });
      try {
        await __ocrWorker.setParameters({
          tessedit_char_whitelist: "0123456789+-xX?",
          tessedit_pageseg_mode: "7",
        });
      } catch (e) {}
    }
    saveCaptchaDebug(originals, variants, tag);
    const votes = {};       // answer -> jumlah suara
    const bestText = {};    // answer -> teks OCR yang menghasilkan
    const used = [];
    for (const v of variants) {
      const buf = Buffer.from(v.split(",")[1] || "", "base64");
      if (!buf.length) continue;
      const text = await ocrBuffer(buf);
      const ans = solveMathCaptcha(text);
      if (!ans) continue;
      votes[ans] = (votes[ans] || 0) + 1;
      if (!bestText[ans]) bestText[ans] = text;
      used.push({ text, ans });
    }
    // Debug OCR lengkap → warkrs-debug-captcha.txt
    try {
      fs.writeFileSync(
        path.join(DIR, "warkrs-debug-captcha.txt"),
        used.map((u) => `"${u.text}" → ${u.ans}`).join("\n") || "(tidak ada pola terbaca)"
      );
    } catch (e) {}

    // Pilih jawaban dengan suara terbanyak (voting)
    let bestAns = "";
    let bestVotes = 0;
    for (const [ans, n] of Object.entries(votes)) {
      if (n > bestVotes) { bestVotes = n; bestAns = ans; }
    }
    return { text: bestText[bestAns] || "", answer: bestAns };
  } catch (e) {
    return { text: "", answer: "" };
  }
}

// Parse teks OCR "8+7=?" / "12 x 5" / "9 ÷ 3" → hasil hitung (string).
// Hapus "?"/"=" (sering terbaca jadi digit) lalu ambil pola angka op angka.
function solveMathCaptcha(text) {
  const t = String(text || "")
    .replace(/[^0-9+\-x×X*÷/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Cari SEMUA pola "angka op angka" (2 digit maks). Non-greedy pada angka
  // kedua supaya "6+77" dibaca "6+7" (bukan "6+77") — digit duplikat dari
  // "?" tidak ikut. Ambil kandidat dengan operand paling kecil (paling kredibel).
  let best = "";
  let bestScore = Infinity;
  const re = /(\d{1,2}?)\s*([+\-x×X*÷/])\s*(\d{1,2}?)/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[3], 10);
    const op = m[2];
    let r = null;
    if (op === "+") r = a + b;
    else if (op === "-") r = a - b;
    else if (/[x×X*]/.test(op)) r = a * b;
    else if (/[÷/]/.test(op) && b !== 0) r = Math.round(a / b);
    if (r === null || r < -50 || r > 99) continue; // hasil wajar captcha sederhana
    const score = Math.max(a, b); // angka kecil lebih kredibel
    if (score < bestScore) { bestScore = score; best = String(r); }
    re.lastIndex = m.index + 1; // lanjut cari dari posisi berikutnya
  }
  return best;
}

// Isi form login (username, password, captcha) lalu submit. Kembalikan true
// bila berhasil login, false bila masih di halaman login.
async function fillAndSubmitLogin(page, user, pass, captchaAnswer) {
  const filled = await page
    .evaluate(
      (u, p, cap) => {
        const pw = document.querySelector('input[type="password"]');
        if (!pw) return false;
        const form = pw.closest("form") || document;
        const setVal = (el, v) => {
          const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
          if (setter) setter.call(el, v);
          else el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const usrSel = [
          'input[name="email"]',
          'input[name="username"]',
          'input[name="user"]',
          'input[name="login"]',
          'input[type="email"]',
          'input[name="nim"]',
          'input[name="no_mhs"]',
          'input[name="no_mahasiswa"]',
          'input[type="text"]',
        ];
        let usr = null;
        for (const sel of usrSel) {
          const el = form.querySelector(sel);
          if (el && el !== pw && !/captcha|kode|verifikasi/i.test((el.name || "") + (el.id || "") + (el.placeholder || ""))) {
            usr = el;
            break;
          }
        }
        if (!usr) return false;
        setVal(usr, u);
        setVal(pw, p);
        if (cap) {
          const capSel = [
            'input[name*="captcha" i]',
            'input[name*="kode" i]',
            'input[name*="code" i]',
            'input[name*="jawaban" i]',
            'input[name*="answer" i]',
            'input[placeholder*="captcha" i]',
            'input[placeholder*="kode" i]',
            'input[placeholder*="jawaban" i]',
          ];
          let capInp = null;
          for (const sel of capSel) {
            capInp = form.querySelector(sel);
            if (capInp) break;
          }
          if (!capInp) {
            capInp = Array.from(form.querySelectorAll('input[type="text"], input:not([type])')).find(
              (el) => el !== usr && el !== pw && !el.value
            );
          }
          if (capInp) setVal(capInp, cap);
        }
        return true;
      },
      user,
      pass,
      captchaAnswer
    )
    .catch(() => false);
  if (!filled) return false;

  const clicked = await page
    .evaluate(() => {
      const btn =
        document.querySelector('button[type="submit"], input[type="submit"]') ||
        Array.from(document.querySelectorAll("button, .btn, input[type=button]")).find((b) =>
          /login|masuk|sign\s*in/i.test(b.textContent || b.value || "")
        );
      if (btn) { btn.click(); return true; }
      const form = document.querySelector('form');
      if (form && typeof form.submit === "function") { form.submit(); return true; }
      return false;
    })
    .catch(() => false);

  const start = Date.now();
  while (Date.now() - start < 30000) {
    if (await isLoggedIn(page)) return true;
    if (!(await page.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => true))) return true;
    await sleep(1500);
  }
  return clicked;
}

// Landing page SIAKAD setelah lolos Turnstile masih butuh klik tombol
// "Masuk"/"Login" sebelum masuk halaman login SSO. Fungsi ini mengekliknya.
async function clickMasuk(page) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    const u = safeUrl(page);
    if (/user\/signin|\/login/i.test(u)) return true;            // sudah di halaman login
    if (await isLoggedIn(page)) return true;                     // ternyata sudah login

    const clicked = await page
      .evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]')
        );
        const pick = btns.find((b) => {
          const t = (b.textContent || b.value || b.title || "").toLowerCase();
          return /masuk|sign\s*in|login|log\s*in|masuk\s+akun/i.test(t);
        });
        if (pick) { pick.click(); return true; }
        return false;
      })
      .catch(() => false);
    if (clicked) {
      await sleep(1500);
      continue;
    }
    await sleep(800);
  }
  return /user\/signin|\/login/i.test(safeUrl(page));
}

// `page.url()` Puppeteer sinkron (bukan Promise) — bungkus biar aman dipakai
// dengan `.catch`. Kembalikan string kosong bila gagal.
function safeUrl(page) {
  try { return page.url() || ""; } catch (e) { return ""; }
}

// Login ulang OTOMATIS memakai kredensial tersimpan (SIAKAD_USERNAME/PASSWORD).
// Isi form login (termasuk captcha matematika bila ada), submit, tunggu login.
// Coba beberapa kali: captcha bisa berubah setiap submit yang gagal.
async function autoLogin(page) {
  const user = CONFIG.SIAKAD_USERNAME;
  const pass = CONFIG.SIAKAD_PASSWORD;
  if (!user || !pass) {
    log("⚠ [login] SIAKAD_USERNAME/PASSWORD kosong — isi di tab Config dulu.", "warn");
    return false;
  }

  // 1) Loloskan Turnstile/Cloudflare challenge dulu.
  await solveTurnstile(page);

  // 2) Kalau masih di landing page (ada tombol "Masuk"), klik biar lanjut
  //    ke halaman login SSO.
  const masukOk = await clickMasuk(page);
  if (!masukOk) {
    log(`⚠ [login] Tidak bisa menuju halaman login (URL: ${safeUrl(page)}).`, "warn");
  }

  // 3) Tunggu form login benar-benar siap.
  const formReady = await page
    .waitForFunction(() => !!document.querySelector('input[type="password"]'), { timeout: 20000, polling: 500 })
    .then(() => true)
    .catch(() => false);

  if (!formReady) {
    log(`⚠ [login] Form login tidak muncul dalam 20s (URL: ${safeUrl(page)}) — lewati auto-login.`, "warn");
    return false;
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    if (await isLoggedIn(page)) return true;

    let captchaAnswer = "";
    const hasCaptchaImg = await page
      .evaluate(() => !!document.querySelector('img[src*="cpch"], img[src*="captcha"], img[alt*="captcha" i]'))
      .catch(() => false);

    if (hasCaptchaImg) {
      const { text, answer } = await solveCaptcha(page, "login-" + attempt);
      captchaAnswer = answer;
      if (!captchaAnswer) {
        log(`🧩 [login] Captcha belum terbaca (OCR: "${text}") — coba ulang ${attempt}/5...`, "warn");
        await sleep(1200);
        continue;
      }
      log(`🧩 [login] Captcha terdeteksi → "${text}" → jawab ${captchaAnswer}.`, "info");
    }

    const ok = await fillAndSubmitLogin(page, user, pass, captchaAnswer);
    if (ok) return true;
    log(`⚠ [login] Login gagal (percobaan ${attempt}/5) — captcha/field mungkin berubah.`, "warn");
    await sleep(1500);
  }
  return false;
}
// ─── CORE WAR ENGINE ────────────────────────────────────────────────────────
async function spamCourse(page, course, reloadCounter) {
  const label = courseLabel(course);
  course.status = "proses";
  course.log = "";
  persist();

  let attempt = 0;
  let lastMsg = "";

  while (!state.aborted) {
    attempt++;
    if (CONFIG.SPAM_LIMIT > 0 && attempt > CONFIG.SPAM_LIMIT) break;

    course.retries = attempt;
    persist();

    renderStatus(`${label} · coba #${attempt} · mengirim request...`);

    // Halaman langkah-2 (pilihmk) harus aktif & dropdown terisi. Reload berkala
    // biar sesi/Cloudflare tetap sehat dan dropdown tetap segar.
    if (reloadCounter.c === 0 || reloadCounter.c % CONFIG.RELOAD_EVERY_ATTEMPTS === 0) {
      try {
        await ensureKrsPage(page);
        const hasDropdown = await page
          .evaluate(() => {
            const s = document.querySelector('select[name="idkelas"], #pilihankelas, select');
            return !!s && s.options && s.options.length > 0;
          })
          .catch(() => false);
        if (!hasDropdown) {
          course.log = `#${attempt}: langkah-2 KRS belum siap (dropdown kosong)`;
          renderStatus(`${label} · coba #${attempt} · ${course.log} (menunggu...)`);
          persist();
          await sleepAbortable(CONFIG.RETRY_DELAY_MS);
          continue;
        }
      } catch (e) {
        if (e.code === "SESSION_EXPIRED") throw e;
        if (e.code === "SECURITY") {
          securityStrike++;
          const cool = securityCooldownMs();
          course.log = `#${attempt}: Cloudflare, cooldown ${cool / 1000}s`;
          log(`🛡 [${label}] Cloudflare challenge. Cooldown ${cool / 1000}s...`, "error");
          persist();
          await sleepAbortable(cool);
          continue;
        }
        course.log = `#${attempt}: ${e.message}`;
        log(`[${label}] Gagal buka halaman: ${e.message}`, "error");
        persist();
        await sleepAbortable(CONFIG.RETRY_DELAY_MS);
        continue;
      }
    }
    reloadCounter.c++;

    // Cek challenge Cloudflare/Turnstile di halaman SEBELUM kirim request.
    // Kalau halaman sedang menampilkan "Pemeriksaan Keamanan" / iframe Turnstile,
    // selesaikan dulu — kalau tidak, semua POST hanya akan kena challenge.
    try {
      const hasCf = await page
        .evaluate(() => {
          const b = document.body;
          const txt = (b ? b.innerText || "" : "") + " " + (document.title || "");
          const textChk = /Pemeriksaan Keamanan|Memverifikasi Browser|Memeriksa Keamanan Browser|checking your browser|verify you are human|just a moment/i.test(txt);
          const iframeChk = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
          return textChk || iframeChk;
        })
        .catch(() => false);
      if (hasCf) {
        log(`🛡 [${label}] Cloudflare di halaman — menyelesaikan challenge...`, "error");
        const okCf = await solveTurnstile(page);
        if (okCf) {
          // Challenge berhasil dilewati → reset hitungan, cooldown berikutnya mulai dari dasar.
          securityStrike = 0;
        } else {
          await waitOutChallenge(page);
          const ok2 = await solveTurnstile(page);
          if (ok2) securityStrike = 0;
        }
        await sleep(1500);
        continue;
      }
    } catch (e) {}

    try {
      const result = await enrollCourse(page, course);
      lastMsg = result.message;

      if (result.sessionExpired) {
        throw new WarError("SESSION_EXPIRED", result.message);
      }
      if (result.success) {
        course.status = "berhasil";
        course.log = `Masuk di percobaan #${attempt}`;
        clearStatus();
        log(`✔ [${label}] BERHASIL! (coba #${attempt})`, "success", { sound: "success" });
        await sendTelegram(`✅ <b>${label}</b> berhasil didaftarkan! (percobaan #${attempt})`);
        persist();
        reloadCounter.c = 0;
        securityStrike = 0;
        return true;
      }
      if (result.permanent) {
        // Error yang tidak akan sembuh dengan spam (periode belum buka, SKS penuh,
        // bentrok, prasyarat) → berhenti untuk matkul ini, lanjut ke berikutnya.
        course.status = "gagal";
        course.log = `${shortMessage(result.message)} (error permanen)`;
        clearStatus();
        log(`⛔ [${label}] ${shortMessage(result.message)} — error permanen, lewati.`, "error");
        await sendTelegram(`⛔ <b>${label}</b>: ${shortMessage(result.message)} — dihentikan (error permanen).`);
        persist();
        return false;
      }
      if (result.security) {
        securityStrike++;
        const cool = securityCooldownMs();
        // Diagnosa: apa isi response Cloudflare yang sebenarnya?
        try {
          const raw = String(result.rawText || "");
          const title = (raw.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
          const snippet = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160);
          const isTurnstile = /turnstile|cf-chl|challenge-platform/.test(raw);
          log(`🛡 [${label}] Kena Cloudflare HTTP ${result.status} | title="${title}" | turnstile=${isTurnstile} | "${snippet}"`, "error", { sound: "cloudflare" });
        } catch (e) {}
        course.log = `#${attempt}: kena Cloudflare, reload + cooldown`;
        clearStatus();
        log(`🛡 [${label}] Kena Cloudflare. Cooldown ${cool / 1000}s...`, "error");
        persist();
        await sendTelegram(`🛡 <b>${label}</b> kena rate-limit/Cloudflare. Cooldown ${cool / 1000}s.`);
        reloadCounter.c = 0;
        // Reload halaman & klik Turnstile bila muncul — jangan hanya menunggu.
        try {
          await page.goto(CONFIG.BASE_URL + CONFIG.KRS_PAGE, { waitUntil: "domcontentloaded", timeout: CONFIG.HTTP_TIMEOUT_MS });
        } catch (e) {}
        await waitOutChallenge(page);
        const solvedCf = await solveTurnstile(page);
        if (solvedCf) securityStrike = 0;
        await sleepAbortable(cool);
        continue;
      }

      // Respons normal (bukan Cloudflare/403) → jaringan sehat, reset hitungan.
      securityStrike = 0;
      course.log = `#${attempt}: ${result.message}`;
      renderStatus(`${label} · coba #${attempt} · ${shortMessage(result.message)}`);

      // Debug: simpan respons mentah biar bisa lihat alasan sebenarnya
      if (CONFIG.DEBUG_RESPONSE && result.rawText) {
        try {
          fs.writeFileSync(
            path.join(DIR, "warkrs-debug.txt"),
            `# ${ts()} [${label}] coba #${attempt} → ${result.message}\n${result.rawText.slice(0, 4000)}`
          );
        } catch (e) {}
      }
    } catch (e) {
      if (e.code === "SESSION_EXPIRED" || e.code === "BROWSER") throw e;
      lastMsg = e.message;
      course.log = `#${attempt} error: ${e.message}`;
      renderStatus(`${label} · coba #${attempt} · Error: ${e.message}`);
    }

    persist();

    // Jeda + jitter acak biar request tidak kaku/ketauan bot
    const jitter = Math.floor(Math.random() * (CONFIG.RETRY_JITTER_MS + 1));
    await sleepAbortable(CONFIG.RETRY_DELAY_MS + jitter);
  }

  course.status = course.status === "berhasil" ? "berhasil" : "gagal";
  if (course.status === "gagal") {
    course.log = `Berhenti di percobaan #${attempt}. ${lastMsg}`;
    clearStatus();
    log(`❌ [${label}] Spam dihentikan di percobaan #${attempt}.`, "error");
  }
  persist();
  return course.status === "berhasil";
}

// Tunggu login ulang di jendela browser saat sesi kedaluwarsa di tengah war.
async function recoverSession(page) {
  log("🔒 SESI LOGIN KEDALUWARSA — mencoba login ulang otomatis...", "error");
  await sendTelegram("🔒 Sesi SIAKAD kedaluwarsa — mencoba login otomatis.");
  try {
    await page.goto(CONFIG.BASE_URL, { waitUntil: "domcontentloaded", timeout: CONFIG.HTTP_TIMEOUT_MS });
  } catch (e) {}
  const ok = await waitOutChallenge(page);
  if (!ok) return false;

  // Loloskan Turnstile checkbox (kalau ada) di halaman login SSO.
  await solveTurnstile(page);

  if (!(await isLoggedIn(page))) {
    const autoOk = await autoLogin(page);
    if (autoOk) {
      log("✅ Login otomatis berhasil.", "success");
    } else {
      log("⚠ Login otomatis gagal — login MANUAL di jendela browser (maks 10 menit)...", "warn");
      await sendTelegram("⚠ Login otomatis gagal — login manual di jendela browser.");
      const loggedIn = await waitForLogin(page);
      if (!loggedIn) return false;
    }
  }
  try {
    await ensureKrsPage(page);
  } catch (e) {
    return false;
  }
  log("✅ Berhasil login ulang — WAR dilanjutkan!", "success");
  await sendTelegram("✅ Login ulang berhasil — WAR lanjut.");
  securityStrike = 0;
  return true;
}

async function runWar(browser, page) {
  state.aborted = false;

  let sigintCount = 0;
  const onSigint = () => {
    sigintCount++;
    if (sigintCount === 1) {
      state.aborted = true;
      log("⛔ Ctrl+C diterima — menghentikan war dengan aman... (Ctrl+C lagi untuk paksa keluar)", "warn");
    } else {
      console.log("\nDipaksa keluar.");
      persist();
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  log(`⚔ WAR KRS dimulai — ${state.courses.length} target · delay ${CONFIG.RETRY_DELAY_MS}ms · limit ${CONFIG.SPAM_LIMIT || "∞"}`, "info");
  log("🌐 Jendela browser otomatis dibuka — JANGAN ditutup selama war.", "info");
  await sendTelegram("🚀 WAR KRS dimulai! Menargetkan " + state.courses.length + " matkul.");

  const reloadCounter = { c: 0 };

  // Helper: cek SKS dari halaman & berhenti kalau sudah penuh
  async function checkSksStop() {
    if (!CONFIG.AUTO_STOP_SKS) return false;
    try {
      const info = await parseSksInfo(page);
      panelSks = info;
      if (info.cap && info.used !== null) {
        if (info.used >= info.cap) {
          log(`⛔ SKS sudah penuh (${info.used}/${info.cap}) — WAR dihentikan.`, "error");
          await sendTelegram(`⛔ SKS sudah penuh (${info.used}/${info.cap}) — WAR dihentikan.`);
          state.aborted = true;
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  try {
    await ensureKrsPage(page);
  } catch (e) {
    if (e.code === "SESSION_EXPIRED") {
      const ok = await recoverSession(page);
      if (!ok) {
        log("⛔ Login gagal — WAR dihentikan.", "error");
        persist();
        process.exitCode = 1;
        return;
      }
    } else if (e.code === "SECURITY") {
      log("🛡 Cloudflare challenge tidak lolos — cek jendela browser.", "error");
      persist();
      process.exitCode = 1;
      return;
    } else {
      throw e;
    }
  }

  if (CONFIG.AUTO_STOP_SKS) {
    const info = await parseSksInfo(page).catch(() => ({}));
    panelSks = info;
    if (info.cap) log(`ℹ️  SKS maksimal terdeteksi: ${info.cap}${info.used !== null ? " · terisi " + info.used : ""}`, "info");
  }

  for (const course of state.courses) {
    if (state.aborted) break;
    if (course.status === "berhasil") continue;
    if (!course.id) {
      log(`⚠ [${courseLabel(course)}] idkelas kosong — dilewati.`, "error");
      course.status = "gagal";
      course.log = "idkelas kosong";
      persist();
      continue;
    }

    try {
      await spamCourse(page, course, reloadCounter);
    } catch (e) {
      if (!(e.code === "SESSION_EXPIRED" || e.code === "BROWSER")) throw e;
      const ok = await recoverSession(page);
      if (!ok) {
        log("⛔ Tidak berhasil login — WAR dihentikan. Progres disimpan.", "error");
        await sendTelegram("⛔ Sesi mati — WAR dihentikan.");
        persist();
        process.exitCode = 1;
        return;
      }
      reloadCounter.c = 0;
      course.status = "antri";
      persist();
      try {
        await spamCourse(page, course, reloadCounter);
      } catch (e2) {
        if (!(e2.code === "SESSION_EXPIRED" || e2.code === "BROWSER")) throw e2;
        log(`⚠ [${courseLabel(course)}] gagal lanjut pasca recovery.`, "warn");
      }
    }

    if (state.aborted) break;
    if (await checkSksStop()) break;
    await sleepAbortable(CONFIG.BATCH_DELAY_MS);
  }

  clearStatus();
  const successCount = state.courses.filter((c) => c.status === "berhasil").length;
  const total = state.courses.length;
  const summary = `🏁 Selesai! Berhasil mengambil ${successCount} dari ${total} target.`;
  log(summary, successCount === total ? "success" : "warn");
  await sendTelegram(summary);
  if (state.aborted) log("⛔ Dihentikan pengguna. Jalankan lagi \"node warkrs-bot.js war\" untuk lanjut.", "warn");
  persist();
}
// ─── HELPERS PERINTAH ───────────────────────────────────────────────────────
function handleFatal(e) {
  if (e.code === "SESSION_EXPIRED") {
    log("🔒 Belum login / sesi kedaluwarsa di browser otomatis.", "error");
    log('   Jalankan: node warkrs-bot.js login   (login sekali, tersimpan)', "warn");
  } else if (e.code === "SECURITY") {
    log("🛡 Cloudflare challenge tidak teratasi otomatis. Cek jendela browser otomatis.", "error");
  } else if (e.code === "BROWSER") {
    log("⚠ Browser error: " + e.message, "error");
    if (!findBrowser()) {
      log('   Chrome/Brave tidak ditemukan. Set manual: config set BROWSER_PATH "<path ke browser>"', "warn");
    }
  } else if (e.code === "NETWORK") {
    log("🌐 Gagal jaringan: " + e.message, "error");
  } else {
    log("Error: " + e.message, "error");
  }
  process.exitCode = 1;
}

// Jalankan perintah yang butuh browser (buka, eksekusi, tutup otomatis).
async function withBrowser(fn) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await getPage(browser);
    await fn(browser, page);
  } catch (e) {
    handleFatal(e);
  } finally {
    if (browser && browser.connected) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

async function cmdDoctor() {
  const exe = findBrowser();
  log("🔧 Browser yang dipakai: " + (exe || "(tidak ditemukan)"), "info");
  await withBrowser(async (browser, page) => {
    log("🌐 Membuka SIAKAD...", "info");
    try {
      await page.goto(CONFIG.BASE_URL, { waitUntil: "domcontentloaded", timeout: CONFIG.HTTP_TIMEOUT_MS });
    } catch (e) {}
    const challengeOk = await waitOutChallenge(page, 60000);
    const title = await page.title().catch(() => "");
    const loggedIn = await isLoggedIn(page);
    console.log(`  ${ANSI.bold}Judul halaman:${ANSI.reset} ${title}${ANSI.reset}`);
    console.log(`  ${ANSI.bold}Status login:${ANSI.reset} ${loggedIn ? ANSI.green + "SUDAH LOGIN" : ANSI.red + "BELUM LOGIN"}${ANSI.reset}`);
    if (challengeOk) console.log(`  ${ANSI.bold}Cloudflare:${ANSI.reset} ${ANSI.green}lolos${ANSI.reset}`);
    else console.log(`  ${ANSI.bold}Cloudflare:${ANSI.reset} ${ANSI.red}challenge belum teratasi${ANSI.reset}`);

    if (challengeOk && loggedIn) {
      try {
        await ensureKrsPage(page);
        const list = await scanAvailable(page);
        console.log(`  ${ANSI.bold}Halaman langkah-2 (pilihmk):${ANSI.reset} terbuka`);
        console.log(`  ${ANSI.bold}Dropdown matkul:${ANSI.reset} ${list.length ? ANSI.green + list.length + " kelas" + ANSI.reset : ANSI.red + "0 (kosong)" + ANSI.reset}`);
      } catch (e) {
        console.log(`  ${ANSI.bold}Halaman KRS:${ANSI.reset} ${ANSI.yellow + "tidak bisa dibuka / belum punya akses KRS" + ANSI.reset}`);
      }
    }
    await sleep(6000); // biar user sempat lihat jendelanya
    log("✅ Diagnostik selesai.", "success");
  });
  if (state.available.length) {
    log(`ℹ️  Cache scan tersimpan: ${state.available.length} kelas.`, "info");
  }
}

async function cmdLogin() {
  await withBrowser(async (browser, page) => {
    log("🌐 Membuka SIAKAD di jendela browser otomatis...", "info");
    try {
      await page.goto(CONFIG.BASE_URL, { waitUntil: "domcontentloaded", timeout: CONFIG.HTTP_TIMEOUT_MS });
    } catch (e) {}
    await waitOutChallenge(page, 90000);
    if (await isLoggedIn(page)) {
      log("✅ Kamu sudah login (sesi tersimpan dari run sebelumnya).", "success");
      return;
    }
    await solveTurnstile(page);
    if (await autoLogin(page)) {
      log("✅ Login otomatis berhasil memakai kredensial tersimpan.", "success");
      return;
    }
    log("👤 Silakan LOGIN di jendela browser. Menunggu sampai login terdeteksi...", "info");
    const ok = await waitForLogin(page);
    if (ok) log("✅ Login berhasil terdeteksi. Sesi tersimpan untuk perintah berikutnya.", "success");
    else log("⛔ Waktu habis (10 menit) — coba lagi dengan: node warkrs-bot.js login", "error");
  });
}

async function cmdScan(args) {
  await withBrowser(async (browser, page) => {
    log("🔍 Membuka halaman KRS...", "info");
    await ensureKrsPage(page);
    const list = await scanAvailable(page);
    if (list.length === 0) {
      log("⚠ Tidak menemukan dropdown matkul. Kemungkinan periode pengisian KRS belum dibuka.", "warn");
      return;
    }
    state.available = list;
    persist();
    log(`✅ ${list.length} kelas ditemukan & disimpan ke cache.`, "success");

    const q = (args[0] || "").toLowerCase();
    const filtered = q ? list.filter((c) => c.label.toLowerCase().includes(q)) : list;
    if (q) log(`Filter "${args[0]}": ${filtered.length} cocok.`, "info");

    const MAX = 300;
    filtered.slice(0, MAX).forEach((c) => {
      const added = state.courses.some((x) => x.id === c.idkelas);
      const mark = added ? `${ANSI.green}[sudah ditambahkan]${ANSI.reset}` : "";
      console.log(`  ${ANSI.bold}${c.idkelas}${ANSI.reset}  ${c.label} ${mark}`);
    });
    if (filtered.length > MAX) console.log(`  ... +${filtered.length - MAX} lagi, persempit dengan: scan <kata-kunci>`);
  });
}

// Tebak prefix prodi pengguna dari matkul yang sudah pernah ditambahkan
// (mis. semua matkul ber-kode IF25-... → prodi IF = Teknik Informatika).
function inferProgramPrefix() {
  const counts = {};
  const addPrefix = (code) => {
    const m = String(code).match(/^[A-Za-z]{2}/);
    if (m) {
      const p = m[0].toUpperCase();
      counts[p] = (counts[p] || 0) + 1;
    }
  };
  for (const c of state.courses) {
    if (c.kode) addPrefix(c.kode);
    else if (c.id && !/^\d/.test(String(c.id))) addPrefix(c.id); // id masih berupa kode
  }
  let best = "", bestN = 0;
  for (const [p, n] of Object.entries(counts)) {
    if (n > bestN) { best = p; bestN = n; }
  }
  return best;
}

// Minta user memilih idkelas saat nama matkul ambigu antar-prodi.
async function promptPick(name, kelas, pilihan) {
  if (!process.stdin.isTTY) return null;
  const question = getAsk();
  console.log(`\n⚠ "${name}"${kelas ? " " + kelas : ""} — ada beberapa pilihan. Pilih nomor:`);
  pilihan.forEach((p, i) => console.log(`  ${ANSI.cyan}[${i + 1}]${ANSI.reset} ${p}`));
  console.log(`  ${ANSI.cyan}[0]${ANSI.reset} Batal`);
  const ans = await question("\nPilih nomor: ");
  const n = parseInt(ans.trim(), 10);
  if (!n || n < 1 || n > pilihan.length) return null;
  const id = pilihan[n - 1].split(" ")[0];
  return state.available.find((f) => f.idkelas === id);
}

async function cmdAdd(args) {
  const lines = args.join(" ").split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) {
    log('Contoh: node warkrs-bot.js add "Kapita Selekta - RA"', "warn");
    return;
  }

  let needScan = false;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed && !parsed.id) { needScan = true; break; }
  }

  // Kalau ada baris tanpa idkelas & cache kosong → scan via browser dulu
  if (needScan && state.available.length === 0) {
    log("Cache scan kosong — membuka halaman KRS...", "info");
    await withBrowser(async (browser, page) => {
      await ensureKrsPage(page);
      state.available = await scanAvailable(page);
      persist();
      log(`🔍 ${state.available.length} kelas terdeteksi.`, "info");
    });
  }

  let added = 0, skipped = 0;
  const notFound = [];
  const pref = inferProgramPrefix();
  if (pref) log(`ℹ️  Deteksi prodi: ${pref} (dari matkul sebelumnya) — kelas prodi kamu dipilih otomatis saat ambigu.`, "info");

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    let { id, name, kelas, kode } = parsed;

    if (!id) {
      let found = findAvailable(name, kelas);
      // Kalau user menyertakan kode (mis. IF25-21008), cocokkan persis kodenya
      if (parsed.kode && found.length > 1) {
        const byKode = found.filter((f) => f.kode.toUpperCase() === parsed.kode.toUpperCase());
        if (byKode.length) found = byKode;
      }
      if (found.length === 0) {
        notFound.push(`${name}${kelas ? " - " + kelas : ""}`);
        continue;
      }
      let pick = null;
      let autoProdi = false;
      if (found.length > 1) {
        const exact = found.filter((f) => f.kelas.toLowerCase() === (kelas || "").toLowerCase());
        const pool = exact.length ? exact : found;
        // Prioritaskan kelas yang cocok dengan prodi pengguna
        if (pref) {
          const byProdi = pool.filter((f) => (f.kode || "").toUpperCase().startsWith(pref));
          if (byProdi.length === 1) { pick = byProdi[0]; autoProdi = true; }
        }
        if (!pick && exact.length === 1) pick = exact[0];
        if (!pick) {
          const pool = exact.length ? exact : found;
          const pilihan = pool.map((f) => `${f.idkelas} (${f.kode} ${f.kelas})`);
          const picked = await promptPick(name, kelas, pilihan);
          if (!picked) {
            notFound.push(`${name} — ambigu, ketik idkelas yang benar: ${pilihan.join(" ; ")}`);
            continue;
          }
          pick = picked;
        }
      } else {
        pick = found[0];
      }
      id = pick.idkelas; name = pick.nama; kelas = pick.kelas; kode = pick.kode;
      if (autoProdi) log(`✔ [${name}] ${kelas} → idkelas ${id} (${kode}) dipilih otomatis (prodi ${pref}).`, "success");
    } else if (!name || name === id) {
      const known = state.available.find((c) => c.idkelas === id);
      if (known) { name = known.nama || known.label; kelas = known.kelas; kode = known.kode; }
      else name = `idkelas ${id}`;
    }

    if (state.courses.some((c) => c.id === id && (c.kelas || "") === kelas)) {
      skipped++;
      continue;
    }
    state.courses.push({ id, name, kelas, kode: kode || "", status: "antri", retries: 0, log: "" });
    log(`➕ ${name}${kelas ? " " + kelas : ""} (idkelas ${id})`, "success");
    added++;
  }

  if (skipped) log(`⏭ ${skipped} duplikat dilewati.`, "warn");
  if (notFound.length) {
    log(`⚠ Tidak ketemu: ${notFound.join("; ")}. Cek ejaan / jalankan "scan" dulu.`, "error");
  }
  persist();
}

function cmdList() {
  if (state.courses.length === 0) {
    log('Belum ada target. Tambah dengan: node warkrs-bot.js add "Nama - Kelas"', "info");
    return;
  }
  state.courses.forEach((c, i) => {
    console.log(
      `  ${ANSI.gray}${i + 1}.${ANSI.reset} ${ANSI.bold}${c.id || "?"}${ANSI.reset}  ${c.name}${c.kelas ? " " + c.kelas : ""}  ${statusLabel(c.status)}${c.retries ? ` (${c.retries}x)` : ""}`
    );
    if (c.log) console.log(`     ${ANSI.gray}${c.log}${ANSI.reset}`);
  });
  const done = state.courses.filter((c) => c.status === "berhasil").length;
  console.log(`  ${ANSI.gray}→ ${done}/${state.courses.length} berhasil${ANSI.reset}`);
}

function cmdRemove(args) {
  const id = args[0];
  if (!id) {
    log("Contoh: node warkrs-bot.js remove 43254", "warn");
    return;
  }
  const before = state.courses.length;
  state.courses = state.courses.filter((c) => c.id !== id);
  const n = before - state.courses.length;
  if (n) log(`🗑 ${n} target (idkelas ${id}) dihapus.`, "success");
  else log(`Tidak ada target dengan idkelas ${id}.`, "warn");
  persist();
}

function cmdClear() {
  state.courses = [];
  persist();
  log("🗑 Semua target dihapus.", "success");
}

function cmdConfig(args) {
  if (args[0] === "set") {
    const key = (args[1] || "").toUpperCase();
    const value = args.slice(2).join(" ");
    if (!key || !(key in DEFAULT_CONFIG)) {
      log("Key tidak dikenal. Key tersedia: " + Object.keys(DEFAULT_CONFIG).join(", "), "error");
      process.exit(1);
    }
    const def = DEFAULT_CONFIG[key];
    let parsed = value;
    if (typeof def === "number") parsed = parseInt(value, 10) || 0;
    else if (typeof def === "boolean") parsed = /^(1|true|yes|on)$/i.test(value);
    CONFIG[key] = parsed;
    saveConfig();
    log(`✅ ${key} = ${parsed}`, "success");
    return;
  }
  for (const [k, v] of Object.entries(CONFIG)) {
    console.log(`  ${ANSI.gray}${k}${ANSI.reset} = ${v}`);
  }
}

async function cmdTgTest() {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    log("Isi dulu TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID via config set.", "error");
    process.exit(1);
  }
  await sendTelegram("✅ Test notifikasi dari WAR KRS ITERA (bot) berhasil!");
  log("📨 Test Telegram dikirim.", "success");
}

// Perbaiki state: ganti id kode-matkul (mis. IF25-21008) dengan idkelas numerik,
// tambah kolom kode (untuk deteksi prodi), bersihkan kelas & reset status.
function cmdFixState() {
  let fixed = 0;
  const unmatched = [];
  state.courses.forEach((c) => {
    const kelasClean = (c.kelas || "").replace(/\s*-\s*$/, "").trim().toUpperCase();
    const idStr = String(c.id || "");
    let target = null;
    if (/^\d/.test(idStr)) {
      target = state.available.find((a) => a.idkelas === c.id);
    } else {
      target =
        state.available.find((a) => a.kode.toUpperCase() === idStr.toUpperCase() && a.kelas.toUpperCase() === kelasClean) ||
        state.available.find((a) => a.kode.toUpperCase() === idStr.toUpperCase());
    }
    if (target) {
      c.id = target.idkelas;
      c.kelas = target.kelas;
      c.kode = target.kode;
      c.name = target.nama || c.name;
      if (c.status !== "berhasil") { c.status = "antri"; c.retries = 0; c.log = ""; }
      fixed++;
    } else {
      unmatched.push(`${c.name} ${c.kelas} (${idStr})`);
    }
  });
  persist();
  log(`🔧 ${fixed} matkul diperbaiki (idkelas numerik + kode + status).`, "success");
  cmdList();
  if (unmatched.length) log(`⚠ Tidak ditemukan di cache scan: ${unmatched.join("; ")}`, "warn");
  const pref = inferProgramPrefix();
  if (pref) log(`ℹ️  Prodi terdeteksi: ${pref} — matkul ambigu akan otomatis pilih prodi kamu.`, "info");
}

async function cmdWar() {
  if (state.courses.length === 0) {
    log('Belum ada target. Tambah dulu: node warkrs-bot.js add "Nama - Kelas"', "error");
    process.exit(1);
  }
  const pending = state.courses.filter((c) => c.status !== "berhasil");
  if (pending.length === 0) {
    log('Semua target sudah berhasil. Jalankan "clear" atau "remove" untuk mulai baru.', "success");
    return;
  }
  state.courses.forEach((c) => { if (c.status !== "berhasil") c.status = "antri"; });
  persist();

  let browser;
  try {
    browser = await launchBrowser();
    const page = await getPage(browser);
    await runWar(browser, page);
  } catch (e) {
    handleFatal(e);
  } finally {
    if (browser && browser.connected) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

function cmdHelp() {
  console.log(`
${ANSI.bold}⚔ WAR KRS v3 — BOT EDITION (Chrome/Brave otomatis)${ANSI.reset}
${ANSI.gray}Jalan di terminal, browser dikelola script — tahan refresh & lolos Cloudflare.${ANSI.reset}

${ANSI.bold}PERINTAH:${ANSI.reset}
  ${ANSI.cyan}doctor${ANSI.reset}               Tes: buka browser, cek SIAKAD + login + periode KRS
  ${ANSI.cyan}login${ANSI.reset}                Login SEKALI di jendela otomatis (sesi tersimpan)
  ${ANSI.cyan}scan [filter]${ANSI.reset}        Pindai daftar kelas dari halaman KRS
  ${ANSI.cyan}add "<baris>"${ANSI.reset}        Tambah target. Format:
                              "Nama Matkul - Kelas"  (cari idkelas otomatis)
                              "IDKELAS - Nama - Kelas"  (langsung)
                              IDKELAS                   (langsung)
  ${ANSI.cyan}list${ANSI.reset}               Lihat daftar target + status
  ${ANSI.cyan}remove <idkelas>${ANSI.reset}   Hapus satu target
  ${ANSI.cyan}clear${ANSI.reset}              Kosongkan semua target
  ${ANSI.cyan}war${ANSI.reset}                MULAI WAR (Ctrl+C untuk berhenti)
  ${ANSI.cyan}config${ANSI.reset}             Lihat config
  ${ANSI.cyan}config set KEY VAL${ANSI.reset} Ubah config (mis: config set RETRY_DELAY_MS 8000)
  ${ANSI.cyan}tgtest${ANSI.reset}             Test notifikasi Telegram

${ANSI.bold}ALUR PAKAI (sekali setup):${ANSI.reset}
  node warkrs-bot.js doctor      ← cek semuanya dulu
  node warkrs-bot.js login       ← login di jendela otomatis (sekali, tersimpan)
  node warkrs-bot.js scan kapita
  node warkrs-bot.js add "Kapita Selekta - RA"
  node warkrs-bot.js list
  node warkrs-bot.js war         ← biarkan berjalan, browser otomatis dibuka

${ANSI.gray}Jangan tutup jendela browser saat war berjalan. Kalau sesi kedaluwarsa,
script akan menunggu kamu login ulang di jendela itu lalu lanjut otomatis.${ANSI.reset}
`);
}

async function cmdMenu() {
  const question = getAsk();

  while (true) {
    console.clear();
    console.log(`\n  ${ANSI.bold}⚔  WAR KRS BOT v3 — MENU UTAMA  ⚔${ANSI.reset}`);
    console.log(`  ${ANSI.gray}─────────────────────────────────────────${ANSI.reset}`);
    console.log(`  ${ANSI.cyan}[1]${ANSI.reset} 🔧 Diagnostik Sistem (doctor)`);
    console.log(`  ${ANSI.cyan}[2]${ANSI.reset} 👤 Login SIAKAD (Sesi Browser)`);
    console.log(`  ${ANSI.cyan}[3]${ANSI.reset} 🔍 Scan Kelas & Simpan ke Cache`);
    console.log(`  ${ANSI.cyan}[4]${ANSI.reset} ➕ Tambah Target War`);
    console.log(`  ${ANSI.cyan}[5]${ANSI.reset} 📋 Lihat Daftar Target`);
    console.log(`  ${ANSI.cyan}[6]${ANSI.reset} 🗑  Hapus Satu Target`);
    console.log(`  ${ANSI.cyan}[7]${ANSI.reset} 🧹 Kosongkan Semua Target`);
    console.log(`  ${ANSI.cyan}[8]${ANSI.reset} ⚔  ${ANSI.bold}MULAI WAR KRS${ANSI.reset}`);
    console.log(`  ${ANSI.cyan}[9]${ANSI.reset} ⚙  Konfigurasi Jeda (Delay)`);
    console.log(`  ${ANSI.cyan}[B]${ANSI.reset} 🌐 Ganti Browser (sekarang: ${ANSI.bold}${currentBrowserLabel()}${ANSI.reset})`);
    console.log(`  ${ANSI.cyan}[0]${ANSI.reset} 🚪 Keluar`);
    console.log(`  ${ANSI.gray}─────────────────────────────────────────${ANSI.reset}`);

    const opt = await question("\nPilih nomor menu: ");
    const choice = opt.trim().toLowerCase();

    if (choice === "1") {
      console.log("\n");
      await cmdDoctor();
      await question("\nTekan Enter untuk kembali ke Menu Utama...");
    } else if (choice === "2") {
      console.log("\n");
      await cmdLogin();
      await question("\nTekan Enter untuk kembali ke Menu Utama...");
    } else if (choice === "3") {
      console.log("\n");
      const filter = await question("Masukkan kata kunci untuk filter (kosongkan untuk scan semua): ");
      await cmdScan([filter.trim()]);
      await question("\nTekan Enter untuk kembali ke Menu Utama...");
    } else if (choice === "4") {
      console.log("\n");
      const target = await question("Masukkan nama matkul atau ID kelas (contoh: Kapita Selekta - RA): ");
      if (target.trim()) await cmdAdd([target.trim()]);
      await question("\nTekan Enter untuk kembali ke Menu Utama...");
    } else if (choice === "5") {
      console.log("\n");
      cmdList();
      await question("\nTekan Enter untuk kembali ke Menu Utama...");
    } else if (choice === "6") {
      console.log("\n");
      cmdList();
      const id = await question("\nMasukkan idkelas yang mau dihapus: ");
      if (id.trim()) await cmdRemove([id.trim()]);
      await question("\nTekan Enter untuk kembali ke Menu Utama...");
    } else if (choice === "7") {
      console.log("\n");
      const confirmClear = await question("Yakin ingin mengosongkan semua target? (y/n): ");
      if (confirmClear.toLowerCase().startsWith("y")) cmdClear();
      await question("\nTekan Enter untuk kembali ke Menu Utama...");
    } else if (choice === "8") {
      console.log("\n");
      await cmdWar();
      await question("\nTekan Enter untuk kembali ke Menu Utama...");
    } else if (choice === "9") {
      console.log("\n");
      cmdConfig([]);
      const key = await question("\nMasukkan nama kunci yang mau diubah (contoh: RETRY_DELAY_MS, kosongkan untuk batal): ");
      if (key.trim()) {
        const val = await question(`Masukkan nilai baru untuk ${key.trim()}: `);
        cmdConfig(["set", key.trim(), val.trim()]);
      }
      await question("\nTekan Enter untuk kembali ke Menu Utama...");
    } else if (choice === "b") {
      console.log("\n");
      await cmdChooseBrowser();
      await question("\nTekan Enter untuk kembali ke Menu Utama...");
    } else if (choice === "0") {
      break;
    }
  }
  if (__rl) { __rl.close(); __rl = null; }
}

// Pilih browser yang dipakai (Chrome / Brave / Auto)
async function cmdChooseBrowser() {
  const question = getAsk();

  const available = detectBrowsers();
  console.log("\n  🌐 Pilih Browser untuk WAR KRS");
  console.log(`  ${ANSI.gray}─────────────────────────────────────────${ANSI.reset}`);
  console.log(`  [1] ${ANSI.bold}Auto${ANSI.reset} (pakai yang terdeteksi pertama)`);
  console.log(`  [2] ${ANSI.bold}Chrome${ANSI.reset}${available.includes("chrome") ? " ✓ terpasang" : " (tidak terpasang)"}`);
  console.log(`  [3] ${ANSI.bold}Brave${ANSI.reset}${available.includes("brave") ? " ✓ terpasang" : " (tidak terpasang)"}`);
  console.log(`  ${ANSI.gray}─────────────────────────────────────────${ANSI.reset}`);
  console.log(`  Saat ini: ${ANSI.bold}${currentBrowserLabel()}${ANSI.reset}`);

  const pick = (await question("\nPilih browser (1-3, Enter = batal): ")).trim();
  const map = { "1": "auto", "2": "chrome", "3": "brave" };
  const val = map[pick];
  if (!val) {
    console.log("\nBatal — browser tidak diubah.");
    return;
  }
  if (val !== "auto" && !available.includes(val)) {
    console.log(`\n⚠ ${BROWSER_LABELS[val]} tidak terpasang di laptop ini.`);
    return;
  }
  CONFIG.BROWSER = val;
  CONFIG.BROWSER_PATH = ""; // bersihkan override manual biar pilihan ini berlaku
  saveConfig();
  console.log(`\n✅ Browser diset ke: ${ANSI.bold}${val === "auto" ? "Auto (deteksi otomatis)" : BROWSER_LABELS[val]}${ANSI.reset}`);
}

// ─── PANEL MODE (UI di browser, diaktifkan dari terminal) ───────────────────
// Panel dibuka sebagai TAB terpisah di browser otomatis (bukan iframe), jadi
// bebas mixed-content/CSP. Tab SIAKAD dipakai untuk automasi war/scan.

function sendJson(res, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function handleActionSafe(fn) {
  return async (req, res) => {
    try {
      const out = await fn();
      sendJson(res, out);
    } catch (e) {
      sendJson(res, { ok: false, message: e.message });
    }
  };
}

function startPanelServer() {
  const http = require("http");
  const panelHtml = fs.readFileSync(path.join(DIR, "panel.html"), "utf8");

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, PANEL_URL);

    if (req.method === "GET" && url.pathname === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.end(panelHtml);
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, {
        courses: state.courses,
        config: CONFIG,
        warRunning: warActive,
        lastStatus: panelLastStatus,
        sks: panelSks,
        availableLen: state.available.length,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/available") {
      return sendJson(res, {
        list: state.available.map((c) => ({ idkelas: c.idkelas, kode: c.kode, kelas: c.kelas, label: c.label })),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/logs") {
      const since = parseInt(url.searchParams.get("since") || "0", 10);
      const rows = panelLogs.filter((l) => l.seq > since);
      return sendJson(res, { rows, next: panelLogSeq });
    }

    if (req.method === "POST" && url.pathname === "/api/action") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const out = await handleAction(parsed.action, parsed.data || {});
          sendJson(res, out);
        } catch (e) {
          sendJson(res, { ok: false, message: e.message });
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("404");
  });

  server.listen(PANEL_PORT, "127.0.0.1");
  return server;
}

function addById(id) {
  const known = state.available.find((c) => c.idkelas === id);
  if (!known) return { ok: false, message: `idkelas ${id} tidak dikenal — pindai dulu.` };
  if (state.courses.some((c) => c.id === id && (c.kelas || "") === known.kelas)) {
    return { ok: true, message: "sudah ada" };
  }
  state.courses.push({ id, name: known.nama || known.label, kelas: known.kelas, kode: known.kode, status: "antri", retries: 0, log: "" });
  persist();
  return { ok: true, message: "ditambahkan" };
}

async function panelAdd(text) {
  const lines = String(text || "").split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, message: "Input kosong" };
  if (!state.available.length) {
    const scanned = await actionScan();
    if (!scanned.ok) return { ok: false, message: "Cache kosong & pindai gagal: " + scanned.message };
  }
  let added = 0, skipped = 0;
  const notFound = [];
  const pref = inferProgramPrefix();
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    let { id, name, kelas, kode } = parsed;
    if (!id) {
      let found = findAvailable(name, kelas);
      if (parsed.kode && found.length > 1) {
        const byKode = found.filter((f) => f.kode.toUpperCase() === parsed.kode.toUpperCase());
        if (byKode.length) found = byKode;
      }
      if (!found.length) { notFound.push(`${name}${kelas ? " - " + kelas : ""}`); continue; }
      let pick = null;
      if (found.length > 1) {
        const exact = found.filter((f) => f.kelas.toLowerCase() === (kelas || "").toLowerCase());
        const pool = exact.length ? exact : found;
        if (pref) {
          const byProdi = pool.filter((f) => (f.kode || "").toUpperCase().startsWith(pref));
          if (byProdi.length === 1) pick = byProdi[0];
        }
        if (!pick && exact.length === 1) pick = exact[0];
        if (!pick) return { ok: false, ambiguous: pool.map((f) => `${f.idkelas} (${f.kode} ${f.kelas})`), message: `"${name}" ambigu` };
      } else {
        pick = found[0];
      }
      id = pick.idkelas; name = pick.nama; kelas = pick.kelas; kode = pick.kode;
    } else if (!name || name === id) {
      const known = state.available.find((c) => c.idkelas === id);
      if (known) { name = known.nama || known.label; kelas = known.kelas; kode = known.kode; }
      else name = `idkelas ${id}`;
    }
    if (state.courses.some((c) => c.id === id && (c.kelas || "") === kelas)) { skipped++; continue; }
    state.courses.push({ id, name, kelas, kode: kode || "", status: "antri", retries: 0, log: "" });
    added++;
  }
  persist();
  return { ok: true, added, skipped, notFound };
}

async function actionScan() {
  if (!panelPage) return { ok: false, message: "Browser belum siap." };
  try {
    await ensureKrsPage(panelPage);
  } catch (e) {
    return { ok: false, message: "Gagal buka KRS: " + e.message };
  }
  state.available = await scanAvailable(panelPage);
  persist();
  log(`🔍 ${state.available.length} kelas dipindai.`, "success");
  return { ok: true, list: state.available.map((c) => ({ idkelas: c.idkelas, label: c.label })), count: state.available.length };
}

async function handleAction(action, data) {
  switch (action) {
    case "add":
      if (data.id) return addById(data.id);
      return panelAdd(data.text);
    case "remove":
      state.courses = state.courses.filter((c) => c.id !== data.id);
      persist();
      return { ok: true };
    case "clear":
      state.courses = [];
      persist();
      return { ok: true };
    case "scan":
      return actionScan();
    case "war":
      if (warActive) return { ok: false, message: "WAR sudah berjalan." };
      if (!state.courses.length) return { ok: false, message: "Belum ada target." };
      if (!panelPage) return { ok: false, message: "Browser belum siap." };
      state.courses.forEach((c) => { if (c.status !== "berhasil") { c.status = "antri"; c.retries = 0; } });
      persist();
      warActive = true;
      runWar(panelBrowser, panelPage)
        .catch((e) => log("Error war: " + e.message, "error"))
        .finally(() => { warActive = false; });
      return { ok: true, message: "WAR dimulai" };
    case "stop":
      state.aborted = true;
      log("⛔ WAR dihentikan via panel.", "warn");
      return { ok: true };
    case "config_set": {
      const key = String(data.key || "").toUpperCase();
      if (!(key in DEFAULT_CONFIG)) return { ok: false, message: "Key tidak dikenal: " + key };
      const def = DEFAULT_CONFIG[key];
      let val = data.value;
      if (typeof def === "number") val = parseInt(val, 10) || 0;
      else if (typeof def === "boolean") val = /^(1|true|yes|on)$/i.test(String(val));
      else val = String(val == null ? "" : val);
      CONFIG[key] = val;
      saveConfig();
      return { ok: true, key, value: val };
    }
    case "browser": {
      const val = String(data.value || "auto");
      if (!(val in BROWSER_LABELS) && val !== "auto") return { ok: false, message: "Browser tidak dikenal" };
      CONFIG.BROWSER = val;
      CONFIG.BROWSER_PATH = "";
      saveConfig();
      log(`🌐 Browser diset: ${val === "auto" ? "Auto" : BROWSER_LABELS[val]}. Berlaku setelah restart panel.`, "info");
      return { ok: true };
    }
    case "tgtest":
      await cmdTgTest();
      return { ok: true };
    case "reset":
      state.courses = [];
      state.available = [];
      persist();
      saveJson(CONFIG_FILE, Object.assign({}, DEFAULT_CONFIG));
      Object.assign(CONFIG, DEFAULT_CONFIG);
      log("🗑 Semua state & config direset.", "warn");
      return { ok: true };
    case "fixstate":
      cmdFixState();
      return { ok: true };
    default:
      return { ok: false, message: "Aksi tidak dikenal: " + action };
  }
}

// Launch panel: server + browser + suntik overlay + buka SIAKAD.
async function cmdPanel() {
  const server = startPanelServer();
  log(`🖥 Panel aktif: ${PANEL_URL}`, "success");
  log("🌐 Membuka browser…", "info");

  let browser;
  try {
    browser = await launchBrowser();
  } catch (e) {
    server.close();
    handleFatal(e);
    return;
  }
  panelBrowser = browser;

  // Tab 1: SIAKAD (dipakai automasi war/scan/login)
  const page = await getPage(browser);
  panelPage = page;

  // Tab 2: Panel UI (tab terpisah → bebas mixed-content/CSP). Kalau server
  // belum siap / URL tidak kebuka, jangan biarkan user melihat tab blank —
  // tunggu server siap lalu coba lagi sebelum menyerah.
  const panelTab = await browser.newPage();
  const openPanel = async () => {
    await panelTab.goto(PANEL_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  };
  try {
    await openPanel();
    log("✅ Panel dibuka di tab baru — alihkan ke tab 'http://127.0.0.1:8765'.", "success");
  } catch (e) {
    log("⚠ Panel belum siap — mencoba lagi… (" + String(e.message).slice(0, 80) + ")", "warn");
    let retried = false;
    for (let i = 0; i < 5 && !retried; i++) {
      await sleep(1500);
      try {
        await openPanel();
        retried = true;
      } catch (e2) {}
    }
    if (!retried) {
      log("⚠ Gagal membuka tab panel setelah dicoba ulang: " + e.message, "error");
      log("   Ketik manual di address bar: " + PANEL_URL, "warn");
    }
  }
  try { await panelTab.bringToFront(); } catch (e) {}

  try {
    await ensureKrsPage(page);
  } catch (e) {
    if (e.code === "SESSION_EXPIRED") {
      log("🔒 Belum login — mencoba login otomatis...", "warn");
      try { await page.goto(CONFIG.BASE_URL, { waitUntil: "domcontentloaded", timeout: CONFIG.HTTP_TIMEOUT_MS }); } catch (e2) {}
      await waitOutChallenge(page);
      await solveTurnstile(page);
      const autoOk = await autoLogin(page);
      if (autoOk) {
        log("✅ Login otomatis berhasil — membuka halaman KRS.", "success");
        try { await ensureKrsPage(page); } catch (e3) { log("⚠ Gagal buka KRS: " + e3.message, "warn"); }
      } else {
        log("⚠ Login otomatis gagal/absen kredensial — login di TAB SIAKAD (panel ada di tab sebelah).", "warn");
        waitForLogin(page).then(async (ok) => {
          if (ok) {
            log("✅ Login terdeteksi — membuka halaman KRS.", "success");
            try { await ensureKrsPage(page); } catch (e3) { log("⚠ Gagal buka KRS: " + e3.message, "warn"); }
          }
        });
      }
    } else if (e.code === "SECURITY") {
      log("🛡 Cloudflare challenge tidak lolos — cek jendela browser.", "error");
    } else {
      log("⚠ Gagal buka KRS: " + e.message, "warn");
    }
  }

  log("✅ Panel siap — operasikan semua lewat panel. (Ctrl+C untuk menutup)", "success");
  await new Promise((resolve) => {
    const onSigint = () => {
      process.removeListener("SIGINT", onSigint);
      console.log("\nMenutup panel…");
      try { server.close(); } catch (e) {}
      if (browser && browser.connected) { browser.close().catch(() => {}); }
      resolve();
    };
    process.on("SIGINT", onSigint);
  });
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    return cmdMenu();
  }
  switch ((cmd || "").toLowerCase()) {
    case "doctor":  return cmdDoctor();
    case "login":   return cmdLogin();
    case "scan":    return cmdScan(args);
    case "add":     return cmdAdd(args);
    case "list":    return cmdList();
    case "remove":  return cmdRemove(args);
    case "clear":   return cmdClear();
    case "war":     return cmdWar();
    case "config":  return cmdConfig(args);
    case "tgtest":  return cmdTgTest();
    case "browser": return cmdChooseBrowser();
    case "fixstate": return cmdFixState();
    case "panel":   return cmdPanel();
    case "help":
    case "":
      return cmdHelp();
    default:
      log(`Perintah tidak dikenal: "${cmd}"`, "error");
      cmdHelp();
      process.exitCode = 1;
  }
}

main().catch((e) => {
  log("Fatal: " + e.message, "error");
  process.exitCode = 1;
});
