"use strict";

exports.start = function start(bot) {
  let browser = null;
  let page = null;
  let busy = false;
  let ready = false;
  bot.CONFIG.USE_REAL_PROFILE = false;
  async function shutdown() {
    bot.abort();
    bot.persist();
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
  }
  process.on("disconnect", shutdown);
  process.on("message", async ({ id, action, data = {} }) => {
    try {
      if (action === "shutdown") return shutdown();
      let result;
      if (action === "state") {
        const loggedIn = page && !page.isClosed() ? await bot.isLoggedIn(page) : false;
        result = { ...bot.snapshot(), busy, ready: ready && !!loggedIn, loggedIn: !!loggedIn,
          browserOpen: !!browser?.connected, browserFound: !!bot.findBrowser() };
      } else {
        if (bot.snapshot().warRunning && ["open_browser", "check_login"].includes(action)) throw new Error("Hentikan WAR terlebih dahulu.");
        if (action === "config_set") {
          const ranges = { RETRY_DELAY_MS: [1000, 300000], RETRY_JITTER_MS: [0, 60000], SPAM_LIMIT: [0, 10000], SECURITY_COOLDOWN_MS: [5000, 300000] };
          const booleans = ["SOUND_ON", "NOTIFY_SUCCESS", "NOTIFY_FAILURE", "CLOUDFLARE_AUTO_VERIFY", "AUTO_STOP_SKS"];
          if (ranges[data.key]) {
            const [min, max] = ranges[data.key];
            if (!Number.isInteger(data.value) || data.value < min || data.value > max) throw new Error(`Nilai ${data.key} harus ${min}-${max}.`);
          } else if (booleans.includes(data.key)) {
            if (typeof data.value !== "boolean") throw new Error("Nilai pengaturan harus boolean.");
          } else throw new Error("Pengaturan ini tidak tersedia di desktop.");
        }
        if (busy && action !== "stop") throw new Error("Persiapan sedang berjalan. Tunggu sebentar.");
        if (action === "open_browser") {
          busy = true;
          try {
            if (!browser?.connected) {
              browser = await bot.launchBrowser();
              page = await bot.getPage(browser);
              bot.attach(browser, page);
              browser.on("disconnected", () => { ready = false; });
            }
            await page.goto(bot.CONFIG.BASE_URL, { waitUntil: "domcontentloaded", timeout: bot.CONFIG.HTTP_TIMEOUT_MS });
            await page.bringToFront();
            if (bot.CONFIG.CLOUDFLARE_AUTO_VERIFY) await bot.solveTurnstile(page, 15000);
            ready = false;
            result = { ok: true };
          } finally { busy = false; }
        } else if (action === "check_login") {
          if (!page || page.isClosed()) throw new Error("Buka browser terlebih dahulu.");
          busy = true;
          try {
            if (!(await bot.isLoggedIn(page))) throw new Error("Login belum terdeteksi. Selesaikan login di browser SIAKAD.");
            await bot.ensureKrsPage(page);
            ready = true;
            result = { ok: true };
          } finally { busy = false; }
        } else {
          if (["war", "scan"].includes(action) && !ready) throw new Error("Periksa login dan halaman KRS terlebih dahulu.");
          if (["open_browser", "check_login"].includes(action) && bot.snapshot().warRunning) throw new Error("Hentikan WAR terlebih dahulu.");
          if (action === "scan") busy = true;
          try { result = await bot.handleAction(action, data); }
          finally { if (action === "scan") busy = false; }
        }
      }
      process.send?.({ id, result });
    } catch (error) { process.send?.({ id, result: { ok: false, message: error.message } }); }
  });
  process.send?.({ type: "ready" });
};
