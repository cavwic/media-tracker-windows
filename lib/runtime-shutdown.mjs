const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Stop this exact server on every shutdown path; never inspect/kill others. */
export async function finalizeRuntimeExit({ server, exitCode = 0, releaseGate = () => {},
  setExitCode = (code) => { process.exitCode = code; }, forceExit = (code) => process.exit(code),
  log = console.log, error = console.error, drainMs = 250, closeTimeoutMs = 2_000 } = {}) {
  let closeTimer;
  let closeError;
  try {
    const closed = new Promise((resolve) => {
      try {
        server.close((failure) => {
          if (failure && failure.code !== "ERR_SERVER_NOT_RUNNING") closeError = failure;
          resolve();
        });
      } catch (failure) {
        if (failure.code !== "ERR_SERVER_NOT_RUNNING") closeError = failure;
        resolve();
      }
    });
    try {
      server.closeIdleConnections?.();
      if (exitCode !== 0) server.closeAllConnections?.();
    } catch (failure) { closeError ||= failure; }
    await Promise.race([
      closed,
      new Promise((resolve) => {
        closeTimer = setTimeout(() => {
          closeError ||= new Error("后台监听退出超时；已停止接受新连接。");
          resolve();
        }, closeTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(closeTimer);
    // This also destroys outstanding sockets after a cleanup rejection or the
    // application's 45-second deadline; closeAllConnections alone never stops
    // the listener, so server.close above is unconditional.
    try { server.closeAllConnections?.(); }
    catch (failure) { closeError ||= failure; }
    try { releaseGate(); }
    catch (failure) { closeError ||= failure; }
  }
  if (closeError) {
    exitCode = 1;
    error("后台监听退出异常：", closeError.message);
  }
  setExitCode(exitCode);
  if (exitCode === 0) {
    log("采集工具已完整退出，后台服务已停止。");
    // Successful shutdown drains libuv naturally, avoiding Windows fetch-close
    // races. No browser/listener is started by repeat forwarding in the first place.
    return { exitCode, forced: false };
  }
  error("退出收尾未全部完成；已停止本次后台监听，等待关闭回调排空后以非零状态终止。已有媒体与索引保留，下次启动可重试。");
  await wait(drainMs);
  // Retain the existing bounded-failure behavior when an owned worker or write
  // cannot finish. This exceptional fallback is never used for a normal exit.
  forceExit(exitCode);
  return { exitCode, forced: true };
}
