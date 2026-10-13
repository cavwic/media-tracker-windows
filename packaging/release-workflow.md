# 独立公开最小版发布流程

公开版只构建 Windows x64 最小版，与自用版使用不同源码目录、服务标识和数据目录。不能以旧 release 目录为新源码，也不能复制自用账号、Cookie、日志或媒体。常规更新递增小版本，内部 patch 固定为 0；大版本调整必须由维护者明确决定。

1. 从当前公开源码更新功能，保留本地 API 令牌、访问限制保护、使用须知确认与第三方许可处理。同步修改 package.json、package-lock.json 的顶层及根包版本。
2. 运行语法、语言、关注列表、增量同步、安全边界和包装测试。使用官方 npm registry 的锁包，完整性值不变。源码安装不得自动下载浏览器。
3. 构建 `node packaging/build-portable.mjs --minimal --publisher-cache <已验证缓存的绝对路径>`。若没有缓存，必须明确添加 `--allow-build-download`，不静默联网。构建目录和 ZIP 使用 `采集工具-公开版-最小版-V大版本.小版本`，同名目标不覆盖。
4. 对当前源码、发布目录和完整 ZIP 执行 `audit-release.mjs`；在隔离临时目录真实验证首次本地编译、启动、再启动及完整退出。不能用旧报告代替新包验收。
5. 使用 `export-github-source.mjs <新的绝对目录> --private-redactions <仅本地测试样本替换配置>` 导出 GitHub 源码。只导出白名单代码、资源、测试、文档和构建文件；不会导出 node_modules、数据、历史、缓存、日志或诊断样本。替换配置不进入源码导出。对导出内容运行检查和匿名测试后，再执行 `--audit`。
6. 新包、源码和实际 smoke 全部验收后，将旧公开 ZIP 移到 `release/history`，不覆盖、不删除旧构建目录。归档计划设置 `publicMinimalOnly:true`，仅允许独立 MIT 公开项目的一份已验证最小版与公开版历史包；先 preview，核对后显式 apply。自用版历史不在此流程范围。
7. GitHub 仓库仅接收审计后的源码导出；ZIP 及 SHA-256 校验文件上传到 Releases。先创建 draft，核对资产大小和校验值后公开。不得上传开发目录或本地验证回执中的私人路径。

本地编译后的 EXE 仍未可信签名，不保证所有 Windows 安全策略都放行。MIT 和使用须知不代替平台许可、内容使用权或适用法律要求。
