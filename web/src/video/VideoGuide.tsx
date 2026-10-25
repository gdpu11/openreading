import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Clapperboard,
  FileText,
  LoaderCircle,
  MessageCircle,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { api, uid } from "../api";
import { tr } from "../i18n";
import type { Captured, Prepared, ReaderAdapter } from "../readers/types";
import {
  cacheSearchIndex,
  extractBookText,
  type TextSection,
} from "../readers/bookText";
import {
  modelChoice,
  modelsFor,
  resolveModelChoice,
} from "../settings/ModelSettings";
import {
  guideTime,
  guideDocumentSections,
  type GuidePlan,
  type GuideSource,
  type VideoGuide as Guide,
} from "./types";
import { useGuidePlayback } from "./useGuidePlayback";
import "./video.css";

type Props = {
  doc: Prepared;
  reader: React.RefObject<ReaderAdapter | null>;
  workspaceId: string;
  providers: any[];
  model: string;
  encoding: string;
  onModel: (model: string) => void;
  onCompose: (
    selection: Captured,
    body: string,
    recipient: "assistant" | "note",
  ) => void;
};

export function VideoGuideButton(props: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(
    () => setOpen(false),
    [props.doc.workspaceDocumentId, props.doc.version.id],
  );
  return (
    <>
      <button
        ref={trigger}
        className="video-guide-trigger"
        title={tr("视频解说")}
        aria-label={tr("视频解说")}
        onClick={() => setOpen(true)}
      >
        <Clapperboard size={17} />
        <span>{tr("视频解说")}</span>
      </button>
      {open &&
        createPortal(
          <VideoGuideDialog
            key={props.doc.workspaceDocumentId + props.doc.version.id}
            {...props}
            onClose={() => {
              setOpen(false);
              trigger.current?.focus();
            }}
          />,
          document.fullscreenElement || document.body,
        )}
    </>
  );
}

function VideoGuideDialog({
  doc,
  reader,
  workspaceId,
  providers,
  model,
  encoding,
  onModel,
  onCompose,
  onClose,
}: Props & { onClose: () => void }) {
  const [records, setRecords] = useState<Guide[]>([]);
  const [guide, setGuide] = useState<Guide>();
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"overview" | "section">("overview");
  const [goal, setGoal] = useState("");
  const [selectedModel, setSelectedModel] = useState(model);
  const [sections, setSections] = useState<TextSection[]>([]);
  const [position, setPosition] = useState<number>();
  const [plan, setPlan] = useState<GuidePlan>();
  const [question, setQuestion] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const preparedRequest = useRef<Record<string, unknown> | undefined>(
    undefined,
  );
  const requestID = useRef(uid());
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const playback = useGuidePlayback(guide?.script.slides || EMPTY_SLIDES);
  const slide = guide?.script.slides[playback.cue?.slide || 0];
  const selectChapter = (index: number) => {
    playback.chapter(index);
    stage.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const endpoint = `/documents/${doc.workspaceDocumentId}/video-guides`;
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    controller.current = abort;
    close.current?.focus();
    api<Guide[]>(
      `${endpoint}?version=${encodeURIComponent(doc.version.id)}`,
      "GET",
      undefined,
      { signal: abort.signal },
    )
      .then((items) => {
        if (!abort.signal.aborted) {
          setRecords(items);
          setGuide(items[0]);
          setEditing(!items.length);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(e.message);
          setEditing(true);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      alive.current = false;
      abort.abort();
      controller.current?.abort();
      document.body.style.overflow = overflow;
    };
  }, [endpoint, doc.version.id]);
  const eligible = (p: any) =>
    (p.protocol === "mock" || p.credentialBound) &&
    (p.enabledWorkspaceIds || []).includes(workspaceId);
  useEffect(() => {
    if (!selectedModel) {
      const first = providers.find(eligible);
      if (first) setSelectedModel(modelChoice(first, modelsFor(first)[0]));
    }
  }, [providers, workspaceId, selectedModel]);
  const invalidate = () => {
    setPlan(undefined);
    preparedRequest.current = undefined;
    setError("");
  };
  const prepare = async () => {
    if (busy || !selectedModel) return;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setBusy(true);
    setError("");
    setStatus("正在提取本机原文");
    setPlan(undefined);
    try {
      let material = sections;
      if (!material.length) {
        if (
          (doc.format === "markdown" || doc.format === "txt") &&
          reader.current?.isReady()
        ) {
          material = guideDocumentSections(
            reader.current.sectionText(),
            doc.title,
            doc.format === "markdown" ? reader.current.getOutline() : [],
          );
        } else
          material = await extractBookText(
            doc,
            encoding,
            abort.signal,
            (value) => setStatus(tr("正在提取本机原文") + " · " + value),
          );
        abort.signal.throwIfAborted();
        await cacheSearchIndex(doc, material, abort.signal);
        abort.signal.throwIfAborted();
        setSections(material);
      }
      const current = reader.current?.getLocation();
      const candidate =
        position ??
        material.find((v) =>
          v.locator.pageIndex !== undefined
            ? v.locator.pageIndex === current?.pageIndex
            : v.locator.href &&
              v.locator.href.split("#")[0] === current?.href?.split("#")[0],
        )?.position ??
        material[0]?.position;
      const readable = material.filter((value) => value.text.trim());
      const section =
        readable.find((value) => value.position === candidate)?.position ??
        readable[0]?.position;
      if (section !== undefined) setPosition(section);
      const request = {
        versionId: doc.version.id,
        mode,
        goal,
        ...(mode === "section" ? { sectionPosition: section } : {}),
        ...resolveModelChoice(selectedModel, providers),
      };
      setStatus("正在准备发送预览");
      const result = await api<GuidePlan>(
        endpoint + "/preview",
        "POST",
        request,
        { signal: abort.signal },
      );
      if (abort.signal.aborted) return;
      preparedRequest.current = request;
      requestID.current = uid();
      setPlan(result);
      onModel(selectedModel);
    } catch (e: any) {
      if (!abort.signal.aborted) setError(e.message);
    } finally {
      if (!abort.signal.aborted) {
        setBusy(false);
        setStatus("");
      }
    }
  };
  const generate = async (regenerate = false) => {
    if (busy || !plan || !preparedRequest.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setStatus("正在生成图解讲稿，请稍候；可以取消");
    try {
      const result = await api<Guide>(
        endpoint,
        "POST",
        {
          ...preparedRequest.current,
          fingerprint: plan.fingerprint,
          clientRequestId: requestID.current,
          regenerate,
        },
        { signal: abort.signal },
      );
      if (abort.signal.aborted) return;
      setRecords((old) => [
        result,
        ...old.filter((v) => v.requestId !== result.requestId),
      ]);
      setGuide(result);
      setEditing(false);
    } catch (e: any) {
      if (!abort.signal.aborted) setError(e.message);
    } finally {
      if (!abort.signal.aborted) {
        setBusy(false);
        setStatus("");
      }
    }
  };
  const cancel = () => {
    controller.current?.abort();
    setBusy(false);
    setStatus("");
  };
  const edit = () => {
    playback.pause();
    setEditing(true);
    invalidate();
  };
  const original = async (source: GuideSource) => {
    playback.pause();
    setActionBusy(true);
    setError("");
    try {
      if (!reader.current) throw Error("阅读器尚未就绪");
      await reader.current.navigateLocation(source.locator);
      const captured = await reader.current.captureExcerpt(source.text);
      if (!alive.current) return;
      if (!captured) throw Error("未能定位讲解引用，请先选择原文");
      await reader.current.navigateTo(captured.anchor);
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionBusy(false);
    }
  };
  const compose = async (recipient: "assistant" | "note") => {
    if (
      !guide ||
      !slide ||
      actionBusy ||
      (recipient === "assistant" && !question.trim())
    )
      return;
    const source = guide.plan.sources.find((v) =>
      slide.sourceIds.includes(v.id),
    );
    if (!source || !reader.current) return;
    playback.pause();
    setActionBusy(true);
    setError("");
    try {
      await reader.current.navigateLocation(source.locator);
      const captured = await reader.current.captureExcerpt(source.text);
      if (!alive.current) return;
      if (!captured) throw Error("未能定位讲解引用，请先选择原文");
      const context = `视频解说 · ${slide.title} · ${guideTime(playback.elapsed)}\nAI 讲解摘录（可能有误，请结合原文核对）：${slide.narration}`;
      if (selectedModel) onModel(selectedModel);
      onCompose(
        captured,
        recipient === "assistant"
          ? `${context}\n\n我的问题：${question.trim()}`
          : `${context}\n\n我的理解：`,
        recipient,
      );
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionBusy(false);
    }
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      const nodes = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ) || [],
      ).filter((el) => el.offsetParent !== null);
      if (
        nodes.length &&
        ((!event.shiftKey && document.activeElement === nodes.at(-1)) ||
          (event.shiftKey && document.activeElement === nodes[0]))
      ) {
        event.preventDefault();
        (event.shiftKey ? nodes.at(-1) : nodes[0])?.focus();
      }
    }
    if (
      (event.target as Element).closest("input,textarea,select,button") ||
      editing ||
      !guide
    )
      return;
    if (event.code === "Space") {
      event.preventDefault();
      playback.toggle();
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      playback.seek(playback.index + 1);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      playback.seek(playback.index - 1);
    }
  };
  return (
    <div className="video-guide-backdrop">
      <div
        ref={dialog}
        className="video-guide-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-guide-heading"
        onKeyDown={onKey}
        tabIndex={-1}
      >
        <header className="video-guide-header">
          <div>
            <span className="video-guide-eyebrow">
              <Clapperboard size={15} /> OPEN READING STUDIO
            </span>
            <h2 id="video-guide-heading">{tr("视频解说")}</h2>
            <p>{doc.title}</p>
          </div>
          <button
            ref={close}
            className="video-icon-button"
            aria-label={tr("关闭视频解说")}
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </header>
        {loading ? (
          <div className="video-guide-empty" role="status">
            <LoaderCircle className="video-spin" />
            {tr("正在读取本机讲解缓存")}
          </div>
        ) : (
          <>
            {editing ? (
              <div className="video-guide-setup">
                <section className="video-guide-intro">
                  <span className="video-guide-intro-icon">
                    <Play size={28} />
                  </span>
                  <h3>{tr("让资料讲给你听")}</h3>
                  <p>
                    {tr(
                      "中文旁白、图解与同步字幕。随时暂停、追问，或回到原文核对。",
                    )}
                  </p>
                </section>
                <div className="video-guide-options">
                  <label>
                    {tr("讲解范围")}
                    <select
                      aria-label={tr("讲解范围")}
                      value={mode}
                      disabled={busy}
                      onChange={(e) => {
                        setMode(e.target.value as typeof mode);
                        invalidate();
                      }}
                    >
                      <option value="overview">{tr("约三分钟导览")}</option>
                      <option value="section">{tr("按章节或页面讲解")}</option>
                    </select>
                  </label>
                  {mode === "section" && !!sections.length && (
                    <label>
                      {tr("选择章节或页面")}
                      <select
                        aria-label={tr("选择章节或页面")}
                        value={position ?? sections[0]?.position}
                        disabled={busy}
                        onChange={(e) => {
                          setPosition(Number(e.target.value));
                          invalidate();
                        }}
                      >
                        {sections
                          .filter((v) => v.text.trim())
                          .map((v) => (
                            <option key={v.position} value={v.position}>
                              {v.label}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  <label>
                    {tr("讲解模型")}
                    <select
                      aria-label={tr("讲解模型")}
                      value={selectedModel}
                      disabled={busy}
                      onChange={(e) => {
                        setSelectedModel(e.target.value);
                        invalidate();
                      }}
                    >
                      <option value="">{tr("选择模型")}</option>
                      {providers.map((p) => (
                        <optgroup key={p.id} label={p.name}>
                          {modelsFor(p).map((id) => (
                            <option
                              key={id}
                              value={modelChoice(p, id)}
                              disabled={!eligible(p)}
                            >
                              {p.protocol === "mock" ? tr("[模拟] ") : ""}
                              {id}
                              {!eligible(p)
                                ? tr(" · 请先绑定密钥并启用工作区")
                                : ""}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="video-goal-label">
                  {tr("这次想弄明白什么？")}
                  <span>{tr("可选，最多 300 字")}</span>
                  <textarea
                    aria-label={tr("阅读目标")}
                    maxLength={300}
                    value={goal}
                    disabled={busy}
                    placeholder={tr(
                      "例如：这份方案解决什么问题？有哪些前提和取舍？",
                    )}
                    onChange={(e) => {
                      setGoal(e.target.value);
                      invalidate();
                    }}
                  />
                </label>
                {!providers.some(eligible) && (
                  <p className="video-guide-hint">
                    {tr(
                      "请先在设置 → 模型与隐私中绑定模型，并为当前工作区启用。普通阅读不受影响。",
                    )}
                  </p>
                )}
                <p className="video-guide-hint">
                  {tr(
                    "仅在确认生成后，把预览中的片段和目标发送给所选模型。旁白使用本机中文语音；生成耗时与成片时长不同。",
                  )}
                </p>
                {doc.format === "pdf" && (
                  <p className="video-guide-hint">
                    {tr(
                      "PDF 讲解仅依据已提取或识别的文字，不包含扫描页或图表中的未识别内容。",
                    )}
                  </p>
                )}
                {plan && (
                  <section
                    className="video-send-preview"
                    aria-label={tr("讲解发送预览")}
                  >
                    <div>
                      <Check size={17} />
                      <strong>{tr("已准备好发送内容")}</strong>
                      <span>
                        {plan.provider} · {plan.modelId}
                      </span>
                    </div>
                    <p>
                      {tr("发送 {0} 个片段，共 {1} 字")
                        .replace("{0}", String(plan.sources.length))
                        .replace("{1}", String(plan.coverage.sentCharacters))}
                    </p>
                    <p className="video-guide-hint">
                      {tr("可提取原文共 {0} 字").replace(
                        "{0}",
                        String(plan.coverage.totalCharacters),
                      )}
                    </p>
                    <p
                      className={
                        plan.coverage.partial
                          ? "video-coverage-warning"
                          : "video-guide-hint"
                      }
                    >
                      {tr(
                        plan.coverage.partial
                          ? "当前为原文抽样，讲解不代表通读全书。以下是本次全部发送片段。"
                          : "所选范围的文字将完整发送。",
                      )}
                    </p>
                    <details>
                      <summary>{tr("查看全部发送片段")}</summary>
                      {plan.sources.map((source) => (
                        <div className="video-source-preview" key={source.id}>
                          <strong>
                            [{source.id}] {source.label}
                          </strong>
                          <p>{source.text}</p>
                        </div>
                      ))}
                    </details>
                    {records.some(
                      (record) => record.plan.fingerprint === plan.fingerprint,
                    ) && (
                      <p className="video-guide-hint">
                        {tr(
                          "已有相同内容的讲解，可直接复用；重新生成会再次调用模型。",
                        )}
                      </p>
                    )}
                  </section>
                )}
                <div className="video-setup-actions">
                  {guide && (
                    <button
                      onClick={() => {
                        cancel();
                        setEditing(false);
                      }}
                    >
                      {tr("返回已生成讲解")}
                    </button>
                  )}
                  {!busy && plan && (
                    <button onClick={() => void prepare()}>
                      {tr("重新预览")}
                    </button>
                  )}
                  {!busy &&
                    plan &&
                    records.some(
                      (record) => record.plan.fingerprint === plan.fingerprint,
                    ) && (
                      <button onClick={() => void generate(true)}>
                        {tr("重新生成（调用模型）")}
                      </button>
                    )}
                  {busy ? (
                    <button onClick={cancel}>{tr("取消生成")}</button>
                  ) : plan ? (
                    <button
                      className="primary video-primary"
                      onClick={() => void generate()}
                    >
                      <Clapperboard size={17} />
                      {tr("确认生成讲解")}
                    </button>
                  ) : (
                    <button
                      className="primary video-primary"
                      disabled={!selectedModel}
                      onClick={() => void prepare()}
                    >
                      {tr("预览讲解内容")}
                      <ArrowRight size={17} />
                    </button>
                  )}
                </div>
              </div>
            ) : guide && slide ? (
              <div className="video-guide-viewer">
                <div className="video-guide-main">
                  <div
                    ref={stage}
                    className="video-stage"
                    data-layout={slide.layout}
                    tabIndex={0}
                    aria-label={tr("图解播放器")}
                  >
                    <div className="video-stage-top">
                      <span>
                        {guide.plan.mock
                          ? tr("模拟讲解 · 未调用真实模型")
                          : tr("AI 图解讲解")}
                      </span>
                      <span>
                        {String((playback.cue?.slide || 0) + 1).padStart(
                          2,
                          "0",
                        )}{" "}
                        / {String(guide.script.slides.length).padStart(2, "0")}
                      </span>
                    </div>
                    <div
                      className="video-slide"
                      key={(playback.cue?.slide || 0) + guide.requestId}
                    >
                      <h3>{slide.title}</h3>
                      <div
                        className={`video-diagram video-diagram-${slide.layout}`}
                      >
                        {slide.items.map((item, index) => (
                          <div className="video-diagram-item" key={index}>
                            <span className="video-diagram-number">
                              {slide.layout === "comparison"
                                ? String.fromCharCode(65 + index)
                                : String(index + 1).padStart(2, "0")}
                            </span>
                            <h4>{item.label}</h4>
                            <p>{item.detail}</p>
                            {slide.layout === "steps" &&
                              index + 1 < slide.items.length && (
                                <ArrowRight
                                  className="video-step-arrow"
                                  size={20}
                                />
                              )}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="video-captions" aria-label={tr("当前字幕")}>
                      <span
                        className={
                          playback.playing ? "video-caption-playing" : ""
                        }
                      >
                        {playback.cue?.text}
                      </span>
                    </div>
                    <div className="video-stage-footer">
                      <span>OPEN READING</span>
                      <span>{tr("AI 讲解，请结合原文核对")}</span>
                    </div>
                  </div>
                  <div className="video-player-controls">
                    <input
                      aria-label={tr("讲解进度")}
                      type="range"
                      min={0}
                      max={Math.max(0, playback.cues.length - 1)}
                      step={1}
                      value={playback.index}
                      onChange={(e) => playback.seek(Number(e.target.value))}
                    />
                    <div>
                      <button
                        className="video-play-button"
                        aria-label={tr(
                          playback.playing
                            ? "暂停讲解"
                            : playback.ended
                              ? "重新播放"
                              : "播放讲解",
                        )}
                        onClick={playback.toggle}
                      >
                        {playback.playing ? (
                          <Pause size={20} />
                        ) : playback.ended ? (
                          <RotateCcw size={20} />
                        ) : (
                          <Play size={20} />
                        )}
                      </button>
                      <button
                        className="video-icon-button"
                        aria-label={tr("上一句")}
                        disabled={playback.index === 0}
                        onClick={() => playback.seek(playback.index - 1)}
                      >
                        <ArrowLeft size={17} />
                      </button>
                      <button
                        className="video-icon-button"
                        aria-label={tr("下一句")}
                        disabled={playback.index + 1 === playback.cues.length}
                        onClick={() => playback.seek(playback.index + 1)}
                      >
                        <ArrowRight size={17} />
                      </button>
                      <span className="video-time">
                        {guideTime(playback.elapsed)} / {tr("约")}
                        {guideTime(playback.duration)}
                      </span>
                      <select
                        aria-label={tr("讲解速度")}
                        value={playback.rate}
                        onChange={(e) =>
                          playback.changeRate(Number(e.target.value))
                        }
                      >
                        {[0.8, 1, 1.25, 1.5, 2].map((rate) => (
                          <option key={rate} value={rate}>
                            {rate}×
                          </option>
                        ))}
                      </select>
                      <button
                        className="video-icon-button"
                        aria-label={tr(
                          playback.muted ? "启用中文旁白" : "静音播放图解",
                        )}
                        aria-pressed={playback.muted}
                        onClick={playback.changeMuted}
                      >
                        {playback.muted ? (
                          <VolumeX size={18} />
                        ) : (
                          <Volume2 size={18} />
                        )}
                      </button>
                    </div>
                  </div>
                  {!playback.voice && !playback.muted && (
                    <p className="video-guide-hint">
                      {tr(
                        "未检测到本机中文语音，请安装中文系统语音，或选择静音播放",
                      )}
                    </p>
                  )}
                  {playback.muted && (
                    <p className="video-guide-hint">
                      {tr("正在使用静音图解模式，播放按预计旁白时长推进。")}
                    </p>
                  )}
                  {playback.error && (
                    <p role="alert" className="video-guide-error">
                      {tr(playback.error)}
                    </p>
                  )}
                  <section className="video-original-sources">
                    <div>
                      <BookOpen size={16} />
                      <strong>{tr("本段依据")}</strong>
                    </div>
                    {guide.plan.sources
                      .filter((source) => slide.sourceIds.includes(source.id))
                      .map((source) => (
                        <button
                          key={source.id}
                          disabled={actionBusy}
                          onClick={() => void original(source)}
                        >
                          <span>
                            [{source.id}] {source.label}
                          </span>
                          <span>{tr("定位原文")} ↗</span>
                          <p>
                            {Array.from(source.text).slice(0, 150).join("")}
                            {Array.from(source.text).length > 150 ? "…" : ""}
                          </p>
                        </button>
                      ))}
                  </section>
                  <div className="video-follow-up">
                    <label htmlFor="video-question">
                      <MessageCircle size={16} />
                      {tr("在这里暂停，问清楚再继续")}
                    </label>
                    <div>
                      <input
                        id="video-question"
                        aria-label={tr("关于本段的问题")}
                        value={question}
                        maxLength={500}
                        placeholder={tr("哪里没听懂？也可以问：举个具体例子")}
                        onFocus={playback.pause}
                        onChange={(e) => setQuestion(e.target.value)}
                      />
                      <button
                        disabled={!question.trim() || actionBusy}
                        onClick={() => void compose("assistant")}
                      >
                        {tr("去原文提问")}
                      </button>
                      <button
                        disabled={actionBusy}
                        onClick={() => void compose("note")}
                      >
                        <FileText size={16} />
                        {tr("写笔记")}
                      </button>
                    </div>
                    <small>
                      {tr(
                        "带上原文和当前讲解，放入笔记区草稿；确认发送后才会调用模型。",
                      )}
                    </small>
                  </div>
                </div>
                <aside className="video-guide-sidebar">
                  <div className="video-guide-sidebar-heading">
                    <span>{tr("讲解章节")}</span>
                    <button onClick={edit}>{tr("新建讲解")}</button>
                  </div>
                  <h3>{guide.script.title}</h3>
                  {guide.plan.goal && (
                    <p className="video-guide-goal">{guide.plan.goal}</p>
                  )}
                  <nav aria-label={tr("讲解章节")}>
                    {guide.script.slides.map((part, index) => (
                      <button
                        key={index}
                        aria-current={
                          (playback.cue?.slide || 0) === index
                            ? "step"
                            : undefined
                        }
                        onClick={() => selectChapter(index)}
                      >
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <strong>{part.title}</strong>
                          <small>
                            {guideTime(
                              playback.cues.find((cue) => cue.slide === index)
                                ?.start || 0,
                            )}
                          </small>
                        </div>
                        {(playback.cue?.slide || 0) === index && (
                          <span
                            className={
                              playback.playing
                                ? "video-equalizer active"
                                : "video-equalizer"
                            }
                          >
                            ▥
                          </span>
                        )}
                      </button>
                    ))}
                  </nav>
                  <details className="video-transcript">
                    <summary>{tr("完整讲稿")}</summary>
                    {guide.script.slides.map((part, index) => (
                      <section key={index}>
                        <button onClick={() => selectChapter(index)}>
                          {part.title}
                        </button>
                        <p>{part.narration}</p>
                      </section>
                    ))}
                  </details>
                  <div className="video-guide-cache-note">
                    <Check size={15} />
                    <span>{tr("讲稿已缓存在本机，重开可直接播放。")}</span>
                  </div>
                  {guide.plan.coverage.partial && (
                    <p className="video-coverage-warning">
                      {tr("本次讲解基于原文抽样，不代表通读全书。")}
                    </p>
                  )}
                  {records.length > 1 && (
                    <label className="video-history-label">
                      {tr("已生成的讲解")}
                      <select
                        aria-label={tr("已生成的讲解")}
                        value={guide.requestId}
                        onChange={(e) => {
                          playback.pause();
                          setGuide(
                            records.find((v) => v.requestId === e.target.value),
                          );
                          setQuestion("");
                          setError("");
                        }}
                      >
                        {records.map((record, index) => (
                          <option
                            key={record.requestId}
                            value={record.requestId}
                          >
                            {index + 1}.{" "}
                            {record.plan.goal || record.script.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </aside>
              </div>
            ) : null}
            {busy && (
              <div className="video-guide-status" role="status">
                <LoaderCircle className="video-spin" size={17} />
                {tr(status)}
              </div>
            )}
            {error && (
              <p className="video-guide-error" role="alert">
                {tr(error)}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const EMPTY_SLIDES: Guide["script"]["slides"] = [];
