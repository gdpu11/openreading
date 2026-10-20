import { Capacitor, registerPlugin } from "@capacitor/core";
export function privateIPv4(host: string) {
  const p = host.split(".").map(Number);
  return (
    p.length === 4 &&
    p.every(
      (n, i) =>
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 255 &&
        String(n) === host.split(".")[i],
    ) &&
    (p[0] === 10 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 169 && p[1] === 254))
  );
}
export function validLAN(origin: string, fingerprint?: string) {
  try {
    const u = new URL(origin);
    return (
      u.origin === origin &&
      u.protocol === "https:" &&
      privateIPv4(u.hostname) &&
      /^[a-f0-9]{64}$/.test(fingerprint || "")
    );
  } catch {
    return false;
  }
}
const LocalSync = registerPlugin<{
  request(options: {
    url: string;
    fingerprint: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
}>("LocalSync");
const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
export async function lanRequest(
  origin: string,
  fingerprint: string,
  path: string,
  token: string,
  body?: any,
) {
  if (
    !validLAN(origin, fingerprint) ||
    !/^\/(sync\/|pair\/(claim|status)(\?|$))/.test(path)
  )
    throw Error("无效的局域网同步地址");
  if (!Capacitor.isNativePlatform())
    throw Error(
      "局域网直连请使用手机 Open Reading 应用扫码，浏览器不支持电脑证书配对",
    );
  const headers: Record<string, string> = { Authorization: "Bearer " + token };
  let bytes: Blob | undefined;
  if (body instanceof FormData) {
    const request = new Request("https://localhost/", { method: "POST", body });
    headers["Content-Type"] = request.headers.get("Content-Type")!;
    bytes = await request.blob();
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    bytes = new Blob([JSON.stringify(body)]);
  }
  const result = await LocalSync.request({
    url: origin + "/api" + path,
    fingerprint,
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(bytes ? { body: await base64(bytes) } : {}),
  });
  const binary = atob(result.body),
    decoded = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
  return new Response(decoded, {
    status: result.status,
    headers: result.headers,
  });
}
