package cn.ixiaoshi.openreading;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
 @Override public void onCreate(Bundle savedInstanceState) {
  registerPlugin(DeviceVaultPlugin.class);
  registerPlugin(LocalSyncPlugin.class);
  registerPlugin(OfflineFilesPlugin.class);
  registerPlugin(ReadingDisplayPlugin.class);
  registerPlugin(ReadingSpeechPlugin.class);
  registerPlugin(AppUpdatePlugin.class);
  super.onCreate(savedInstanceState);
 }
}
