const { contextBridge, ipcRenderer } = require("electron");
const argument = (name) =>
  process.argv.find((v) => v.startsWith(name + "="))?.slice(name.length + 1);
const memberId = argument("--open-reading-member");
contextBridge.exposeInMainWorld("openReadingDesktop", {
  readerTarget: memberId
    ? {
        memberId,
        workspaceId: argument("--open-reading-workspace"),
        threadId: argument("--open-reading-thread"),
      }
    : null,
  openBook: (workspaceId, memberId, threadId) =>
    ipcRenderer.invoke("open-reading:book", {
      workspaceId,
      memberId,
      threadId,
    }),
  renderBookPDF: (html) => ipcRenderer.invoke("open-reading:render-pdf", html),
  saveConvertedBook: (data, format, name) =>
    ipcRenderer.invoke("open-reading:save-conversion", { data, format, name }),
  showLibrary: () => ipcRenderer.send("open-reading:library"),
  onThread: (navigate) => {
    const listener = (_, id) => navigate(id);
    ipcRenderer.on("open-reading:thread", listener);
    return () => ipcRenderer.removeListener("open-reading:thread", listener);
  },
  onClosing: (flush) => {
    const listener = async () => {
      try {
        await flush();
      } finally {
        ipcRenderer.send("open-reading:closed-ready");
      }
    };
    ipcRenderer.on("open-reading:closing", listener);
    return () => ipcRenderer.removeListener("open-reading:closing", listener);
  },
  setLanguage: (language) => {
    if (language === "en" || language === "zh")
      ipcRenderer.send("open-reading:language", language);
  },
});
