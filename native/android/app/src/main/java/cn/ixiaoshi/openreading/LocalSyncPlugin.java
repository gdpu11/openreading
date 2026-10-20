package cn.ixiaoshi.openreading;

import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.*;
import java.security.*;
import java.security.cert.*;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;

@CapacitorPlugin(name = "LocalSync")
public class LocalSyncPlugin extends Plugin {
    private static final ExecutorService IO = Executors.newFixedThreadPool(3);
    private static final int LIMIT = 210 * 1024 * 1024;
    static boolean privateHost(String host) {
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] p = new int[4];
        try { for (int i=0;i<4;i++) { p[i]=Integer.parseInt(parts[i]); if(p[i]<0||p[i]>255||!Integer.toString(p[i]).equals(parts[i])) return false; } } catch(Exception e) { return false; }
        return p[0]==10 || p[0]==172&&p[1]>=16&&p[1]<=31 || p[0]==192&&p[1]==168 || p[0]==169&&p[1]==254;
    }
    static String fingerprint(X509Certificate cert) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
        StringBuilder out = new StringBuilder(); for(byte b:bytes) out.append(String.format(Locale.ROOT,"%02x",b&255)); return out.toString();
    }
    @PluginMethod public void request(PluginCall call) {
        IO.execute(() -> {
            HttpsURLConnection connection = null;
            try {
                URL url = new URL(Objects.requireNonNull(call.getString("url")));
                String pin = call.getString("fingerprint", "");
                String method = call.getString("method", "GET");
                String path = url.toURI().normalize().getPath();
                if (!url.getProtocol().equals("https") || !privateHost(url.getHost()) || url.getUserInfo()!=null || !pin.matches("[a-f0-9]{64}") || !(method.equals("GET")||method.equals("POST")) || !(path.startsWith("/api/sync/")||path.equals("/api/pair/claim")||path.equals("/api/pair/status"))) throw new IllegalArgumentException("无效的局域网同步地址");
                X509TrustManager trust = new X509TrustManager() {
                    public X509Certificate[] getAcceptedIssuers() {return new X509Certificate[0];}
                    public void checkClientTrusted(X509Certificate[] chain,String auth) throws CertificateException {throw new CertificateException("Client certificates unsupported");}
                    public void checkServerTrusted(X509Certificate[] chain,String auth) throws CertificateException {
                        try { if(chain.length==0||!MessageDigest.isEqual(pin.getBytes(java.nio.charset.StandardCharsets.US_ASCII),fingerprint(chain[0]).getBytes(java.nio.charset.StandardCharsets.US_ASCII))) throw new CertificateException("电脑证书与二维码不一致"); chain[0].checkValidity(); }
                        catch(CertificateException e){throw e;} catch(Exception e){throw new CertificateException("电脑证书校验失败",e);}
                    }
                };
                SSLContext tls=SSLContext.getInstance("TLS");tls.init(null,new TrustManager[]{trust},new SecureRandom());
                connection=(HttpsURLConnection)url.openConnection(Proxy.NO_PROXY);
                connection.setSSLSocketFactory(tls.getSocketFactory());
                // Identity is the exact QR-pinned certificate, independent of a
                // computer's DHCP address. Never alter the global TLS verifier.
                connection.setHostnameVerifier((host,session)->{
                    try{return host.equals(url.getHost())&&fingerprint((X509Certificate)session.getPeerCertificates()[0]).equals(pin);}catch(Exception e){return false;}
                });
                connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);connection.setConnectTimeout(15000);connection.setReadTimeout(120000);connection.setRequestMethod(method);
                JSObject headers=call.getObject("headers",new JSObject());
                for(String key:new String[]{"Authorization","Content-Type","Range"}){String value=headers.optString(key,"");if(!value.isEmpty())connection.setRequestProperty(key,value);}
                String encoded=call.getString("body");
                if(encoded!=null){if(encoded.length()>145*1024*1024)throw new IOException("手机上传超过 100 MB 上限");byte[] body=Base64.decode(encoded,Base64.DEFAULT);connection.setDoOutput(true);connection.setFixedLengthStreamingMode(body.length);try(OutputStream out=connection.getOutputStream()){out.write(body);}}
                int status=connection.getResponseCode();JSObject responseHeaders=new JSObject();
                for(Map.Entry<String,List<String>> entry:connection.getHeaderFields().entrySet()){if(entry.getKey()!=null&&!entry.getValue().isEmpty())responseHeaders.put(entry.getKey(),String.join(", ",entry.getValue()));}
                ByteArrayOutputStream output=new ByteArrayOutputStream();InputStream input=status>=400?connection.getErrorStream():connection.getInputStream();
                if(input!=null){try(InputStream stream=input){byte[] buffer=new byte[65536];int n;while((n=stream.read(buffer))!=-1){if(output.size()+n>LIMIT)throw new IOException("文件超过手机直连下载上限");output.write(buffer,0,n);}}}
                JSObject result=new JSObject();result.put("status",status);result.put("headers",responseHeaders);result.put("body",Base64.encodeToString(output.toByteArray(),Base64.NO_WRAP));call.resolve(result);
            } catch(Exception e) {
                boolean trust=false;for(Throwable c=e;c!=null;c=c.getCause()){if(c instanceof CertificateException||c instanceof SSLPeerUnverifiedException){trust=true;break;}}
                call.reject(trust?"电脑证书与二维码不一致，请核对电脑并重新扫码":"局域网连接失败，请确认电脑开机、同步已开启，手机与电脑连接同一网络");
            } finally {if(connection!=null)connection.disconnect();}
        });
    }
}
