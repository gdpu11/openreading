import { tr } from "../i18n";
import React, { useEffect, useState } from "react";
import { ArrowLeft, Plus, Server, Check, RefreshCw } from "lucide-react";
import { api } from "../api";
import "./models.css";
import { credentialTarget } from "./credentials";

export function modelsFor(p: any): string[] {
  return p.models ?? p.config?.models ?? (p.modelId ? [p.modelId] : []);
}
export function modelChoice(p: any, id: string): string {
  return id === p.modelId ? p.id : JSON.stringify([p.id, id]);
}
export function resolveModelChoice(value: string, providers: any[]) {
  for (const p of providers) {
    for (const id of modelsFor(p)) {
      if (modelChoice(p, id) === value)
        return { modelProfileId: p.id, modelId: id };
    }
  }
  return { modelProfileId: "", modelId: "" };
}
const defaults = {
  protocol: "openai",
  name: "",
  platformId: "custom",
  baseUrl: "",
  modelId: "",
  models: [] as string[],
  inputBudget: 8000,
  generatedTokenCap: 2000,
  contextWindow: 32000,
  timeout: 60,
  streaming: true,
  systemRole: "system",
  outputLimitField: "max_tokens",
  includeUsage: false,
};
export function ModelSettings({
  providers,
  workspace,
  allowMock,
  reloadProviders,
  onNotice,
}: any) {
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [view, setView] = useState<"list" | "platforms" | "edit">("list");
  const [form, setForm] = useState<any>(defaults);
  const [key, setKey] = useState("");
  const [rememberKey, setRememberKey] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState<string[]>([]);
  const [manual, setManual] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api("/provider-platforms")
      .then(setPlatforms)
      .catch((e) => setError(e.message));
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const edit = (p: any) => {
    const models = modelsFor(p);
    setForm({ ...defaults, ...p.config, ...p, models });
    setAvailable(models);
    setKey("");
    setRememberKey(false);
    if (p.id)
      void window.openReadingDesktop
        ?.credential("load", { id: p.id, target: credentialTarget(p) })
        .then((value) => setRememberKey(!!value))
        .catch((e) => setError(e.message));
    setManual("");
    setFilter("");
    setError("");
    setEnabled(
      !!workspace && (p.enabledWorkspaceIds ?? []).includes(workspace.id),
    );
    setView("edit");
  };
  const create = (platform?: any) => {
    edit({
      ...defaults,
      ...(platform
        ? {
            name: platform.name,
            platformId: platform.id,
            baseUrl: platform.baseUrl,
            outputLimitField: platform.outputLimitField,
          }
        : {}),
    });
  };
  const set = (values: any) => setForm((p: any) => ({ ...p, ...values }));
  const toggleModel = (id: string, checked: boolean) => {
    const models = checked
      ? [...form.models, id]
      : form.models.filter((v: string) => v !== id);
    set({
      models,
      modelId: models.includes(form.modelId) ? form.modelId : (models[0] ?? ""),
    });
  };
  const save = () =>
    run(async () => {
      const saved = await api(
        "/providers" + (form.id ? "/" + form.id : ""),
        form.id ? "PATCH" : "POST",
        { ...form, apiKey: key },
      );
      // Keep the new revision if workspace enablement fails, so retry edits this provider.
      setForm((p: any) => ({ ...p, ...saved }));
      if (window.openReadingDesktop?.credential) {
        if (rememberKey && key)
          await window.openReadingDesktop.credential("save", {
            id: saved.id,
            target: credentialTarget(form),
            key,
          });
        else if (!rememberKey)
          await window.openReadingDesktop.credential("forget", {
            id: saved.id,
            target: credentialTarget(form),
          });
      }
      setKey("");
      if (workspace)
        await api(
          `/workspaces/${workspace.id}/providers/${saved.id}/enable`,
          enabled ? "POST" : "DELETE",
          {},
        );
      await reloadProviders();
      setView("list");
      onNotice("提供方和模型已保存");
    });
  const selectedPlatform = platforms.find((p) => p.id === form.platformId);
  return (
    <section className="model-settings" aria-label={tr("模型提供方设置")}>
      {view === "list" ? (
        <>
          <div className="provider-heading">
            <div>
              <h3>{tr("模型提供方")}</h3>
              <p className="muted">
                {tr("选择平台、填写 API 密钥，再添加要使用的模型。")}
              </p>
            </div>
          </div>
          <div className="provider-cards">
            {providers.map((p: any) => (
              <article className="provider-card" key={p.id}>
                <div className="provider-card-copy">
                  <div className="provider-title">
                    <strong>{p.name}</strong>
                    {(!p.config?.platformId ||
                      p.config.platformId === "custom") && (
                      <span className="provider-badge">{tr("自定义")}</span>
                    )}
                    <span
                      className={`provider-status ${p.credentialBound || p.protocol === "mock" ? "bound" : ""}`}
                    />
                    <span className="provider-state">
                      {p.protocol === "mock"
                        ? tr("模拟")
                        : p.credentialBound
                          ? tr("密钥已绑定")
                          : tr("待绑定密钥")}
                    </span>
                  </div>
                  <p>
                    {modelsFor(p).length}
                    {tr("个模型")}
                    {workspace
                      ? ` · ${tr((p.enabledWorkspaceIds ?? []).includes(workspace.id) ? "当前工作区已启用" : "当前工作区未启用")}`
                      : ""}
                  </p>
                  <div className="provider-model-tags">
                    {modelsFor(p)
                      .slice(0, 3)
                      .map((id) => (
                        <span key={id}>{id}</span>
                      ))}
                    {modelsFor(p).length > 3 && (
                      <span>+{modelsFor(p).length - 3}</span>
                    )}
                  </div>
                </div>
                <div className="provider-card-actions">
                  <button
                    className="secondary"
                    onClick={() => edit(p)}
                    disabled={busy}
                    aria-label={tr(`编辑 ${p.name}`)}
                  >
                    {tr("编辑")}
                  </button>
                  <button
                    className="provider-danger"
                    disabled={busy}
                    aria-label={tr(`删除 ${p.name}`)}
                    onClick={() => {
                      if (
                        confirm(
                          tr(
                            `删除提供方“${p.name}”和本次进程中的密钥？历史问答会保留。`,
                          ),
                        )
                      )
                        run(async () => {
                          await api(`/providers/${p.id}`, "DELETE", {
                            revision: p.revision,
                          });
                          await window.openReadingDesktop?.credential(
                            "forget",
                            { id: p.id, target: credentialTarget(p) },
                          );
                          await reloadProviders();
                          onNotice("提供方已删除，历史问答已保留");
                        });
                    }}
                  >
                    {tr("删除")}
                  </button>
                </div>
              </article>
            ))}
            {!providers.length && (
              <div className="providers-empty">
                <Server size={30} />
                <strong>{tr("连接你的第一个模型平台")}</strong>
                <p>{tr("同一个平台可以配置多个模型，共用一个 API 密钥。")}</p>
              </div>
            )}
          </div>
          <div className="provider-add-actions">
            <button
              onClick={() => {
                setError("");
                setView("platforms");
              }}
              disabled={busy}
            >
              <Plus size={18} />
              {tr("添加提供方")}
            </button>
            <button onClick={() => create()} disabled={busy}>
              <Plus size={18} />
              {tr("添加自定义提供方")}
            </button>
          </div>
          <p className="provider-privacy muted">
            {tr(
              "密钥默认只在服务进程内存中；桌面端可选择系统保护的密钥存储。小阅只发送你预览的原文与历史；每个工作区分别启用提供方。",
            )}
          </p>
        </>
      ) : view === "platforms" ? (
        <>
          <button className="provider-back" onClick={() => setView("list")}>
            <ArrowLeft size={16} />
            {tr("返回提供方")}
          </button>
          <h3>{tr("选择模型平台")}</h3>
          <p className="muted">
            {tr(
              "平台会自动填入 API 地址；模型列表从你的账号获取，也可以手动添加。",
            )}
          </p>
          <div className="platform-grid">
            {platforms.map((p) => (
              <button
                className="platform-card"
                key={p.id}
                onClick={() => create(p)}
              >
                <strong>{p.name}</strong>
                <span>{tr(p.description)}</span>
              </button>
            ))}
          </div>
          <button className="provider-custom-link" onClick={() => create()}>
            {tr("使用自定义 API 地址（如 LiteLLM）")}
            <Plus size={16} />
          </button>
        </>
      ) : (
        <>
          <button
            className="provider-back"
            disabled={busy}
            onClick={() => {
              setKey("");
              setError("");
              setView("list");
            }}
          >
            <ArrowLeft size={16} />
            {tr("返回提供方")}
          </button>
          <h3>
            {form.id ? tr("编辑提供方") : tr("添加提供方")}
            {selectedPlatform ? ` · ${selectedPlatform.name}` : tr(" · 自定义")}
          </h3>
          <fieldset className="provider-editor" disabled={busy}>
            <div className="settings-grid">
              <label>
                {tr("提供方名称")}
                <input
                  aria-label={tr("提供方名称")}
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder={tr("例如：我的 LiteLLM")}
                />
              </label>
              <label>
                API Key
                <input
                  aria-label={tr("提供方 API Key")}
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={
                    form.credentialBound
                      ? tr("已绑定，留空保留")
                      : tr("填写此平台的 API Key")
                  }
                />
              </label>
              {window.openReadingDesktop?.credential && (
                <label className="full">
                  <input
                    type="checkbox"
                    checked={rememberKey}
                    onChange={(e) => setRememberKey(e.target.checked)}
                  />
                  {tr("使用系统密钥存储记住 API Key")}
                  <small>
                    {tr("仅保存在本机系统保护的存储中，不进入书库备份。")}
                  </small>
                </label>
              )}
              <label className="full">
                {tr("API 地址（Base URL）")}
                <input
                  aria-label={tr("提供方 API 地址")}
                  value={form.baseUrl}
                  onChange={(e) => set({ baseUrl: e.target.value })}
                  placeholder="https://your-api.example/v1"
                />
              </label>
            </div>
            {selectedPlatform && (
              <p className="muted provider-platform-hint">
                {tr(selectedPlatform.description)} ·{" "}
                <a
                  href={selectedPlatform.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {tr("平台文档")}
                </a>
              </p>
            )}
            <div className="provider-model-heading">
              <div>
                <strong>{tr("模型")}</strong>
                <p className="muted">
                  {tr("勾选要使用的文本模型，或手动输入模型 ID。")}
                </p>
              </div>
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  run(async () => {
                    const result = await api("/provider-models", "POST", {
                      id: form.id,
                      protocol: form.protocol,
                      baseUrl: form.baseUrl,
                      apiKey: key,
                    });
                    setAvailable([
                      ...new Set<string>([...form.models, ...result.models]),
                    ]);
                    if (!result.models.length)
                      setError("平台未返回模型；请手动添加模型 ID。");
                  })
                }
              >
                <RefreshCw size={14} />
                {tr("获取模型")}
              </button>
            </div>
            <div className="provider-manual">
              <input
                aria-label={tr("手动模型 ID")}
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder={tr("输入完整模型 ID")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    document.getElementById("add-provider-model")?.click();
                  }
                }}
              />
              <button
                id="add-provider-model"
                className="secondary"
                disabled={!manual.trim()}
                onClick={() => {
                  const id = manual.trim();
                  setAvailable([...new Set([...available, id])]);
                  if (!form.models.includes(id)) toggleModel(id, true);
                  setManual("");
                  setFilter("");
                }}
              >
                <Plus size={16} />
                {tr("添加模型")}
              </button>
            </div>
            {available.length > 8 && (
              <input
                className="provider-model-filter"
                aria-label={tr("筛选平台模型")}
                placeholder={tr("筛选模型")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
            {available.length > 0 && (
              <div
                className="provider-model-list"
                aria-label={tr("平台模型列表")}
              >
                {available
                  .filter((id) =>
                    id.toLowerCase().includes(filter.toLowerCase()),
                  )
                  .map((id) => (
                    <label key={id}>
                      <input
                        type="checkbox"
                        checked={form.models.includes(id)}
                        onChange={(e) => toggleModel(id, e.target.checked)}
                      />
                      <span>{id}</span>
                      {form.modelId === id && <small>{tr("默认")}</small>}
                    </label>
                  ))}
              </div>
            )}
            <div className="settings-grid">
              <label className="full">
                {tr("默认模型")}
                <select
                  aria-label={tr("默认模型")}
                  value={form.modelId}
                  onChange={(e) => set({ modelId: e.target.value })}
                >
                  <option value="">{tr("暂不选择")}</option>
                  {form.models.map((id: string) => (
                    <option key={id}>{id}</option>
                  ))}
                </select>
              </label>
            </div>
            <details className="provider-advanced">
              <summary>{tr("高级设置")}</summary>
              <p className="muted">
                {tr("接口：Chat Completions。仅支持该接口的模型可用。")}
              </p>
              <div className="settings-grid">
                {[
                  ["inputBudget", "输入预算"],
                  ["generatedTokenCap", "生成上限"],
                  ["contextWindow", "模型上下文容量"],
                  ["timeout", "超时（秒）"],
                ].map(([id, name]) => (
                  <label key={id}>
                    {tr(name)}
                    <input
                      type="number"
                      aria-label={tr(name)}
                      value={form[id]}
                      onChange={(e) => set({ [id]: Number(e.target.value) })}
                    />
                  </label>
                ))}
                <label>
                  {tr("输出上限字段")}
                  <select
                    value={form.outputLimitField}
                    onChange={(e) => set({ outputLimitField: e.target.value })}
                  >
                    <option>max_tokens</option>
                    <option>max_completion_tokens</option>
                  </select>
                </label>
                <label>
                  {tr("system 角色")}
                  <select
                    value={form.systemRole}
                    onChange={(e) => set({ systemRole: e.target.value })}
                  >
                    <option>system</option>
                    <option>developer</option>
                    <option value="none">{tr("不支持")}</option>
                  </select>
                </label>
                <label className="provider-check">
                  <input
                    type="checkbox"
                    checked={form.streaming}
                    onChange={(e) => set({ streaming: e.target.checked })}
                  />
                  {tr("流式输出")}
                </label>
                <label className="provider-check">
                  <input
                    type="checkbox"
                    checked={form.includeUsage}
                    onChange={(e) => set({ includeUsage: e.target.checked })}
                  />
                  {tr("请求流式用量统计")}
                </label>
                {allowMock && (
                  <label>
                    {tr("验收协议")}
                    <select
                      value={form.protocol}
                      onChange={(e) => set({ protocol: e.target.value })}
                    >
                      <option value="openai">Chat Completions</option>
                      <option value="mock">{tr("模拟（仅开发验收）")}</option>
                    </select>
                  </label>
                )}
              </div>
            </details>
            {workspace && (
              <div className="provider-enabling">
                <label className="provider-check">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                  {tr("为“")}
                  {workspace.name}
                  {tr("”启用此提供方")}
                </label>
                <p className="muted">
                  {tr("启用后，你选中的原文和问答会发送到")}{" "}
                  <span>{form.baseUrl || tr("上述 API 地址")}</span>。
                </p>
              </div>
            )}
            <div className="provider-editor-actions">
              <button
                className="primary"
                onClick={save}
                disabled={!form.name.trim() || !form.baseUrl.trim()}
              >
                <Check size={16} />
                {busy ? tr("处理中…") : tr("保存提供方")}
              </button>
              {form.id && (
                <button
                  className="secondary"
                  onClick={() => {
                    if (
                      confirm(
                        tr(
                          "将使用已保存的默认模型发送固定短文本测试连接，可能产生一次模型费用，继续？",
                        ),
                      )
                    )
                      run(async () => {
                        const result = await api(
                          `/providers/${form.id}/test`,
                          "POST",
                          {},
                        );
                        onNotice(result.message);
                      });
                  }}
                >
                  {tr("测试已保存配置")}
                </button>
              )}
              {form.id && form.credentialBound && (
                <button
                  className="provider-danger"
                  onClick={() =>
                    run(async () => {
                      await api(`/providers/${form.id}/credential`, "DELETE");
                      await window.openReadingDesktop?.credential("forget", {
                        id: form.id,
                        target: credentialTarget(form),
                      });
                      set({ credentialBound: false });
                      await reloadProviders();
                      onNotice("会话密钥已删除");
                    })
                  }
                >
                  {tr("删除会话密钥")}
                </button>
              )}
              <button
                className="provider-cancel"
                onClick={() => {
                  setKey("");
                  setView("list");
                  setError("");
                }}
              >
                {tr("取消")}
              </button>
            </div>
          </fieldset>
        </>
      )}
      {error && (
        <p role="alert" className="provider-error">
          {tr(error)}
        </p>
      )}
    </section>
  );
}
