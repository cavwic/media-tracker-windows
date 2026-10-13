# Media Tracker · 公开最小版

独立的 Windows 本地媒体采集与管理工具。当前公开版本为 V1.2，仅支持 Windows x64；暂不支持 macOS、Linux、Windows ARM64 或 32 位 Windows。原创代码为 MIT 开源许可，只构建最小版，不携带发布者账号、Cookie、人物配置或媒体。

保留 X、Instagram、Facebook、TikTok 的网页媒体采集、增量同步、人物级本地精确去重、来源索引、搜索、系统程序打开及缓存维护；可选 FFmpeg / ffprobe 在明确确认后准备，或指定已有工具位置。缺少组件时显示普通鼠标，不影响精确去重。

这些采集器不是平台官方 API，本工具没有取得平台自动采集许可。必须遵守平台规则、作品权利和适用法律；本版的使用须知、MIT 许可或本地编译都不代表获得这些许可。详见 [发行版说明](PUBLIC-EDITION.md)、[隐私](PRIVACY.md)、[发布检查](PUBLISHING.md) 与 [原创许可](LICENSE)。

## 下载与首次运行

在 [Releases](https://github.com/cavwic/media-tracker-windows/releases) 页面下载 Windows 最小版 ZIP 和 SHA-256 校验文件。不要把 GitHub 自动生成的 `Source code (zip)` 当作可直接使用的软件包。

1. 完整解压到可写的独立目录，不要直接在压缩包中运行。
2. 运行 `首次编译.cmd`，使用 Windows 自带的 .NET 编译器生成本地 EXE。编译或启动失败时保留编译材料供重试；确认启动成功后才清理这些材料。
3. 首次环境准备须确认联网，随后从固定 HTTPS 来源下载独立运行环境并核对完整 SHA-256。取消后不下载，可稍后重试。
4. 准备成功后直接运行生成的 EXE。添加采集对象和账号后，按需登录、验证并同步；所有操作应以平台规则与作品权利许可为前提。

无需管理员权限，不安装到系统，不改注册表或系统 PATH。关闭主窗口会退出本版拥有的后台服务及浏览器。最小包体积不等于准备后的磁盘占用：浏览器与 Python 等运行环境会增加目录大小。

保持本版目录独立。它不会复用自用版服务或资料，但平台账号或 IP 共享仍可能让平台限流、封禁同时影响两版。本地编译生成未签名 EXE，不能保证 Windows 安全策略放行；不要关闭安全功能。

## 媒体与去重

- 按采集对象保存 `Image`、`Video` 和 `Index`，媒体目录在需要时创建；来源索引保留发布平台、账号和原帖链接。
- 已成功同步的账号继续增量同步，失败项目保留重试信息；不会因为原帖被删除而自动删除本地媒体。
- 精确去重使用本地 SHA-256，不需要额外模型或联网服务。相似去重为可选功能：缺少 FFmpeg / ffprobe 时，可明确选择下载工具包、指定已有路径或取消；未开始处理时保持普通鼠标指针。
- 相似去重不是内容许可判断，可能误判。合并副本保留在可恢复归档中，保留不同音轨版本。重要媒体仍应自行备份。

登录资料、媒体和日志不要上传到 Issue。缓存清理不会删除仍绑定账号的登录状态；完整旧登录资料的删除是另一个需要选择并确认的操作。详见 [PRIVACY.md](PRIVACY.md)。

## 开发与打包

开发及发布构建请使用 Windows x64 和 Node.js 24.14.1；发布运行环境按组件清单锁定。`npm ci` 会联网安装锁定依赖，浏览器相关测试另需独立的 Playwright 浏览器。测试使用隔离样本，不应连接生产媒体目录，也不要复制真实登录目录来公开测试。

```powershell
npm ci
npm run check
npm run check:language
npm run check:custom
npm run check:following
npm run check:lifecycle
npm run check:media
npm test
```

`npm run release:local-build -- --publisher-cache <已验证的本地缓存绝对目录>` 只读取发行者缓存；缺少必要归档时失败，不偷偷联网。明确希望获取缺少构建归档时才使用 `--allow-build-download`。发布构建仅最小版；不提供标准版或捆绑运行环境选项。公开与自用更新目录分开，小版本号递增。

发布 ZIP 用白名单，只包含可读应用源码、许可说明、固定组件清单及首次本地编译材料。不要把开发工作目录整体压缩或直接推送：调试脚本和测试不属于公开 ZIP，真实路径或目标账号样例应先脱敏。第三方许可见包内 `THIRD-PARTY-NOTICES.txt` 和各组件的 LICENSE / NOTICE。

## 反馈与贡献

普通问题使用本仓库的 [Issue 模板](https://github.com/cavwic/media-tracker-windows/issues/new/choose)，提交前删除 Cookie、令牌、私有路径及账号信息。安全漏洞请按 [SECURITY.md](SECURITY.md) 通过私密渠道反馈；贡献前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。版本变化见 [CHANGELOG.md](CHANGELOG.md)。

仓库 Windows CI 使用合成样例和隔离目录运行检查与测试，不配置生产平台账号。需要实际桌面或未安装可选运行环境的测试可能按条件跳过；CI 通过不代表所有 Windows 设备、网络环境或平台页面均已验证。

Windows-only local-first media collector and organizer. Original code is MIT-licensed. Optional runtimes and tools require explicit confirmation; the application is not affiliated with or authorized by the supported platforms. The locally compiled EXE is unsigned.
