"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const puppeteer = require("puppeteer-core");
async function main() {
  const root = path.join(__dirname, "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "warkrs-ui-test-"));
  const env = { ...process.env, WARKRS_TEST_DATA: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.argv[2] || require("electron");
  const args = !process.argv[2] || path.basename(executable).toLowerCase() === "electron.exe" ? [root] : [];
  args.push("--remote-debugging-port=9465");
  const child = spawn(executable, args, { env, windowsHide: true, stdio: "pipe" });
  let errors = "";
  child.stderr.on("data", (data) => { errors += data; });
  let browser;
  try {
    for (let i = 0; i < 60; i++) {
      try { browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9465", defaultViewport: null, protocolTimeout: 30000 }); break; }
      catch (_) { await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    assert.ok(browser, `Electron did not start: ${errors}`);
    const page = (await browser.pages()).find((p) => p.url().endsWith("desktop/index.html"));
    assert.ok(page, "Wizard window not found");
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.waitForFunction(() => document.getElementById("connection").textContent === "Mesin terhubung", { timeout: 30000 });
    const state = await page.evaluate(() => window.war.request("state"));
    assert.equal(state.ready, false);
    assert.equal(state.config.USE_REAL_PROFILE, false);
    assert.equal(state.browserFound, true);
    assert.equal(await page.evaluate(() => typeof require), "undefined");
    assert.equal((await page.evaluate(() => window.war.request("war"))).ok, false);
    await page.click('[data-go="2"]');
    assert.equal(await page.$eval("#message", (el) => el.textContent), "Periksa login terlebih dahulu.");
    await page.click('[data-step="0"]');
    await page.click('[data-step="4"]');
    await page.waitForSelector('[data-screen="4"]', { visible: true });
    await page.click('#notifySuccess');
    await page.click('#autoVerify');
    await page.click('#saveSettings');
    await page.waitForFunction(() => document.getElementById('message').textContent === 'Pengaturan tersimpan.');
    const settings = await page.evaluate(() => window.war.request('state'));
    assert.equal(settings.config.NOTIFY_SUCCESS, false);
    assert.equal(settings.config.CLOUDFLARE_AUTO_VERIFY, false);
    await page.click('[data-step="5"]');
    await page.waitForSelector('[data-screen="5"]', { visible: true });
    await page.click('[data-step="0"]');
    assert.deepEqual(failures, []);
    console.log("Electron smoke test passed: wizard, IPC, engine readiness, browser detection, isolated renderer.");
  } finally {
    if (browser) { await browser.close().catch(() => {}); }
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
