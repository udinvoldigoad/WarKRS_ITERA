"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("war", {
  request: (action, data = {}) => ipcRenderer.invoke("war:request", action, data),
});
