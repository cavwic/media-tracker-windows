import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export const APP_WINDOW_BINDING = "__mediaTrackerWindow";
export const APP_FRAME_ACTIONS = new Set(["get-state", "minimize", "toggle-maximize", "close", "drag"]);
const trustedSource = fileURLToPath(new URL("../scripts/windows-app-frame.cs",import.meta.url));
const trustedIcon = fileURLToPath(new URL("../public/media-tracker-v2.ico",import.meta.url));
const trustedCache = fileURLToPath(new URL("../data/native-app-frame",import.meta.url));
const execute = promisify(execFile);

export async function prepareAppWindowFrame({ cacheDirectory=trustedCache, sourcePath=trustedSource, executeFile=execute }={}) {
  const source = await readFile(sourcePath);
  const digest = createHash("sha256").update(source).digest("hex");
  const executable = path.join(cacheDirectory,`app-frame-${digest}.exe`);
  try { await access(executable); return executable; } catch {}
  await mkdir(cacheDirectory,{recursive:true});
  const windowsDirectory=process.env.SystemRoot || "C:\\Windows";
  const compiler=path.join(windowsDirectory,"Microsoft.NET","Framework64","v4.0.30319","csc.exe");
  await access(compiler);
  const temporary=path.join(cacheDirectory,`app-frame-${digest}-${process.pid}.tmp.exe`);
  try {
    await executeFile(compiler,["/nologo","/target:winexe","/optimize+",`/out:${temporary}`,"/reference:System.Windows.Forms.dll","/reference:System.Drawing.dll","/reference:System.Web.Extensions.dll",sourcePath],{windowsHide:true,timeout:20_000,maxBuffer:64*1024});
    try { await rename(temporary,executable); } catch(error) { try { await access(executable); } catch {throw error;} }
    return executable;
  } finally {await rm(temporary,{force:true}).catch(()=>{});}
}

function stateOf(record) {
  if(record?.frameless!==true || typeof record.maximized!=="boolean" || typeof record.minimized!=="boolean")throw new Error("Invalid private app window state.");
  return {frameless:true,maximized:record.maximized,minimized:record.minimized};
}

export function watchAppWindowFrame({binding,origin,state}) {
  if(window!==window.top || location.origin!==origin)return;
  window.__mediaTrackerWindowState=state;
  window.dispatchEvent(new CustomEvent("media-tracker-window-state",{detail:state}));
  if(window.__mediaTrackerWindowThemeObserver)return;
  let prior;
  const update=()=>{
    const theme=document.documentElement?.dataset.theme;
    if((theme==="light" || theme==="dark") && theme!==prior){ prior=theme;Promise.resolve(window[binding]("__theme",theme)).catch(()=>{prior=undefined;}); }
  };
  const install=()=>{
    if(window.__mediaTrackerWindowThemeObserver || !document.documentElement)return;
    window.__mediaTrackerWindowThemeObserver=new MutationObserver(update);
    window.__mediaTrackerWindowThemeObserver.observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});
    update();
  };
  install();
  if(!window.__mediaTrackerWindowThemeObserver)window.addEventListener("DOMContentLoaded",install,{once:true});
}

export async function attachAppWindowFrame({context,page,url,executable,onClose=()=>{},onError=console.error,spawnProcess=spawn}={}) {
  const origin=new URL(url).origin;
  if(new URL(url).protocol!=="http:" || !["127.0.0.1","localhost","[::1]"].includes(new URL(url).hostname))throw new TypeError("Window controls require the local tool service.");
  if(new URL(page.url()).origin!==origin)throw new TypeError("The owned main page must use the local tool service.");
  // The host's exposed resize gutter is painted before Chromium is attached.
  // Read the already bootstrapped UI theme so the very first frame cannot show
  // a light border around a dark page. Only these two fixed colors are native.
  const pageTheme=await page.evaluate(()=>document.documentElement?.dataset.theme);
  const initialTheme=pageTheme==="dark"?"dark":"light";
  const session=await context.browser().newBrowserCDPSession();
  let processInfo;
  try {processInfo=await session.send("SystemInfo.getProcessInfo");} finally {await session.detach().catch(()=>{});}
  const browserProcess=processInfo.processInfo.filter(item=>item.type==="browser");
  if(browserProcess.length!==1 || !Number.isSafeInteger(browserProcess[0].id) || browserProcess[0].id<=0)throw new Error("The private app browser process is not unique.");
  const helper=spawnProcess(executable || await prepareAppWindowFrame(),[String(browserProcess[0].id),trustedIcon,initialTheme],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  let closed=false,closing=false,closeNotified=false,sequence=0,current;
  const report=error=>{try{Promise.resolve(onError(error)).catch(()=>{});}catch{}};
  const notify=()=>{if(closing || closeNotified)return;closeNotified=true;try{Promise.resolve(onClose()).catch(report);}catch(error){report(error);}};
  const pending=new Map();
  let resolveReady,rejectReady,resolveExit;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const exited=new Promise(resolve=>{resolveExit=resolve;});
  const readyTimer=setTimeout(()=>rejectReady(new Error("The private app window host did not become ready.")),10_000);
  const emit=async(state)=>{
    current=state;
    if(page.isClosed())return;
    await page.evaluate((value)=>{window.__mediaTrackerWindowState=value;window.dispatchEvent(new CustomEvent("media-tracker-window-state",{detail:value}));},state).catch(()=>{});
  };
  const lines=createInterface({input:helper.stdout});
  lines.on("line",line=>{
    try {
      if(line.length>2048)throw new Error("Invalid private window response.");
      const record=JSON.parse(line);
      const state=stateOf(record);
      if(record.kind==="ready"){clearTimeout(readyTimer);current=state;resolveReady(state);}
      else if(record.kind==="reply"){
        const operation=pending.get(record.id);
        if(!operation)return;
        pending.delete(record.id);clearTimeout(operation.timer);
        if(record.error)operation.reject(new Error("Private app window action failed."));else{current=state;operation.resolve(state);}
      } else if(record.kind==="state")void emit(state);
      else if(record.kind==="closed")notify();
    } catch(error) {report(error);}
  });
  let errors="";
  helper.stderr.on("data",chunk=>{errors+=chunk.toString();if(errors.length>4096)errors=errors.slice(-4096);});
  // A native close can race a polling write. EPIPE is an ordinary window-close
  // condition, not an unhandled stream error that may crash the service.
  helper.stdin.on("error",error=>{
    for(const operation of pending.values()){clearTimeout(operation.timer);operation.reject(error);}pending.clear();
  });
  helper.once("error",rejectReady);
  helper.once("exit",()=>{
    closed=true;clearTimeout(readyTimer);rejectReady(new Error("The private app window host exited."));
    for(const operation of pending.values()){clearTimeout(operation.timer);operation.reject(new Error("The private app window is closed."));}pending.clear();
    lines.close();resolveExit();
    notify();
  });
  const request=(action,theme)=>{
    if(closed)return Promise.reject(new Error("The private app window is closed."));
    const id=++sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error("Private app window action timed out."));},5000);
      pending.set(id,{resolve,reject,timer});
      helper.stdin.write(`${JSON.stringify({id,action,...(theme?{theme}:{})})}\n`,error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});
    });
  };
  const close=async()=>{
    if(closing)return exited;
    closing=true;
    if(!closed){await request("close").catch(()=>{});helper.stdin.end();}
    let timer;
    try{await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{helper.kill();resolve();},3000);timer.unref();})]);}
    finally{clearTimeout(timer);}
  };
  try {
    await ready;
    await context.exposeBinding(APP_WINDOW_BINDING,async(source,action,theme)=>{
      if(source.page!==page || source.frame!==page.mainFrame() || new URL(page.url()).origin!==origin)throw new Error("Window controls are only available in the owned main page.");
      if(action==="__theme" && ["light","dark"].includes(theme))return request("theme",theme);
      if(typeof action!=="string" || !APP_FRAME_ACTIONS.has(action) || theme!==undefined)throw new TypeError("Unsupported app window action.");
      return request(action);
    });
    const setup={binding:APP_WINDOW_BINDING,origin,state:current};
    await context.addInitScript(watchAppWindowFrame,setup);
    await page.evaluate(watchAppWindowFrame,setup);
    return {get state(){return current;},focus:()=>request("focus"),close};
  } catch(error){await close();throw error;}
}
