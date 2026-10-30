const { openAsBlob } = require("node:fs");
const { stat } = require("node:fs/promises");
const { basename, extname, isAbsolute } = require("node:path");
const { createHash } = require("node:crypto");

function isBookFile(path) {
  return (
    typeof path === "string" &&
    isAbsolute(path) &&
    extname(path).toLowerCase() === ".epub"
  );
}

// Only an OS-supplied file is copied into the local library. Its parent folder
// is never registered as a source, and no file-reading IPC is exposed to pages.
async function openLocalBook(path, request, language) {
  const text = (zh, en) => (language === "zh" ? zh : en);
  if (!isBookFile(path))
    throw Error(text("请选择 EPUB 文件", "Choose an EPUB file"));
  const info = await stat(path);
  if (!info.isFile() || info.size > 200 * 1024 * 1024)
    throw Error(
      text(
        "请选择不超过 200 MB 的 EPUB 文件",
        "Choose an EPUB file smaller than 200 MB",
      ),
    );
  const blob = await openAsBlob(path, { type: "application/epub+zip" });
  if (blob.size > 200 * 1024 * 1024)
    throw Error(text("文件超过 200 MB", "File exceeds 200 MB"));
  const [workspaces, prefs] = await Promise.all([
    request("/workspaces"),
    request("/preferences"),
  ]);
  let workspace =
    workspaces.find((w) => w.id === prefs.activeWorkspaceId) || workspaces[0];
  const createdWorkspace = !workspace;
  if (!workspace)
    workspace = await request("/workspaces", "POST", {
      name: text("我的书库", "My Library"),
    });
  const root = `/workspaces/${workspace.id}`;
  const name = basename(path);
  const query = `?format=epub&limit=500&q=${encodeURIComponent(name)}`;
  const hash = createHash("sha256");
  for await (const chunk of blob.stream()) hash.update(chunk);
  const digest = hash.digest("hex");
  let cursor = "";
  do {
    const page = await request(root + "/documents" + query + cursor);
    for (const member of page.items) {
      if (member.state !== "active") continue;
      const binding = member.bindings.find(
        (b) =>
          b.state === "active" &&
          b.bindingState === "active" &&
          b.sourceState === "active" &&
          b.size === blob.size,
      );
      if (!binding) continue;
      const prepared = await request(
        `/documents/${member.documentId}/prepare`,
        "POST",
        {
          workspaceDocumentId: member.id,
          sourceEntryId: binding.id,
          purpose: "conversion",
        },
      );
      if (prepared.version.contentHash === digest)
        return {
          workspaceId: workspace.id,
          memberId: member.id,
          createdWorkspace,
        };
    }
    cursor = page.nextCursor
      ? "&cursor=" + encodeURIComponent(page.nextCursor)
      : "";
  } while (cursor);
  const body = new FormData();
  body.append("files", blob, name);
  const imported = await request(root + "/imports", "POST", body);
  if (!imported.files[0]?.imported || imported.scan.state !== "completed")
    throw Error(
      imported.files[0]?.error ||
        text("文件未能加入书库", "Unable to add the file to the library"),
    );
  cursor = "";
  do {
    const page = await request(root + "/documents" + query + cursor);
    const member = page.items.find((m) =>
      m.bindings.some((b) => b.sourceId === imported.id),
    );
    if (member)
      return {
        workspaceId: workspace.id,
        memberId: member.id,
        createdWorkspace,
      };
    cursor = page.nextCursor
      ? "&cursor=" + encodeURIComponent(page.nextCursor)
      : "";
  } while (cursor);
  throw Error(
    text(
      "文件已导入，请在书库中打开",
      "File imported; open it from the library",
    ),
  );
}

module.exports = { isBookFile, openLocalBook };
