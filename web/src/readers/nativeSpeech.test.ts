import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({speak:vi.fn(),stop:vi.fn()}));
vi.mock("@capacitor/core", () => ({Capacitor:{getPlatform:()=>"android",isPluginAvailable:()=>true},registerPlugin:()=>native}));
import { NativeBookSpeech } from "./nativeSpeech";
beforeEach(() => {vi.resetAllMocks();native.stop.mockResolvedValue(undefined);});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
it("uses native speech without Web Speech and completes sentences in order", async () => {
  const done=vi.fn(),failed=vi.fn();
  native.speak.mockResolvedValue(undefined);
  await new NativeBookSpeech(["第一句。","第二句。"],"zh-CN",1,done,failed).resume();
  expect(native.speak.mock.calls.map(v=>v[0].text)).toEqual(["第一句。","第二句。"]);
  expect(done).toHaveBeenCalledOnce();expect(failed).not.toHaveBeenCalled();
});
it("pause resumes the current sentence; stopped callbacks cannot restart speech", async () => {
  let reject!: (e:Error)=>void;
  native.speak.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;})).mockResolvedValue(undefined);
  const done=vi.fn(),failed=vi.fn(),speech=new NativeBookSpeech(["一句。","两句。"],"zh-CN",1,done,failed);
  const first=speech.resume();await tick();speech.pause();reject(Error("stopped"));await first;
  expect(failed).not.toHaveBeenCalled();await speech.resume();
  expect(native.speak.mock.calls.map(v=>v[0].text)).toEqual(["一句。","一句。","两句。"]);
  speech.stop();await speech.resume();expect(done).toHaveBeenCalledOnce();
});
it("reports engine errors instead of pretending the whole device lacks speech", async () => {
  native.speak.mockRejectedValue(Error("缺少离线语音包"));
  const failed=vi.fn(),done=vi.fn();await new NativeBookSpeech(["内容"],"zh-CN",1,done,failed).resume();
  expect(failed.mock.calls[0][0].message).toBe("缺少离线语音包");expect(done).not.toHaveBeenCalled();
});
