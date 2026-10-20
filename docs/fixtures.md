# 格式样本与复核方法

工程自有样本由 `node scripts/fixtures.mjs` 生成，不含个人材料和密钥：

| 样本 | 用途 |
|---|---|
| 幂等性.md | 标题、中文、表格、Go 代码、行内代码、公式与本机 SVG |
| 中文与Unicode.txt | 生僻字、emoji、ZWJ、组合字符及 UTF-16 到 code point 转换 |
| 双栏与扫描混合.pdf | 两栏、多行、页眉与脚注、CropBox 偏移、90° 原生页旋转、无文字页 |
| 500页按需加载.pdf | 单页画布、大页数、首屏和浏览器进程内存采样 |
| 可靠接口.epub | 两章、中文、可重排、CFI、字号、行距、字体与分页 |
| 封面与正文.epub | 包装层内的 SVG 封面、真实嵌入 PNG，以及一个清单声明但缺失的可选图片；验证封面尺寸和资源映射 |
| 恶意内容测试.epub | 明确的脚本、远程资源、危险链接测试；阅读时均应被阻断 |

公开真实双栏论文使用 [PDF.js 官方演示样本](https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf)。该 PDF 只用于本机临时验证，不放入源码或发布 ZIP；证据只记录页数、选段长度、几何及预览一致性，不分发原文截图。

复现可将该 PDF 下载到临时目录，再运行：

```sh
OR_REAL_PDF=/absolute/path/to/compressed.tracemonkey-pldi-09.pdf \
  npm run test:e2e -- tests/browser/system.spec.ts
```

浏览器测试自动创建独立的临时数据目录、一次性会话和显式模拟模型，不读取任何已有模型配置或真实密钥。工程证据目录不包含浏览器 storageState 或会话 cookie。

人工视觉复核以实际渲染截图为依据：正文可读、选段高亮与原文相符、讨论不遮挡正文、扫描页能力提示正确、EPUB 重排后高亮保持在原句、模拟回复有明显标记。测试证据保存在本机，发布前检查范围见 release-review.md。

`OR_REAL_EPUB=/absolute/path/to/authorized.epub` 可额外验证本机实际 EPUB。该文件只复制到临时目录，不进入工程或交付包；证据只记录尺寸、解码结果和章节是否有文本。
