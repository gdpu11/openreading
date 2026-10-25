import { useEffect, useMemo, useRef, useState } from "react";
import { localReadingVoice } from "../readers/BookTools";
import { narrationCues, type GuideSlide } from "./types";

export function useGuidePlayback(slides: GuideSlide[]) {
  const cues = useMemo(() => narrationCues(slides), [slides]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [voice, setVoice] = useState<SpeechSynthesisVoice>();
  const [fraction, setFraction] = useState(0);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState("");
  const [seekRevision, setSeekRevision] = useState(0);
  const offset = useRef(0);
  const positionRevision = useRef(0);
  const epoch = useRef(0);
  const owner = useRef(false);
  const cue = cues[index];
  useEffect(() => {
    const speech = window.speechSynthesis;
    if (!speech) return;
    const load = () => setVoice(localReadingVoice(speech.getVoices(), "zh-CN"));
    load();
    speech.addEventListener("voiceschanged", load);
    return () => speech.removeEventListener("voiceschanged", load);
  }, []);
  useEffect(() => {
    setPlaying(false);
    setIndex(0);
    setFraction(0);
    setEnded(false);
    positionRevision.current++;
    offset.current = 0;
  }, [cues]);
  useEffect(() => {
    if (!playing || !cue) return;
    const run = ++epoch.current;
    const position = positionRevision.current;
    let from = Math.min(offset.current, cue.text.length - 1);
    if (/[\uDC00-\uDFFF]/u.test(cue.text[from])) from--;
    const started = performance.now();
    const initial = from / cue.text.length;
    const duration = Math.max(0.3, (cue.duration * (1 - initial)) / rate);
    const finish = () => {
      if (run !== epoch.current || position !== positionRevision.current)
        return;
      positionRevision.current++;
      offset.current = 0;
      if (index + 1 < cues.length) {
        setFraction(0);
        setIndex(index + 1);
      } else {
        setFraction(1);
        setEnded(true);
        setPlaying(false);
      }
    };
    const timer = window.setInterval(() => {
      const progress = Math.min(
        0.97,
        (performance.now() - started) / (duration * 1000),
      );
      setFraction(initial + progress * (1 - initial));
    }, 100);
    let silentTimer: number | undefined;
    if (muted) silentTimer = window.setTimeout(finish, duration * 1000);
    else if (voice && window.speechSynthesis) {
      const speech = window.speechSynthesis;
      // Playing a guide is an explicit user action and takes over local narration.
      speech.cancel();
      const utterance = new SpeechSynthesisUtterance(cue.text.slice(from));
      utterance.voice = voice;
      utterance.lang = "zh-CN";
      utterance.rate = rate;
      utterance.onboundary = (event) => {
        if (run === epoch.current && position === positionRevision.current)
          offset.current = from + event.charIndex;
      };
      utterance.onend = finish;
      utterance.onerror = (event) => {
        if (
          run !== epoch.current ||
          event.error === "canceled" ||
          event.error === "interrupted"
        )
          return;
        setPlaying(false);
        setError("旁白播放失败，请检查本机中文语音，或选择静音播放");
      };
      owner.current = true;
      speech.speak(utterance);
    } else {
      setPlaying(false);
      setError("未检测到本机中文语音，请安装中文系统语音，或选择静音播放");
    }
    return () => {
      epoch.current++;
      window.clearInterval(timer);
      window.clearTimeout(silentTimer);
      if (muted && position === positionRevision.current)
        offset.current = Math.floor(
          cue.text.length *
            Math.min(
              0.97,
              initial +
                ((performance.now() - started) / (duration * 1000)) *
                  (1 - initial),
            ),
        );
      if (owner.current) {
        owner.current = false;
        window.speechSynthesis?.cancel();
      }
    };
  }, [cue, index, playing, rate, muted, voice, cues.length, seekRevision]);
  const seek = (next: number) => {
    positionRevision.current++;
    offset.current = 0;
    setIndex(Math.max(0, Math.min(cues.length - 1, next)));
    setFraction(0);
    setEnded(false);
    setSeekRevision((n) => n + 1);
  };
  const toggle = () => {
    setError("");
    if (ended) seek(0);
    setPlaying((value) => !value);
  };
  return {
    cues,
    index,
    cue,
    fraction,
    playing,
    ended,
    rate,
    muted,
    voice,
    error,
    duration: cues.length ? cues.at(-1)!.start + cues.at(-1)!.duration : 0,
    elapsed: cue ? cue.start + cue.duration * fraction : 0,
    toggle,
    pause: () => setPlaying(false),
    seek,
    chapter: (slide: number) =>
      seek(
        Math.max(
          0,
          cues.findIndex((c) => c.slide === slide),
        ),
      ),
    changeRate: (value: number) => setRate(value),
    changeMuted: () => {
      setPlaying(false);
      setError("");
      setMuted((value) => !value);
    },
  };
}
