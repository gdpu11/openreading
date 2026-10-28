package cn.ixiaoshi.openreading;

import android.content.Intent;
import android.content.pm.*;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.URL;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;

@CapacitorPlugin(name="AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy=new AtomicBoolean();
    private File apk() {return new File(getContext().getCacheDir(),"openreading-update.apk");}
    @PluginMethod public void info(PluginCall call) {
        try {
            PackageInfo p=getContext().getPackageManager().getPackageInfo(getContext().getPackageName(),0);
            JSObject result=new JSObject();result.put("versionCode",version(p));result.put("versionName",p.versionName);call.resolve(result);
        } catch(Exception e) {call.reject("无法读取当前版本");}
    }
    static long version(PackageInfo p) {return Build.VERSION.SDK_INT>=28?p.getLongVersionCode():p.versionCode;}
    private static Set<String> signatures(PackageInfo p) {
        Signature[] list=Build.VERSION.SDK_INT>=28 && p.signingInfo!=null?p.signingInfo.getApkContentsSigners():p.signatures;
        Set<String> result=new HashSet<>();if(list!=null)for(Signature sig:list)result.add(sig.toCharsString());return result;
    }
    static void validatePackage(PackageInfo installed,PackageInfo update,long expected) throws IOException {
        if(update==null || !installed.packageName.equals(update.packageName))throw new IOException("升级包不属于 Open Reading");
        if(version(update)<=version(installed) || version(update)!=expected)throw new IOException("升级包版本无效，请重新检查更新");
        Set<String> signers=signatures(installed);
        if(signers.isEmpty() || !signers.equals(signatures(update)))throw new IOException("升级包签名不一致，无法覆盖安装；请勿卸载原应用");
    }
    private void validate(File file,long expected) throws Exception {
        PackageManager pm=getContext().getPackageManager();
        int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
        validatePackage(pm.getPackageInfo(getContext().getPackageName(),flags),pm.getPackageArchiveInfo(file.getAbsolutePath(),flags),expected);
    }
    @PluginMethod public void download(PluginCall call) {
        if(!busy.compareAndSet(false,true)){call.reject("升级包正在下载");return;}
        io.execute(()->{
            HttpsURLConnection conn=null;File partial=new File(getContext().getCacheDir(),"openreading-update.part");
            try {
                String origin=call.getString("origin",""),pin=call.getString("fingerprint",""),hash=call.getString("sha256","");
                int bytes=call.getInt("bytes",0),target=call.getInt("versionCode",0);
                URL base=new URL(origin);
                if(!base.getPath().isEmpty() || base.getQuery()!=null || base.getRef()!=null || !hash.matches("[a-f0-9]{64}") || bytes<1 || bytes>210*1024*1024 || target<1)
                    throw new IOException("升级信息无效，请重新检查更新");
                conn=LocalSyncPlugin.openPinned(new URL(origin+"/api/sync/app-update/apk"),pin);
                conn.setInstanceFollowRedirects(false);conn.setUseCaches(false);conn.setConnectTimeout(10000);conn.setReadTimeout(30000);
                conn.setRequestProperty("Authorization","Bearer "+call.getString("token",""));
                if(conn.getResponseCode()!=200)throw new IOException("无法获取升级包，请检查电脑连接后重试");
                MessageDigest digest=MessageDigest.getInstance("SHA-256");int received=0,last=-1;
                try(InputStream in=conn.getInputStream();FileOutputStream out=new FileOutputStream(partial)) {
                    byte[] buffer=new byte[65536];int n;
                    while((n=in.read(buffer))!=-1) {
                        received+=n;if(received>bytes)throw new IOException("升级包大小已变化，请重新检查更新");
                        digest.update(buffer,0,n);out.write(buffer,0,n);
                        int percent=(int)((long)received*100/bytes);
                        if(percent!=last){JSObject progress=new JSObject();progress.put("percent",percent);notifyListeners("progress",progress);last=percent;}
                    }
                    out.getFD().sync();
                }
                StringBuilder actual=new StringBuilder();for(byte b:digest.digest())actual.append(String.format(Locale.ROOT,"%02x",b&255));
                if(received!=bytes || !hash.contentEquals(actual))throw new IOException("升级包校验失败，请重新检查更新");
                validate(partial,target);
                if(!partial.renameTo(apk()))throw new IOException("保存升级包失败，请检查手机剩余空间");
                call.resolve(new JSObject());
            } catch(Exception e){call.reject(e.getMessage()==null?"下载失败，请检查电脑连接和手机剩余空间后重试":e.getMessage());}
            finally {partial.delete();if(conn!=null)conn.disconnect();busy.set(false);}
        });
    }
    @PluginMethod public void install(PluginCall call) {
        if(busy.get()){call.reject("请等待升级包下载完成");return;}
        io.execute(()->{
            try {
                validate(apk(),call.getInt("versionCode",0));
                getActivity().runOnUiThread(()->{
                    try {
                        JSObject result=new JSObject();
                        if(Build.VERSION.SDK_INT>=26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                            getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getContext().getPackageName())));
                            result.put("needsPermission",true);
                        } else {
                            Uri uri=FileProvider.getUriForFile(getContext(),getContext().getPackageName()+".fileprovider",apk());
                            Intent intent=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            getActivity().startActivity(intent);result.put("needsPermission",false);
                        }
                        call.resolve(result);
                    }catch(Exception e){call.reject("无法打开系统安装页，请检查手机的安装权限");}
                });
            }catch(Exception e){call.reject(e.getMessage());}
        });
    }
    @Override protected void handleOnDestroy(){io.shutdown();super.handleOnDestroy();}
}
