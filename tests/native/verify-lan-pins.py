"""Exercise the production Java TLS bridge and Swift trust delegate against a disposable PC server."""
from pathlib import Path
import subprocess, tempfile, sys, os
root=Path(__file__).resolve().parents[2]
origin,pin=sys.argv[1:3]
with tempfile.TemporaryDirectory(prefix='openreading-native-pins-') as directory:
 d=Path(directory)
 sources={
 'android/util/Base64.java':'''package android.util; public class Base64 {public static final int DEFAULT=0,NO_WRAP=2; public static byte[] decode(String v,int f){return java.util.Base64.getMimeDecoder().decode(v);}public static String encodeToString(byte[] v,int f){return java.util.Base64.getEncoder().encodeToString(v);}}''',
 'com/getcapacitor/Plugin.java':'package com.getcapacitor; public class Plugin {}',
 'com/getcapacitor/PluginMethod.java':'package com.getcapacitor; public @interface PluginMethod {}',
 'com/getcapacitor/annotation/CapacitorPlugin.java':'package com.getcapacitor.annotation; public @interface CapacitorPlugin {String name();}',
 'com/getcapacitor/JSObject.java':'''package com.getcapacitor; public class JSObject extends java.util.HashMap<String,Object>{public String optString(String k,String f){return (String)getOrDefault(k,f);}}''',
 'com/getcapacitor/PluginCall.java':'''package com.getcapacitor; public class PluginCall{public String url,pin,error;public JSObject result;public final java.util.concurrent.CountDownLatch done=new java.util.concurrent.CountDownLatch(1);public String getString(String k){return getString(k,null);}public String getString(String k,String f){return k.equals("url")?url:k.equals("fingerprint")?pin:f;}public JSObject getObject(String k,JSObject f){return f;}public void resolve(JSObject r){result=r;done.countDown();}public void reject(String e){error=e;done.countDown();}}''',
 'cn/ixiaoshi/openreading/LocalSyncPlugin.java':(root/'native/android/app/src/main/java/cn/ixiaoshi/openreading/LocalSyncPlugin.java').read_text(),
 'cn/ixiaoshi/openreading/PinProbe.java':'''package cn.ixiaoshi.openreading; import com.getcapacitor.*;public class PinProbe{public static void main(String[] args)throws Exception{LocalSyncPlugin plugin=new LocalSyncPlugin();for(int i=0;i<2;i++){PluginCall c=new PluginCall();c.url=args[0]+"/api/sync/library";c.pin=i==0?args[1]:"0".repeat(64);plugin.request(c);if(!c.done.await(20,java.util.concurrent.TimeUnit.SECONDS))throw new Exception("timeout");if(i==0&&(c.error!=null||!Integer.valueOf(401).equals(c.result.get("status"))))throw new Exception("correct pin rejected: "+c.error);if(i==1&&(c.error==null||!c.error.contains("证书")))throw new Exception("wrong pin accepted");}System.out.println("Android production TLS bridge: correct pin accepted; wrong pin rejected");System.exit(0);}}'''
 }
 for name,text in sources.items():
  p=d/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
 java=Path('/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin')
 subprocess.run([str(java/'javac'),'-encoding','UTF-8','-d',str(d/'classes')]+[str(d/n) for n in sources],check=True)
 subprocess.run([str(java/'java'),'-cp',str(d/'classes'),'cn.ixiaoshi.openreading.PinProbe',origin,pin],check=True,timeout=45)
 swift=(root/'native/ios/App/App/LocalSync.swift').read_text().split('@objc(LocalSyncPlugin)')[0].replace('import Capacitor\n','')
 swift+='''
let origin=CommandLine.arguments[1], pin=CommandLine.arguments[2]
for expected in [true,false] {
 let trust=LocalTrust(expected ? pin : String(repeating:"0",count:64))
 let session=URLSession(configuration:.ephemeral,delegate:trust,delegateQueue:nil)
 let done=DispatchSemaphore(value:0)
 var passed=false
 session.dataTask(with:URL(string:origin+"/api/sync/library")!){data,response,error in
  passed=expected ? (error==nil && (response as? HTTPURLResponse)?.statusCode==401) : (error != nil && trust.failedPin)
  done.signal()
 }.resume()
 guard done.wait(timeout:.now()+20) == .success && passed else {fatalError("Swift certificate pin verification failed")}
 session.finishTasksAndInvalidate()
}
print("iOS production trust delegate on macOS Security: correct pin accepted; wrong pin rejected")
'''
 (d/'probe.swift').write_text(swift)
 subprocess.run(['swiftc','-module-cache-path',str(d/'swift-cache'),str(d/'probe.swift'),'-o',str(d/'swift-probe')],check=True,timeout=120)
 subprocess.run([str(d/'swift-probe'),origin,pin],check=True,timeout=45)
