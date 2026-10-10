"use strict";
const { app, BrowserWindow, ipcMain, dialog, Notification } = require("electron");
const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
let window, engine, closing = false, sequence = 0;
const pending = new Map();
const uiPath = path.join(__dirname, "index.html");
const uiURL = pathToFileURL(uiPath).href;
if (process.env.WARKRS_TEST_DATA) app.setPath("userData", process.env.WARKRS_TEST_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window) { window.restore(); window.focus(); } });
  app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId("id.itera.warkrs");
    const browserPath = path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "..", "build"), "browser", "chrome.exe");
    engine = fork(path.join(__dirname, "..", "bot.js"), ["desktop"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", WARKRS_DATA_DIR: app.getPath("userData"),
        WARKRS_BROWSER_PATH: fs.existsSync(browserPath) ? browserPath : "" },
      silent: true,
    });
    engine.stdout.on("data", () => {});
    engine.stderr.on("data", () => {});
    engine.on("message", ({ id, result, type, kind, message }) => {
      if (type === "notification" && Notification.isSupported() && !process.env.WARKRS_TEST_DATA) {
        const notification = new Notification({ title: kind === "success" ? "WAR KRS · Berhasil" : "WAR KRS · Target gagal", body: message, silent: true });
        notification.on("click", () => { window?.restore(); window?.focus(); });
        notification.show();
      }
      const item = pending.get(id);
      if (item) { clearTimeout(item.timer); pending.delete(id); item.resolve(result); }
    });
    engine.on("error", (error) => dialog.showErrorBox("Mesin WAR KRS gagal dibuka", error.message));
    engine.on("exit", () => {
      for (const item of pending.values()) { clearTimeout(item.timer); item.resolve({ ok: false, message: "Mesin berhenti. Tutup dan buka kembali aplikasi." }); }
      pending.clear();
    });
    const actions = new Set(["state", "open_browser", "check_login", "scan", "add", "remove", "war", "stop", "config_set"]);
    ipcMain.handle("war:request", (event, action, data) => {
      if (event.sender !== window.webContents || event.senderFrame.url !== uiURL || !actions.has(action)) throw new Error("Permintaan tidak diizinkan.");
      if (!engine?.connected) return { ok: false, message: "Mesin belum tersedia." };
      return new Promise((resolve) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, message: "Operasi belum selesai. Periksa browser dan log sebelum mencoba lagi." }); }, action === "state" ? 10000 : 240000);
        pending.set(id, { resolve, timer });
        engine.send({ id, action, data });
      });
    });
    window = new BrowserWindow({ width: 1120, height: 800, minWidth: 800, minHeight: 640,
      title: "WAR KRS", backgroundColor: "#101816", autoHideMenuBar: true, show: !process.env.WARKRS_TEST_DATA,
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.loadFile(uiPath);
    window.on("close", (event) => {
      if (closing) return;
      const answer = process.env.WARKRS_TEST_DATA ? 1 : dialog.showMessageBoxSync(window, { type: "question", buttons: ["Tetap buka", "Tutup aplikasi"], defaultId: 0, cancelId: 0,
        title: "Tutup WAR KRS?", message: "Operasi WAR akan dihentikan dan progres disimpan." });
      if (answer === 0) { event.preventDefault(); return; }
      event.preventDefault(); closing = true;
      if (engine?.connected) engine.send({ action: "shutdown" });
      const timeout = setTimeout(() => { engine?.kill(); window.destroy(); app.quit(); }, 5000);
      engine?.once("exit", () => { clearTimeout(timeout); window.destroy(); app.quit(); });
    });
  });
  app.on("window-all-closed", () => app.quit());
}
