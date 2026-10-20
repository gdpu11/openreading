package cn.ixiaoshi.openreading;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "DeviceVault")
public class DeviceVaultPlugin extends Plugin {
    private static final String ALIAS = "openreading.device.v1";
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey)store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    @PluginMethod public void get(PluginCall call) {
        try {
            String stored = getContext().getSharedPreferences(ALIAS, Context.MODE_PRIVATE).getString("credential", null);
            JSObject result = new JSObject();
            if (stored != null) {
                String[] parts = stored.split(":");
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                result.put("value", new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), java.nio.charset.StandardCharsets.UTF_8));
            }
            call.resolve(result);
        } catch (Exception e) { call.reject("设备凭证无法读取，请移除连接后重新配对"); }
    }
    @PluginMethod public void set(PluginCall call) {
        String value = call.getString("value");
        if (value == null || value.length() > 65536) { call.reject("无效的设备凭证"); return; }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
            String encrypted = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)), Base64.NO_WRAP);
            if(!getContext().getSharedPreferences(ALIAS, Context.MODE_PRIVATE).edit().putString("credential", encrypted).commit()) throw new Exception();
            call.resolve();
        } catch (Exception e) { call.reject("设备凭证保存失败"); }
    }
    @PluginMethod public void clear(PluginCall call) {
        if(getContext().getSharedPreferences(ALIAS, Context.MODE_PRIVATE).edit().clear().commit())call.resolve();else call.reject("设备凭证移除失败");
    }
}
