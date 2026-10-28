package cn.ixiaoshi.openreading;

import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

@CapacitorPlugin(name = "OfflineFiles")
public class OfflineFilesPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private File files() { return new File(getContext().getFilesDir(), "openreading/files"); }
    @PluginMethod public void has(PluginCall call) { lookup(call, false); }
    @PluginMethod public void get(PluginCall call) { lookup(call, true); }
    private void lookup(PluginCall call, boolean includeUri) {
        worker.execute(() -> {
            try {
                String key = call.getString("key");
                OfflineFileStore.validKey(key);
                File file = new File(files(), key);
                boolean exists = OfflineFileStore.verified(file, key);
                JSObject result = new JSObject().put("exists", exists);
                if (exists && includeUri) result.put("uri", Uri.fromFile(file).toString());
                call.resolve(result);
            } catch (Exception e) {
                call.reject("无法检查离线文件，请重试", "OFFLINE_READ", e);
            }
        });
    }
    @PluginMethod public void commit(PluginCall call) {
        worker.execute(() -> {
            try {
                String key = call.getString("key");
                OfflineFileStore.validKey(key);
                // JSON.stringify sends sizes within our 210 MiB limit as an
                // Integer on Android. Capacitor getLong accepts Long only.
                Integer total = call.getInt("total");
                if (total == null || total < 0 || total > OfflineFileStore.MAX_SIZE)
                    throw new IllegalArgumentException("文件大小无效，请更新应用后重试");
                File partial = new File(getContext().getFilesDir(), "openreading/partial/" + key);
                OfflineFileStore.commit(files(), key, total, offset -> {
                    File chunk = new File(partial, offset + ".json");
                    if (chunk.length() > 3 * 1024 * 1024) throw new OfflineFileStore.IntegrityException();
                    JSONObject json = new JSONObject(new String(Files.readAllBytes(chunk.toPath()), StandardCharsets.UTF_8));
                    return new OfflineFileStore.Part(Base64.decode(json.getString("data"), Base64.DEFAULT),
                            json.getString("hash"), json.getLong("total"));
                });
                call.resolve();
            } catch (OfflineFileStore.IntegrityException e) {
                call.reject(e.getMessage(), "INTEGRITY", e);
            } catch (IllegalArgumentException e) {
                call.reject("同步文件参数无效，请更新应用后重试；已下载分片已保留", "OFFLINE_ARGUMENT", e);
            } catch (java.nio.file.NoSuchFileException e) {
                call.reject("下载分片不完整，请重新接收；已有分片会继续使用", "OFFLINE_PARTIAL", e);
            } catch (Exception e) {
                boolean noSpace = false;
                for (Throwable cause = e; cause != null; cause = cause.getCause())
                    if (cause instanceof android.system.ErrnoException
                            && ((android.system.ErrnoException) cause).errno == android.system.OsConstants.ENOSPC)
                        noSpace = true;
                call.reject(noSpace
                    ? "手机存储空间不足，请释放空间后重试；已下载分片已保留"
                    : "离线文件保存失败（" + e.getClass().getSimpleName() + "），请重试；已下载分片已保留",
                    noSpace ? "OFFLINE_NO_SPACE" : "OFFLINE_SAVE", e);
            }
        });
    }
    @Override protected void handleOnDestroy() { worker.shutdown(); }
}
