package cn.ixiaoshi.openreading;

import android.content.pm.*;
import java.io.IOException;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk={28,35})
public class AppUpdatePluginTest {
    private PackageInfo pkg(String name,int code,String signer) {
        PackageInfo p=new PackageInfo();p.packageName=name;p.setLongVersionCode(code);
        p.signatures=new Signature[]{new Signature(signer)};return p;
    }
    @Test public void acceptsOnlyNewerSamePackageAndSigner() throws Exception {
        AppUpdatePlugin.validatePackage(pkg("cn.ixiaoshi.openreading",20,"aabb"),pkg("cn.ixiaoshi.openreading",21,"aabb"),21);
    }
    @Test public void refusesDowngradeUnexpectedVersionOtherPackageAndSigner() {
        PackageInfo installed=pkg("cn.ixiaoshi.openreading",20,"aabb");
        PackageInfo[] bad={null,pkg("other",21,"aabb"),pkg(installed.packageName,20,"aabb"),pkg(installed.packageName,19,"aabb"),pkg(installed.packageName,22,"aabb"),pkg(installed.packageName,21,"ccdd")};
        for(PackageInfo candidate:bad) {
            assertThrows(IOException.class,()->AppUpdatePlugin.validatePackage(installed,candidate,21));
        }
    }
    @Test public void pinnedConnectionsRejectPublicHostsPlainHttpAndMissingPin() {
        for(String url:new String[]{"http://192.168.1.2/api/sync/app-update/apk","https://8.8.8.8/api/sync/app-update/apk","https://user@192.168.1.2/api/sync/app-update/apk"}) {
            assertThrows(Exception.class,()->LocalSyncPlugin.openPinned(new java.net.URL(url),"a".repeat(64)));
        }
        assertThrows(Exception.class,()->LocalSyncPlugin.openPinned(new java.net.URL("https://192.168.1.2/api/sync/app-update/apk"),""));
    }
}
