package cn.ixiaoshi.openreading;

import android.content.Context;
import android.content.ContextWrapper;
import android.util.Base64;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Uses Android framework org.json and real Capacitor getters, not a JS bridge mock. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE)
public class OfflineFilesPluginTest {
    private File root;
    private OfflineFilesPlugin plugin;
    private static class Receipt extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        volatile String error, code;
        volatile JSObject result;
        Receipt(String method, String json) throws Exception {
            super(null, "OfflineFiles", "test", method, new JSObject(json));
        }
        @Override public void resolve() { done.countDown(); }
        @Override public void resolve(JSObject data) { result = data; done.countDown(); }
        @Override public void reject(String message, String errorCode, Exception exception) {
            error = message; code = errorCode; done.countDown();
        }
        Receipt await() throws Exception {
            assertTrue("Native call never finished", done.await(30, TimeUnit.SECONDS));
            return this;
        }
    }
    @Before public void setup() throws Exception {
        Context app = RuntimeEnvironment.getApplication();
        root = Files.createTempDirectory(app.getCacheDir().toPath(), "offline-bridge-").toFile();
        Context isolated = new ContextWrapper(app) {
            @Override public File getFilesDir() { return root; }
        };
        plugin = new OfflineFilesPlugin() {
            @Override public Context getContext() { return isolated; }
        };
    }
    @After public void cleanup() throws Exception {
        plugin.handleOnDestroy();
        try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(root.toPath())) {
            for (java.nio.file.Path p : paths.sorted(java.util.Comparator.reverseOrder()).toArray(java.nio.file.Path[]::new)) Files.delete(p);
        }
    }
    private String hash(byte[] bytes) throws Exception {
        return OfflineFileStore.hex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private String prepare(long size) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        File staging = new File(root, "staging");
        assertTrue(staging.mkdir());
        for (long offset = 0; offset < size; offset += OfflineFileStore.CHUNK_SIZE) {
            byte[] bytes = new byte[(int)Math.min(OfflineFileStore.CHUNK_SIZE, size - offset)];
            for (int i = 0; i < bytes.length; i++) bytes[i] = (byte)((offset + i) % 251);
            digest.update(bytes);
            JSONObject chunk = new JSONObject().put("total", size).put("hash", hash(bytes))
                    .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            Files.write(new File(staging, offset + ".json").toPath(), chunk.toString().getBytes(StandardCharsets.UTF_8));
        }
        String key = OfflineFileStore.hex(digest.digest());
        File destination = new File(root, "openreading/partial/" + key);
        assertTrue(destination.getParentFile().mkdirs());
        assertTrue(staging.renameTo(destination));
        return key;
    }
    private Receipt commit(String key, long size) throws Exception {
        // JSON text mirrors JSON.stringify on the WebView; small numbers are Integer.
        Receipt call = new Receipt("commit", "{\"key\":\"" + key + "\",\"total\":" + size + "}");
        assertTrue(call.getData().opt("total") instanceof Integer);
        assertNull("Capacitor getLong cannot read a JavaScript-sized Integer", call.getLong("total"));
        plugin.commit(call);
        return call.await();
    }
    @Test public void savesJavaScriptIntegerThroughRealPlugin() throws Exception {
        String key = prepare(37);
        Receipt call = commit(key, 37);
        assertNull("Native save rejected: " + call.error, call.error);
        assertTrue(OfflineFileStore.verified(new File(root, "openreading/files/" + key), key));
        Receipt lookup = new Receipt("get", "{\"key\":\"" + key + "\"}");
        plugin.get(lookup);
        lookup.await();
        assertNull(lookup.error);
        assertTrue(lookup.result.getBoolean("exists"));
        assertTrue(lookup.result.getString("uri").startsWith("file://"));
    }
    @Test public void savesEmptyJavaScriptIntegerFile() throws Exception {
        String key = prepare(0);
        assertNull(commit(key, 0).error);
        assertTrue(OfflineFileStore.verified(new File(root, "openreading/files/" + key), key));
    }
    @Test public void savesScreenshotSizedFileAndReplacesInterruptedStaging() throws Exception {
        int size = 61976622;
        String key = prepare(size);
        File directory = new File(root, "openreading/files");
        assertTrue(directory.mkdirs());
        Files.write(new File(directory, ".receiving-" + key).toPath(), new byte[]{1,2,3});
        Receipt call = commit(key, size);
        assertNull("Native save rejected: " + call.error, call.error);
        assertEquals(size, new File(directory, key).length());
        assertTrue(OfflineFileStore.verified(new File(directory, key), key));
        assertEquals(1, directory.list().length);
    }
    @Test public void distinguishesInvalidArgumentsFromStorageFailures() throws Exception {
        for (String total : new String[]{"null", "-1", "0.5", "\"37\"", "220200961", "2147483648"}) {
            Receipt call = new Receipt("commit", "{\"key\":\"" + "a".repeat(64) + "\",\"total\":" + total + "}");
            plugin.commit(call); call.await();
            assertEquals(total + ": " + call.error, "OFFLINE_ARGUMENT", call.code);
            assertFalse(call.error.contains("空间"));
        }
    }
    @Test public void ordinaryStorageFailureDoesNotClaimPhoneIsFull() throws Exception {
        String key = prepare(37);
        Files.write(new File(root, "openreading/files").toPath(), new byte[]{1});
        Receipt failed = commit(key, 37);
        assertEquals("OFFLINE_SAVE", failed.code);
        assertTrue(failed.error.contains("IOException"));
        assertFalse(failed.error.contains("空间"));
        assertTrue(new File(root, "openreading/partial/" + key + "/0.json").isFile());
    }
    @Test public void missingChunksAreNotMisreportedAsDiskFullAndRemainRetryable() throws Exception {
        String key = prepare(OfflineFileStore.CHUNK_SIZE + 5);
        File missing = new File(root, "openreading/partial/" + key + "/" + OfflineFileStore.CHUNK_SIZE + ".json");
        byte[] original = Files.readAllBytes(missing.toPath());
        assertTrue(missing.delete());
        Receipt failed = commit(key, OfflineFileStore.CHUNK_SIZE + 5);
        assertEquals("OFFLINE_PARTIAL", failed.code);
        assertFalse(failed.error.contains("空间"));
        assertTrue(new File(root, "openreading/partial/" + key + "/0.json").isFile());
        Files.write(missing.toPath(), original);
        assertNull(commit(key, OfflineFileStore.CHUNK_SIZE + 5).error);
    }
}
