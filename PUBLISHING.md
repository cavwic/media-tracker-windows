# 发布前检查与未解决的边界

本文件不是法律意见、平台授权或“已完全合规”证明。当前发行版按用户决定保留网页采集，平台许可问题仍然存在，不能仅用免责声明解决。

## 已做的工程整改

原创代码明确采用 MIT；保留随包 Node / Playwright 完整许可及声明。最小包不捆绑浏览器、Python、相似去重二进制、Playwright FFmpeg 辅助程序或 winldd。首次环境及可选工具联网准备需要确认，固定版本及完整哈希校验，第三方运行环境不因此获得 MIT 许可。

首版移除直接导入 `gallery-dl` 的接口及其自动下载，不以进程分离或改名假称规避 GPL。`yt-dlp` 按当前固定 wheel 自身的 Unlicense 及其实际依赖分别列出许可；不能把其它来源的 yt-dlp EXE 当作同一种许可的二进制包。

发行版独立目录、应用身份和空白数据；本地服务仅监听 loopback，检查 Host / Origin 并对私有 API 检查随机会话令牌。令牌机制不抵御已能读取同用户本地文件的恶意程序。没有自动配置共享、云端账号、验证码破解或 DRM 解密；用户主动共享账号、IP 或媒体输出目录仍会破坏隔离，尤其不可同时操作同一人物 Index。

## 仍须在发布地区及渠道核对

1. 自动采集：现有采集不是获准 API。X、Meta、TikTok 等对自动访问有自己的规定；登录、关注、用户确认或个人自用都不自动解决条款限制。宜获得平台许可或使用获准接口，否则存在限制访问、封号及渠道下架风险。
2. 内容权利：软件的 MIT 许可不授予作品复制、再发布、肖像使用、个人信息处理、数字人或模型训练权。不得宣传“任意账号全量下载”“无授权训练”“防封”“绕过限制”。使用许可应与实际内容、用途、地区核对。
3. 发行责任：不能通过“下载后是用户的事”排除开发者可能承担的责任；是否构成帮助侵权取决于事实，而不是所有通用工具一概违法。
4. 第三方组件：即使由终端用户直接下载，也应保留许可、来源和用户确认。再次打包已安装环境、FFmpeg 或其它组件发布，必须另行满足对应许可、源码及通知义务；单一 FFmpeg 上游提交链接不代表所有构建依赖的对应源码齐全。
5. 分发渠道：GitHub / 网盘可依据条款、版权或隐私投诉限制文件。保留实际维护者联系渠道，响应权利投诉和问题反馈，不上传 Cookie、真实人物配置、媒体、索引或脱敏前的日志。软件不会自行创建账号、仓库或公开上传；维护者发布仓库及 Release 是独立操作。
6. Windows：本地编译不等于可信签名或 SmartScreen 信誉。不得让用户关闭 SmartScreen / SAC、改注册表或导入自签证书来规避系统保护。

## 公开源码导出

便携包的 `app` 中包含可读原创源码与 MIT `LICENSE`。维护者源码目录含测试及调试脚本，发布源码仓库应使用白名单导出，不能直接推送整个工作目录。排除 `data`、浏览器资料、运行环境、媒体、日志、缓存、验证产物、私有路径与真实账号测试样例。可以将问题报告模板和安全联系方式写在选定渠道，但不要编造维护者邮箱。

V1.2 发布到 GitHub 前，还应确认：

- README 使用专业简洁的中英文产品介绍、亮点和快速上手说明，明确 Windows x64、首次确认下载与本地编译流程，不把 GitHub 自动源码 ZIP 描述为便携发行包；不强调内部版别，不加入改动清单或后续计划。标题图仅含英文，使用截图仅含虚构演示数据，图片按精确白名单发布。
- 仓库包含 MIT `LICENSE`、隐私说明、安全说明、贡献说明及脱敏 Issue 模板；平台自动采集未授权边界在 README 中可见。
- 在全新目录验证 ZIP、完整 SHA-256、版本及实际源码指纹；将便携 ZIP 和校验文件放到 Release 附件，不把用户数据、运行环境或历史包提交进 Git。
- 本仓库已启用 GitHub 私密漏洞报告，后续发布应确认该入口仍可用。公开 Issue 不应接收 Cookie、令牌、完整浏览器资料或可直接利用的漏洞细节。
- CI 只使用合成数据及隔离目录，不配置真实平台账号，不自动登录或采集目标账号，也不强制安装可选相似去重组件。
- 启用 CI、发布公开仓库或上传 Release 不是 GitHub 对本工具的合规批准；依旧应响应版权、隐私与安全问题。

## 官方参考

- X 自动化规则：https://help.x.com/en/rules-and-policies/x-automation
- Meta 自动采集条款：https://www.facebook.com/legal/automated_data_collection_terms （本次读取被登录限制，发布前需在适用地区核对实际条款）
- TikTok 条款：https://www.tiktok.com/legal/page/row/terms-of-service/en （本次读取受限，不将旧版本当作当前条款确认）
- GitHub 可接受使用政策：https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies
- Node 完整许可：https://github.com/nodejs/node/blob/v24.14.1/LICENSE
- Playwright 许可：https://github.com/microsoft/playwright/blob/v1.62.1/LICENSE
- Chrome for Testing：https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing

第三方资料核对日期：2026-10-12。正式发布前应再次核对有时效性的条款。

2026-10-13 重新读取 GitHub 可接受使用政策；平台条款仍按上文访问限制标明，未将无法读取的条款视作已核验。GitHub 私密漏洞报告操作参考：https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately
