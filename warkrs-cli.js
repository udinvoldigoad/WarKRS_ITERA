#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");

// ─── FILE PENYIMPANAN ───────────────────────────────────────────────────────
const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, "warkrs-config.json");
const STATE_FILE = path.join(DIR, "warkrs-state.json");

const DEFAULT_CONFIG = {
  BASE_URL: "https://siakad.itera.ac.id",
  KRS_PAGE: "/mahasiswa/krsbaru",            // Halaman KRS (ambil CSRF + scan dropdown)
  ENDPOINT: "/mahasiswa/krsbaru/simpanKRS",  // Endpoint daftar KRS (verified)
  COURSE_ID_FIELD: "idkelas",                // Field ID kelas di payload (verified)
  EXTRA_FIELDS: "",                          // Field tambahan payload, mis: "foo=bar&x=1"
  RETRY_DELAY_MS: 5000,                      // Jeda antar percobaan (ms)
  RETRY_JITTER_MS: 3000,                     // Jitter acak biar tidak terlihat bot (ms)
  SPAM_LIMIT: 0,                             // 0 = spam terus sampai sukses/Ctrl+C
  BATCH_DELAY_MS: 2000,                      // Jeda antar matkul berbeda (ms)
  SECURITY_COOLDOWN_MS: 60000,               // Cooldown kalau kena proteksi bot/403 (ms)
  HTTP_TIMEOUT_MS: 30000,                    // Timeout per request (ms)
  REFRESH_TOKEN_PER_ATTEMPT: true,           // GET halaman KRS utk token baru tiap percobaan
  SOUND_ON: true,                            // Beep saat berhasil
  TELEGRAM_BOT_TOKEN: "",                    // Isi jika pakai notif Telegram
  TELEGRAM_CHAT_ID: "",                      // Chat ID / user ID Telegram kamu
  USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  COOKIE: "",                                // Cookie sesi login (isi via perintah `cookie`)
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

function log(msg, type = "info") {
  const c = TYPE_COLOR[type] || ANSI.reset;
  console.log(`${ANSI.gray}[${ts()}]${ANSI.reset} ${c}${msg}${ANSI.reset}`);
}

function beep() {
  if (CONFIG.SOUND_ON) process.stdout.write("\x07");
}

function shortMessage(s) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > 70 ? s.slice(0, 70) + "…" : s;
}

// ─── UTIL ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Sleep yang bisa diputus saat user menekan Ctrl+C
async function sleepAbortable(ms) {
  const step = 200;
  let t = 0;
  while (t < ms && !state.aborted) {
    await sleep(Math.min(step, ms - t));
    t += step;
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

// ─── HTTP CLIENT (cookie jar sederhana) ─────────────────────────────────────
const jar = new Map(); // name -> value

function initJar(cookieStr) {
  jar.clear();
  String(cookieStr || "")
    .split(/;\s*/)
    .filter(Boolean)
    .forEach((pair) => {
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    });
}

function jarHeader() {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function mergeSetCookies(res) {
  try {
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const pair = sc.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  } catch (e) {}
}

async function http(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    body,
    redirect: "follow",
    signal: AbortSignal.timeout(CONFIG.HTTP_TIMEOUT_MS),
    headers: Object.assign(
      {
        "User-Agent": CONFIG.USER_AGENT,
        Accept: "*/*",
        Cookie: jarHeader(),
      },
      headers
    ),
  });
  mergeSetCookies(res);
  return res;
}

// ─── PARSING HTML SIAKAD ────────────────────────────────────────────────────
function extractAttr(tag, attr) {
  const m =
    tag.match(new RegExp(attr + '\\s*=\\s*"([^"]*)"', "i")) ||
    tag.match(new RegExp(attr + "\\s*=\\s*'([^']*)'", "i"));
  return m ? m[1] : "";
}

function extractCsrf(html) {
  // <meta name="csrf-token" content="...">
  const metas = html.match(/<meta[^>]*>/gi) || [];
  for (const m of metas) {
    if (/name\s*=\s*["']csrf-token["']/i.test(m)) {
      const c = extractAttr(m, "content");
      if (c) return c;
    }
  }
  // <input name="_token" value="...">
  const inputs = html.match(/<input[^>]*>/gi) || [];
  for (const i of inputs) {
    if (/name\s*=\s*["']_token["']/i.test(i)) {
      const v = extractAttr(i, "value");
      if (v) return v;
    }
  }
  return "";
}

function looksLikeLoginPage(html, finalUrl) {
  if (/login/i.test(finalUrl || "")) return true;
  return /name\s*=\s*["']password["']/i.test(html) && /<title[^>]*>[^<]*login/i.test(html);
}

function looksLikeSecurityPage(status, html) {
  return (
    status === 403 ||
    /Pemeriksaan Keamanan|Memverifikasi Browser|Memeriksa Keamanan Browser/i.test(html)
  );
}

/**
 * Baca <option> dropdown matkul dari HTML halaman KRS.
 * Label: "AR25-11001 - Studio Dasar 1 - RA -"
 */
function parseAvailable(html) {
  const out = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const value = extractAttr(m[1], "value").trim();
    const raw = decodeEntities(m[2].replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " "));
    if (!value || !raw.includes("-")) continue;
    const parts = raw.replace(/-\s*$/, "").split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
    out.push({
      idkelas: value,
      label: raw,
      kode: parts[0] || "",
      nama: parts[1] || "",
      kelas: parts[2] || "",
    });
  }
  return out;
}
// ─── SIAKAD API ─────────────────────────────────────────────────────────────
class WarError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "SESSION_EXPIRED" | "SECURITY" | "NETWORK"
  }
}

async function fetchKrsPage() {
  const url = CONFIG.BASE_URL + CONFIG.KRS_PAGE;
  let res, text;
  try {
    res = await http(url);
    text = await res.text();
  } catch (e) {
    throw new WarError("NETWORK", `Gagal menghubungi SIAKAD: ${e.message}`);
  }
  if (looksLikeSecurityPage(res.status, text)) {
    throw new WarError("SECURITY", "Kena proteksi bot saat ambil halaman KRS.");
  }
  if (looksLikeLoginPage(text, res.url)) {
    throw new WarError("SESSION_EXPIRED", "Sesi login kedaluwarsa / cookie tidak valid.");
  }
  const token = extractCsrf(text);
  if (!token) {
    throw new WarError("NETWORK", "CSRF token tidak ditemukan di halaman KRS.");
  }
  return { token, html: text };
}

/**
 * Analisis respons POST simpanKRS — port dari versi browser,
 * dengan heuristik tambahan untuk membedakan fragmen flash vs full page
 * (redirect 302 di-follow bisa berisi seluruh halaman KRS).
 */
// Error permanen = spam tidak akan menyelesaikannya → matkul harus di-stop.
function isPermanentText(t) {
  return /(periode|pengisian).{0,30}(belum|tidak)|belum dibuka|masa pengisian|melebihi.{0,20}sks|sks.{0,20}(maksimal|terpenuhi|penuh)|jatah.{0,20}sks|bentrok|prasyarat|tidak ditemukan/i.test(
    String(t || "")
  );
}

function analyzeEnrollResponse(status, contentType, text, finalUrl) {
  if (looksLikeLoginPage(text, finalUrl)) {
    return { sessionExpired: true, message: "Redirect ke halaman login." };
  }
  if (status === 419) {
    return { tokenExpired: true, message: "CSRF token kedaluwarsa (HTTP 419)." };
  }
  if (looksLikeSecurityPage(status, text)) {
    return { security: true, message: "Kena proteksi bot (HTTP 403)." };
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

  const fullPage = /<html|<!doctype/i.test(text) && text.length > 5000;

  // Modal error SIAKAD (error.png) atau alert Bootstrap → GAGAL
  if (/error\.png|alert-danger/i.test(text)) {
    return { success: false, permanent: isPermanentText(text), message: describeHtmlResponse(status, text) };
  }

  // Indikator sukses eksplisit
  if (/success\.png|alert-success/i.test(text)) {
    return { success: true, message: "OK (konfirmasi sukses dari SIAKAD)" };
  }

  if (!fullPage) {
    // Fragmen pendek → aman scan kata kunci kegagalan
    const hasError =
      /kuota habis|kelas penuh|penuh|gagal|terbatas|tidak dapat|tidak bisa|melebihi|bentrok/i.test(text);
    if (hasError) return { success: false, permanent: isPermanentText(text), message: describeHtmlResponse(status, text) };
    if (status === 200) return { success: true, message: "OK (HTML response)" };
    return { success: false, permanent: isPermanentText(text), message: describeHtmlResponse(status, text) };
  }

  // Full page tanpa penanda error → POST di-redirect balik ke halaman KRS,
  // kemungkinan besar sukses (flash error sudah terdeteksi di atas).
  if (status === 200) return { success: true, message: "OK (redirect ke halaman KRS)" };
  return { success: false, permanent: isPermanentText(text), message: describeHtmlResponse(status, text) };
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

/**
 * Daftarkan satu matkul ke KRS.
 */
async function enrollCourse(course, csrf) {
  const url = /^https?:\/\//i.test(CONFIG.ENDPOINT)
    ? CONFIG.ENDPOINT
    : CONFIG.BASE_URL + CONFIG.ENDPOINT;

  const p = new URLSearchParams();
  p.append(CONFIG.COURSE_ID_FIELD, course.id);
  p.append("_token", csrf);
  if (CONFIG.EXTRA_FIELDS) {
    try {
      new URLSearchParams(CONFIG.EXTRA_FIELDS).forEach((v, k) => p.append(k, v));
    } catch (e) {}
  }

  const res = await http(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-TOKEN": csrf,
      "X-Requested-With": "XMLHttpRequest",
      Referer: CONFIG.BASE_URL + CONFIG.KRS_PAGE,
      Origin: CONFIG.BASE_URL,
    },
    body: p.toString(),
  });

  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  return analyzeEnrollResponse(res.status, contentType, text, res.url);
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

// ─── PARSING INPUT TARGET ───────────────────────────────────────────────────
/**
 *   "43254 - Kapita Selekta - RA"   (idkelas diketahui)
 *   "Kapita Selekta - RA"           (nama + kelas → cari idkelas dari hasil scan)
 *   "IF25-41031 - RA"               (kode + kelas → cari idkelas dari hasil scan)
 *   "43106  IF25-21008 - Nama - RA" (copy-paste hasil scan)
 */
function parseLine(line) {
  const cleanKelas = (s) => s.replace(/\s*[-–—]\s*$/, "").trim().toUpperCase();
  line = String(line || "").replace(/\s+/g, " ").trim();
  if (!line) return null;

  let id = "", kode = "", name = "", kelas = "";

  // Format hasil scan: "43106  IF25-21008 - Jaringan Komputer - RA"
  const m = line.match(/^(\d[\d,]*)\s+(.+)$/);
  if (m) {
    id = m[1];
    line = m[2];
  }

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
// ─── CORE WAR ENGINE ────────────────────────────────────────────────────────
async function spamCourse(course) {
  const label = courseLabel(course);
  course.status = "proses";
  course.log = "";
  persist();

  let attempt = 0;
  let lastMsg = "";
  let token = null;

  while (!state.aborted) {
    attempt++;
    if (CONFIG.SPAM_LIMIT > 0 && attempt > CONFIG.SPAM_LIMIT) break;

    course.retries = attempt;
    persist();

    // Ambil CSRF token segar (default: tiap percobaan)
    try {
      if (CONFIG.REFRESH_TOKEN_PER_ATTEMPT || !token) {
        const page = await fetchKrsPage();
        token = page.token;
      }
    } catch (e) {
      if (e.code === "SESSION_EXPIRED") throw e; // runWar yang menangani
      if (e.code === "SECURITY") {
        course.log = `#${attempt}: kena proteksi bot (GET), cooldown ${CONFIG.SECURITY_COOLDOWN_MS / 1000}s`;
        log(`🛡 [${label}] Proteksi bot saat ambil token. Cooldown ${CONFIG.SECURITY_COOLDOWN_MS / 1000} detik...`, "error");
        persist();
        await sleepAbortable(CONFIG.SECURITY_COOLDOWN_MS);
        continue;
      }
      course.log = `#${attempt}: ${e.message}`;
      log(`[${label}] Gagal ambil token: ${e.message}`, "error");
      persist();
      await sleepAbortable(CONFIG.RETRY_DELAY_MS);
      continue;
    }

    try {
      const result = await enrollCourse(course, token);
      lastMsg = result.message;

      if (result.sessionExpired) {
        throw new WarError("SESSION_EXPIRED", result.message);
      }
      if (result.tokenExpired) {
        course.log = `#${attempt}: token kedaluwarsa, refresh...`;
        log(`[${label}] #${attempt} token kedaluwarsa — ambil token baru.`, "warn");
        persist();
        token = null; // paksa refresh di iterasi berikutnya
        continue;
      }
      if (result.success) {
        course.status = "berhasil";
        course.log = `Masuk di percobaan #${attempt}`;
        log(`✅ [${label}] BERHASIL! Percobaan #${attempt}.`, "success");
        beep();
        await sendTelegram(`✅ <b>${label}</b> berhasil didaftarkan! (percobaan #${attempt})`);
        persist();
        return true;
      }
      if (result.permanent) {
        // Error yang tidak akan sembuh dengan spam (periode belum buka, SKS penuh,
        // bentrok, prasyarat) → berhenti untuk matkul ini, lanjut ke berikutnya.
        course.status = "gagal";
        course.log = `${shortMessage(result.message)} (error permanen)`;
        log(`⛔ [${label}] ${shortMessage(result.message)} — error permanen, lewati.`, "error");
        await sendTelegram(`⛔ <b>${label}</b>: ${shortMessage(result.message)} — dihentikan (error permanen).`);
        persist();
        return false;
      }
      if (result.security) {
        course.log = `#${attempt}: kena proteksi bot, cooldown ${CONFIG.SECURITY_COOLDOWN_MS / 1000}s`;
        log(`🛡 [${label}] Kena proteksi Cloudflare (403). Cooldown ${CONFIG.SECURITY_COOLDOWN_MS / 1000} detik...`, "error");
        log(`💡 Kalau berulang: cf_clearance mungkin kedaluwarsa — salin ulang cookie + UA dari browser.`, "warn");
        log(`💡 Bisa juga naikkan delay: node warkrs-cli.js config set RETRY_DELAY_MS 8000`, "warn");
        persist();
        await sendTelegram(`🛡 <b>${label}</b> kena rate-limit SIAKAD. Cooldown ${CONFIG.SECURITY_COOLDOWN_MS / 1000}s.`);
        await sleepAbortable(CONFIG.SECURITY_COOLDOWN_MS);
        continue;
      }

      course.log = `#${attempt}: ${result.message}`;
      log(`[${label}] #${attempt} gagal: ${result.message}`, "warn");
    } catch (e) {
      if (e.code === "SESSION_EXPIRED") throw e;
      lastMsg = e.message;
      course.log = `#${attempt} error: ${e.message}`;
      log(`[${label}] Error: ${e.message}`, "error");
    }

    persist();

    // Jeda + jitter acak biar request tidak kaku/ketauan bot
    const jitter = Math.floor(Math.random() * (CONFIG.RETRY_JITTER_MS + 1));
    await sleepAbortable(CONFIG.RETRY_DELAY_MS + jitter);
  }

  course.status = course.status === "berhasil" ? "berhasil" : "gagal";
  if (course.status === "gagal") {
    course.log = `Berhenti di percobaan #${attempt}. ${lastMsg}`;
    log(`❌ [${label}] Spam dihentikan di percobaan #${attempt}.`, "error");
  }
  persist();
  return course.status === "berhasil";
}

async function runWar() {
  state.aborted = false;

  // Ctrl+C → berhenti halus; Ctrl+C lagi → paksa keluar
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount++;
    if (sigintCount === 1) {
      state.aborted = true;
      log("⛔ Ctrl+C diterima — berhenti setelah request berjalan selesai. (Ctrl+C lagi untuk paksa keluar)", "warn");
    } else {
      console.log("\nDipaksa keluar.");
      persist();
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  log("🚀 WAR KRS dimulai!", "success");
  log("ℹ️  Script hanya NAMBAH matkul ke draft. KRS TIDAK disimpan otomatis.", "info");
  log(`⏱  Delay ${CONFIG.RETRY_DELAY_MS}ms + jitter ${CONFIG.RETRY_JITTER_MS}ms | Limit: ${CONFIG.SPAM_LIMIT || "tanpa batas"}`, "info");
  await sendTelegram("🚀 WAR KRS dimulai! Menargetkan " + state.courses.length + " matkul.");

  try {
    for (const course of state.courses) {
      if (state.aborted) break;
      if (course.status === "berhasil") continue;
      if (!course.id) {
        log(`⚠ [${courseLabel(course)}] idkelas kosong — dilewati. Jalankan "scan" lalu "add" ulang.`, "error");
        course.status = "gagal";
        course.log = "idkelas kosong";
        persist();
        continue;
      }

      await spamCourse(course);
      if (state.aborted) break;

      await sleepAbortable(CONFIG.BATCH_DELAY_MS);
    }
  } catch (e) {
    if (e.code === "SESSION_EXPIRED") {
      log("🔒 SESI LOGIN KEDALUWARSA / COOKIE TIDAK VALID.", "error");
      log("   Salin ulang cookie dari browser (DevTools → Network → Headers → Cookie), lalu jalankan:", "warn");
      log('   node warkrs-cli.js cookie "<cookie-baru>"', "warn");
      await sendTelegram("🔒 Sesi SIAKAD kedaluwarsa. Update cookie lalu jalankan ulang war.");
      persist();
      process.exitCode = 1;
      return;
    }
    throw e;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  const successCount = state.courses.filter((c) => c.status === "berhasil").length;
  const total = state.courses.length;
  const summary = `🏁 Selesai! ✅ ${successCount}/${total} berhasil.`;
  log(summary, successCount === total ? "success" : "warn");
  await sendTelegram(summary);
  if (state.aborted) log("⛔ Dihentikan pengguna. Jalankan lagi " + '"node warkrs-cli.js war"' + " untuk lanjut (progres tersimpan).", "warn");
  persist();
}
// Nama-nama cookie sesi yang umum (SIAKAD ITERA pakai CodeIgniter → ci_session)
const SESSION_COOKIE_NAMES = ["ci_session", "laravel_session", "PHPSESSID", "session", "sessionid"];

function hasSessionCookie() {
  return SESSION_COOKIE_NAMES.some((n) => jar.has(n));
}

// ─── COMMANDS ───────────────────────────────────────────────────────────────
function requireCookie() {
  if (!CONFIG.COOKIE) {
    log("Cookie belum diisi. Login di browser, salin header Cookie, lalu jalankan:", "error");
    log('  node warkrs-cli.js cookie "cf_clearance=...; ci_session=..."', "warn");
    process.exit(1);
  }
  initJar(CONFIG.COOKIE);
  if (!jar.has("cf_clearance")) {
    log("⚠ Cookie tidak mengandung cf_clearance — Cloudflare kemungkinan akan memblokir (403).", "warn");
    log("  Salin ULANG cookie lengkap dari browser setelah lolos 'Pemeriksaan Keamanan'.", "warn");
  }
}

function handleFatal(e) {
  if (e.code === "SESSION_EXPIRED") {
    log("🔒 SESI LOGIN KEDALUWARSA / COOKIE TIDAK VALID.", "error");
    log('   Salin ulang cookie dari browser, lalu: node warkrs-cli.js cookie "<cookie-baru>"', "warn");
  } else if (e.code === "SECURITY") {
    log("🛡 Diblokir Cloudflare (Pemeriksaan Keamanan).", "error");
    log("   Kemungkinan: cookie tanpa cf_clearance, cf_clearance kedaluwarsa, atau UA beda.", "warn");
    log('   Fix: salin ulang cookie + UA dari browser:', "warn");
    log('   node warkrs-cli.js cookie "<cookie-baru-lengkap>"', "warn");
    log('   node warkrs-cli.js ua "<navigator.userAgent dari browser>"', "warn");
  } else {
    log("Error: " + e.message, "error");
  }
  process.exitCode = 1;
}

async function cmdCookie(args) {
  let raw = args.join(" ").trim();
  raw = raw.replace(/^cookie\s*:\s*/i, "").replace(/^["']|["']$/g, "");
  if (!raw.includes("=")) {
    log("Format cookie tidak valid. Salin nilai header Cookie lengkap dari DevTools.", "error");
    process.exit(1);
  }
  CONFIG.COOKIE = raw;
  saveConfig();
  initJar(raw);
  const names = Array.from(jar.keys()).join(", ");
  log(`✅ Cookie tersimpan (${jar.size} item: ${names})`, "success");
  if (!hasSessionCookie()) {
    log("⚠ Tidak ada cookie sesi (ci_session) — pastikan kamu sudah login saat menyalin cookie.", "warn");
  }
  if (!jar.has("cf_clearance")) {
    log("⚠ Tidak ada 'cf_clearance' — Cloudflare kemungkinan memblokir request terminal (403).", "warn");
    log("  Salin cookie SETELAH lolos halaman 'Pemeriksaan Keamanan' di browser.", "warn");
  }
}

function cmdUa(args) {
  const ua = args.join(" ").trim().replace(/^["']|["']$/g, "");
  if (!ua || ua.length < 10) {
    log("Contoh: node warkrs-cli.js ua \"Mozilla/5.0 (Windows NT 10.0; ...) Chrome/126.0.0.0 ...\"", "warn");
    log("Dapatkan dari console DevTools browser: navigator.userAgent", "info");
    process.exit(1);
  }
  CONFIG.USER_AGENT = ua;
  saveConfig();
  log("✅ User-Agent tersimpan: " + ua, "success");
}

async function cmdScan(args) {
  requireCookie();
  log("🔍 Memindai halaman KRS...", "info");
  let page;
  try {
    page = await fetchKrsPage();
  } catch (e) {
    handleFatal(e);
    return;
  }

  state.available = parseAvailable(page.html);
  persist();

  if (state.available.length === 0) {
    log("⚠ Tidak menemukan dropdown matkul. Pastikan periode pengisian KRS sudah dibuka.", "warn");
    return;
  }
  log(`✅ ${state.available.length} kelas ditemukan.`, "success");

  const q = (args[0] || "").toLowerCase();
  const filtered = q ? state.available.filter((c) => c.label.toLowerCase().includes(q)) : state.available;
  if (q) log(`Filter "${args[0]}": ${filtered.length} cocok.`, "info");

  const MAX = 300;
  filtered.slice(0, MAX).forEach((c) => {
    const added = state.courses.some((x) => x.id === c.idkelas);
    const mark = added ? `${ANSI.green}[sudah ditambahkan]${ANSI.reset}` : "";
    console.log(`  ${ANSI.bold}${c.idkelas}${ANSI.reset}  ${c.label} ${mark}`);
  });
  if (filtered.length > MAX) console.log(`  ... +${filtered.length - MAX} lagi, persempit dengan: scan <kata-kunci>`);
}
// Minta user memilih idkelas saat nama matkul ambigu antar-prodi.
async function promptPick(name, kelas, pilihan) {
  if (!process.stdin.isTTY) return null;
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q) => new Promise((r) => rl.question(q, r));
  console.log(`\n⚠ "${name}"${kelas ? " " + kelas : ""} — ada beberapa pilihan. Pilih nomor:`);
  pilihan.forEach((p, i) => console.log(`  ${ANSI.cyan}[${i + 1}]${ANSI.reset} ${p}`));
  console.log(`  ${ANSI.cyan}[0]${ANSI.reset} Batal`);
  const ans = await question("\nPilih nomor: ");
  rl.close();
  const n = parseInt(ans.trim(), 10);
  if (!n || n < 1 || n > pilihan.length) return null;
  const id = pilihan[n - 1].split(" ")[0];
  return state.available.find((f) => f.idkelas === id);
}

// Tebak prefix prodi pengguna dari matkul yang sudah pernah ditambahkan.
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
    else if (c.id && !/^\d/.test(String(c.id))) addPrefix(c.id);
  }
  let best = "", bestN = 0;
  for (const [p, n] of Object.entries(counts)) {
    if (n > bestN) { best = p; bestN = n; }
  }
  return best;
}

async function cmdAdd(args) {
  const lines = args.join(" ").split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) {
    log('Contoh: node warkrs-cli.js add "Kapita Selekta - RA"', "warn");
    return;
  }

  let added = 0, skipped = 0;
  const notFound = [];
  const pref = inferProgramPrefix();
  if (pref) log(`ℹ️  Deteksi prodi: ${pref} — kelas prodi kamu dipilih otomatis saat ambigu.`, "info");

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    let { id, name, kelas, kode } = parsed;

    if (!id) {
      // Cari idkelas dari hasil scan (cache). Kalau kosong, scan dulu.
      if (state.available.length === 0) {
        log("Cache scan kosong — memindai halaman KRS dulu...", "info");
        requireCookie();
        try {
          const page = await fetchKrsPage();
          state.available = parseAvailable(page.html);
          persist();
          log(`🔍 ${state.available.length} kelas terdeteksi.`, "info");
        } catch (e) {
          handleFatal(e);
          return;
        }
      }
      let found = findAvailable(name, kelas);
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
        if (pref) {
          const byProdi = pool.filter((f) => (f.kode || "").toUpperCase().startsWith(pref));
          if (byProdi.length === 1) { pick = byProdi[0]; autoProdi = true; }
        }
        if (!pick && exact.length === 1) pick = exact[0];
        if (!pick) {
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

function statusLabel(s) {
  return { antri: "⏳ antri", proses: "🔄 proses", berhasil: "✅ OK", gagal: "❌ gagal" }[s] || s;
}

function cmdList() {
  if (state.courses.length === 0) {
    log('Belum ada target. Tambah dengan: node warkrs-cli.js add "Nama - Kelas"', "info");
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
    log("Contoh: node warkrs-cli.js remove 43254", "warn");
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
  // Tampilkan config (cookie disensor)
  for (const [k, v] of Object.entries(CONFIG)) {
    const shown = k === "COOKIE" ? (v ? `(tersimpan, ${String(v).length} karakter)` : "(kosong)") : v;
    console.log(`  ${ANSI.gray}${k}${ANSI.reset} = ${shown}`);
  }
}

async function cmdTgTest() {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    log("Isi dulu TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID via config set.", "error");
    process.exit(1);
  }
  await sendTelegram("✅ Test notifikasi dari WAR KRS ITERA (terminal) berhasil!");
  log("📨 Test Telegram dikirim.", "success");
}

async function cmdWar() {
  requireCookie();
  if (state.courses.length === 0) {
    log('Belum ada target. Tambah dulu: node warkrs-cli.js add "Nama - Kelas"', "error");
    process.exit(1);
  }
  const pending = state.courses.filter((c) => c.status !== "berhasil");
  if (pending.length === 0) {
    log('Semua target sudah berhasil. Jalankan "clear" atau "remove" untuk mulai baru.', "success");
    return;
  }
  // Reset status non-berhasil ke antri (sama seperti tombol Start di versi browser)
  state.courses.forEach((c) => { if (c.status !== "berhasil") c.status = "antri"; });
  persist();
  await runWar();
}

function cmdHelp() {
  console.log(`
${ANSI.bold}⚔ WAR KRS v3 — TERMINAL EDITION (ITERA)${ANSI.reset}
${ANSI.gray}Jalan di terminal — tahan refresh browser, state tersimpan di file.${ANSI.reset}

${ANSI.bold}SETUP (sekali saja):${ANSI.reset}
  1. Login SIAKAD di browser → lolos "Pemeriksaan Keamanan" Cloudflare
  2. DevTools (F12) → Network → klik request apa pun → Headers → salin "Cookie:"
     (pastikan mengandung cf_clearance)
  3. DevTools → Console → ketik: navigator.userAgent → salin hasilnya
  4. ${ANSI.cyan}node warkrs-cli.js cookie "cf_clearance=...; ci_session=..."${ANSI.reset}
     ${ANSI.cyan}node warkrs-cli.js ua "<hasil navigator.userAgent>"${ANSI.reset}

${ANSI.bold}PERINTAH:${ANSI.reset}
  ${ANSI.cyan}cookie "<cookie>"${ANSI.reset}    Simpan cookie sesi login
  ${ANSI.cyan}ua "<user-agent>"${ANSI.reset}    Simpan User-Agent browser (wajib sama dgn browser)
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

${ANSI.bold}CONTOH ALUR WAR:${ANSI.reset}
  node warkrs-cli.js cookie "cf_clearance=...; ci_session=9fda88..."
  node warkrs-cli.js ua "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ..."
  node warkrs-cli.js scan kapita
  node warkrs-cli.js add "Kapita Selekta - RA"
  node warkrs-cli.js add "Studio Dasar 1 - RC"
  node warkrs-cli.js war

${ANSI.gray}Refresh/minimize browser TIDAK berpengaruh ke script ini. Kalau di-log
"SESI LOGIN KEDALUWARSA" atau "Diblokir Cloudflare", salin ulang cookie (+UA)
dari browser lalu jalankan war lagi — progres yang sudah berhasil tersimpan.${ANSI.reset}
`);
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch ((cmd || "").toLowerCase()) {
    case "cookie":  return cmdCookie(args);
    case "ua":      return cmdUa(args);
    case "scan":    return cmdScan(args);
    case "add":     return cmdAdd(args);
    case "list":    return cmdList();
    case "remove":  return cmdRemove(args);
    case "clear":   return cmdClear();
    case "war":     return cmdWar();
    case "config":  return cmdConfig(args);
    case "tgtest":  return cmdTgTest();
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





