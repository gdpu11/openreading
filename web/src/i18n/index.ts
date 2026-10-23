import { useEffect, useSyncExternalStore } from "react";
import english from "./en.json";
export type Language = "en" | "zh";
declare global {
  interface Window {
    openReadingDesktop?: {
      readerTarget: {
        workspaceId: string;
        memberId: string;
        threadId?: string;
      } | null;
      openBook: (
        workspaceId: string,
        memberId: string,
        threadId?: string,
      ) => Promise<void>;
      renderBookPDF: (html: string) => Promise<Uint8Array>;
      saveConvertedBook: (
        data: Uint8Array,
        format: "pdf" | "epub",
        name: string,
      ) => Promise<{ saved: boolean }>;
      credential: (action: "load" | "save" | "forget", request: {id:string;target:string;key?:string}) => Promise<string | boolean | null>;
      recognizePage: (image: string) => Promise<string>;
      showLibrary: () => void;
      onThread: (navigate: (id: string) => void) => () => void;
      onClosing: (flush: () => Promise<void>) => () => void;
      setLanguage: (language: Language) => void;
    };
  }
}
const storageKey = "open-reading-language";
let language: Language =
  typeof localStorage !== "undefined" &&
  typeof localStorage.getItem === "function" &&
  localStorage.getItem(storageKey) === "zh"
    ? "zh"
    : "en";
const listeners = new Set<() => void>();
export function getLanguage() {
  return language;
}
export function locale() {
  return language === "zh" ? "zh-CN" : "en-US";
}
function applyLanguage() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale();
  window.openReadingDesktop?.setLanguage(language);
}
export function setLanguage(next: Language) {
  if (next !== "en" && next !== "zh") return;
  language = next;
  if (
    typeof localStorage !== "undefined" &&
    typeof localStorage.setItem === "function"
  )
    localStorage.setItem(storageKey, next);
  applyLanguage();
  listeners.forEach((notify) => notify());
}
export function useLanguage() {
  const selected = useSyncExternalStore((notify) => {
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, getLanguage);
  useEffect(applyLanguage, [selected]);
  return [selected, setLanguage] as const;
}
const messages = english as Record<string, string>;
const reverse = Object.fromEntries(
  Object.entries(messages).map(([zh, en]) => [en, zh]),
);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = Object.entries(messages)
  .filter(([zh]) => /\{\d+\}/.test(zh))
  .map(([zh, en]) => {
    const compile = (value: string) =>
      new RegExp(
        "^" +
          value
            .split(/(\{\d+\})/)
            .map((part) =>
              /^\{\d+\}$/.test(part) ? "([\\s\\S]*?)" : escape(part),
            )
            .join("") +
          "$",
      );
    return { zh, en, fromZH: compile(zh), fromEN: compile(en) };
  });
// Only application-owned strings call tr(). Never pass document contents,
// filenames, provider/model names or user-authored notes through this function.
export function tr(text: string): string {
  const key = text.trim().replace(/\s+/g, " ");
  const exact = language === "en" ? messages[key] : reverse[key];
  if (exact !== undefined) return exact;
  for (const p of patterns) {
    const match = (language === "en" ? p.fromZH : p.fromEN).exec(text.trim());
    if (match)
      return (language === "en" ? p.en : p.zh).replace(
        /\{(\d+)\}/g,
        (_, i) => match[Number(i) + 1] || "",
      );
  }
  return text;
}
