import { Capacitor, registerPlugin } from "@capacitor/core";
export const readingDisplayAvailable = () =>
  Capacitor.getPlatform() === "android" &&
  Capacitor.isPluginAvailable("ReadingDisplay");
export const ReadingDisplay = registerPlugin<{
  set: (options: {
    active?: boolean;
    backgroundColor?: string;
    keepAwake?: boolean;
    brightness?: number;
  }) => Promise<void>;
}>("ReadingDisplay");
