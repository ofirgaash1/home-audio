"use strict";

const electron = require("electron");
const app = electron.app;
const Tray = electron.Tray;
const Menu = electron.Menu;
const shell = electron.shell;
const clipboard = electron.clipboard;
const dialog = electron.dialog;
const nativeImage = electron.nativeImage;
const BrowserWindow = electron.BrowserWindow;
const { fork } = require("node:child_process");
const path = require("node:path");

if (!app || !Tray || !Menu || !shell || !clipboard || !dialog || !nativeImage || !BrowserWindow) {
  throw new Error("Electron main-process APIs unavailable. Ensure the app is started by Electron (not node mode).");
}

const APP_PORT = Number(process.env.PORT || 43117);
const STATUS_URL = `http://127.0.0.1:${APP_PORT}/api/status`;

let tray = null;
let serverProcess = null;
let cachedStatus = null;
let openingHostAfterStart = true;
let fallbackWindow = null;

function getServerEntryPath() {
  return path.join(__dirname, "..", "lan-audio", "server.js");
}

function createTrayIcon() {
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAQAAAC1QeVaAAAAQ0lEQVR42mNgoBAwUqifATGxA4j4D8QYGBgY/v//j4mJiQmIuQWQxA1E9Q8gqgeQxH8Q1QfE5E8gqk8Q1QfE5A8AAMM5DpqAFxvAAAAAElFTkSuQmCC";
  const icon = nativeImage.createFromDataURL(dataUrl);
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchStatus() {
  try {
    const response = await fetch(STATUS_URL, { method: "GET" });
    if (!response.ok) return null;
    const body = await response.json();
    cachedStatus = body;
    return body;
  } catch (error) {
    return null;
  }
}

async function waitForServerReady(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await fetchStatus();
    if (status && status.hostPage) return status;
    await wait(250);
  }
  return null;
}

function getHostPageUrl() {
  return (cachedStatus && cachedStatus.hostPage) || `http://localhost:${APP_PORT}/host`;
}

function getPreferredListenUrl() {
  const listenPages = (cachedStatus && cachedStatus.listenPages) || [];
  if (listenPages.length > 0) return listenPages[0];
  return `http://localhost:${APP_PORT}/listen`;
}

async function openHostPage() {
  await fetchStatus();
  await shell.openExternal(getHostPageUrl());
}

async function copyListenerLink() {
  await fetchStatus();
  const link = getPreferredListenUrl();
  clipboard.writeText(link);
  if (tray) {
    tray.displayBalloon({
      iconType: "info",
      title: "Home Audio",
      content: `Copied listener link:\n${link}`
    });
  }
}

async function openListenerQr() {
  await fetchStatus();
  const link = getPreferredListenUrl();
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(link)}`;
  await shell.openExternal(qrUrl);
}

function stopServer() {
  if (!serverProcess) return;
  serverProcess.kill();
  serverProcess = null;
  cachedStatus = null;
  updateTrayMenu();
}

async function startServer() {
  if (serverProcess) return;

  const entryPath = getServerEntryPath();
  serverProcess = fork(entryPath, {
    env: {
      ...process.env,
      PORT: String(APP_PORT)
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });

  serverProcess.stdout.on("data", chunk => {
    process.stdout.write(`[home-audio] ${chunk}`);
  });

  serverProcess.stderr.on("data", chunk => {
    process.stderr.write(`[home-audio:err] ${chunk}`);
  });

  serverProcess.on("exit", () => {
    serverProcess = null;
    cachedStatus = null;
    updateTrayMenu();
  });

  updateTrayMenu();
  const status = await waitForServerReady();
  if (!status) {
    dialog.showErrorBox(
      "Home Audio",
      "Failed to start the LAN audio server. Check firewall permissions and audio app logs."
    );
    return;
  }

  if (openingHostAfterStart) {
    openingHostAfterStart = false;
    await openHostPage();
  }

  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const running = Boolean(serverProcess);
  const hostPage = getHostPageUrl();
  const listenLink = getPreferredListenUrl();

  const contextMenu = Menu.buildFromTemplate([
    { label: "Home Audio", enabled: false },
    { type: "separator" },
    {
      label: running ? "Server: Running" : "Server: Stopped",
      enabled: false
    },
    {
      label: "Open Host Page",
      click: () => openHostPage()
    },
    {
      label: "Copy Listener Link",
      click: () => copyListenerLink()
    },
    {
      label: "Show Listener QR",
      click: () => openListenerQr()
    },
    { type: "separator" },
    {
      label: "Start Server",
      enabled: !running,
      click: () => startServer()
    },
    {
      label: "Stop Server",
      enabled: running,
      click: () => stopServer()
    },
    { type: "separator" },
    {
      label: "Launch At Login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => {
        app.setLoginItemSettings({ openAtLogin: Boolean(item.checked) });
      }
    },
    { type: "separator" },
    {
      label: `Host: ${hostPage}`,
      enabled: false
    },
    {
      label: `Listen: ${listenLink}`,
      enabled: false
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        stopServer();
        app.quit();
      }
    }
  ]);

  tray.setToolTip(running ? "Home Audio (running)" : "Home Audio (stopped)");
  tray.setContextMenu(contextMenu);
}

async function createTrayApp() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    openHostPage().catch(() => {});
  });

  try {
    tray = new Tray(createTrayIcon());
    tray.on("double-click", () => {
      openHostPage().catch(() => {});
    });
  } catch (error) {
    dialog.showMessageBox({
      type: "warning",
      title: "Home Audio",
      message: "Tray icon could not be initialized. Running without tray menu.",
      detail: String(error && error.message ? error.message : error)
    }).catch(() => {});
    fallbackWindow = new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      skipTaskbar: true,
      frame: false
    });
  }

  updateTrayMenu();
  await startServer();
}

app.on("window-all-closed", event => {
  event.preventDefault();
});

app.on("before-quit", () => {
  stopServer();
});

app.whenReady().then(() => {
  createTrayApp().catch(error => {
    dialog.showErrorBox("Home Audio", `Failed to initialize desktop app:\n${String(error.message || error)}`);
    app.quit();
  });
});
