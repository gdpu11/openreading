# 合规复核记录（2026-10-20）

## 结论与范围

**本次不能出具“全部合法、零侵权”的结论。** 已检查公开基线 `5cbd796` 的
510 个受跟踪文件、可达公开历史、npm 锁文件、Go 许可材料、原生依赖声明、
示例资料和公开 APK。复核发现了分发许可和 SDK 隐私说明缺口，已在本地源码
准备修正；旧发布包尚未因这些源码修正而自动改变。

这是工程与开源分发检查，不是律师法律意见、全球商标/专利检索或应用商店认证。
判断不依赖“没有查出问题就等于不存在问题”。本次图工具不可用，使用实际源码、
构建配置、上游许可及已下载 APK 核对。

## 发现及处理

| 严重性 | 发现 | 本次处理与剩余事项 |
| --- | --- | --- |
| 高 | npm/Go 的许可材料主要保存在源码仓库，原构建没有把应用完整许可包明确复制进客户端。 | 新增离线许可目录，网页/Go 嵌入资源/Capacitor 共用；桌面另外复制到 Resources/licenses。须重新构建并核对最终原生包；不能将本地构建成功等同于旧安装包已经修复。 |
| 高 | 安卓扫码依赖 Google ML Kit，原隐私叙述不足以反映该 SDK 的指标发送。 | 新增 PRIVACY.md 和配对页可见提示/许可链接。Google SDK 仍存在；未做逐平台运行时流量审计，也未宣称仅粘贴链接就能阻止 SDK 初始化或指标发送。 |
| 中 | 原许可收集只查包根目录，遗漏 pako 的 zlib 子目录声明；未在仓库许可索引列出 PDF.js 资产级许可。 | 补收集 zlib 声明和 PDF 字体/CMap/WASM/ICC 许可；原 PDF 资产目录本身已有部分许可，并非此前所有资产都完全没有许可。 |
| 中 | KaTeX 代码的 MIT 许可不能替代字体内嵌的 SIL OFL 声明。 | 从实际随包 TTF 的 name 表提取版权、Reserved Font Name 和许可信息，另保留官方 OFL 原文；没有给字体重新标记为 MIT。 |
| 中 | Go 默认递归嵌入会忽略下划线开头的 npm 许可目录。 | 改为 all:static，并以真实嵌入文件系统的回归检查覆盖全部清单引用。 |
| 中 | 未明确双许可证选项和 Go MPL 对应源码获取方式。 | DOMPurify 选择 Apache-2.0，JSZip 选择 MIT；补充未修改 golang-lru v2.0.7 的对应源码链接及 MPL 说明。MPL 覆盖文件不因主项目 MIT 而改为 MIT。 |
| 待闭环 | 原生 Maven/Swift 的完整解析依赖与许可未形成逐包清单。 | npm MIT 声明不能替代原生传递依赖、Google SDK 条款和发布平台的隐私披露。下一轮分发前需生成每个平台真实解析版本的清单并补齐许可材料。 |
| 待闭环 | marks-pane/path-webpack 上游 npm 包只带 MIT 元数据或 README，根目录缺独立许可文件。 | 保留确切上游元数据与作者信息，不编造版权年份或授权书。path-webpack README 表明代码来自 Node v7.0.0，补入该版本原始 Node.js 许可。marks-pane 的完整授权文本/归属仍需上游确认。isarray 的 README 本身已有完整许可。 |

## 未发现的具体问题（有范围限制）

- 在公开受跟踪文本、EPUB 内的 XHTML/OPF/目录以及路径中，未发现此前
  Z-Library/LibGen、公司 Git 域名等扫描标记；公开示例是合成测试资料。
- gitleaks 8.30.1 对可达公开 Git 历史的重新扫描为 0 条命中。扫描器不证明
  所有秘密都不存在，且它不是版权或违法内容检测器。
- npm 锁文件未发现“只能选择 GPL”的运行时包：JSZip 可选 MIT，DOMPurify
  可选 Apache-2.0。构建工具 lightningcss 使用 MPL；Go golang-lru 也使用 MPL，
  均须按各自实际分发方式履行义务，不能统一称为 MIT。
- `docs/images/` 两张宣传图显示项目示例资料；当前图标有可编辑 SVG 来源。
  未发现将系统字体文件直接纳入公开源码，但构建使用的第三方字体仍有独立许可。

## 公开 APK 证据

下载了 `v1.6.6-preview.1` 的 Android APK，并校验 SHA-256 与 GitHub 发布资产
API 的 digest 一致。包内含 ML Kit 模型和 15 个名称含 license/notice 的文件，
但没有新的 `assets/public/licenses/` 应用许可包。不能据此声称所有原生依赖
已满足通知要求，也不能把新源码中的提示当作旧 APK 已经具有的界面。

macOS/Windows/iOS 发布包本次未逐个重新下载解包。其缺口判断以构建配置为依据；
不能替代对应最终包的验证。不要无提示替换已发布二进制或沿用旧校验和。

## 仍需权利人或运营方确认的事项

1. 第一方代码、图标及截图的所有权以维护者此前“个人项目”的说明为基础；
   无法通过代码扫描验证劳动合同、职务成果、外包约定、贡献者授权或他人未公开主张。
2. 未进行 Open Reading 名称/图标的全球商标和专利自由实施检索；避免使用
   Apple Books 或模型服务商标识制造合作、认证、相同产品的印象。
3. 个人本机使用、分发工具和公开运营 AI/书籍服务不是同一适用场景。若运营
   公开云端服务、面向未成年人、收费或跨境处理数据，需结合运营地区重新审查。
4. 用户导入的书籍、ORD、笔记及 AI 输出不由主项目 MIT 自动授权。只分享
   有权传播的资料；格式转换不是 DRM 解除或版权许可。

## 一手依据

- [Apache 2.0 第 4 条分发义务](https://www.apache.org/licenses/LICENSE-2.0.html)
- [Mozilla MPL 2.0（含可执行形式与对应源码）](https://www.mozilla.org/en-US/MPL/2.0/)
- [SIL OFL 原文（第三方字体依其各自许可）](https://openfontlicense.org/open-font-license-official-text/)
- [Google ML Kit 条款与隐私](https://developers.google.com/ml-kit/terms)
- [Google ML Kit Android 数据披露](https://developers.google.com/ml-kit/android-data-disclosure)
- [Node v7.0.0 许可](https://github.com/nodejs/node/blob/v7.0.0/LICENSE)

## 修复验证

`npm test` 33 项通过，`npm run build` 通过；离线包的 230 条 npm/Go 记录引用均存在，
项目 LICENSE/PRIVACY/索引复制内容一致。另验证 Go 真实嵌入资源中的许可完整性。
原生重打包、各安装包许可解包检查、上游缺失许可和商店隐私表单仍为开放项。
