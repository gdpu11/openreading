import Foundation
import Capacitor
import Security

@objc(DeviceVaultPlugin)
public class DeviceVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceVaultPlugin"
    public let jsName = "DeviceVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "cn.ixiaoshi.openreading.device", kSecAttrAccount as String: "connection", kSecAttrSynchronizable as String: false] }
    @objc func get(_ call: CAPPluginCall) {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve([:]); return }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else { call.reject("设备凭证无法读取"); return }
        call.resolve(["value": value])
    }
    @objc func set(_ call: CAPPluginCall) {
        guard let value = call.getString("value"), value.utf8.count <= 65536, let data = value.data(using: .utf8) else { call.reject("无效的设备凭证"); return }
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound { var item = query; attrs.forEach { item[$0.key] = $0.value }; status = SecItemAdd(item as CFDictionary, nil) }
        if status == errSecSuccess { call.resolve() } else { call.reject("设备凭证保存失败") }
    }
    @objc func clear(_ call: CAPPluginCall) {
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { call.resolve() } else { call.reject("设备凭证移除失败") }
    }
}
class OpenReadingViewController: CAPBridgeViewController {
    override func capacitorDidLoad() { bridge?.registerPluginInstance(DeviceVaultPlugin()); bridge?.registerPluginInstance(LocalSyncPlugin()) }
}
