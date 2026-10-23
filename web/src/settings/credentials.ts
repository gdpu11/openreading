import { api } from "../api";
export const credentialTarget = (p: any) => p.protocol + "\n" + p.baseUrl;
export async function restoreCredentials(
  providers: any[],
  onFailure: (message: string) => void,
) {
  const desktop = window.openReadingDesktop;
  if (!desktop?.credential) return providers;
  let changed = false,
    failed = false;
  for (const p of providers) {
    if (p.credentialBound || p.protocol === "mock") continue;
    try {
      const key = await desktop.credential("load", {
        id: p.id,
        target: credentialTarget(p),
      });
      if (typeof key === "string" && key) {
        try {
          await api(`/providers/${p.id}`, "PATCH", {
            ...p.config,
            ...p,
            apiKey: key,
          });
        } catch (e: any) {
          if (e.code !== "REVISION_CONFLICT") throw e;
          const latest = await api("/providers");
          if (!latest.find((item: any) => item.id === p.id)?.credentialBound)
            throw e;
        }
        changed = true;
      }
    } catch {
      failed = true;
    }
  }
  if (failed) onFailure("部分模型密钥未恢复，请在模型设置中重新绑定。");
  return changed ? await api("/providers") : providers;
}
