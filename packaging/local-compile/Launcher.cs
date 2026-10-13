using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

// Built with Windows' .NET Framework compiler; no developer SDK is needed.
// Normal startup never invokes CMD, PowerShell, VBS, npm or an installer.
internal static class Launcher
{
    private static readonly string Root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    private static readonly string AppRoot = Path.Combine(Root, "app");
    private static readonly string DataRoot = Path.Combine(Root, "data");
    private static readonly Encoding Utf8 = new UTF8Encoding(false);

    [DataContract]
    private sealed class RuntimeReport
    {
        [DataMember(Name = "nodeMajor")] public int NodeMajor;
        [DataMember(Name = "browserExecutable")] public string BrowserExecutable;
    }

    [DataContract]
    private sealed class SelfTestReport
    {
        [DataMember(Name = "schemaVersion")] public int SchemaVersion = 1;
        [DataMember(Name = "ok")] public bool Ok;
        [DataMember(Name = "message")] public string Message;
    }

    [DataContract]
    private sealed class CompileReceipt
    {
        [DataMember(Name = "schemaVersion")] public int SchemaVersion;
        [DataMember(Name = "filename")] public string Filename;
        [DataMember(Name = "sha256")] public string Sha256;
        [DataMember(Name = "sources")] public Dictionary<string, string> Sources;
    }

    [DataContract]
    private sealed class ReadyReceipt
    {
        [DataMember(Name = "schemaVersion")] public int SchemaVersion;
        [DataMember(Name = "token")] public string Token;
        [DataMember(Name = "ready")] public bool Ready;
    }

    [DataContract]
    private sealed class ComponentStatus
    {
        [DataMember(Name = "id")] public string Id;
        [DataMember(Name = "name")] public string Name;
        [DataMember(Name = "displayName")] public string DisplayName;
        [DataMember(Name = "state")] public string State;
        [DataMember(Name = "message")] public string Message;
        [DataMember(Name = "ready")] public bool Ready;
        [DataMember(Name = "downloadBytes")] public long DownloadBytes;
        [DataMember(Name = "licenseSummary")] public string LicenseSummary;
    }

    [DataContract]
    private sealed class PreparationStatus
    {
        [DataMember(Name = "schemaVersion")] public int SchemaVersion;
        [DataMember(Name = "ready")] public bool Ready;
        [DataMember(Name = "requiresDownload")] public bool RequiresDownload;
        [DataMember(Name = "blocked")] public bool Blocked;
        [DataMember(Name = "message")] public string Message;
        [DataMember(Name = "totalDownloadBytes")] public long TotalDownloadBytes;
        [DataMember(Name = "components")] public List<ComponentStatus> Components;
        public bool NodeBootstrap;
    }

    [DataContract]
    private sealed class NodeBootstrapSpec
    {
        [DataMember(Name = "schemaVersion")] public int SchemaVersion;
        [DataMember(Name = "id")] public string Id;
        [DataMember(Name = "version")] public string Version;
        [DataMember(Name = "platform")] public string Platform;
        [DataMember(Name = "archiveURL")] public string ArchiveUrl;
        [DataMember(Name = "archiveSha256")] public string ArchiveSha256;
        [DataMember(Name = "archiveBytes")] public long ArchiveBytes;
        [DataMember(Name = "maxArchiveBytes")] public long MaxArchiveBytes;
    }

    [DataContract]
    private sealed class NodeBootstrapReceipt
    {
        [DataMember(Name = "schemaVersion")] public int SchemaVersion = 1;
        [DataMember(Name = "version")] public string Version;
        [DataMember(Name = "archiveSha256")] public string ArchiveSha256;
        [DataMember(Name = "nodeSha256")] public string NodeSha256;
        [DataMember(Name = "nodeBytes")] public long NodeBytes;
        [DataMember(Name = "nodeWriteTicks")] public long NodeWriteTicks;
        [DataMember(Name = "licenseSha256")] public string LicenseSha256;
    }

    [DataContract]
    private sealed class PreparationEvent
    {
        [DataMember(Name = "type")] public string Type;
        [DataMember(Name = "componentId")] public string ComponentId;
        [DataMember(Name = "phase")] public string Phase;
        [DataMember(Name = "bytes")] public long Bytes;
        [DataMember(Name = "totalBytes")] public long TotalBytes;
        [DataMember(Name = "message")] public string Message;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string reportPath = null;
        bool selfTest = false;
        bool cleanupBootstrap = false;
        bool prepareOnly = false;
        string fixtureDecision = null;
        string readyToken = null;
        try
        {
            string readyPath = null;
            string sourceSha = null;
            int waitPid = 0;
            long waitStart = 0;
            int callerPid = 0;
            long callerStart = 0;
            for (int index = 0; index < args.Length; index++)
            {
                if (args[index] == "--self-test") selfTest = true;
                else if (args[index] == "--cleanup-first-run") cleanupBootstrap = true;
                else if (args[index] == "--prepare-runtime") prepareOnly = true;
                else if (args[index] == "--fixture-runtime-decision" && index + 1 < args.Length) fixtureDecision = args[++index];
                else if (args[index] == "--report" && index + 1 < args.Length) reportPath = args[++index];
                else if (args[index] == "--ready-file" && index + 1 < args.Length) readyPath = args[++index];
                else if (args[index] == "--ready-token" && index + 1 < args.Length) readyToken = args[++index];
                else if (args[index] == "--source-sha" && index + 1 < args.Length) sourceSha = args[++index];
                else if (args[index] == "--wait-pid" && index + 1 < args.Length) waitPid = Int32.Parse(args[++index]);
                else if (args[index] == "--wait-start" && index + 1 < args.Length) waitStart = Int64.Parse(args[++index]);
                else if (args[index] == "--caller-pid" && index + 1 < args.Length) callerPid = Int32.Parse(args[++index]);
                else if (args[index] == "--caller-start" && index + 1 < args.Length) callerStart = Int64.Parse(args[++index]);
                else throw new InvalidOperationException("Unknown or incomplete launcher argument.");
            }
            if (cleanupBootstrap)
            {
                if (selfTest || prepareOnly || fixtureDecision != null || reportPath != null || readyPath != null) throw new InvalidOperationException("Invalid cleanup-mode arguments.");
                CleanupFirstRun(readyToken, sourceSha, waitPid, waitStart, callerPid, callerStart);
                return 0;
            }
            if (sourceSha != null || waitPid != 0 || waitStart != 0 || callerPid != 0 || callerStart != 0)
                throw new InvalidOperationException("Cleanup arguments cannot be used for a normal launch.");
            if (selfTest)
            {
                if (prepareOnly || fixtureDecision != null) throw new InvalidOperationException("Offline self-test cannot prepare runtime components.");
                CheckRuntime();
                WriteReport(reportPath, true, "Bundled runtime validation succeeded; no service or browser was started.");
                return 0;
            }
            if (reportPath != null) throw new InvalidOperationException("--report is only supported with --self-test.");
            if (fixtureDecision != null) VerifyPreparationFixture();
            PrepareNodeBootstrap(fixtureDecision);
            PrepareRuntime(fixtureDecision);
            if (prepareOnly) return 0;
            ValidateReadyArguments(readyPath, readyToken);
            return RunService(readyPath, readyToken);
        }
        catch (Exception error)
        {
            if (error is OperationCanceledException) return 2;
            if (cleanupBootstrap)
            {
                try
                {
                    string filename = Path.Combine(DataRoot, "startup-logs", "cleanup-" + Guid.NewGuid().ToString("N") + ".log");
                    File.WriteAllText(filename, error.Message, Utf8);
                }
                catch { }
            }
            else if (selfTest)
            {
                try { WriteReport(reportPath, false, error.Message); } catch { }
            }
            else if (fixtureDecision == null)
            {
                using (RuntimeFailureForm failure = new RuntimeFailureForm(error.Message)) failure.ShowDialog();
            }
            return 1;
        }
    }

    private static string NodePath { get { return Path.Combine(Root, "runtime", "node", "node.exe"); } }
    private static string BrowserRoot { get { return Path.Combine(Root, "runtime", "browsers"); } }
    private static string PreparationScript { get { return Path.Combine(AppRoot, "scripts", "prepare-portable-runtime.mjs"); } }

    private const string PinnedNodeVersion = "24.14.1";
    private const string PinnedNodeArchive = "https://nodejs.org/dist/v24.14.1/node-v24.14.1-win-x64.zip";
    private const string PinnedNodeSha = "6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70";

    private static void RequireRegular(string filename, bool directory)
    {
        FileAttributes attributes = File.GetAttributes(filename);
        if ((attributes & FileAttributes.ReparsePoint) != 0 || ((attributes & FileAttributes.Directory) != 0) != directory)
            throw new InvalidOperationException("组件路径不是普通" + (directory ? "目录" : "文件") + "，已保留原内容：" + filename);
    }

    private static void EnsureOwnedDirectory(string directory)
    {
        string full = Path.GetFullPath(directory);
        if (!String.Equals(full, Root, StringComparison.OrdinalIgnoreCase) && !IsInside(Root, full))
            throw new InvalidOperationException("运行组件目录不在本工具中。");
        if (!String.Equals(full, Root, StringComparison.OrdinalIgnoreCase)) EnsureOwnedDirectory(Path.GetDirectoryName(full));
        if (!Directory.Exists(full)) Directory.CreateDirectory(full);
        RequireRegular(full, true);
    }

    private static NodeBootstrapSpec ReadNodeBootstrapSpec()
    {
        string descriptor = Path.Combine(Root, "components", "bootstrap-node.json");
        if (!File.Exists(descriptor) && !Directory.Exists(descriptor)) return null; // Standard packages keep their bundled Node.
        RequireRegular(Root, true); RequireRegular(Path.GetDirectoryName(descriptor), true); RequireRegular(descriptor, false);
        if (new FileInfo(descriptor).Length > 8192) throw new InvalidOperationException("Node 组件清单过大。");
        NodeBootstrapSpec spec = ReadControl<NodeBootstrapSpec>(descriptor);
        if (spec == null || spec.SchemaVersion != 1 || spec.Id != "node" || spec.Version != PinnedNodeVersion ||
            spec.Platform != "win32-x64" || spec.ArchiveUrl != PinnedNodeArchive ||
            !String.Equals(spec.ArchiveSha256, PinnedNodeSha, StringComparison.OrdinalIgnoreCase) ||
            spec.ArchiveBytes <= 0 || spec.ArchiveBytes > 128L * 1024 * 1024 ||
            spec.MaxArchiveBytes < spec.ArchiveBytes || spec.MaxArchiveBytes > 128L * 1024 * 1024)
            throw new InvalidOperationException("Node 组件清单不是本工具允许的固定官方版本；未开始下载。");
        return spec;
    }

    private static bool NodeBootstrapReady(NodeBootstrapSpec spec)
    {
        string runtime = Path.Combine(Root, "runtime"), target = Path.Combine(runtime, "node");
        RequireRegular(Root, true);
        if (Directory.Exists(runtime) || File.Exists(runtime)) RequireRegular(runtime, true);
        if (!Directory.Exists(target) && !File.Exists(target)) return false;
        RequireRegular(target, true);
        RequireRegular(NodePath, false);
        string license = Path.Combine(target, "LICENSE"), receiptFile = Path.Combine(target, ".collector-node-ready.json");
        RequireRegular(license, false); RequireRegular(receiptFile, false);
        if (new FileInfo(license).Length <= 0 || new FileInfo(license).Length > 2L * 1024 * 1024)
            throw new InvalidOperationException("Node LICENSE 文件大小无效。");
        if (new FileInfo(receiptFile).Length > 8192) throw new InvalidOperationException("Node 本地完成记录无效。");
        NodeBootstrapReceipt receipt = ReadControl<NodeBootstrapReceipt>(receiptFile);
        FileInfo node = new FileInfo(NodePath);
        if (receipt == null || receipt.SchemaVersion != 1 || receipt.Version != spec.Version ||
            !String.Equals(receipt.ArchiveSha256, spec.ArchiveSha256, StringComparison.OrdinalIgnoreCase) ||
            !Regex.IsMatch(receipt.NodeSha256 ?? "", "\\A[A-F0-9]{64}\\z") ||
            node.Length != receipt.NodeBytes || node.LastWriteTimeUtc.Ticks != receipt.NodeWriteTicks ||
            FileSha256(license) != receipt.LicenseSha256)
            throw new InvalidOperationException("已有 Node 目录不是完整的本工具安装记录，或文件已被修改。请先将 runtime\\node 改名备份后重试；不会自动覆盖。");
        return true; // No network and no large executable hashing on ordinary startup.
    }

    private static void PrepareNodeBootstrap(string fixtureDecision)
    {
        NodeBootstrapSpec spec = ReadNodeBootstrapSpec();
        if (spec == null || NodeBootstrapReady(spec)) return;
        string lockFile = Path.Combine(Root, "runtime", ".collector-node-install.lock.json");
        if (File.Exists(lockFile) || Directory.Exists(lockFile))
            throw new InvalidOperationException("已有 Node 准备记录，请等待其他准备窗口结束。若确认已无准备窗口，请将此记录改名备份后重试：" + lockFile);
        if (fixtureDecision == "reject") throw new OperationCanceledException("用户选择暂不下载 Node。");
        if (fixtureDecision != null) throw new InvalidOperationException("离线测试的自动确认不能批准 Node 联网下载。");
        PreparationStatus status = new PreparationStatus { SchemaVersion = 1, RequiresDownload = true, NodeBootstrap = true,
            TotalDownloadBytes = spec.ArchiveBytes, Components = new List<ComponentStatus> {
                new ComponentStatus { Id = "node", DisplayName = "独立 Node.js 运行引擎", DownloadBytes = spec.ArchiveBytes, State = "missing", LicenseSummary = "Node.js：MIT 及附属组件许可；完整 LICENSE 随组件保留。" }
            } };
        using (RuntimeConsentForm consent = new RuntimeConsentForm(status))
            if (consent.ShowDialog() != DialogResult.OK) throw new OperationCanceledException("用户取消 Node 下载。");
        using (RuntimeProgressForm progress = new RuntimeProgressForm(status))
        {
            progress.PreparationAction = (form) => InstallNodeBootstrap(spec, form);
            progress.ShowDialog();
            if (progress.Cancelled) throw new OperationCanceledException("Node 下载已取消，编译材料和已完成组件保留。");
            if (progress.Failure != null) throw new InvalidOperationException(progress.Failure);
        }
        if (!NodeBootstrapReady(spec)) throw new InvalidOperationException("Node 组件尚未完成，未启动采集服务。");
    }

    private static void ThrowIfNodeCancelled(Func<bool> cancelled)
    {
        if (cancelled != null && cancelled()) throw new OperationCanceledException("Node 下载已取消。");
    }

    private static void CopyVerifiedNodeArchive(Stream source, string filename, NodeBootstrapSpec spec, Action<long> progress, Func<bool> cancelled)
    {
        long total = 0;
        byte[] buffer = new byte[65536];
        using (SHA256 hash = SHA256.Create())
        using (FileStream output = new FileStream(filename, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            int read;
            while (true)
            {
                ThrowIfNodeCancelled(cancelled);
                read = source.Read(buffer, 0, buffer.Length);
                if (read == 0) break;
                total += read;
                if (total > spec.MaxArchiveBytes || total > spec.ArchiveBytes) throw new InvalidOperationException("Node 下载超出固定大小限制。");
                output.Write(buffer, 0, read); hash.TransformBlock(buffer, 0, read, null, 0);
                if (progress != null) progress(total);
            }
            ThrowIfNodeCancelled(cancelled); hash.TransformFinalBlock(new byte[0], 0, 0); output.Flush(true);
            if (total != spec.ArchiveBytes || !String.Equals(BitConverter.ToString(hash.Hash).Replace("-", ""), spec.ArchiveSha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Node 下载大小或 SHA-256 不符，未解压或运行下载内容。");
        }
    }

    private static void ExtractNodeArchive(string archiveFile, string payload, NodeBootstrapSpec spec, Func<bool> cancelled)
    {
        RequireRegular(archiveFile, false); RequireRegular(payload, true);
        string prefix = "node-v" + spec.Version + "-win-x64/";
        int files = 0, nodes = 0, licenses = 0;
        long expanded = 0;
        using (FileStream stream = File.OpenRead(archiveFile))
        using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
        {
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                ThrowIfNodeCancelled(cancelled);
                string name = entry.FullName;
                if (++files > 20000 || !name.StartsWith(prefix, StringComparison.Ordinal) || name.IndexOf('\\') >= 0 ||
                    name.IndexOf(':') >= 0 || name.IndexOf('\0') >= 0 || ((entry.ExternalAttributes >> 16) & 0xf000) == 0xa000 ||
                    (entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) != 0)
                    throw new InvalidOperationException("Node 压缩包包含不允许的路径或链接。");
                string trimmed = name.TrimEnd('/');
                foreach (string part in trimmed.Split('/'))
                    if (part.Length == 0 || part == "." || part == "..") throw new InvalidOperationException("Node 压缩包路径无效。");
                expanded += entry.Length;
                if (expanded > 700L * 1024 * 1024) throw new InvalidOperationException("Node 压缩包解压总量超出限制。");
                bool isNode = name == prefix + "node.exe", isLicense = name == prefix + "LICENSE";
                if (!isNode && !isLicense) continue; // npm, headers and other ZIP files are never installed.
                if ((isNode && ++nodes != 1) || (isLicense && ++licenses != 1) || entry.Length <= 0 ||
                    entry.Length > (isNode ? 150L * 1024 * 1024 : 2L * 1024 * 1024))
                    throw new InvalidOperationException("Node 压缩包必要文件重复或大小无效。");
                string destination = Path.Combine(payload, isNode ? "node.exe" : "LICENSE");
                using (Stream input = entry.Open())
                using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    byte[] buffer = new byte[65536]; int read; long written = 0;
                    while ((read = input.Read(buffer, 0, buffer.Length)) != 0)
                    {
                        ThrowIfNodeCancelled(cancelled); written += read;
                        if (written > entry.Length) throw new InvalidOperationException("Node 解压内容超过记录大小。");
                        output.Write(buffer, 0, read);
                    }
                    if (written != entry.Length) throw new InvalidOperationException("Node 解压内容不完整。");
                    output.Flush(true);
                }
            }
        }
        if (nodes != 1 || licenses != 1) throw new InvalidOperationException("Node 压缩包缺少 node.exe 或 LICENSE。");
    }

    private static void ValidateExtractedNode(string executable, string version)
    {
        RequireRegular(executable, false);
        using (FileStream input = File.OpenRead(executable))
        using (BinaryReader binary = new BinaryReader(input))
        {
            if (input.Length < 256 || binary.ReadUInt16() != 0x5a4d) throw new InvalidOperationException("Node 可执行文件不是有效 PE。");
            input.Position = 0x3c; uint pe = binary.ReadUInt32();
            if (pe > input.Length - 26) throw new InvalidOperationException("Node PE 头无效。");
            input.Position = pe;
            if (binary.ReadUInt32() != 0x00004550 || binary.ReadUInt16() != 0x8664) throw new InvalidOperationException("Node 可执行文件不是 Windows x64。");
        }
        using (Process process = new Process())
        {
            process.StartInfo = new ProcessStartInfo(executable, "--version") { UseShellExecute = false, CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true };
            // NODE_OPTIONS could preload a machine-specific script even for --version.
            process.StartInfo.EnvironmentVariables.Remove("NODE_OPTIONS");
            process.StartInfo.EnvironmentVariables.Remove("NODE_PATH");
            if (!process.Start()) throw new InvalidOperationException("无法验证独立 Node。");
            Task<string> output = process.StandardOutput.ReadToEndAsync(), error = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(15000)) { process.Kill(); process.WaitForExit(); throw new TimeoutException("Node 版本验证超时。"); }
            Task.WaitAll(output, error);
            if (process.ExitCode != 0 || output.Result.Trim() != "v" + version) throw new InvalidOperationException("Node 版本验证不符，未安装组件。");
        }
    }

    private static void CommitVerifiedNodeArchive(string archiveFile, string payload, NodeBootstrapSpec spec, Func<bool> cancelled)
    {
        string runtime = Path.Combine(Root, "runtime"), stage = Path.GetDirectoryName(payload);
        RequireRegular(Root, true); RequireRegular(runtime, true); RequireRegular(stage, true); RequireRegular(payload, true); RequireRegular(archiveFile, false);
        if (!String.Equals(Path.GetDirectoryName(stage), runtime, StringComparison.OrdinalIgnoreCase) ||
            !Regex.IsMatch(Path.GetFileName(stage), "\\A\\.collector-node-stage-[a-f0-9]{32}\\z") ||
            !String.Equals(Path.GetFileName(payload), "payload", StringComparison.Ordinal) ||
            !String.Equals(Path.GetDirectoryName(archiveFile), stage, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Node 暂存路径不在本次独立准备目录内。");
        string target = Path.Combine(runtime, "node");
        if (Directory.Exists(target) || File.Exists(target)) throw new InvalidOperationException("runtime\\node 已存在；不会覆盖未知或已有组件。");
        ThrowIfNodeCancelled(cancelled);
        if (new FileInfo(archiveFile).Length != spec.ArchiveBytes ||
            !String.Equals(FileSha256(archiveFile), spec.ArchiveSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Node 压缩包大小或 SHA-256 不符，未解压或运行下载内容。");
        ExtractNodeArchive(archiveFile, payload, spec, cancelled);
        string executable = Path.Combine(payload, "node.exe");
        ValidateExtractedNode(executable, spec.Version); ThrowIfNodeCancelled(cancelled);
        NodeBootstrapReceipt receipt = new NodeBootstrapReceipt { Version = spec.Version, ArchiveSha256 = spec.ArchiveSha256,
            NodeSha256 = FileSha256(executable), NodeBytes = new FileInfo(executable).Length,
            NodeWriteTicks = File.GetLastWriteTimeUtc(executable).Ticks, LicenseSha256 = FileSha256(Path.Combine(payload, "LICENSE")) };
        using (FileStream record = new FileStream(Path.Combine(payload, ".collector-node-ready.json"), FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            new DataContractJsonSerializer(typeof(NodeBootstrapReceipt)).WriteObject(record, receipt); record.Flush(true);
        }
        RequireRegular(runtime, true); RequireRegular(stage, true); RequireRegular(payload, true); ThrowIfNodeCancelled(cancelled);
        Directory.Move(payload, target); // Atomic, and an existing directory is never replaced.
    }

    private static void RemoveNodeStage(string stage)
    {
        RequireRegular(stage, true);
        foreach (string filename in Directory.GetFiles(stage)) { RequireRegular(filename, false); File.Delete(filename); }
        foreach (string directory in Directory.GetDirectories(stage)) RemoveNodeStage(directory);
        Directory.Delete(stage, false); // Never recurse through an unchecked reparse point.
    }

    private static void InstallNodeBootstrap(NodeBootstrapSpec spec, RuntimeProgressForm form)
    {
        string runtime = Path.Combine(Root, "runtime"), logs = Path.Combine(DataRoot, "startup-logs");
        EnsureOwnedDirectory(runtime); EnsureOwnedDirectory(logs);
        string lockFile = Path.Combine(runtime, ".collector-node-install.lock.json"), stage = Path.Combine(runtime, ".collector-node-stage-" + Guid.NewGuid().ToString("N"));
        string log = Path.Combine(logs, "node-prepare-" + Guid.NewGuid().ToString("N") + ".log");
        Func<bool> cancelled = () => form != null && form.CancellationRequested;
        bool ownsLock = false;
        string ownerSha = null;
        try
        {
        using (FileStream lease = new FileStream(lockFile, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read))
        {
            ownsLock = true;
            byte[] owner = Utf8.GetBytes("{\"pid\":" + Process.GetCurrentProcess().Id + ",\"stage\":\"" + Path.GetFileName(stage) + "\"}");
            using (SHA256 ownerHash = SHA256.Create()) ownerSha = BitConverter.ToString(ownerHash.ComputeHash(owner)).Replace("-", "");
            lease.Write(owner, 0, owner.Length); lease.Flush(true);
            Directory.CreateDirectory(stage); RequireRegular(stage, true);
            try
            {
                string archive = Path.Combine(stage, "archive.zip"), payload = Path.Combine(stage, "payload");
                Directory.CreateDirectory(payload);
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(spec.ArchiveUrl);
                request.AllowAutoRedirect = false; request.Timeout = 30000; request.ReadWriteTimeout = 10000;
                request.UserAgent = "MediaTracker-Portable-NodeBootstrap/1";
                if (form != null) form.CancellationAction = () => { try { request.Abort(); } catch { } };
                ThrowIfNodeCancelled(cancelled);
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if (response.StatusCode != HttpStatusCode.OK || response.ResponseUri.AbsoluteUri != spec.ArchiveUrl ||
                        (response.ContentLength >= 0 && response.ContentLength != spec.ArchiveBytes))
                        throw new InvalidOperationException("Node 官方下载响应或固定大小不符；不接受地址跳转。");
                    using (Stream input = response.GetResponseStream())
                        CopyVerifiedNodeArchive(input, archive, spec, (bytes) => { if (form != null) form.Report(new PreparationEvent { ComponentId = "node", Phase = "download", Bytes = bytes, TotalBytes = spec.ArchiveBytes }); }, cancelled);
                }
                if (form != null) form.Report(new PreparationEvent { ComponentId = "node", Phase = "validate", Bytes = 0, TotalBytes = 0 });
                CommitVerifiedNodeArchive(archive, payload, spec, cancelled);
                File.WriteAllText(log, "Fixed official Node archive verified and installed locally. No system settings changed.", Utf8);
            }
            catch (Exception error)
            {
                try { File.WriteAllText(log, error.Message, Utf8); } catch { }
                if (cancelled()) throw new OperationCanceledException("Node 下载已取消。");
                throw new InvalidOperationException(error.Message + "\r\n日志：" + log, error);
            }
            finally
            {
                if (form != null) form.CancellationAction = null;
                try { if (Directory.Exists(stage)) RemoveNodeStage(stage); } catch { }
            }
        }
        }
        finally
        {
            if (ownsLock) try { RequireRegular(lockFile, false); if (FileSha256(lockFile) == ownerSha) File.Delete(lockFile); } catch { }
        }
    }

    private static T ParseJson<T>(string value)
    {
        using (MemoryStream stream = new MemoryStream(Utf8.GetBytes(value)))
            return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(stream);
    }

    private static PreparationStatus RuntimeStatus()
    {
        if (!File.Exists(Path.Combine(Root, "components", "runtime-manifest.json")))
            return null; // The complete offline package has no deferred components.
        RequireFile(PreparationScript); // A slim manifest cannot silently fall back.
        using (Process process = new Process())
        {
            process.StartInfo = NodeInfo(Quote(PreparationScript) + " --status --json");
            if (!process.Start()) throw new InvalidOperationException("无法检查本工具运行组件。");
            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> errors = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(15000))
            {
                process.Kill(); process.WaitForExit();
                throw new TimeoutException("运行组件检查超时；未开始下载或启动服务。");
            }
            Task.WaitAll(output, errors);
            if (process.ExitCode != 0)
            {
                string reason = errors.Result.Trim();
                try { reason = ParseJson<PreparationEvent>(output.Result.Trim()).Message ?? reason; } catch { }
                throw new InvalidOperationException("运行组件检查失败：" + reason);
            }
            PreparationStatus status = ParseJson<PreparationStatus>(output.Result.Trim());
            if (status == null || status.SchemaVersion != 1 || status.Components == null)
                throw new InvalidOperationException("运行组件检查没有返回有效状态。");
            return status;
        }
    }

    private static string ComponentProblems(PreparationStatus status)
    {
        StringBuilder text = new StringBuilder();
        if (!String.IsNullOrEmpty(status.Message)) text.AppendLine(status.Message);
        foreach (ComponentStatus item in status.Components)
            if (!item.Ready) text.AppendLine((item.DisplayName ?? item.Name ?? item.Id) + "：" + (item.Message ?? item.State));
        return text.ToString().Trim();
    }

    private static void PrepareRuntime(string fixtureDecision)
    {
        PreparationStatus status = RuntimeStatus();
        if (status == null || status.Ready) return;
        if (status.Blocked || !status.RequiresDownload || status.Components.Exists((item) => item.State == "invalid"))
            throw new InvalidOperationException("现有运行组件需要检查；不会覆盖或清空已有目录。\r\n" + ComponentProblems(status));
        if (fixtureDecision == "reject") throw new OperationCanceledException("用户选择暂不下载运行组件。");
        if (fixtureDecision == null)
        {
            using (RuntimeConsentForm consent = new RuntimeConsentForm(status))
                if (consent.ShowDialog() != DialogResult.OK) throw new OperationCanceledException("用户取消下载运行组件。");
            using (RuntimeProgressForm progress = new RuntimeProgressForm(status))
            {
                progress.ShowDialog();
                if (progress.Cancelled) throw new OperationCanceledException("运行组件下载已取消，已完成的组件保留。");
                if (progress.Failure != null) throw new InvalidOperationException(progress.Failure);
            }
        }
        else
        {
            if (fixtureDecision != "accept" && fixtureDecision != "cancel") throw new InvalidOperationException("Invalid fixture decision.");
            RunRuntimeInstallation(null, fixtureDecision == "cancel");
        }
        PreparationStatus verified = RuntimeStatus();
        if (verified == null || !verified.Ready) throw new InvalidOperationException("下载后运行组件仍未准备完成；未启动服务。\r\n" + (verified == null ? "准备器不存在。" : ComponentProblems(verified)));
    }

    // Automated consent is deliberately limited to the exact offline fixture
    // script under an isolated temporary collector directory. Real packages
    // cannot approve downloads by setting an environment variable or URL.
    private static void VerifyPreparationFixture()
    {
        string temporary = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!Root.StartsWith(temporary, StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(Root).StartsWith("collector", StringComparison.Ordinal) ||
            !File.Exists(PreparationScript) || FileSha256(PreparationScript) != "AA84270B5AED2555AD6098351BF66BA02854ADBA026F7D6D1EBEFE381017591C")
            throw new InvalidOperationException("Runtime fixture consent cannot be used for a real package.");
    }

    private static void RunRuntimeInstallation(RuntimeProgressForm form, bool fixtureCancel)
    {
        string logs = Path.Combine(DataRoot, "startup-logs");
        Directory.CreateDirectory(logs);
        string log = Path.Combine(logs, "runtime-prepare-" + Guid.NewGuid().ToString("N") + ".log");
        using (StreamWriter transcript = new StreamWriter(log, false, Utf8))
        using (Process process = new Process())
        {
            process.StartInfo = NodeInfo(Quote(PreparationScript) + " --install --confirmed --cancel-on-eof");
            process.StartInfo.RedirectStandardInput = true;
            if (!process.Start()) throw new InvalidOperationException("无法启动运行组件下载。日志：" + log);
            Task<string> errors = process.StandardError.ReadToEndAsync();
            if (form != null) form.AttachProcess(process);
            if (fixtureCancel) { process.StandardInput.WriteLine("cancel"); process.StandardInput.Flush(); }
            try
            {
                string failure = null;
                string line;
                while ((line = process.StandardOutput.ReadLine()) != null)
                {
                    transcript.WriteLine(line); transcript.Flush();
                    PreparationEvent update = ParseJson<PreparationEvent>(line);
                    if (update.Type == "error") failure = update.Message;
                    if (form != null) form.Report(update);
                }
                process.WaitForExit();
                string errorText = errors.GetAwaiter().GetResult();
                transcript.Write(errorText);
                if (process.ExitCode == 2 || fixtureCancel || (form != null && form.CancellationRequested))
                    throw new OperationCanceledException("运行组件下载已取消。");
                if (process.ExitCode != 0) throw new InvalidOperationException((failure ?? errorText.Trim() ?? "运行组件下载失败。") + "\r\n日志：" + log);
            }
            catch
            {
                // A malformed progress line or local I/O error must not leave
                // an installer running after the progress window has closed.
                try
                {
                    if (!process.HasExited)
                    {
                        process.StandardInput.WriteLine("cancel"); process.StandardInput.Flush();
                        if (!process.WaitForExit(15000)) { process.Kill(); process.WaitForExit(); }
                    }
                }
                catch { try { if (!process.HasExited) process.Kill(); } catch { } }
                throw;
            }
        }
    }

    private static bool SystemDarkTheme()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", false))
                return key != null && Convert.ToInt32(key.GetValue("AppsUseLightTheme", 1)) == 0;
        }
        catch { return false; }
    }

    private class RuntimeForm : Form
    {
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
        private readonly bool darkTheme;
        protected readonly Color Muted;
        protected readonly Color Accent = Color.FromArgb(43, 87, 205);
        protected RuntimeForm(bool? previewTheme = null)
        {
            bool dark = previewTheme ?? SystemDarkTheme();
            darkTheme = dark;
            BackColor = dark ? Color.FromArgb(19, 29, 46) : Color.FromArgb(246, 248, 253);
            ForeColor = dark ? Color.FromArgb(239, 244, 252) : Color.FromArgb(27, 39, 62);
            Muted = dark ? Color.FromArgb(165, 177, 198) : Color.FromArgb(98, 113, 138);
            Font = new Font("Segoe UI", 10F);
            Text = "采集工具 · 运行组件";
            ClientSize = new Size(600, 390);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            AutoScaleMode = AutoScaleMode.Dpi;
            // A missing optional/runtime component is an actionable choice,
            // not a busy state. Keep consent, failure and cancellation controls
            // on the normal pointer even while a progress bar is displayed.
            UseWaitCursor = false;
            Cursor = Cursors.Default;
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
        }
        protected override void OnHandleCreated(EventArgs args)
        {
            base.OnHandleCreated(args);
            try
            {
                int dark = darkTheme ? 1 : 0;
                if (DwmSetWindowAttribute(Handle, 20, ref dark, 4) != 0) DwmSetWindowAttribute(Handle, 19, ref dark, 4);
            }
            catch { }
        }
        protected Label TextLabel(string value, int x, int y, int width, int height, bool heading)
        {
            Label label = new Label { Text = value, Location = new Point(x, y), Size = new Size(width, height),
                ForeColor = heading ? ForeColor : Muted, Font = new Font(heading ? "Microsoft YaHei UI" : "Segoe UI", heading ? 17F : 10F, heading ? FontStyle.Bold : FontStyle.Regular) };
            Controls.Add(label); return label;
        }
        protected Button ActionButton(string value, int x, int y, bool primary)
        {
            Button button = new Button { Text = value, Location = new Point(x, y), Size = new Size(145, 42), FlatStyle = FlatStyle.Flat,
                BackColor = primary ? Accent : BackColor, ForeColor = primary ? Color.White : ForeColor,
                UseWaitCursor = false, Cursor = Cursors.Default };
            button.FlatAppearance.BorderColor = primary ? Accent : Muted;
            Controls.Add(button); return button;
        }
    }

    private sealed class RuntimeConsentForm : RuntimeForm
    {
        public RuntimeConsentForm(PreparationStatus status, bool? previewTheme = null) : base(previewTheme)
        {
            TextLabel(status.NodeBootstrap ? "先准备独立运行引擎" : "准备本工具的独立运行环境", 28, 26, 544, 44, true);
            StringBuilder components = new StringBuilder();
            StringBuilder licenses = new StringBuilder();
            foreach (ComponentStatus item in status.Components)
                if (!item.Ready) {
                    components.AppendLine("• " + (item.DisplayName ?? item.Name ?? item.Id) + "    " + BytesLabel(item.DownloadBytes));
                    if (!String.IsNullOrEmpty(item.LicenseSummary)) licenses.AppendLine(item.LicenseSummary);
                }
            TextLabel("需要下载的组件\r\n" + components.ToString().TrimEnd(), 30, 86, 540, 88, false);
            ClientSize = new Size(600, 475);
            TextLabel("保存位置：" + Path.Combine(Root, "runtime") + "\r\n\r\n只保存在工具文件夹，不安装系统程序、不修改注册表、不使用你的日常浏览器。组件完整后，启动不再联网检查。" +
                (status.NodeBootstrap ? "\r\n随后会再询问浏览器与采集引擎的下载。" : ""), 30, 176, 540, 108, false);
            TextBox licenseText = new TextBox { Text = licenses.ToString().TrimEnd() + "\r\n来源、版本与完整校验值见 components；许可说明见 THIRD-PARTY-NOTICES.txt。确认仅授权本次组件下载，不代替平台采集授权。",
                Location = new Point(30, 292), Size = new Size(540, 102), Multiline = true, ReadOnly = true,
                ScrollBars = ScrollBars.Vertical, BackColor = BackColor, ForeColor = Muted, UseWaitCursor = false, Cursor = Cursors.Default };
            Controls.Add(licenseText);
            Button reject = ActionButton("暂不下载", 266, 411, false);
            Button accept = ActionButton("下载并继续", 426, 411, true);
            reject.DialogResult = DialogResult.Cancel; accept.DialogResult = DialogResult.OK;
            CancelButton = reject;
            AcceptButton = reject; // Enter cannot silently approve a download.
        }
    }

    private static string BytesLabel(long bytes)
    {
        return bytes >= 0 ? (bytes / 1000000D).ToString("0.0") + " MB" : "大小由固定组件清单提供";
    }

    private sealed class RuntimeFailureForm : RuntimeForm
    {
        public RuntimeFailureForm(string message)
        {
            TextLabel("采集工具未能启动", 28, 26, 544, 44, true);
            TextBox details = new TextBox { Text = message, Location = new Point(30, 92), Size = new Size(540, 204),
                Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BackColor = BackColor, ForeColor = ForeColor };
            Controls.Add(details);
            Button close = ActionButton("关闭", 426, 322, true);
            close.DialogResult = DialogResult.OK; AcceptButton = close; CancelButton = close;
        }
    }

    private sealed class RuntimeProgressForm : RuntimeForm
    {
        private readonly Label phase;
        private readonly Label detail;
        private readonly ProgressBar progress;
        private readonly Button cancel;
        private readonly Timer cancellationTimer;
        private Process child;
        private bool completed;
        private DateTime cancellationDeadline;
        public bool CancellationRequested { get; private set; }
        public bool Cancelled { get; private set; }
        public string Failure { get; private set; }
        public Action<RuntimeProgressForm> PreparationAction;
        public Action CancellationAction;

        public RuntimeProgressForm(PreparationStatus status, bool? previewTheme = null) : base(previewTheme)
        {
            PreparationAction = (form) => RunRuntimeInstallation(form, false);
            TextLabel("正在准备运行组件", 28, 26, 544, 44, true);
            phase = TextLabel("连接固定组件下载地址…", 30, 92, 540, 42, false);
            progress = new ProgressBar { Location = new Point(30, 150), Size = new Size(540, 16), Style = ProgressBarStyle.Marquee };
            Controls.Add(progress);
            detail = TextLabel("下载、校验并保存到本工具目录。已有账号和媒体不会被删除。", 30, 196, 540, 96, false);
            cancel = ActionButton("取消下载", 426, 322, false);
            cancel.Click += (sender, args) => RequestCancellation();
            CancelButton = cancel;
            cancellationTimer = new Timer { Interval = 250 };
            cancellationTimer.Tick += (sender, args) => {
                if (CancellationRequested && DateTime.UtcNow > cancellationDeadline && child != null)
                    try { if (!child.HasExited) child.Kill(); } catch { }
            };
            Shown += (sender, args) => {
                Task.Run(() => PreparationAction(this)).ContinueWith((task) => {
                    BeginInvoke(new Action(() => {
                        completed = true; cancellationTimer.Stop();
                        Cancelled = task.IsCanceled || CancellationRequested;
                        if (task.IsFaulted)
                        {
                            Exception error = task.Exception.GetBaseException();
                            Cancelled = error is OperationCanceledException || CancellationRequested;
                            if (!Cancelled) Failure = error.Message;
                        }
                        Close();
                    }));
                });
            };
            FormClosing += (sender, args) => { if (!completed) { args.Cancel = true; RequestCancellation(); } };
            FormClosed += (sender, args) => cancellationTimer.Dispose();
        }
        public void AttachProcess(Process process)
        {
            Invoke(new Action(() => { child = process; if (CancellationRequested) SendCancellation(); }));
        }
        private void SendCancellation()
        {
            try { if (child != null && !child.HasExited) { child.StandardInput.WriteLine("cancel"); child.StandardInput.Flush(); } } catch { }
        }
        private void RequestCancellation()
        {
            if (completed || CancellationRequested) return;
            CancellationRequested = true;
            cancel.Enabled = false;
            phase.Text = "正在取消并清理本次临时文件…";
            progress.Style = ProgressBarStyle.Marquee;
            cancellationDeadline = DateTime.UtcNow.AddSeconds(15);
            cancellationTimer.Start(); SendCancellation();
            if (CancellationAction != null) CancellationAction();
        }
        public void Report(PreparationEvent update)
        {
            BeginInvoke(new Action(() => {
                if (CancellationRequested || completed) return;
                string name = update.ComponentId == "chromium" ? "内置浏览器" : update.ComponentId == "python" ? "通用采集引擎" : update.ComponentId == "node" ? "独立 Node.js 引擎" : "运行组件";
                string action = update.Phase == "download" ? "下载" : update.Phase == "extract" || update.Phase == "extracted" ? "解压" :
                    update.Phase == "verify" || update.Phase == "verified" || update.Phase == "validate" ? "校验" :
                    update.Phase == "commit" || update.Phase == "ready" ? "保存" : "准备";
                phase.Text = "正在" + action + " · " + name;
                if (update.TotalBytes > 0 && update.Bytes >= 0)
                {
                    progress.Style = ProgressBarStyle.Continuous;
                    progress.Value = (int)Math.Max(0, Math.Min(100, 100D * update.Bytes / update.TotalBytes));
                    detail.Text = BytesLabel(update.Bytes) + " / " + BytesLabel(update.TotalBytes) + "\r\n保存位置：" + Path.Combine(Root, "runtime");
                }
                else progress.Style = ProgressBarStyle.Marquee;
            }));
        }
    }

    private static string FileSha256(string filename)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream stream = File.OpenRead(filename))
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
    }

    private static T ReadControl<T>(string filename)
    {
        if ((File.GetAttributes(filename) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
            throw new InvalidOperationException("A bootstrap control file is not a regular file.");
        using (FileStream stream = File.OpenRead(filename))
            return (T)new DataContractJsonSerializer(typeof(T), new DataContractJsonSerializerSettings
                { UseSimpleDictionaryFormat = true }).ReadObject(stream);
    }

    private static void WaitForExactProcess(int pid, long creationTicks, bool requireCmd, DateTime deadline)
    {
        if (pid <= 0 || creationTicks <= 0) throw new InvalidOperationException("Invalid bootstrap process identity.");
        Process process;
        try { process = Process.GetProcessById(pid); }
        catch (ArgumentException) { return; } // This exact caller has already exited.
        using (process)
        {
            if (process.StartTime.ToUniversalTime().Ticks != creationTicks ||
                (requireCmd && !String.Equals(process.ProcessName, "cmd", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("The bootstrap caller process identity changed; its files were preserved.");
            int remaining = (int)Math.Max(0, Math.Min(60000, (deadline - DateTime.UtcNow).TotalMilliseconds));
            if (!process.WaitForExit(remaining))
                throw new TimeoutException("The compiler caller is still running; its first-run entry was preserved.");
        }
    }

    private static void CleanupFirstRun(string token, string sourceSha, int waitPid, long waitStart, int callerPid, long callerStart)
    {
        if (!Regex.IsMatch(token ?? "", "\\A[a-f0-9]{32}\\z") || !Regex.IsMatch(sourceSha ?? "", "\\A[A-F0-9]{64}\\z"))
            throw new InvalidOperationException("Invalid bootstrap cleanup controls.");
        string logs = Path.Combine(DataRoot, "startup-logs");
        foreach (string directory in new string[] { Root, DataRoot, logs })
            if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("The bootstrap cleanup directory is a link.");
        string first = Path.Combine(Root, "\u9996\u6b21\u7f16\u8bd1.cmd");
        string receiptPath = Path.Combine(logs, "local-compile-state.json");
        string readyPath = Path.Combine(logs, ".ready-" + token + ".json");
        ReadyReceipt ready = ReadControl<ReadyReceipt>(readyPath);
        CompileReceipt receipt = ReadControl<CompileReceipt>(receiptPath);
        string readySha = FileSha256(readyPath);
        string receiptSha = FileSha256(receiptPath);
        string recorded;
        if (ready.SchemaVersion != 1 || !ready.Ready || ready.Token != token ||
            receipt.SchemaVersion != 1 || receipt.Filename != Path.GetFileName(Assembly.GetExecutingAssembly().Location) ||
            receipt.Sha256 != FileSha256(Assembly.GetExecutingAssembly().Location) || receipt.Sources == null ||
            !receipt.Sources.TryGetValue(Path.GetFileName(first), out recorded) || recorded != sourceSha)
            throw new InvalidOperationException("The bootstrap cleanup receipts do not match this completed build.");
        DateTime deadline = DateTime.UtcNow.AddSeconds(60);
        WaitForExactProcess(waitPid, waitStart, false, deadline);
        if (callerPid != 0 || callerStart != 0) WaitForExactProcess(callerPid, callerStart, true, deadline);
        // No source-script self-deletion while CMD can still read that batch.
        // Only this fixed, unchanged first-run entry is deleted after callers exit.
        if ((File.GetAttributes(first) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 || FileSha256(first) != sourceSha)
            throw new InvalidOperationException("The first-run entry changed; it was preserved.");
        if ((File.GetAttributes(readyPath) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 ||
            (File.GetAttributes(receiptPath) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 ||
            FileSha256(readyPath) != readySha || FileSha256(receiptPath) != receiptSha)
            throw new InvalidOperationException("The bootstrap cleanup controls changed; they were preserved.");
        File.Delete(first);
        File.Delete(readyPath);
        File.Delete(receiptPath);
    }

    private static void RequireFile(string filename)
    {
        if (!File.Exists(filename)) throw new FileNotFoundException("A bundled component is missing: " + filename);
    }

    private static ProcessStartInfo NodeInfo(string arguments)
    {
        RequireFile(NodePath);
        ProcessStartInfo info = new ProcessStartInfo(NodePath, arguments);
        info.WorkingDirectory = AppRoot;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WindowStyle = ProcessWindowStyle.Hidden;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = Utf8;
        info.StandardErrorEncoding = Utf8;
        // Each public package owns its own state and browser profiles. Do not
        // inherit private/developer profile, executable or service overrides.
        foreach (string key in new string[] { "MEDIA_TRACKER_DATA_DIR", "MEDIA_TRACKER_PORTABLE_ROOT", "MEDIA_TRACKER_PORT",
            "MEDIA_TRACKER_PROFILE_DIR", "MEDIA_TRACKER_BROWSER_PROFILE", "CHROME_USER_DATA_DIR",
            "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "CHROME_PATH", "CHROMIUM_PATH", "NODE_OPTIONS", "NODE_PATH" })
            info.EnvironmentVariables.Remove(key);
        info.EnvironmentVariables["MEDIA_TRACKER_DATA_DIR"] = DataRoot;
        info.EnvironmentVariables["MEDIA_TRACKER_PORTABLE_ROOT"] = Root;
        info.EnvironmentVariables["PLAYWRIGHT_BROWSERS_PATH"] = BrowserRoot;
        info.EnvironmentVariables["MEDIA_TRACKER_BACKGROUND_START"] = "1";
        info.EnvironmentVariables["MEDIA_TRACKER_SYSTEM_UI_LANGUAGE"] = System.Globalization.CultureInfo.CurrentUICulture.Name;
        info.EnvironmentVariables["MEDIA_TRACKER_LAUNCH_STARTED_AT_MS"] =
            ((long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds).ToString();
        // Never inherit developer-specific executable locations from this machine.
        info.EnvironmentVariables.Remove("MEDIA_TRACKER_SOURCE_PYTHON");
        info.EnvironmentVariables.Remove("MEDIA_TRACKER_FFMPEG");
        info.EnvironmentVariables.Remove("MEDIA_TRACKER_FFPROBE");
        info.EnvironmentVariables.Remove("MEDIA_TRACKER_NO_OPEN");
        info.EnvironmentVariables.Remove("MEDIA_TRACKER_BOOTSTRAP_STATUS_FILE");
        info.EnvironmentVariables.Remove("MEDIA_TRACKER_BOOTSTRAP_TOKEN");
        info.EnvironmentVariables.Remove("MEDIA_TRACKER_READY_FILE");
        info.EnvironmentVariables.Remove("MEDIA_TRACKER_READY_TOKEN");
        info.EnvironmentVariables.Remove("PYTHONHOME");
        info.EnvironmentVariables.Remove("PYTHONPATH");
        info.EnvironmentVariables["PYTHONNOUSERSITE"] = "1";
        info.EnvironmentVariables["PYTHONDONTWRITEBYTECODE"] = "1";
        string python = Path.Combine(Root, "runtime", "python", "python.exe");
        if (File.Exists(python)) info.EnvironmentVariables["MEDIA_TRACKER_SOURCE_PYTHON"] = python;
        return info;
    }

    private static void CheckRuntime()
    {
        NodeBootstrapSpec node = ReadNodeBootstrapSpec();
        if (node != null && !NodeBootstrapReady(node)) throw new InvalidOperationException("独立 Node 尚未准备完成；离线检查不会下载。");
        RequireFile(NodePath);
        PreparationStatus prepared = RuntimeStatus();
        if (prepared != null && !prepared.Ready) throw new InvalidOperationException("运行组件尚未准备完成（离线检查不会下载）：" + ComponentProblems(prepared));
        RequireFile(Path.Combine(AppRoot, "server.mjs"));
        RequireFile(Path.Combine(AppRoot, "scripts", "start-service.mjs"));
        RequireFile(Path.Combine(AppRoot, "node_modules", "playwright", "package.json"));
        if (!Directory.Exists(BrowserRoot)) throw new DirectoryNotFoundException("The bundled private browser is missing.");
        string code = "import {existsSync} from 'node:fs';import {chromium} from 'playwright';" +
            "const nodeMajor=Number(process.versions.node.split('.')[0]);" +
            "const browserExecutable=chromium.executablePath();" +
            "console.log(JSON.stringify({nodeMajor,browserExecutable}));" +
            "process.exit(nodeMajor>=20 && existsSync(browserExecutable)?0:1);";
        using (Process process = new Process())
        {
            process.StartInfo = NodeInfo("--input-type=module -e " + Quote(code));
            if (!process.Start()) throw new InvalidOperationException("The bundled Node runtime could not be started.");
            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> errors = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(15000))
            {
                process.Kill();
                process.WaitForExit();
                throw new TimeoutException("The bundled runtime check timed out.");
            }
            Task.WaitAll(output, errors);
            if (process.ExitCode != 0) throw new InvalidOperationException("Bundled runtime validation failed. " + errors.Result.Trim());
            RuntimeReport report;
            byte[] bytes = Utf8.GetBytes(output.Result.Trim());
            using (MemoryStream stream = new MemoryStream(bytes))
                report = (RuntimeReport)new DataContractJsonSerializer(typeof(RuntimeReport)).ReadObject(stream);
            if (report == null || report.NodeMajor < 20 || !File.Exists(report.BrowserExecutable) ||
                !IsInside(BrowserRoot, report.BrowserExecutable))
                throw new InvalidOperationException("The runtime did not resolve the private bundled browser.");
        }
    }

    private static void ValidateReadyArguments(string filename, string token)
    {
        if (filename == null && token == null) return;
        string expected = token == null ? null : Path.Combine(DataRoot, "startup-logs", ".ready-" + token + ".json");
        if (!Regex.IsMatch(token ?? "", "\\A[a-f0-9]{32}\\z") || filename == null ||
            !Path.IsPathRooted(filename) || !String.Equals(Path.GetFullPath(filename), expected, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Invalid first-start readiness marker.");
    }

    private static bool IsInside(string directory, string filename)
    {
        return filename != null && Path.GetFullPath(filename).StartsWith(
            Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase);
    }

    private static int RunService(string readyPath, string readyToken)
    {
        RequireFile(Path.Combine(AppRoot, "scripts", "start-service.mjs"));
        string logs = Path.Combine(DataRoot, "startup-logs");
        Directory.CreateDirectory(logs);
        string id = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N");
        string stdoutPath = Path.Combine(logs, id + ".out.log");
        string stderrPath = Path.Combine(logs, id + ".err.log");
        using (FileStream stdout = new FileStream(stdoutPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, true))
        using (FileStream stderr = new FileStream(stderrPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, true))
        using (Process process = new Process())
        {
            process.StartInfo = NodeInfo(Quote(Path.Combine(AppRoot, "scripts", "start-service.mjs")));
            if (readyPath != null)
            {
                process.StartInfo.EnvironmentVariables["MEDIA_TRACKER_READY_FILE"] = readyPath;
                process.StartInfo.EnvironmentVariables["MEDIA_TRACKER_READY_TOKEN"] = readyToken;
            }
            if (!process.Start()) throw new InvalidOperationException("The local service could not be started.");
            Task outCopy = process.StandardOutput.BaseStream.CopyToAsync(stdout);
            Task errCopy = process.StandardError.BaseStream.CopyToAsync(stderr);
            // The app's existing close lifecycle owns its browser and exits Node.
            // Do not kill unrelated browsers or all Node processes by image name.
            process.WaitForExit();
            Task.WaitAll(outCopy, errCopy);
            stdout.Flush();
            stderr.Flush();
            if (process.ExitCode != 0) throw new InvalidOperationException("The local service exited with code " + process.ExitCode +
                ".\r\nLogs:\r\n" + stdoutPath + "\r\n" + stderrPath);
            return 0;
        }
    }

    private static void WriteReport(string filename, bool ok, string message)
    {
        if (filename == null || !Path.IsPathRooted(filename) || !IsInside(DataRoot, filename))
            throw new InvalidOperationException("A self-test report must be inside this package's data folder.");
        Directory.CreateDirectory(Path.GetDirectoryName(filename));
        using (FileStream stream = new FileStream(filename, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            new DataContractJsonSerializer(typeof(SelfTestReport)).WriteObject(stream,
                new SelfTestReport { Ok = ok, Message = message });
    }

    private static string Quote(string value)
    {
        return "\"" + Regex.Replace(Regex.Replace(value, "(\\\\*)\"", "$1$1\\\""), "(\\\\+)$", "$1$1") + "\"";
    }
}
