# Native clients

Open Reading uses Electron on macOS/Windows and Capacitor on Android/iOS. Local reading does not require a cloud account. The computer hosts a library; phones pair over the same LAN.

## Desktop

```sh
npm ci
npm run desktop:dev
npm run desktop:pack:mac:arm64
npm run desktop:pack:mac:intel
# Run on Windows:
npm run desktop:pack:windows
```

Build on a compatible host. Each desktop package includes the matching native Go service. Use separate Intel/Apple Silicon packages; there is no universal binary. Signing/notarization is not configured in this preview.

| Computer | Installer | Portable archive |
| --- | --- | --- |
| Mac with Apple Silicon | `Open-Reading-<version>-macOS-arm64.dmg` | `Open-Reading-<version>-macOS-arm64.zip` |
| Mac with Intel CPU | `Open-Reading-<version>-macOS-x64.dmg` | `Open-Reading-<version>-macOS-x64.zip` |
| Windows with Intel / AMD CPU | `Open-Reading-<version>-Windows-x64-setup.exe` | `Open-Reading-<version>-Windows-x64.zip` |

The native build workflow uploads these under `Open-Reading-mac-arm64`, `Open-Reading-mac-x64`, and `Open-Reading-win-x64` in its Actions run. Intel Mac builds run on an Intel runner; Windows builds run on Windows. Every package checks the Electron and Go executable architectures, and native-host builds start the bundled service against a temporary library to verify its health endpoint and web assets. These checks run before generating the installer archives.

`npm run desktop:pack -- --mac --x64` and `--win --x64` remain available. Build one platform and architecture per invocation: combining architectures would put only one Go service into multiple incompatible packages. Run `npm run test:desktop-packaging` to check target selection and architecture validation.

For local macOS updates, keep only one rollback app in `release/installed-app-backups/`. After copying the installed app there, installing the new build and verifying its hashes, remove older app backups with:

```sh
python3 scripts/prune-app-backups.py --keep "/absolute/path/to/release/installed-app-backups/Open Reading-previous.app"
```

Pass the backup from the current installation explicitly, since copied apps can retain old timestamps. If backup, installation or verification fails, keep the existing backups. The helper leaves library database backups untouched. Check the retention helper with `PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-prune-app-backups.py`.

Library data is stored separately from the application. The Library menu can select an existing local library directory; stop any other service using that directory first. Closing reading windows flushes drafts and progress before the shared backend exits.

Optional self-hosted use requires your own HTTPS server. Set `OPENREADING_CLOUD_URL` to its HTTPS origin when launching the desktop app. No hosted server is included or configured by default. Local reading and LAN sync do not need this option.

## Android

Requirements: JDK 21, Android SDK and a compatible Gradle setup.

```sh
npm ci
npm run mobile:sync
cd native/android
./gradlew assembleDebug
# Windows: gradlew.bat assembleDebug
```

The debug APK is written under `native/android/app/build/outputs/apk/debug/`. Install it only for testing. The first local-network connection may request network/camera permissions for pairing. The desktop can bundle this APK for temporary installer-only sharing; it does not expose the library administration APIs.

## iOS

Requirements: macOS and Xcode with the iOS SDK.

```sh
npm ci
npm run mobile:sync
xcodebuild -project native/ios/App/App.xcodeproj -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -derivedDataPath release/ios CODE_SIGNING_ALLOWED=NO build
```

This produces a **simulator** app. A physical iPhone requires your own Apple signing setup. No App Store or TestFlight link is provided. The optional installation link in Settings accepts a valid Apple distribution URL; an APK cannot be installed on iOS.

## LAN pairing

1. Keep the computer and phone on the same trusted Wi-Fi or wired LAN.
2. Open Settings → Phone & sync on the desktop and enable LAN synchronization.
3. Choose the workspaces to share and generate a pairing QR code.
4. Scan it with the mobile app and approve the matching device on the desktop.
5. Download the selected files. Reconnect to the computer to exchange offline notes.

The phone pins the computer certificate from pairing; changed certificates require explicit re-pairing. Revoking a device blocks future synchronization; it cannot recall files already downloaded to that device. The computer must remain running and reachable. Guest-network isolation or a firewall can prevent pairing.
