# ORD 学习包（格式版本 1）

Open Reading 1.2.0 起支持单本书导出、导入 `.ord`。导入者不需要原始文件夹或导出者的账号；在自己的 Open Reading 工作区导入，即可阅读原文、查看标注和笔记，并继续学习。此文件可直接通过聊天、网盘或移动端分享面板传递。

## 使用

- 网页、macOS、Windows：打开书籍 → 顶部“导出本书 ORD”（下载图标）。左下角“导入文件或 ORD 学习包”选择 `.ord`，导入到当前工作区。
- Android、iOS：已配对的手机打开书籍 → 顶部下载图标 → 系统分享面板，可保存文件或发给其他人。书库底部选择目标工作区，再点“导入 ORD 学习包”。手机导入导出需要联网，书籍与笔记下载成功后仍可离线阅读。
- 每次主动导入创建独立副本。相同内容不会覆盖现有书籍、标注或笔记；请求因丢失响应重放时，通过请求编号避免重复创建。
- 接收者可以编辑导入的笔记；修改不会回写导出者的书库。分享的是导出时的快照，不是持续协作链接。

包含：当前打开的书籍版本、标注所需历史原文、已捕获的图片资源、标注样式、引用选区、学习状态、已保存笔记和讨论正文，以及阅读位置。支持 Markdown、TXT、PDF、EPUB；EPUB 原始压缩包完整保留，PDF 保留原始字节。

不包含：其他工作区的笔记、其他书籍、未发送草稿、笔记被编辑前的旧内容、模型配置、API Key、来源绝对路径、登录会话、配对设备令牌、AI 请求上下文和执行任务。分享前请先保存需要携带的笔记。问答正在生成时暂不导出；导入后的历史回答作为静态正文，不会自动调用模型。

手机先上传已保存的离线笔记，再导出；有未解决的本书笔记同步冲突或未保存编辑时提示处理，避免遗漏。未配对的手机仍需先连接自己的云端书库，不提供匿名本地导入。手机上限 100 MB；网页和桌面端文件上限 1 GB，展开合计上限 1 GB，单个快照或资源上限 200 MB，元数据上限 32 MB。

## 容器

`.ord` 是 ZIP 容器，不是整个书库的 ZIP 备份；两者入口和格式不同。

```text
manifest.json
book.json
blobs/<sha256>
```

`manifest.json`：`type="openreading-book"`、`version=1`、`createdAt`、`bookHash`（book.json 的 SHA-256）、`files`（路径→SHA-256）。

`book.json`：`title`、`format`、`documentId`、`workspaceDocumentId`、`versionId`、可选 `resourceManifestId`、`tables`。数据表仅允许 `versions`、`artifacts`、`manifests`、`annotations`、`resolutions`、`threads`、`messages`、`message_versions`、`reading_states`；字段沿用数据库 schema 1 的列名。`message_versions` 只携带每条笔记当前保存的版本。

导入时所有实体编号及选区内嵌编号重新生成，在目标工作区建立应用管理的文件副本；资源清单绑定到新的书籍来源。使用者无需连接导出者的文件系统，书籍缓存清理不会清除导入的原文。

导入先检查版本、条目数量/大小、路径、重复条目、数据和资源哈希、原文大小、EPUB 容器、提取产物哈希、字段白名单和引用关系，再通过同一事务提交书籍与笔记。错误或中断不会提交半本书；失败的暂存副本会清理。内容校验用于检测损坏，并不证明发送者身份。

## API

- `GET /api/documents/{workspaceDocumentId}/ord?versionId=...&manifestId=...` 下载学习包。
- `POST /api/workspaces/{workspaceId}/ord`，multipart `file` + `clientRequestId`，返回新文档编号及标注/消息/版本数量。
- 手机使用对应的 `/api/sync/documents/.../ord`、`/api/sync/workspaces/.../ord` 接口。设备只能访问其授权工作区，不获得整库备份、模型配置或服务器目录权限。

原生文件分享使用 [Capacitor 官方 Share 插件](https://capacitorjs.com/docs/apis/share)，文件暂存于应用 Cache 目录，不扩大 Android 外部文件目录访问范围。
