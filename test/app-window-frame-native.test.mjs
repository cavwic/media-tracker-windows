import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {spawn,execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,rm,mkdir} from "node:fs/promises";
import {createInterface} from "node:readline";
import {createAppShell} from "../lib/app-shell.mjs";
import {attachAppWindowFrame,prepareAppWindowFrame} from "../lib/app-window-frame.mjs";

const execute=promisify(execFile);

test("native isolated frameless host really resizes the renderer and restores minimized/maximized state",{
 skip:process.platform!=="win32" || process.env.MEDIA_TRACKER_NATIVE_FRAME_TEST!=="1",timeout:30_000,
},async(t)=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"collector-native-app-frame-"));
 const profileDirectory=path.join(directory,"profile");
 const executable=await prepareAppWindowFrame({cacheDirectory:path.join(directory,"native-app-frame")});
 const server=http.createServer((_req,res)=>{res.setHeader("Content-Type","text/html;charset=utf-8");res.end('<!doctype html><html data-theme="dark"><title>Isolated native frame fixture</title><body style="margin:0;background:#0d1420;color:white"><div style="height:60px;background:#26344a">Owned native frame fixture</div></body></html>');});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const notices=[],records=[],pageErrors=[];
 const shell=createAppShell({profileDirectory,onLastWindowClosed:notice=>notices.push(notice),windowFrameFactory:options=>attachAppWindowFrame({...options,executable,spawnProcess:(...args)=>{const child=spawn(...args);const lines=createInterface({input:child.stdout});lines.on("line",line=>records.push(JSON.parse(line)));child.once("exit",()=>lines.close());return child;}})});
 t.after(async()=>{await shell.close();await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith("collector-native-app-frame-"));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const url=`http://127.0.0.1:${server.address().port}/`;
 const page=await shell.open(url);page.on("pageerror",error=>pageErrors.push(error.message));
 const action=action=>page.evaluate(action=>window.__mediaTrackerWindow(action),action);
 const dimensions=()=>page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
 const assertRendererFits=async()=>{await page.waitForTimeout(100);const renderer=await dimensions();await action("get-state");const geometry=records.at(-1).geometry;assert.ok(Math.abs(renderer.width*renderer.dpr-geometry[4])<=2,JSON.stringify({renderer,geometry}));assert.ok(Math.abs(renderer.height*renderer.dpr-geometry[5])<=2,JSON.stringify({renderer,geometry}));return renderer;};
 const normal=await assertRendererFits();assert.ok(normal.width>400);assert.ok(normal.height>300);
 await mkdir(path.resolve(import.meta.dirname,"../test-artifacts/native-frame"),{recursive:true});
 await page.screenshot({path:path.resolve(import.meta.dirname,"../test-artifacts/native-frame/normal.png")});
 assert.equal((await action("toggle-maximize")).maximized,true);const maximized=await assertRendererFits();assert.ok(maximized.width>=normal.width);assert.ok(maximized.height>=normal.height);
 await action("minimize");await shell.open(url);assert.deepEqual(await action("get-state"),{frameless:true,maximized:true,minimized:false});
 await action("toggle-maximize");const restored=await assertRendererFits();assert.deepEqual(restored,normal);
 await action("minimize");await shell.open(url);assert.deepEqual(await action("get-state"),{frameless:true,maximized:false,minimized:false});assert.deepEqual(await assertRendererFits(),normal);
 for(const key of ["F11","Escape"]){await page.keyboard.press(key);await page.waitForTimeout(50);assert.deepEqual(await dimensions(),normal);}
 await page.reload();await action("get-state");assert.deepEqual(await dimensions(),normal);assert.deepEqual(pageErrors,[]);
 await action("close").catch(error=>{if(!page.isClosed())throw error;});
 await new Promise(resolve=>setTimeout(resolve,150));assert.equal(page.isClosed(),true);assert.deepEqual(notices,[{reason:"app-window-closed"}]);
});

test("isolated native motion moves the actual host, restores maximized anchors, and stops on release, blur, minimize and close",{
 skip:process.platform!=="win32" || process.env.MEDIA_TRACKER_NATIVE_FRAME_TEST!=="1",timeout:30_000,
},async(t)=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"collector-native-motion-"));
 const executable=path.join(directory,"owned-motion.exe");
 await execute(path.join(process.env.SystemRoot||"C:\\Windows","Microsoft.NET","Framework64","v4.0.30319","csc.exe"),[
  "/nologo","/target:winexe","/optimize+","/define:OWNED_FRAME_TEST","/main:CollectorMotionFixture",`/out:${executable}`,
  "/reference:System.Windows.Forms.dll","/reference:System.Drawing.dll","/reference:System.Web.Extensions.dll",
  path.resolve(import.meta.dirname,"../scripts/windows-app-frame.cs"),path.resolve(import.meta.dirname,"fixtures/app-frame-motion.cs"),
 ],{windowsHide:true,timeout:20_000,maxBuffer:64*1024});
 const server=http.createServer((_req,res)=>{res.setHeader("Content-Type","text/html");res.end('<!doctype html><html data-theme="dark"><title>Owned native motion fixture</title><body>Private offline sample only</body></html>');});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const records=[],errors=[];let resolveClosed;const closed=new Promise(resolve=>{resolveClosed=resolve;});
 const shell=createAppShell({profileDirectory:path.join(directory,"profile"),onLastWindowClosed:()=>resolveClosed(),windowFrameFactory:options=>attachAppWindowFrame({...options,executable,spawnProcess:(...args)=>{
  const child=spawn(...args),lines=createInterface({input:child.stdout});lines.on("line",line=>records.push(JSON.parse(line)));child.stderr.on("data",chunk=>errors.push(chunk.toString()));child.once("exit",()=>lines.close());return child;
 }})});
 t.after(async()=>{await shell.close();await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith("collector-native-motion-"));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 await shell.open(`http://127.0.0.1:${server.address().port}/`);await closed;await shell.close();
 assert.equal(records.find(record=>record.kind==="motion-test")?.passed,true,errors.join("\n"));
 assert.equal(records.find(record=>record.kind==="motion-close-test")?.passed,true,errors.join("\n"));
 assert.deepEqual(errors,[]);
});
