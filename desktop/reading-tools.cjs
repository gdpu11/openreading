const { join } = require("node:path");
const fs = require("node:fs/promises");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);

function credentialStore(directory, safeStorage) {
  let serial = Promise.resolve();
  const path = join(directory, "protected-model-keys.json");
  const read = async () => {
    try {
      return JSON.parse(await fs.readFile(path, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return {};
      throw e;
    }
  };
  const encrypted = () =>
    safeStorage.isEncryptionAvailable() &&
    (!safeStorage.getSelectedStorageBackend ||
      safeStorage.getSelectedStorageBackend() !== "basic_text");
  return async (action, request) => {
    if (
      !request ||
      !/^[a-f0-9]{32}$/.test(request.id) ||
      typeof request.target !== "string" ||
      request.target.length > 4096
    )
      throw Error("Invalid provider");
    const task = serial.then(async () => {
      const values = await read(),
        previous = values[request.id];
      if (action === "load") {
        if (!previous || previous.target !== request.target) return null;
        if (!encrypted()) throw Error("系统密钥存储不可用，未读取已保存密钥");
        return safeStorage.decryptString(Buffer.from(previous.value, "base64"));
      }
      if (action === "save") {
        if (!encrypted()) throw Error("系统密钥存储不可用，密钥未持久保存");
        if (
          typeof request.key !== "string" ||
          !request.key ||
          request.key.length > 8192
        )
          throw Error("Invalid credential");
        values[request.id] = {
          target: request.target,
          value: safeStorage.encryptString(request.key).toString("base64"),
        };
      } else if (action === "forget") delete values[request.id];
      else throw Error("Invalid credential action");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path + ".tmp", JSON.stringify(values), {
        mode: 0o600,
      });
      await fs.rename(path + ".tmp", path);
      return true;
    });
    serial = task.catch(() => {});
    return task;
  };
}
function parseTesseractTsv(tsv) {
  const groups = new Map();
  const rows = tsv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((row) => row.split("\t"));
  const page = rows.find((row) => row[0] === "1");
  const width = Number(page?.[8]) || 1,
    height = Number(page?.[9]) || 1;
  for (const row of rows) {
    if (row[0] !== "5" || !row[11]?.trim()) continue;
    const key = row.slice(1, 5).join(":"),
      text = row.slice(11).join("\t");
    const confidence = Math.max(0, Math.min(1, (Number(row[10]) || 0) / 100));
    const box = {
      x: Number(row[6]) / width,
      y: 1 - (Number(row[7]) + Number(row[9])) / height,
      width: Number(row[8]) / width,
      height: Number(row[9]) / height,
    };
    const previous = groups.get(key);
    if (previous) {
      previous.text += " " + text;
      previous.confidence = Math.min(previous.confidence, confidence);
      const right = Math.max(
          previous.box.x + previous.box.width,
          box.x + box.width,
        ),
        top = Math.max(
          previous.box.y + previous.box.height,
          box.y + box.height,
        );
      previous.box.x = Math.min(previous.box.x, box.x);
      previous.box.y = Math.min(previous.box.y, box.y);
      previous.box.width = right - previous.box.x;
      previous.box.height = top - previous.box.y;
    } else groups.set(key, { text, confidence, box, alternatives: [] });
  }
  return [...groups.values()];
}
async function recognizePage(image, tempRoot, runtime, detailed = false) {
  if (
    typeof image !== "string" ||
    !image.startsWith("data:image/png;base64,") ||
    image.length > 32 * 1024 * 1024
  )
    throw Error("Invalid page image");
  const bytes = Buffer.from(image.slice(22), "base64");
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw Error("Invalid PNG");
  const dir = await fs.mkdtemp(join(tempRoot, "openreading-ocr-"));
  try {
    const file = join(dir, "page.png");
    await fs.writeFile(file, bytes, { mode: 0o600 });
    let result;
    if (process.platform === "darwin") {
      const helper = join(runtime, "openreading-ocr");
      try {
        await fs.access(helper);
        result = await execFile(
          helper,
          [file, ...(detailed ? ["--details"] : [])],
          {
            timeout: detailed ? 120000 : 60000,
            maxBuffer: 2 * 1024 * 1024,
          },
        );
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    if (!result) {
      const { stdout } = await execFile("tesseract", ["--list-langs"], {
        timeout: 5000,
      });
      const languages = ["chi_sim", "eng"].filter((lang) =>
        stdout.split(/\s+/).includes(lang),
      );
      if (!languages.length) throw Error("请为 Tesseract 安装中文或英文语言包");
      result = await execFile(
        "tesseract",
        [
          file,
          "stdout",
          "-l",
          languages.join("+"),
          ...(detailed ? ["tsv"] : []),
        ],
        { timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
      );
      if (detailed) {
        const second = await execFile(
          "tesseract",
          [file, "stdout", "-l", languages.join("+"), "--psm", "6"],
          { timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
        );
        return {
          engine: "tesseract",
          lines: parseTesseractTsv(result.stdout),
          secondaryText: second.stdout.trim(),
        };
      }
    }
    if (detailed) {
      const value = JSON.parse(result.stdout);
      if (
        !Array.isArray(value.lines) ||
        value.lines.length > 10000 ||
        typeof value.secondaryText !== "string" ||
        !value.lines.every(
          (line) =>
            typeof line.text === "string" &&
            Number.isFinite(line.confidence) &&
            line.confidence >= 0 &&
            line.confidence <= 1 &&
            Array.isArray(line.alternatives),
        )
      )
        throw Error("本机 OCR 返回了无效的校对信息，请更新客户端后重试");
      return value;
    }
    return result.stdout.trim();
  } catch (e) {
    if (e.code === "ENOENT")
      throw Error(
        "本机没有 OCR 引擎，请安装 Tesseract，或重新构建带视觉识别的 macOS 客户端",
      );
    throw e;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
module.exports = { credentialStore, recognizePage, parseTesseractTsv };
