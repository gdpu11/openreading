package cn.ixiaoshi.openreading;

import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Reading-only display controls. Never change the user's global brightness. */
@CapacitorPlugin(name = "ReadingDisplay")
public class ReadingDisplayPlugin extends Plugin {
    private Integer backgroundColor;
    private void applyBackground(Window window, int color) {
        // A new drawable can reset padding; retain the insets owned by SystemBars.
        View decor = window.getDecorView();
        int left = decor.getPaddingLeft(), top = decor.getPaddingTop();
        int right = decor.getPaddingRight(), bottom = decor.getPaddingBottom();
        window.setBackgroundDrawable(new ColorDrawable(color));
        decor.setBackgroundColor(color);
        window.setStatusBarColor(color);
        window.setNavigationBarColor(color);
        decor.setPadding(left, top, right, bottom);
    }
    @PluginMethod public void set(PluginCall call) {
        String background = call.getString("backgroundColor");
        if (background != null && !background.matches("#[a-fA-F0-9]{6}")) {
            call.reject("无效的阅读背景颜色");
            return;
        }
        boolean displayControls = call.getData().has("active");
        boolean active = call.getBoolean("active", false);
        boolean keepAwake = call.getBoolean("keepAwake", true);
        double brightness = call.getDouble("brightness", -1.0);
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            if (background != null) {
                backgroundColor = Color.parseColor(background);
                applyBackground(window, backgroundColor);
            }
            if (!displayControls) {
                call.resolve(new JSObject());
                return;
            }
            if (active && keepAwake) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.screenBrightness = active && brightness >= 0
                ? (float) Math.max(0.05, Math.min(1, brightness))
                : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
            window.setAttributes(attributes);
            call.resolve(new JSObject());
        });
    }
    @Override protected void handleOnConfigurationChanged(Configuration config) {
        super.handleOnConfigurationChanged(config);
        Window window = getActivity().getWindow();
        // SystemBars restores the Android theme background on rotation.
        // Repaint after all configuration listeners have finished.
        window.getDecorView().post(() -> {
            if (backgroundColor != null) applyBackground(window, backgroundColor);
        });
    }
    @Override protected void handleOnDestroy() {
        backgroundColor = null;
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
            window.setAttributes(attributes);
        });
    }
}
