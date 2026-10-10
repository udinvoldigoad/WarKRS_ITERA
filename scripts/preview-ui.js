"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
(async () => {
  const root = path.join(__dirname, "..");
  const browser = await puppeteer.launch({ executablePath: path.join(root, "build", "browser", "chrome.exe"), headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1232, height: 975, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      const config = { RETRY_DELAY_MS: 5000, RETRY_JITTER_MS: 3000, SPAM_LIMIT: 0, SECURITY_COOLDOWN_MS: 45000, NOTIFY_SUCCESS: true, NOTIFY_FAILURE: true, SOUND_ON: true, CLOUDFLARE_AUTO_VERIFY: true, AUTO_STOP_SKS: true };
      window.war = { request: async (action, data) => {
        if (action === "config_set") { config[data.key] = data.value; return { ok: true }; }
        return { config, courses: [], available: [], logs: [], sks: {}, ready: false, browserFound: true, browserOpen: false, warRunning: false };
      } };
    });
    await page.goto(pathToFileURL(path.join(root, "src", "desktop", "index.html")).href);
    await page.waitForFunction(() => document.getElementById("connection").textContent === "Mesin terhubung");
    fs.mkdirSync(path.join(root, "build"), { recursive: true });
    await page.screenshot({ path: path.join(root, "build", "desktop-preview.png"), fullPage: true });
    await page.click('[data-step="4"]');
    await page.screenshot({ path: path.join(root, "build", "settings-preview.png"), fullPage: true });
    await page.click('[data-step="1"]');
    await page.screenshot({ path: path.join(root, "build", "preparation-preview.png"), fullPage: true });
    console.log("UI previews created using isolated fixture data.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
