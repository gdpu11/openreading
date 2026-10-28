package cn.ixiaoshi.openreading;

import android.os.Looper;
import android.speech.tts.*;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.*;
import java.util.*;
import java.time.Duration;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import org.robolectric.android.controller.ActivityController;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class ReadingSpeechPluginTest {
    ActivityController<AppCompatActivity> activity;
    ReadingSpeechPlugin plugin;
    TextToSpeech.OnInitListener init;
    FakeEngine engine;
    static class Receipt extends PluginCall {
        boolean resolved; String error;
        Receipt(String json) throws Exception {super(null,"ReadingSpeech","test","speak",new JSObject(json));}
        @Override public void resolve(JSObject o) {resolved=true;}
        @Override public void reject(String e) {error=e;}
        @Override public void reject(String e,String code) {error=e;}
    }
    class FakeEngine extends TextToSpeech {
        Voice voice=new Voice("local",Locale.CHINA,300,300,false,Set.of());
        UtteranceProgressListener listener; String id; boolean shutdown; int languageResult=LANG_AVAILABLE;
        FakeEngine() {super(activity.get(), s->{});}
        @Override public int setLanguage(Locale l) {return languageResult;}
        @Override public Voice getVoice() {return voice;}
        @Override public Set<Voice> getVoices() {return Set.of(voice);}
        @Override public int setVoice(Voice v) {return SUCCESS;}
        @Override public int setSpeechRate(float r) {return SUCCESS;}
        @Override public int setOnUtteranceProgressListener(UtteranceProgressListener l) {listener=l;return SUCCESS;}
        @Override public int speak(CharSequence t,int q,android.os.Bundle b,String utterance) {id=utterance;return SUCCESS;}
        @Override public int stop() {return SUCCESS;}
        @Override public void shutdown() {shutdown=true;}
    }
    @Before public void setup() {
        activity=Robolectric.buildActivity(AppCompatActivity.class);
        activity.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat);activity.setup();
        plugin=new ReadingSpeechPlugin() {
            @Override public AppCompatActivity getActivity() {return activity.get();}
            @Override protected TextToSpeech createEngine(TextToSpeech.OnInitListener l) {init=l;engine=new FakeEngine();return engine;}
        };
    }
    void idle() {Shadows.shadowOf(Looper.getMainLooper()).idle();}
    Receipt start() throws Exception {
        Receipt r=new Receipt("{\"text\":\"你好。\",\"language\":\"zh-CN\",\"rate\":1.0}");
        plugin.speak(r);idle();return r;
    }
    void ready() {init.onInit(TextToSpeech.SUCCESS);idle();}
    @After public void cleanup() {plugin.handleOnDestroy();activity.pause().stop().destroy();}
    @Test public void waitsForInitializationAndResolvesOnlyOnPlaybackCompletion() throws Exception {
        Receipt r=start();assertFalse(r.resolved);ready();assertNotNull(engine.id);assertFalse(r.resolved);
        engine.listener.onDone(engine.id);idle();assertTrue(r.resolved);assertNull(r.error);
    }
    @Test public void refusesNetworkVoicesAndMissingLanguageData() throws Exception {
        Receipt r=start();engine.voice=new Voice("cloud",Locale.CHINA,300,300,true,Set.of());ready();
        assertTrue(r.error.contains("离线语音"));assertNull(engine.id);
        engine.languageResult=TextToSpeech.LANG_MISSING_DATA;r=start();assertTrue(r.error.contains("语言包"));
    }
    @Test public void canceledCompletionCannotCompleteNextRequest() throws Exception {
        Receipt old=start();ready();String oldId=engine.id;Receipt next=start();
        assertNotNull(old.error);engine.listener.onDone(oldId);idle();assertFalse(next.resolved);
        engine.listener.onDone(engine.id);idle();assertTrue(next.resolved);
    }
    @Test public void initializationTimesOutAndCanRetry() throws Exception {
        Receipt r=start();Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(11));
        assertTrue(r.error.contains("语音引擎"));assertTrue(engine.shutdown);
        TextToSpeech.OnInitListener stale=init;r=start();stale.onInit(TextToSpeech.SUCCESS);idle();assertNull(engine.id);
        ready();assertNotNull(engine.id);
    }
    @Test public void staleInitializationCannotDisableRetryTimeout() throws Exception {
        Receipt first=start();Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(11));
        assertNotNull(first.error);
        TextToSpeech.OnInitListener stale=init;Receipt retry=start();
        stale.onInit(TextToSpeech.SUCCESS);idle();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(11));
        assertNotNull(retry.error);assertTrue(engine.shutdown);
    }
    @Test public void systemInterruptionCompletesPendingCallAndIgnoresOldCallbacks() throws Exception {
        Receipt first=start();ready();String oldId=engine.id;
        engine.listener.onStop(oldId,true);idle();assertTrue(first.error.contains("中断"));
        Receipt next=start();engine.listener.onStop(oldId,true);idle();assertNull(next.error);
        engine.listener.onDone(engine.id);idle();assertTrue(next.resolved);
    }
    @Test public void leavingAppStopsPlayback() throws Exception {
        Receipt r=start();ready();plugin.handleOnPause();assertNotNull(r.error);
        engine.listener.onDone(engine.id);idle();assertFalse(r.resolved);
    }
}
