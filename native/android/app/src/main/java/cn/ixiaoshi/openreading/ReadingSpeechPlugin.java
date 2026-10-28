package cn.ixiaoshi.openreading;

import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;
import java.util.Set;

@CapacitorPlugin(name = "ReadingSpeech")
public class ReadingSpeechPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech engine;
    private boolean ready;
    private PluginCall pending;
    private String utterance;
    private long sequence;
    private long engineGeneration;
    private final Runnable initTimeout = () -> failInitialization();

    protected TextToSpeech createEngine(TextToSpeech.OnInitListener listener) {
        return new TextToSpeech(getContext(), listener);
    }
    @PluginMethod public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String language = call.getString("language", "");
        if (text.trim().isEmpty() || text.length() > TextToSpeech.getMaxSpeechInputLength()
                || !(language.equals("zh-CN") || language.equals("en-US"))) {
            call.reject("朗读文本或语言无效"); return;
        }
        getActivity().runOnUiThread(() -> {
            cancel();
            pending = call;
            if (ready) { play(); return; }
            if (engine != null) return;
            main.postDelayed(initTimeout, 10000);
            long generation = ++engineGeneration;
            engine = createEngine(status -> main.post(() -> {
                if (engine == null || generation != engineGeneration) return;
                main.removeCallbacks(initTimeout);
                if (status != TextToSpeech.SUCCESS) {failInitialization();return;}
                ready = true;
                engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onDone(String id) { main.post(() -> complete(id, null)); }
                    @Override public void onError(String id) { main.post(() -> complete(id, "朗读失败，请检查系统语音设置")); }
                    @Override public void onStop(String id, boolean interrupted) { main.post(() -> complete(id, "朗读已被系统中断，请重新开始")); }
                });
                if (pending != null) play();
            }));
        });
    }
    private static boolean installedOffline(Voice voice) {
        return voice != null && !voice.isNetworkConnectionRequired()
            && (voice.getFeatures() == null || !voice.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
    }
    private void play() {
        Locale locale = Locale.forLanguageTag(pending.getString("language"));
        int result = engine.setLanguage(locale);
        if (result < TextToSpeech.LANG_AVAILABLE) {
            reject("缺少对应语言的系统语音，请在手机的文字转语音设置中安装语言包");return;
        }
        // Match the browser's local-only policy: never send book text to a
        // network voice just because it is the engine's default.
        Voice voice = engine.getVoice();
        if (!installedOffline(voice) || !voice.getLocale().getLanguage().equals(locale.getLanguage())) {
            voice = null;
            Set<Voice> voices = engine.getVoices();
            if (voices != null) for (Voice candidate : voices) {
                if (installedOffline(candidate) && candidate.getLocale().getLanguage().equals(locale.getLanguage())) {
                    voice = candidate;
                    if (candidate.getLocale().equals(locale)) break;
                }
            }
        }
        if (voice == null || engine.setVoice(voice) == TextToSpeech.ERROR) {
            reject("未找到对应语言的离线语音，请在手机的文字转语音设置中下载语音包");return;
        }
        double rate = pending.getDouble("rate", 1.0);
        engine.setSpeechRate((float)Math.max(0.5, Math.min(2, Double.isFinite(rate) ? rate : 1)));
        utterance = "reading-" + (++sequence);
        if (engine.speak(pending.getString("text"), TextToSpeech.QUEUE_FLUSH, null, utterance) == TextToSpeech.ERROR)
            reject("朗读启动失败，请检查系统语音设置");
    }
    private void complete(String id, String error) {
        if (pending == null || !id.equals(utterance)) return;
        if (error != null) {reject(error);return;}
        PluginCall call = pending; pending = null; utterance = null;
        call.resolve(new JSObject());
    }
    private void reject(String message) {
        PluginCall call = pending; pending = null; utterance = null;
        if (call != null) call.reject(message);
    }
    private void cancel() {
        PluginCall call = pending; pending = null; utterance = null;
        if (engine != null && ready) engine.stop();
        if (call != null) call.reject("朗读已停止", "CANCELED");
    }
    private void failInitialization() {
        main.removeCallbacks(initTimeout);
        reject("系统语音引擎未就绪，请在手机的文字转语音设置中启用语音引擎后重试");
        release();
    }
    private void release() {
        engineGeneration++;
        ready = false;
        if (engine != null) engine.shutdown();
        engine = null;
    }
    @PluginMethod public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {cancel();call.resolve(new JSObject());});
    }
    @Override protected void handleOnPause() {super.handleOnPause();cancel();}
    @Override protected void handleOnDestroy() {
        main.removeCallbacks(initTimeout);cancel();release();super.handleOnDestroy();
    }
}
