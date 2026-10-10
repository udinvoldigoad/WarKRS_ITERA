"use strict";
const { install, Browser, BrowserPlatform, resolveBuildId } = require("@puppeteer/browsers");
const fs = require("fs");
const path = require("path");
async function main() {
  if (process.platform !== "win32") throw new Error("Build installer ini membutuhkan Windows.");
  const root = path.join(__dirname, "..", "build");
  const destination = path.join(root, "browser");
  if (fs.existsSync(path.join(destination, "chrome.exe"))) {
    console.log("Browser siap:", path.join(destination, "chrome.exe"));
    return;
  }
  const buildId = await resolveBuildId(Browser.CHROME, BrowserPlatform.WIN64, "stable");
  console.log(`Mengunduh Chrome for Testing ${buildId} untuk installer…`);
  const installed = await install({ browser: Browser.CHROME, platform: BrowserPlatform.WIN64,
    buildId, cacheDir: path.join(root, "browser-cache") });
  fs.cpSync(path.dirname(installed.executablePath), destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "warkrs-browser.json"), JSON.stringify({ buildId, browser: "Chrome for Testing" }, null, 2));
  console.log("Browser siap:", path.join(destination, "chrome.exe"));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
