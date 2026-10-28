package cn.ixiaoshi.openreading;

import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Looper;
import android.os.Build;
import android.view.Window;
import android.view.WindowManager;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {28, 35})
public class ReadingDisplayPluginTest {
    private ActivityController<AppCompatActivity> controller;
    private ReadingDisplayPlugin plugin;
    private Window window;
    private static class Receipt extends PluginCall {
        boolean resolved;
        String error;
        Receipt(String json) throws Exception { super(null, "ReadingDisplay", "test", "set", new JSObject(json)); }
        @Override public void resolve(JSObject data) { resolved = true; }
        @Override public void reject(String message) { error = message; }
    }
    @Before public void setup() {
        controller = Robolectric.buildActivity(AppCompatActivity.class);
        controller.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat);
        controller.setup();
        window = controller.get().getWindow();
        plugin = new ReadingDisplayPlugin() {
            @Override public AppCompatActivity getActivity() { return controller.get(); }
        };
    }
    @After public void cleanup() { controller.pause().stop().destroy(); }
    private void apply(String json) throws Exception {
        Receipt call = new Receipt(json);
        plugin.set(call);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertNull(call.error);
        assertTrue(call.resolved);
    }
    @Test public void paintsNativeCutoutAreaForEachReadingThemeWithoutRemovingSafePadding() throws Exception {
        window.getDecorView().setPadding(0, 44, 0, 24);
        for (String color : new String[]{"#17191c", "#ffffff", "#f4ecd8", "#e3ecdf"}) {
            apply("{\"backgroundColor\":\"" + color + "\"}");
            assertEquals(Color.parseColor(color), ((ColorDrawable)window.getDecorView().getBackground()).getColor());
            // Android 15+ enforces transparent system bars; the decor below
            // them carries the reading color. Older Android uses bar colors.
            if (Build.VERSION.SDK_INT < 35) {
                assertEquals(Color.parseColor(color), window.getStatusBarColor());
                assertEquals(Color.parseColor(color), window.getNavigationBarColor());
            }
            assertEquals(44, window.getDecorView().getPaddingTop());
            assertEquals(24, window.getDecorView().getPaddingBottom());
        }
    }
    @Test public void restoresBackgroundAfterSystemBarsRecolorsOnRotation() throws Exception {
        apply("{\"backgroundColor\":\"#17191c\"}");
        window.getDecorView().setBackgroundColor(Color.WHITE);
        plugin.handleOnConfigurationChanged(new Configuration());
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals(Color.parseColor("#17191c"), ((ColorDrawable)window.getDecorView().getBackground()).getColor());
    }
    @Test public void changingBackgroundPreservesBrightnessAndKeepAwake() throws Exception {
        apply("{\"active\":true,\"brightness\":0.4,\"keepAwake\":true}");
        apply("{\"backgroundColor\":\"#17191c\"}");
        assertEquals(0.4f, window.getAttributes().screenBrightness, 0.001f);
        assertTrue((window.getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0);
        apply("{\"active\":false}");
        assertEquals(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE, window.getAttributes().screenBrightness, 0);
        assertEquals(0, window.getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
