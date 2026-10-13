import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {PassThrough,Writable} from "node:stream";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {attachAppWindowFrame,APP_WINDOW_BINDING,APP_FRAME_ACTIONS,prepareAppWindowFrame,watchAppWindowFrame} from "../lib/app-window-frame.mjs";
import {createAppShell} from "../lib/app-shell.mjs";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({onClose=()=>{},onError=()=>{},theme="dark"}={}){
 const frame={};let address="http://127.0.0.1:43178/";
 const page={url:()=>address,isClosed:()=>false,mainFrame:()=>frame,evaluate:async()=>theme};
 const calls=[],bindings=new Map(),scripts=[];
 const context={browser:()=>({newBrowserCDPSession:async()=>({send:async()=>({processInfo:[{type:"browser",id:1234},{type:"renderer",id:2345}]}),detach:async()=>{}})}),exposeBinding:async(name,callback)=>bindings.set(name,callback),addInitScript:async(fn,arg)=>scripts.push({fn,arg})};
 const helper=new EventEmitter();helper.stdout=new PassThrough();helper.stderr=new PassThrough();helper.kill=()=>helper.emit("exit",0);
 let maximized=false,minimized=false;
 const output=(kind,id)=>helper.stdout.write(`${JSON.stringify({kind,id,frameless:true,maximized,minimized})}\n`);
 helper.stdin=new Writable({write(chunk,_encoding,callback){const request=JSON.parse(chunk.toString());calls.push(request);if(request.action==="toggle-maximize")maximized=!maximized;if(request.action==="minimize")minimized=true;if(request.action==="focus")minimized=false;output("reply",request.id);callback();if(request.action==="close"){output("closed",0);setImmediate(()=>helper.emit("exit",0));}}});
 const launches=[];
 const open=()=>attachAppWindowFrame({context,page,url:address,executable:"D:\\private\\app-frame.exe",onClose,onError,spawnProcess:(exe,args,options)=>{launches.push({exe,args,options});setImmediate(()=>output("ready",0));return helper;}});
 return {page,frame,context,helper,calls,bindings,scripts,launches,open,navigate:url=>{address=url;}};
}

test("frameless bridge controls only its exact owned top-level local page with fixed actions",async()=>{
 const f=fixture();const controller=await f.open();
 assert.deepEqual(f.launches[0].args.slice(0,1),["1234"]);
 assert.match(f.launches[0].args[1],/public[\\/]media-tracker-v2\.ico$/);
 assert.equal(f.launches[0].args[2],"dark");
 assert.equal(f.launches[0].options.windowsHide,true);
 assert.deepEqual(f.launches[0].options.stdio,["pipe","pipe","pipe"]);
 const binding=f.bindings.get(APP_WINDOW_BINDING);const source={page:f.page,frame:f.frame};
 assert.deepEqual(await binding(source,"toggle-maximize"),{frameless:true,maximized:true,minimized:false});
 assert.deepEqual(await binding(source,"minimize"),{frameless:true,maximized:true,minimized:true});
 await controller.focus();assert.deepEqual(controller.state,{frameless:true,maximized:true,minimized:false});
 for(const action of ["kill","resize","D:\\private","__theme"])await assert.rejects(binding(source,action));
 await assert.rejects(binding(source,"minimize",{"pid":999}),/Unsupported/);
 await assert.rejects(binding({page:{},frame:f.frame},"minimize"),/owned main page/);
 await assert.rejects(binding({page:f.page,frame:{}},"minimize"),/owned main page/);
 f.navigate("https://example.com/");await assert.rejects(binding(source,"close"),/owned main page/);
 f.navigate("http://127.0.0.1:43178/");
 assert.equal(f.scripts[0].fn,watchAppWindowFrame);assert.equal(f.scripts[0].arg.origin,"http://127.0.0.1:43178");
 await controller.close();assert.equal(f.calls.at(-1).action,"close");
});

test("host close plus process exit notifies once, intentional close never recursively notifies",async()=>{
 let notifications=0;const f=fixture({onClose:()=>{notifications++;}});const controller=await f.open();
 f.helper.stdout.write(`${JSON.stringify({kind:"closed",id:0,frameless:true,maximized:false,minimized:false})}\n`);
 f.helper.emit("exit",0);await tick();assert.equal(notifications,1);await controller.close();
 const intentional=fixture({onClose:()=>{notifications++;}});const c=await intentional.open();await c.close();await tick();assert.equal(notifications,1);
});

test("first native frame receives only the already resolved light or dark UI theme",async()=>{
 for(const theme of ["light","unexpected-theme",null]){
  const f=fixture({theme});const controller=await f.open();assert.equal(f.launches[0].args[2],theme==="dark"?"dark":"light");await controller.close();
 }
 const f=fixture();f.page.url=()=>"https://example.com/";await assert.rejects(f.open(),/owned main page must use/);assert.equal(f.launches.length,0);
});

test("diagnostic rejection cannot crash malformed native response handling",async()=>{
 const f=fixture({onError:async()=>{throw new Error("fixture diagnostics failed");}});const controller=await f.open();
 f.helper.stdout.write("invalid-private-protocol\n");await tick();assert.deepEqual(await controller.focus(),{frameless:true,maximized:false,minimized:false});await controller.close();
});

test("native source versions compile once into the actual private profile cache without online dependencies",async(t)=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"collector-frame-build-"));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourcePath=path.join(directory,"fixture.cs");await writeFile(sourcePath,"// owned compiler fixture\n");
 const cacheDirectory=path.join(directory,"private-cache");let calls=0;
 const executeFile=async(compiler,args,options)=>{calls++;assert.match(compiler,/Microsoft\.NET[\\/]Framework64[\\/]v4\.0\.30319[\\/]csc\.exe$/);assert.equal(options.windowsHide,true);assert.ok(args.includes("/target:winexe"));await writeFile(args.find(a=>a.startsWith("/out:")).slice(5),"fixture executable");};
 if(process.platform!=="win32"){t.skip("Windows compiler paths");return;}
 const first=await prepareAppWindowFrame({sourcePath,cacheDirectory,executeFile});const second=await prepareAppWindowFrame({sourcePath,cacheDirectory,executeFile});
 assert.equal(first,second);assert.equal(path.dirname(first),cacheDirectory);assert.match(path.basename(first),/^app-frame-[a-f0-9]{64}\.exe$/);assert.equal(calls,1);
 await writeFile(sourcePath,"// next source version\n");assert.notEqual(await prepareAppWindowFrame({sourcePath,cacheDirectory,executeFile}),first);assert.equal(calls,2);
});

test("window observer safely waits for the root element and exposes no raw native handles",async()=>{
 const source=watchAppWindowFrame.toString();assert.match(source,/!document\.documentElement/);assert.match(source,/DOMContentLoaded/);assert.ok(!source.includes("pid"));assert.deepEqual([...APP_FRAME_ACTIONS],["get-state","minimize","toggle-maximize","close","drag"]);
 const native=await readFile(new URL("../scripts/windows-app-frame.cs",import.meta.url),"utf8");
 assert.match(native,/actual == pid/);assert.match(native,/GetParent\(child\)==Handle/);assert.match(native,/MonitorFromWindow\(Handle,2\)/);
 assert.ok(!native.includes("TopMost"));assert.ok(!native.includes("Process.Kill"));assert.ok(!native.includes("SetWindowsHookEx"));assert.ok(!native.includes("SetWindowLongPtr"));
 assert.match(native,/Math\.Min\(1944,work\.Width\)/);assert.match(native,/Math\.Min\(1372,work\.Height\)/);
 assert.match(native,/GetAsyncKeyState\(Native\.GetSystemMetrics\(23\)!=0\?2:1\)&0x8000/);assert.match(native,/GetCursorPos\(out cursor\)/);
 assert.match(native,/movement\.Interval=16/);assert.match(native,/GetAncestor\(foreground,2\)==Handle/);
 assert.match(native,/DwmSetWindowAttribute\(Handle,2,ref disabled,4\)/);
 assert.match(native,/~0x00040000 & ~0x00080000/);
 assert.ok(!native.includes("Native.ReleaseCapture()"));assert.ok(!native.includes("Native.SendMessage(Handle,0x0112"));
});

test("owned frameless shell uses kiosk renderer, native focus/cleanup and no theme extensions",async()=>{
 const page=new EventEmitter();page.url=()=>"http://127.0.0.1:43178/";page.isClosed=()=>false;page.bringToFront=()=>assert.fail("Embedded Chromium cannot focus a separate top-level browser window");
 const context=new EventEmitter();context.browser=()=>new EventEmitter();context.pages=()=>[page];let contextCloses=0;context.close=async()=>{contextCloses++;};
 let options,focuses=0,closes=0,notify;
 const shell=createAppShell({profileDirectory:"D:\\isolated\\data\\app-profile",platform:"win32",browserType:{executablePath:()=>"private.exe",launchPersistentContext:async(_profile,args)=>{options=args;return context;}},windowFrameFactory:async args=>{notify=args.onClose;return{focus:async()=>{focuses++;},close:async()=>{closes++;}};}});
 await shell.open(page.url());assert.ok(options.args.includes("--kiosk"));assert.ok(options.args.includes("--start-minimized"));assert.ok(!options.args.includes("--enable-unsafe-extension-debugging"));
 await shell.open(page.url());assert.equal(focuses,2);assert.equal(shell.ready,true);await shell.close();assert.equal(closes,1);assert.equal(contextCloses,1);assert.equal(typeof notify,"function");
});
