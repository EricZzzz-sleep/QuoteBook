const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

app.commandLine.appendSwitch("high-dpi-support", "1");

let backendProcess;
let mainWindow;
let backendPort;
let isStarting = false;
let isQuitting = false;
let isStoppingBackend = false;

function isDev() {
  return !app.isPackaged;
}

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function backendExecutablePath() {
  const executable = process.platform === "win32" ? "quotebook-backend.exe" : "quotebook-backend";
  return path.join(process.resourcesPath, "backend", executable);
}

function backendDevCommand(port, dataDir) {
  const python = process.platform === "win32" ? "python" : "python3";
  return {
    command: python,
    args: [
      path.join(__dirname, "backend_launcher.py"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--data-dir",
      dataDir,
    ],
    options: { cwd: path.join(__dirname, "..") },
  };
}

function backendPackagedCommand(port, dataDir) {
  return {
    command: backendExecutablePath(),
    args: ["--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir],
    options: {},
  };
}

function isWindowAlive(window) {
  try {
    return Boolean(window && !window.isDestroyed());
  } catch {
    return false;
  }
}

function sendToMainWindow(channel, ...args) {
  const window = mainWindow;
  try {
    if (!isWindowAlive(window)) return false;
    const { webContents } = window;
    if (!webContents || webContents.isDestroyed()) return false;
    webContents.send(channel, ...args);
    return true;
  } catch {
    if (mainWindow === window) mainWindow = null;
    return false;
  }
}

function showMainWindow() {
  const window = mainWindow;
  try {
    if (!isWindowAlive(window)) return false;
    window.show();
    window.focus();
    return true;
  } catch {
    if (mainWindow === window) mainWindow = null;
    return false;
  }
}

function waitForBackend(port, timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(`http://127.0.0.1:${port}/api/books/`, (response) => {
        response.resume();
        resolve();
      });

      request.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("QuoteBook backend did not start in time."));
          return;
        }
        setTimeout(check, 350);
      });
      request.setTimeout(1000, () => request.destroy());
    };

    check();
  });
}

async function startBackend() {
  const port = await findOpenPort();
  const dataDir = app.getPath("userData");
  fs.mkdirSync(dataDir, { recursive: true });

  const backend = isDev() ? backendDevCommand(port, dataDir) : backendPackagedCommand(port, dataDir);
  backendProcess = spawn(backend.command, backend.args, {
    ...backend.options,
    env: {
      ...process.env,
      QUOTEBOOK_DATA_DIR: dataDir,
      PORT: String(port),
    },
    stdio: isDev() ? "inherit" : "pipe",
    windowsHide: true,
  });

  backendProcess.on("exit", (code) => {
    const shouldNotify = code !== 0 && !isQuitting && !isStoppingBackend;
    backendProcess = null;
    backendPort = null;
    isStoppingBackend = false;
    if (shouldNotify) sendToMainWindow("backend-exited", code);
  });

  await waitForBackend(port);
  backendPort = port;
  return port;
}

async function createWindow(port) {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "QuoteBook",
    backgroundColor: "#f7f4ef",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = window;

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await window.loadURL(`http://127.0.0.1:${port}/`);
}

function stopBackend() {
  if (!backendProcess || backendProcess.killed) {
    backendProcess = null;
    backendPort = null;
    return;
  }
  isStoppingBackend = true;
  backendProcess.kill();
  backendProcess = null;
  backendPort = null;
}

async function startApp() {
  if (isStarting) return;

  if (isWindowAlive(mainWindow)) {
    showMainWindow();
    return;
  }

  isStarting = true;
  try {
    const port = backendPort || await startBackend();
    await createWindow(port);
  } catch (error) {
    dialog.showErrorBox("QuoteBook could not start", error.message);
    app.quit();
  } finally {
    isStarting = false;
  }
}

app.whenReady().then(() => {
  startApp();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 || !isWindowAlive(mainWindow)) {
      startApp();
    } else {
      showMainWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
});

app.on("window-all-closed", () => {
  app.quit();
});
