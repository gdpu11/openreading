const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  session,
  powerMonitor,
  ipcMain,
  safeStorage,
  screen,
} = require("electron");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} = require("node:fs");
const CLOUD = process.env.OPENREADING_CLOUD_URL || "";
let win,
  service,
  stopping = false,
  opening = false;
const readers = new Map();
const managedWindows = new Set();
const closeWaiters = new Map();
let libraryURL;
let pendingReadingLink;
function parseReadingLink(value) {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "openreading:" ||
      u.hostname !== "read" ||
      u.username ||
      u.password
    )
      return null;
    const target = {
      workspaceId: u.searchParams.get("workspace"),
      memberId: u.searchParams.get("book"),
      threadId: u.searchParams.get("thread") || undefined,
    };
    if (
      ![
        target.workspaceId,
        target.memberId,
        ...(target.threadId ? [target.threadId] : []),
      ].every((v) => typeof v === "string" && /^[a-f0-9]{32}$/.test(v))
    )
      return null;
    return target;
  } catch {
    return null;
  }
}
async function followReadingLink(value) {
  const target = parseReadingLink(value);
  if (!target) return;
  if (!libraryURL) {
    pendingReadingLink = value;
    return;
  }
  await openBookTarget(target);
}
app.on("open-url", (event, value) => {
  event.preventDefault();
  void followReadingLink(value).catch(() => showLibrary());
});
let quitting = false;
let stopPromise = Promise.resolve();
let settings = { mode: "local", language: "en" };
const settingsFile = () => join(app.getPath("userData"), "desktop.json");
if (
  !app.isPackaged &&
  process.env.OR_DESKTOP_SMOKE &&
  process.env.OR_DESKTOP_DATA
) {
  const profile = join(process.env.OR_DESKTOP_DATA, "..", "desktop-profile");
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
}

function save() {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings), { mode: 0o600 });
}
function stopService() {
  if (!service) return stopPromise;
  const child = service;
  service = undefined;
  stopPromise = new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
  return stopPromise;
}
async function localService() {
  const binary = app.isPackaged
    ? join(
        process.resourcesPath,
        "runtime",
        process.platform === "win32" ? "openreading.exe" : "openreading",
      )
    : join(
        __dirname,
        "runtime",
        process.platform === "win32" ? "openreading.exe" : "openreading",
      );
  if (!existsSync(binary))
    throw Error("本机阅读服务未打包。开发环境先运行 npm run desktop:prepare。");
  const apk = join(
    app.isPackaged ? process.resourcesPath : __dirname,
    "mobile",
    "Open-Reading-android.apk",
  );
  const child = (service = spawn(
    binary,
    [
      "--port",
      "0",
      "--machine-readable",
      "--data-dir",
      settings.dataDir || join(app.getPath("userData"), "library"),
      ...(existsSync(apk) ? ["--android-apk", apk] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  ));
  const ready = await new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(Error("本机服务启动超时")), 30000);
    child.once("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        Error(
          `本机阅读服务无法启动（${code}）。请确认书库没有被其他进程占用。`,
        ),
      );
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const v = JSON.parse(line);
          if (v.type === "ready") {
            clearTimeout(timeout);
            resolve(v);
          }
        } catch {}
      }
    });
    // Backend logs never enter the renderer or persistent Electron logs.
    child.stderr.on("data", () => {});
  });
  const response = await fetch(ready.url + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: ready.code }),
  });
  if (!response.ok) throw Error("本机服务登录失败");
  const token = /openreading_session=([^;]+)/.exec(
    response.headers.get("set-cookie") || "",
  )?.[1];
  if (!token) throw Error("本机服务未返回会话");
  await session.defaultSession.cookies.set({
    url: ready.url,
    name: "openreading_session",
    value: token,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  return ready.url;
}
async function open(mode) {
  if (opening) return;
  if (mode === "cloud") {
    let valid = false;
    try {
      const url = new URL(CLOUD);
      valid =
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash;
    } catch {}
    if (!valid) {
      await dialog.showMessageBox(win, {
        type: "info",
        title: "Open Reading",
        message:
          settings.language === "zh"
            ? "请先配置你自己的云端书库地址"
            : "Configure your own cloud library first",
        detail:
          settings.language === "zh"
            ? "启动应用时设置 OPENREADING_CLOUD_URL 为你的 HTTPS 服务器地址。本机阅读和局域网同步无需服务器。"
            : "Set OPENREADING_CLOUD_URL to your HTTPS server origin when launching the app. Local reading and LAN sync do not need a server.",
      });
      return;
    }
  }
  opening = true;
  try {
    await Promise.all([...readers.values()].map(closeWindow));
    await stopService();
    settings.mode = mode;
    save();
    const url = mode === "local" ? await localService() : CLOUD;
    libraryURL = url;
    if (!win || win.isDestroyed()) win = createWindow();
    win.allowedOrigin = new URL(url).origin;
    await win.loadURL(url);
    win.show();
  } catch (e) {
    await stopService();
    await dialog.showMessageBox(win, {
      type: "error",
      title: "Open Reading",
      message: e.message,
    });
  } finally {
    opening = false;
  }
}
async function zoomReading(action, target = BrowserWindow.getFocusedWindow()) {
  const contents = target?.webContents;
  if (!contents || contents.isDestroyed()) return;
  // The fixed event is handled by the PDF reader. Preserve application zoom
  // when another document or the library is open.
  try {
    const unhandled = await contents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent("openreading-pdf-zoom", { detail: "${action}", cancelable: true }))`,
    );
    if (unhandled && !contents.isDestroyed())
      contents.setZoomLevel(
        action === "reset"
          ? 0
          : contents.getZoomLevel() + (action === "in" ? 1 : -1),
      );
  } catch {
    // A navigation or window close can dispose the target during the command.
  }
}
function configureMenu() {
  const text = (zh, en) => (settings.language === "zh" ? zh : en);
  const roles = {
    quit: ["退出 Open Reading", "Quit Open Reading"],
    undo: ["撤销", "Undo"],
    redo: ["重做", "Redo"],
    cut: ["剪切", "Cut"],
    copy: ["复制", "Copy"],
    paste: ["粘贴", "Paste"],
    selectAll: ["全选", "Select All"],
    reload: ["重新载入", "Reload"],
    resetZoom: ["实际大小", "Actual Size"],
    zoomIn: ["放大", "Zoom In"],
    zoomOut: ["缩小", "Zoom Out"],
    togglefullscreen: ["切换全屏", "Toggle Full Screen"],
    close: ["关闭窗口", "Close Window"],
  };
  const roleItem = (role) => ({ role, label: text(...roles[role]) });
  const zoomItem = (role, action, accelerator) => ({
    id: "reading-zoom-" + action,
    label: text(...roles[role]),
    accelerator,
    click: () => void zoomReading(action),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      {
        label: text("书库", "Library"),
        submenu: [
          {
            label: text("显示书库", "Show Library"),
            accelerator: "CmdOrCtrl+L",
            click: showLibrary,
          },
          { type: "separator" },
          {
            label: text("本机书库 · 局域网同步", "Local library · LAN sync"),
            click: () => open("local"),
          },
          {
            label: text("可选云端书库", "Optional cloud library"),
            click: () => open("cloud"),
          },
          {
            label: text("打开已有本机书库…", "Open existing local library…"),
            click: async () => {
              const v = await dialog.showOpenDialog(win, {
                properties: ["openDirectory"],
                title: text(
                  "选择 Open Reading 数据目录（包含 library.sqlite）",
                  "Choose an Open Reading data folder (containing library.sqlite)",
                ),
              });
              if (!v.canceled) {
                if (!existsSync(join(v.filePaths[0], "library.sqlite"))) {
                  await dialog.showMessageBox(win, {
                    message: text(
                      "请选择包含 library.sqlite 的完整书库目录",
                      "Choose a complete library folder containing library.sqlite",
                    ),
                  });
                  return;
                }
                settings.dataDir = v.filePaths[0];
                await open("local");
              }
            },
          },
          { type: "separator" },
          roleItem("close"),
          roleItem("quit"),
        ],
      },
      {
        label: text("编辑", "Edit"),
        submenu: [
          roleItem("undo"),
          roleItem("redo"),
          { type: "separator" },
          roleItem("cut"),
          roleItem("copy"),
          roleItem("paste"),
          roleItem("selectAll"),
        ],
      },
      {
        label: text("视图", "View"),
        submenu: [
          roleItem("reload"),
          zoomItem("resetZoom", "reset", "CmdOrCtrl+0"),
          zoomItem("zoomIn", "in", "CmdOrCtrl+Plus"),
          zoomItem("zoomOut", "out", "CmdOrCtrl+-"),
          roleItem("togglefullscreen"),
        ],
      },
      { role: "windowMenu", label: text("窗口", "Window") },
      {
        label: text("帮助", "Help"),
        submenu: [
          {
            label: text("GitHub（调试阶段私有）", "GitHub (private preview)"),
            click: () =>
              shell.openExternal("https://github.com/gdpu11/openreading"),
          },
          {
            label: text("关于 Open Reading", "About Open Reading"),
            click: () =>
              dialog.showMessageBox(win, {
                message: "Open Reading " + app.getVersion(),
                detail: text(
                  "文件、阅读与笔记。电脑即书库。手机在同一局域网扫码同步，无需服务器。",
                  "Files, reading and notes. Your computer hosts your library; phones sync directly over your local network. No server needed.",
                ),
              }),
          },
        ],
      },
    ]),
  );
}
function trusted(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  return (
    managedWindows.has(window) &&
    !!event.senderFrame &&
    event.senderFrame === event.sender.mainFrame &&
    new URL(event.senderFrame.url).origin === window.allowedOrigin
  );
}
function readingSystemState() {
  // A resume notification can precede screen unlock, and its matching unlock
  // notification may be missed. Re-sample instead of latching that state.
  publishReadingSystemState(powerMonitor.getSystemIdleState(120) !== "locked");
}
function publishReadingSystemState(systemActive) {
  for (const window of managedWindows) {
    if (window.webContents.isDestroyed()) continue;
    const active =
      systemActive &&
      window.isFocused() &&
      !window.isMinimized() &&
      window.isVisible();
    void window.webContents
      .executeJavaScript(
        `document.documentElement.dataset.readingSystemActive = '${active}'; window.dispatchEvent(new Event('openreading-system-state'));`,
      )
      .catch(() => {});
  }
}
function showLibrary() {
  if (!win || win.isDestroyed()) {
    win = createWindow();
    if (libraryURL) {
      win.allowedOrigin = new URL(libraryURL).origin;
      void win.loadURL(libraryURL);
    }
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
async function closeWindow(window) {
  if (window.isDestroyed()) return;
  if (window.closing) return window.closing;
  window.closing = (async () => {
    // Keep the shared service alive until progress and drafts are flushed.
    // A crashed renderer must not prevent closing the desktop application.
    if (
      !window.webContents.isDestroyed() &&
      !window.webContents.isLoadingMainFrame()
    )
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        closeWaiters.set(window.webContents.id, () => {
          clearTimeout(timeout);
          resolve();
        });
        window.webContents.send("open-reading:closing");
      });
    closeWaiters.delete(window.webContents.id);
    window.allowClose = true;
    if (!window.isDestroyed()) window.close();
  })();
  return window.closing;
}
async function openBookTarget(target) {
  if (
    opening ||
    quitting ||
    !libraryURL ||
    !target ||
    ![target.workspaceId, target.memberId].every(
      (v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v),
    )
  )
    throw Error("Invalid reading window request");
  const existing = readers.get(target.memberId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    if (typeof target.threadId === "string")
      existing.webContents.send("open-reading:thread", target.threadId);
    return;
  }
  const window = createWindow({
    workspaceId: target.workspaceId,
    memberId: target.memberId,
    threadId:
      typeof target.threadId === "string" &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(target.threadId)
        ? target.threadId
        : undefined,
  });
  readers.set(target.memberId, window);
  try {
    await window.loadURL(libraryURL);
  } catch (error) {
    // Reloading or closing a loading book cancels the initial navigation.
    if (!window.isDestroyed() && error.code !== "ERR_ABORTED") throw error;
  }
}
function createWindow(target) {
  const library = target && win && !win.isDestroyed() ? win.getBounds() : null;
  const area = library ? screen.getDisplayMatching(library).workArea : null;
  const width = library
    ? Math.max(600, Math.min(1200, library.width - 120, area.width - 48))
    : 1420;
  const height = library
    ? Math.max(560, Math.min(800, library.height - 100, area.height - 48))
    : 960;
  const window = new BrowserWindow({
    title: "Open Reading",
    width,
    height,
    ...(library
      ? {
          x: Math.max(
            area.x,
            Math.min(
              library.x + Math.round((library.width - width) / 2),
              area.x + area.width - width,
            ),
          ),
          y: Math.max(
            area.y,
            Math.min(
              library.y + Math.round((library.height - height) / 2),
              area.y + area.height - height,
            ),
          ),
        }
      : {}),
    minWidth: 600,
    minHeight: 560,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      additionalArguments: target
        ? [
            "--open-reading-workspace=" + target.workspaceId,
            "--open-reading-member=" + target.memberId,
            ...(target.threadId
              ? ["--open-reading-thread=" + target.threadId]
              : []),
          ]
        : [],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (
      input.type !== "keyDown" ||
      input.alt ||
      input.isComposing ||
      !(input.control || input.meta)
    )
      return;
    const action = ["+", "="].includes(input.key)
      ? "in"
      : ["-", "_"].includes(input.key)
        ? "out"
        : input.key === "0"
          ? "reset"
          : undefined;
    if (action) {
      event.preventDefault();
      void zoomReading(action, window);
    }
  });

  window.readerTarget = target;
  window.allowedOrigin = libraryURL ? new URL(libraryURL).origin : undefined;
  managedWindows.add(window);
  window.webContents.on("did-finish-load", readingSystemState);
  for (const name of ["focus", "blur", "minimize", "restore", "show", "hide"])
    window.on(name, readingSystemState);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== window.allowedOrigin) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (window.allowClose) return;
    event.preventDefault();
    if (window === win && readers.size && !quitting) window.hide();
    else void closeWindow(window);
  });
  window.on("closed", () => {
    managedWindows.delete(window);
    if (target) {
      readers.delete(target.memberId);
      if (!quitting && win && !win.isVisible()) showLibrary();
    } else if (win === window) win = undefined;
  });
  return window;
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_, argv) => {
    const value = argv.find((v) => v.startsWith("openreading://"));
    if (value) void followReadingLink(value).catch(() => showLibrary());
    else showLibrary();
  });
  app.on("activate", () => {
    if (
      !quitting &&
      libraryURL &&
      ![...managedWindows].some(
        (window) => window.isVisible() && !window.isMinimized(),
      )
    )
      showLibrary();
  });
  app.whenReady().then(async () => {
    try {
      settings = {
        ...settings,
        ...JSON.parse(readFileSync(settingsFile(), "utf8")),
      };
    } catch {}
    if (!settings.localFirstVersion) {
      settings.mode = "local";
      settings.localFirstVersion = 1;
    }
    if (!app.isPackaged && process.env.OR_DESKTOP_SMOKE)
      settings.dataDir = process.env.OR_DESKTOP_DATA;
    for (const name of ["lock-screen", "suspend"])
      powerMonitor.on(name, () => publishReadingSystemState(false));
    for (const name of ["unlock-screen", "resume"])
      powerMonitor.on(name, readingSystemState);
    // Native activation events can report a transitional focus/visibility state.
    // Reconcile after it settles, even when no further window event arrives.
    const readingStateTimer = setInterval(readingSystemState, 1000);
    readingStateTimer.unref();
    app.once("will-quit", () => clearInterval(readingStateTimer));
    session.defaultSession.setPermissionRequestHandler(
      (wc, permission, callback, details) => {
        const window = BrowserWindow.fromWebContents(wc);
        callback(
          managedWindows.has(window) &&
            details.isMainFrame &&
            ["fullscreen", "clipboard-sanitized-write"].includes(permission) &&
            new URL(details.requestingUrl).origin === window.allowedOrigin,
        );
      },
    );
    const tools = require("./reading-tools.cjs");
    const keys = tools.credentialStore(app.getPath("userData"), safeStorage);
    ipcMain.handle(
      "open-reading:credential",
      async (event, action, request) => {
        if (!trusted(event) || settings.mode !== "local")
          throw Error("Local desktop only");
        return keys(action, request);
      },
    );
    ipcMain.handle("open-reading:ocr", async (event, image) => {
      if (!trusted(event)) throw Error("Untrusted reader");
      return tools.recognizePage(
        image,
        app.getPath("temp"),
        app.isPackaged
          ? join(process.resourcesPath, "runtime")
          : join(__dirname, "runtime"),
      );
    });
    ipcMain.on("open-reading:closed-ready", (event) => {
      if (trusted(event)) closeWaiters.get(event.sender.id)?.();
    });
    ipcMain.on("open-reading:library", (event) => {
      if (trusted(event)) showLibrary();
    });
    ipcMain.handle("open-reading:render-pdf", async (event, html) => {
      if (
        !trusted(event) ||
        typeof html !== "string" ||
        Buffer.byteLength(html) > 200 * 1024 * 1024
      )
        throw Error("Invalid print request");
      const fs = require("node:fs/promises");
      const dir = await fs.mkdtemp(
        join(app.getPath("temp"), "openreading-print-"),
      );
      let printing;
      try {
        const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'">`;
        await fs.writeFile(join(dir, "book.html"), policy + html, {
          mode: 0o600,
        });
        printing = new BrowserWindow({
          show: false,
          width: 900,
          height: 1200,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            partition: "conversion-" + require("node:crypto").randomUUID(),
          },
        });
        const initialURL = require("node:url").pathToFileURL(
          join(dir, "book.html"),
        ).href;
        printing.webContents.session.setPermissionRequestHandler(
          (wc, permission, callback) => callback(false),
        );
        printing.webContents.session.webRequest.onBeforeRequest(
          (details, callback) =>
            callback({
              cancel:
                details.url !== initialURL && !details.url.startsWith("data:"),
            }),
        );
        printing.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        printing.webContents.on("will-navigate", (e) => e.preventDefault());
        await printing.loadFile(join(dir, "book.html"));
        await printing.webContents.executeJavaScript(
          "Promise.all([document.fonts.ready,...Array.from(document.images,img=>img.complete?(img.naturalWidth?Promise.resolve():Promise.reject(Error('Image could not load'))):new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('Image could not load'));}))]).then(()=>true)",
        );
        const pdf = await printing.webContents.printToPDF({
          pageSize: "A4",
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: false,
        });
        if (pdf.length > 200 * 1024 * 1024)
          throw Error("Converted PDF exceeds 200 MB");
        return new Uint8Array(pdf);
      } finally {
        if (printing && !printing.isDestroyed()) printing.destroy();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
    ipcMain.handle("open-reading:save-conversion", async (event, request) => {
      if (
        !trusted(event) ||
        !request ||
        !["pdf", "epub"].includes(request.format) ||
        !(request.data instanceof Uint8Array) ||
        request.data.length > 200 * 1024 * 1024
      )
        throw Error("Invalid conversion output");
      const bytes = Buffer.from(request.data);
      if (
        request.format === "pdf"
          ? bytes.subarray(0, 5).toString() !== "%PDF-"
          : bytes.subarray(0, 2).toString() !== "PK"
      )
        throw Error("Invalid output format");
      const name =
        String(request.name || "Book")
          .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
          .slice(0, 160) +
        "." +
        request.format;
      const chosen = await dialog.showSaveDialog(
        BrowserWindow.fromWebContents(event.sender),
        {
          defaultPath: join(app.getPath("downloads"), name),
          filters: [
            {
              name: request.format.toUpperCase(),
              extensions: [request.format],
            },
          ],
        },
      );
      if (chosen.canceled || !chosen.filePath) return { saved: false };
      const path = chosen.filePath.toLowerCase().endsWith("." + request.format)
        ? chosen.filePath
        : chosen.filePath + "." + request.format;
      const fs = require("node:fs/promises");
      // The save panel only confirmed chosen.filePath. If we appended an
      // extension, ask again before replacing a different existing filename.
      if (path !== chosen.filePath) {
        try {
          await fs.access(path);
          const answer = await dialog.showMessageBox(
            BrowserWindow.fromWebContents(event.sender),
            {
              type: "warning",
              buttons: ["Cancel", "Replace"],
              defaultId: 0,
              cancelId: 0,
              message: "Replace the existing file?",
              detail: path,
              noLink: true,
            },
          );
          if (answer.response !== 1) return { saved: false };
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      const temp =
        path + ".openreading-" + require("node:crypto").randomUUID() + ".tmp";
      try {
        await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
        await fs.rename(temp, path);
      } finally {
        await fs.rm(temp, { force: true });
      }
      return { saved: true };
    });
    ipcMain.handle("open-reading:book", async (event, target) => {
      if (!trusted(event)) throw Error("Untrusted reading window");
      return openBookTarget(target);
    });
    ipcMain.on("open-reading:language", (event, language) => {
      if (
        !trusted(event) ||
        !["en", "zh"].includes(language) ||
        settings.language === language
      )
        return;
      settings.language = language;
      save();
      configureMenu();
    });
    configureMenu();
    await open(settings.mode === "cloud" ? "cloud" : "local");
    if (app.isPackaged) app.setAsDefaultProtocolClient("openreading");
    const readingLink =
      pendingReadingLink ||
      process.argv.find((v) => v.startsWith("openreading://"));
    if (readingLink) await followReadingLink(readingLink);
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (stopping) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => {
      await Promise.all([...managedWindows].map(closeWindow));
      await stopService();
      stopping = true;
      app.quit();
    })();
  });
}
