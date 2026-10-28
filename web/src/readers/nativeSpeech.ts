import { Capacitor, registerPlugin } from "@capacitor/core";

const ReadingSpeech = registerPlugin<{
  speak(options: { text: string; language: string; rate: number }): Promise<void>;
  stop(): Promise<void>;
}>("ReadingSpeech");
export const nativeSpeechAvailable = () =>
  Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("ReadingSpeech");

// Android's WebView need not expose Web Speech. Keep one native utterance in
// flight; pausing resumes from the current short sentence.
export class NativeBookSpeech {
  private run = 0;
  private index = 0;
  private stopped = false;
  private stopPending: Promise<void> = Promise.resolve();
  constructor(private sentences: string[], private language: string, private rate: number,
    private done: () => void, private failed: (error: Error) => void) {}
  private cancel() {
    this.run++;
    this.stopPending = this.stopPending.then(() => ReadingSpeech.stop()).catch(() => {});
  }
  pause() { this.cancel(); }
  stop() { this.stopped = true; this.cancel(); }
  async resume() {
    if (this.stopped) return;
    const run = ++this.run;
    await this.stopPending;
    try {
      while (run === this.run && !this.stopped && this.index < this.sentences.length) {
        await ReadingSpeech.speak({text:this.sentences[this.index], language:this.language, rate:this.rate});
        if (run !== this.run || this.stopped) return;
        this.index++;
      }
      if (run === this.run && !this.stopped) {this.stopped = true;this.done();}
    } catch (error) {
      if (run === this.run && !this.stopped) {this.stopped = true;this.failed(error as Error);}
    }
  }
}
