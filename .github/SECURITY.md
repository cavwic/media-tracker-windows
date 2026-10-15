# 安全问题反馈

当前维护对象为最新公开 Windows x64 最小版。旧版本可能没有修复最新问题，请使用最新发行包；本地编译产生未签名 EXE，不保证 Windows 安全策略放行，也不要求关闭安全功能。

## 私密报告

本仓库已启用 GitHub 私密漏洞报告，请在 [Security 页面](https://github.com/cavwic/media-tracker-windows/security) 选择 **Report a vulnerability** 提交报告。若该入口不可用，请先创建仅询问“如何私密报告安全问题”的 Issue，由维护者提供渠道；不要在公开 Issue 中先披露凭据或可直接利用的漏洞细节。

可提供版本、Windows 版本、脱敏的复现步骤、影响范围及最小合成样例。不上传 Cookie、密码、会话令牌、整个 `data` 或浏览器资料夹，不测试第三方账号或非本人拥有的媒体目录。请不要因为测试而关闭 Windows 安全设置。

没有固定响应时限承诺。维护者将通过实际可用的 GitHub 渠道沟通；本文件不编造邮箱、赏金计划或服务等级。

## 安全边界

- 本地后台监听 loopback，并检查来源及私有 API 会话令牌。这不能抵御已能读取同用户文件的恶意软件，也不是不可信网站的绝对沙箱。
- `data/browser-profiles` 含敏感登录资料；不要上传、共享或当作普通缓存整目录删除。具体清理范围见 [PRIVACY.md](../docs/PRIVACY.md)。
- 首次运行环境和可选组件使用明确确认、固定 HTTPS 来源与完整 SHA-256。自行替换二进制、修改清单或使用第三方重新打包版会改变此边界。
- 不支持验证码破解、DRM 解密、付费访问绕过或平台限制规避。平台封禁、登录失效及内容不可访问通常不等于软件安全漏洞。

GitHub 操作参考：[私密报告安全漏洞](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)。
