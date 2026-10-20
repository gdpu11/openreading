import { clearChunks, hash, loadChunk, saveChunk, storeBlob } from "./storage";

// A completed range is durable before the next request starts. Killing the
// WebView can lose at most the current 2 MiB, including on the native TLS bridge.
const chunkSize = 2 * 1024 * 1024;
const maxSize = 210 * 1024 * 1024;
export async function downloadBlob(
  key: string,
  expectedSize: number | undefined,
  request: (range: string) => Promise<Response>,
  progress: (received: number, total: number) => void,
) {
  let total = expectedSize,
    offset = 0;
  const parts: Blob[] = [];
  if (
    total !== undefined &&
    (!Number.isSafeInteger(total) || total < 0 || total > maxSize)
  )
    throw Error("文件大小无效或超过手机直连下载上限");
  while (total === undefined || offset < total) {
    let chunk = await loadChunk(key, offset);
    if (
      chunk &&
      (chunk.total > maxSize ||
        (total !== undefined && chunk.total !== total) ||
        chunk.blob.size !== Math.min(chunkSize, chunk.total - offset))
    )
      chunk = undefined;
    if (!chunk) {
      const end = Math.min(offset + chunkSize, total ?? Infinity) - 1;
      const response = await request(`bytes=${offset}-${end}`);
      if (response.status === 200) {
        // Older servers/bridges may ignore Range. A 200 response is a whole
        // file, never a chunk to append to a previously saved prefix.
        const blob = await response.blob();
        if (blob.size > maxSize || (total !== undefined && blob.size !== total))
          throw Error("下载文件长度不一致，请重试");
        await commit(blob);
        progress(blob.size, blob.size);
        return;
      }
      if (
        response.status === 416 &&
        response.headers.get("Content-Range") === "bytes */0" &&
        offset === 0 &&
        (total === undefined || total === 0)
      ) {
        total = 0;
        break;
      }
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        response.headers.get("Content-Range") || "",
      );
      if (response.status !== 206 || !range)
        throw Error("下载断点响应无效，请重试");
      const [start, last, length] = range.slice(1).map(Number);
      if (
        !Number.isSafeInteger(length) ||
        length <= offset ||
        length > maxSize ||
        start !== offset ||
        last !== Math.min(end, length - 1) ||
        (total !== undefined && total !== length)
      )
        throw Error("下载断点与文件不一致，请重试");
      const blob = await response.blob();
      if (blob.size !== last - start + 1)
        throw Error("文件下载中断，下次将从已保存进度继续");
      chunk = { blob, total: length };
      await saveChunk(key, offset, chunk);
    }
    total = chunk.total;
    parts.push(chunk.blob);
    offset += chunk.blob.size;
    progress(offset, total);
  }
  await commit(new Blob(parts));

  async function commit(blob: Blob) {
    if ((await hash(await blob.arrayBuffer())) !== key) {
      await clearChunks(key);
      throw Error("文件校验失败，下载断点已清除，请重新同步");
    }
    await storeBlob(key, blob);
    await clearChunks(key);
  }
}
