import Foundation
import Capacitor
import CryptoKit
import Security

private final class LocalTrust: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    let pin: String
    var failedPin = false
    init(_ pin: String) { self.pin = pin }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let certificate = SecTrustGetCertificateAtIndex(trust, 0) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        let fingerprint = SHA256.hash(data: SecCertificateCopyData(certificate) as Data).map { String(format: "%02x", $0) }.joined()
        guard fingerprint == pin else { failedPin = true; completionHandler(.cancelAuthenticationChallenge, nil); return }
        // The QR certificate is the computer's identity, rather than its DHCP IP.
        SecTrustSetPolicies(trust, SecPolicyCreateBasicX509())
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        guard SecTrustEvaluateWithError(trust, nil) else { failedPin = true; completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@objc(LocalSyncPlugin)
public class LocalSyncPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalSyncPlugin"
    public let jsName = "LocalSync"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise)]
    private func privateHost(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        let p = parts.compactMap { Int($0) }
        guard p.count == 4, p.allSatisfy({ $0 >= 0 && $0 <= 255 }), zip(parts,p).allSatisfy({ String($0.0) == String($0.1) }) else { return false }
        return p[0] == 10 || p[0] == 172 && (16...31).contains(p[1]) || p[0] == 192 && p[1] == 168 || p[0] == 169 && p[1] == 254
    }
    @objc func request(_ call: CAPPluginCall) {
        guard let value = call.getString("url"), let url = URL(string: value), let host = url.host,
              url.scheme == "https", url.user == nil, url.password == nil, privateHost(host),
              let pin = call.getString("fingerprint"), pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              url.path.hasPrefix("/api/sync/") || url.path == "/api/pair/claim" || url.path == "/api/pair/status" else { call.reject("无效的局域网同步地址"); return }
        let method = call.getString("method") ?? "GET"
        guard method == "GET" || method == "POST" else { call.reject("无效的同步操作"); return }
        let timeout = Double(max(5000, min(120000, call.getInt("timeoutMs") ?? 25000))) / 1000
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method; request.httpShouldHandleCookies = false
        let headers = call.getObject("headers") ?? [:]
        for key in ["Authorization", "Content-Type", "Range"] { if let value = headers[key] as? String { request.setValue(value, forHTTPHeaderField: key) } }
        if let body = call.getString("body") {
            guard body.utf8.count <= 145 * 1024 * 1024, let data = Data(base64Encoded: body) else { call.reject("手机上传超过 100 MB 上限或数据无效"); return }
            request.httpBody = data
        }
        let trust = LocalTrust(pin)
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
        config.waitsForConnectivity = false; config.timeoutIntervalForRequest = timeout; config.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: config, delegate: trust, delegateQueue: nil)
        session.dataTask(with: request) { data, response, error in
            defer { session.finishTasksAndInvalidate() }
            if error != nil { call.reject(trust.failedPin ? "电脑证书与二维码不一致，请核对电脑并重新扫码" : "局域网连接失败，请检查本地网络权限、电脑是否开机，以及手机与电脑是否在同一网络"); return }
            guard let response = response as? HTTPURLResponse, let data = data, data.count <= 210 * 1024 * 1024 else { call.reject("电脑响应无效或文件超过手机直连下载上限"); return }
            var headers: [String:String] = [:]
            for (key,value) in response.allHeaderFields { if let key = key as? String { headers[key] = String(describing: value) } }
            call.resolve(["status":response.statusCode,"headers":headers,"body":data.base64EncodedString()])
        }.resume()
    }
}
