"use strict";
const $ = (id) => document.getElementById(id);
let step = 0, state = null, working = false, polling = false, lastLog = "", settingsLoaded = false;
const names = ["RINGKASAN", "PERSIAPAN / LOGIN", "PERSIAPAN / MATA KULIAH", "PERSIAPAN / MULAI WAR", "SETTINGS", "AKTIVITAS"];
const settings = { RETRY_DELAY_MS: "delay", RETRY_JITTER_MS: "jitter", SPAM_LIMIT: "limit", SECURITY_COOLDOWN_MS: "cooldown", NOTIFY_SUCCESS: "notifySuccess", NOTIFY_FAILURE: "notifyFailure", SOUND_ON: "sound", CLOUDFLARE_AUTO_VERIFY: "autoVerify", AUTO_STOP_SKS: "autoSks" };
function fillSettings() {
  for (const [key, id] of Object.entries(settings)) {
    if ($(id).type === "checkbox") $(id).checked = state.config[key] !== false;
    else $(id).value = state.config[key];
  }
  settingsLoaded = true;
  $("settingsDirty").hidden = true;
}
function message(text, success = false) { $("message").hidden = !text; $("message").textContent = text; $("message").className = success ? "success" : ""; }
function go(next) {
  if (state?.warRunning && [1, 2].includes(next)) return message("Hentikan WAR sebelum mengubah persiapan.");
  if ([2, 3].includes(next) && !state?.ready) return message("Periksa login terlebih dahulu.");
  step = next;
  document.querySelectorAll("[data-screen]").forEach((el) => { el.hidden = +el.dataset.screen !== step; });
  document.querySelectorAll("[data-step]").forEach((el) => el.classList.toggle("active", +el.dataset.step === ([2, 3].includes(step) ? 1 : step)));
  $("stepLabel").textContent = names[step];
  message("");
}
async function request(action, data) {
  const result = await window.war.request(action, data);
  if (result?.ok === false) throw new Error(result.message || "Operasi gagal.");
  return result;
}
async function task(operation) {
  if (working) return;
  working = true; message(""); updateControls();
  try { await operation(); }
  catch (error) { message(error.message); }
  finally { working = false; await refresh(); updateControls(); }
}
function updateControls() {
  document.querySelectorAll("button").forEach((button) => { button.disabled = working && button.id !== "stop" && !button.hasAttribute("data-step") && !button.hasAttribute("data-go"); });
  if (!state) { $("prepare").disabled = true; return; }
  $("prepare").disabled = working || state.warRunning || !state.browserFound;
  $("review").disabled = working || !state.courses.length;
  $("start").disabled = working || !state.ready || !state.courses.some((c) => c.status !== "berhasil");
  $("start").hidden = state.warRunning; $("stop").hidden = !state.warRunning;
  $("editTargets").disabled = working || state.warRunning;
  $("saveSettings").disabled = working || state.warRunning;
  $("openBrowser").disabled = working || state.warRunning || !state.browserFound;
  $("checkLogin").disabled = working || state.warRunning || !state.browserOpen;
  $("scan").disabled = working || state.warRunning || !state.ready;
  for (const id of Object.values(settings)) $(id).disabled = working || state.warRunning;
  document.querySelectorAll(".course button").forEach((button) => { button.disabled = working || state.warRunning; });
}
function row(title, subtitle, buttonText, onClick, badge) {
  const el = document.createElement("div"); el.className = "course";
  const info = document.createElement("div"); info.className = "info";
  const strong = document.createElement("strong"); strong.textContent = title;
  const small = document.createElement("small"); small.textContent = subtitle;
  info.append(strong, small); el.append(info);
  if (badge) { const b = document.createElement("span"); b.className = "badge"; b.textContent = badge; el.append(b); }
  if (buttonText) { const button = document.createElement("button"); button.textContent = buttonText; button.disabled = working || state.warRunning; button.onclick = () => task(onClick); el.append(button); }
  return el;
}
function empty(container, text) { const el = document.createElement("div"); el.className = "empty"; el.textContent = text; container.append(el); }
function renderCourses() {
  if (!state) return;
  const query = $("search").value.trim().toLowerCase();
  const selected = new Set(state.courses.map((c) => c.id));
  const available = $("available"); available.replaceChildren();
  const list = state.available.filter((c) => `${c.label} ${c.idkelas}`.toLowerCase().includes(query));
  list.slice(0, 100).forEach((c) => available.append(row(c.label, `ID kelas ${c.idkelas}`, selected.has(c.idkelas) ? null : "Tambah", async () => { await request("add", { id: c.idkelas }); }, selected.has(c.idkelas) ? "Dipilih" : "")));
  if (!list.length) empty(available, state.available.length ? "Tidak ada kelas yang cocok." : "Klik Pindai kelas untuk memuat daftar.");
  $("scanInfo").textContent = state.available.length ? `${state.available.length} kelas dalam cache. Menampilkan ${Math.min(list.length, 100)} hasil. Pindai ulang untuk memperbarui.` : "Daftar kelas belum dipindai.";
  $("targetCount").textContent = `${state.courses.length} target dipilih`;
  const targets = $("targets"); targets.replaceChildren();
  const labels = { antri: "ANTRI", proses: "PROSES", berhasil: "BERHASIL", gagal: "GAGAL" };
  state.courses.forEach((c) => targets.append(row(`${c.name} · ${c.kelas || ""}`, `${c.kode || c.id} · ${c.retries || 0} percobaan${c.log ? " · " + c.log : ""}`, state.warRunning ? null : "Hapus", async () => { await request("remove", { id: c.id }); }, labels[c.status] || c.status)));
  if (!state.courses.length) empty(targets, "Belum ada target. Kembali ke Pilih target.");
  const done = state.courses.filter((c) => c.status === "berhasil").length;
  $("summary").textContent = `${done} dari ${state.courses.length} target berhasil${state.sks.cap ? ` · SKS ${state.sks.used ?? "?"}/${state.sks.cap}` : ""}.`;
  $("previewCount").textContent = `${state.courses.length} target`;
  const preview = $("previewTargets"); preview.replaceChildren();
  state.courses.slice(0, 4).forEach((c) => preview.append(row(`${c.name} · ${c.kelas || ""}`, c.kode || c.id, null, null, labels[c.status] || c.status)));
  if (!state.courses.length) empty(preview, "Belum ada target. Mulai dari menu Persiapan WAR.");
  $("browserHeadline").textContent = state.browserOpen ? "Browser terbuka" : state.browserFound ? "Siap dibuka" : "Tidak tersedia";
  $("sessionHeadline").textContent = state.ready ? "Siap digunakan" : state.loggedIn ? "Perlu diperiksa" : "Belum terhubung";
  $("targetHeadline").textContent = state.courses.length ? `${state.courses.length} mata kuliah` : "Belum dipilih";
  $("progressHeadline").textContent = `${done} berhasil · ${state.courses.filter((c) => c.status === "gagal").length} gagal`;
  $("targetBadge").textContent = `${state.courses.length} target`;
  $("mapStatus").textContent = state.ready ? "Terhubung" : "Belum terhubung";
  $("workspaceStatus").textContent = state.ready ? "Login dan halaman KRS siap" : "Login belum diperiksa";
  $("stepOneStatus").textContent = state.ready ? "✓" : "";
  $("stepTwoStatus").textContent = state.courses.length ? "✓" : "";
  $("activityCount").textContent = state.logs.length;
  $("warBadge").textContent = state.warRunning ? "Berjalan" : "Menunggu";
  for (const [id, good, label] of [["browserBadge", state.browserOpen, state.browserOpen ? "Terbuka" : "Belum dibuka"], ["sessionBadge", state.ready, state.ready ? "Terhubung" : "Belum siap"]]) {
    $(id).textContent = label; $(id).className = `badge ${good ? "good" : "off"}`;
  }
  $("readinessBanner").textContent = state.warRunning ? "WAR berjalan. Pantau hasil melalui Mulai WAR atau Aktivitas." : state.ready ? "Sesi SIAKAD siap. Pilih mata kuliah, lalu mulai WAR setelah memeriksa target." : "Sesi belum siap. Buka browser dan login untuk memulai persiapan.";
  $("readinessBanner").className = `notice-banner ${state.ready ? "ready" : ""}`;
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    state = await request("state");
    if (!settingsLoaded) fillSettings();
    $("connection").textContent = state.warRunning ? "WAR sedang berjalan" : state.busy ? "Mesin sedang menyiapkan…" : state.ready ? "SIAKAD siap" : "Mesin terhubung";
    $("browserStatus").textContent = state.browserFound ? "Tersedia dan siap dibuka" : "Browser tidak ditemukan. Instal ulang aplikasi.";
    $("warStatus").textContent = state.warRunning ? state.lastStatus || "WAR berjalan…" : state.ready ? "Siap untuk memulai." : "Sesi belum siap. Periksa login terlebih dahulu.";
    renderCourses(); updateControls();
    const logs = state.logs.map((l) => `[${l.ts}] ${l.msg}`).join("\n");
    if (logs !== lastLog) { $("logs").textContent = logs || "Belum ada aktivitas."; $("logs").scrollTop = $("logs").scrollHeight; lastLog = logs; }
  } catch (error) { $("connection").textContent = "Mesin tidak terhubung"; message(error.message); }
  finally { polling = false; }
}
document.querySelectorAll("[data-step]").forEach((button) => { button.onclick = () => go(+button.dataset.step); });
document.querySelectorAll("[data-go]").forEach((button) => { button.onclick = () => go(+button.dataset.go); });
$("dashboardPrepare").onclick = () => go(1);
for (const id of Object.values(settings)) $(id).addEventListener("input", () => { $("settingsDirty").hidden = false; });
$("prepare").onclick = () => task(async () => { await request("open_browser"); go(1); });
$("openBrowser").onclick = () => task(async () => { await request("open_browser"); });
$("checkLogin").onclick = () => task(async () => { await request("check_login"); await refresh(); go(2); });
$("scan").onclick = () => task(async () => { const result = await request("scan"); message(`${result.count} kelas berhasil dipindai.`, true); });
$("search").oninput = renderCourses;
$("review").onclick = () => go(3);
$("editTargets").onclick = () => go(2);
$("start").onclick = () => task(async () => { await request("war"); });
$("stop").onclick = async () => { try { await request("stop"); await refresh(); } catch (error) { message(error.message); } };
$("saveSettings").onclick = () => task(async () => {
  const values = [["RETRY_DELAY_MS", "delay", 1000, 300000], ["RETRY_JITTER_MS", "jitter", 0, 60000], ["SPAM_LIMIT", "limit", 0, 10000], ["SECURITY_COOLDOWN_MS", "cooldown", 5000, 300000]];
  for (const [, id, min, max] of values) { const n = Number($(id).value); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Nilai ${id} harus ${min}–${max}.`); }
  for (const [key, id] of values) await request("config_set", { key, value: Number($(id).value) });
  for (const [key, id] of Object.entries(settings)) if ($(id).type === "checkbox") await request("config_set", { key, value: $(id).checked });
  $("settingsDirty").hidden = true;
  message("Pengaturan tersimpan.", true);
});
go(0);
refresh();
setInterval(refresh, 2000);
