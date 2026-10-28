package cn.ixiaoshi.openreading;

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
    @PluginMethod public void set(PluginCall call) {
        boolean active = call.getBoolean("active", false);
        boolean keepAwake = call.getBoolean("keepAwake", true);
        double brightness = call.getDouble("brightness", -1.0);
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
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
    @Override protected void handleOnDestroy() {
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
            window.setAttributes(attributes);
        });
    }
}
