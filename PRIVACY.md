# Privacy / 隐私说明

This describes the preview source and its current dependencies. It is not a
claim that every platform runtime is offline or that an app-store privacy
review has been completed. 自托管、二次分发和商业运营需要结合实际部署另行评估。

## Books, notes and pairing / 书籍、笔记与配对

The default desktop library stores books, snapshots, annotations and reading
activity in the local data directory. Opening a source folder can cache its
documents in that library. Backups and ORD exports may contain full books,
conversations and personal notes; share only content you are entitled to share.

本机阅读默认使用本机服务。开启局域网同步并在电脑确认配对后，手机可获取授权
工作区的文件与学习记录；手机保留离线副本和待同步草稿。撤销设备授权不等于
远程删除已经下载到设备的数据。移出书库也不等于清除历史快照、笔记和备份。

## Optional AI / 可选 AI

When you send an AI question, the configured provider receives the selected
context, your question and relevant conversation history. The UI lets you
preview that context. Provider privacy policies, retention, location of
processing and fees apply separately. Do not send confidential or third-party
personal information unless you have authority to do so.

API Key 默认仅保存在本机服务进程内存，不进入书库备份；桌面端可主动选择系统保护的加密存储。
普通阅读和笔记不需要模型服务。选择服务商不代表该服务商为本项目背书。

## Camera and native SDKs / 相机与原生 SDK

Camera permission is used for scanning a desktop pairing code. Pasting the
pairing link is an alternative. The Android barcode plugin currently depends
on Google ML Kit, alongside other native libraries. Google states that ML Kit
processes image input on-device, but may contact Google services and send
performance/usage metrics. This may include device/app information, installation
identifiers, timing and error information. See Google's
[terms and privacy](https://developers.google.com/ml-kit/terms) and
[Android data disclosure](https://developers.google.com/ml-kit/android-data-disclosure).

因此不能将“本地优先”理解为“所有第三方 SDK 绝不联网或发送指标”。本次未完成
每个平台原生 SDK 的运行时流量审计；不能把本说明当作应用商店隐私表单已经通过。

## Reports and public services / 公开反馈与服务

Public issue reports are public. Use synthetic documents and remove private
book contents, API keys, pairing links, device tokens and backups before
reporting a bug. GitHub downloads, external links, optional model requests and
an operator's self-hosted service are governed by their respective providers.
For security-sensitive reports use the private reporting link in SECURITY.md.

## Rights and scope / 权利与适用范围

Reading, conversion and ORD export do not grant copyright in a book or its
illustrations, remove DRM, or authorize public redistribution. AI answers may
be inaccurate and do not establish permission to reuse underlying material.
Hosted public services, minors' data, commercial distribution and international
data transfers need review for the operator's actual jurisdiction and use.

## Optional desktop key storage

When explicitly selected in model settings, API keys are encrypted using Electron safeStorage and the operating system credential protection. Encrypted records live in the desktop application profile, bind to the provider ID, protocol and endpoint, and are excluded from library backups and ORD exports. Plaintext fallback storage is refused. Deleting a remembered credential removes the encrypted record.

## Reading tools

Full-text indexes, OCR page text, bookmarks, tags and review schedules remain in the library. OCR runs locally with macOS Vision or a locally installed Tesseract. Web article import contacts only the public URL entered by the user (and validated public redirects); article contents are previewed before import. Read aloud selects a matching voice marked local by the system/browser speech API. If no local voice is available, it displays an error rather than choosing an online voice.
