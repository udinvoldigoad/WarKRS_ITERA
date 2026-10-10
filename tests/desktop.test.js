"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
test("desktop engine isolates data, hides secrets, validates readiness and persists targets", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warkrs-desktop-test-"));
  fs.writeFileSync(path.join(dir, "warkrs-config.json"), JSON.stringify({ SIAKAD_PASSWORD: "test-secret", TELEGRAM_BOT_TOKEN: "test-token", COOKIE: "test-cookie" }));
  fs.writeFileSync(path.join(dir, "warkrs-state.json"), JSON.stringify({ courses: [], available: [{ idkelas: "123", nama: "Matkul Uji", kode: "IF-1", kelas: "RA", label: "IF-1 - Matkul Uji - RA" }] }));
  const child = fork(path.join(__dirname, "..", "src", "bot.js"), ["desktop"], { env: { ...process.env, WARKRS_DATA_DIR: dir }, silent: true });
  let id = 0;
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Engine startup timed out")), 15000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Engine exited: ${code}`)));
    child.on("message", (message) => { if (message.type === "ready") { clearTimeout(timer); resolve(); } });
    child.stderr.on("data", (data) => process.stderr.write(data));
  });
  const request = (action, data) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => reject(new Error(`Timeout: ${action}`)), 5000);
    const listener = (message) => { if (message.id === current) { clearTimeout(timer); child.off("message", listener); resolve(message.result); } };
    child.on("message", listener); child.send({ id: current, action, data });
  });
  const state = await request("state");
  assert.equal(state.ready, false);
  assert.equal(state.config.USE_REAL_PROFILE, false);
  for (const secret of ["SIAKAD_PASSWORD", "TELEGRAM_BOT_TOKEN", "COOKIE"]) assert.equal(secret in state.config, false);
  assert.equal((await request("war")).ok, false);
  assert.equal((await request("scan")).ok, false);
  assert.equal((await request("check_login")).ok, false);
  assert.equal((await request("config_set", { key: "RETRY_DELAY_MS", value: -1 })).ok, false);
  assert.equal((await request("config_set", { key: "SIAKAD_PASSWORD", value: "blocked" })).ok, false);
  for (const key of ["NOTIFY_SUCCESS", "NOTIFY_FAILURE", "CLOUDFLARE_AUTO_VERIFY", "SOUND_ON"]) {
    assert.equal((await request("config_set", { key, value: false })).ok, true);
    assert.equal((await request("state")).config[key], false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "warkrs-config.json")))[key], false);
  }
  assert.equal((await request("add", { id: "123" })).ok, true);
  assert.equal((await request("add", { id: "123" })).ok, true);
  assert.equal((await request("state")).courses.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "warkrs-state.json"))).courses[0].id, "123");
  assert.equal((await request("remove", { id: "123" })).ok, true);
  assert.equal((await request("state")).courses.length, 0);
});
