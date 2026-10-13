using System;
using System.IO;
using System.Reflection;

// Integration-test harness only. Never included in a public release, never
// downloads, and never exposes a production CLI that bypasses GUI consent.
internal static class NodeBootstrapProbe
{
    private static int Main(string[] args)
    {
        string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string temporary = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string parent = Path.GetDirectoryName(root);
        if (args.Length != 1 || Path.GetFileName(root) != "便携编译 空格路径" ||
            !root.StartsWith(temporary, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(parent).StartsWith("collector-real-portable-test-", StringComparison.Ordinal))
            throw new InvalidOperationException("Node archive validation is restricted to the owned portable integration fixture.");
        string runtime = Path.Combine(root, "runtime");
        string stage = Path.Combine(runtime, ".collector-node-stage-" + Guid.NewGuid().ToString("N"));
        string payload = Path.Combine(stage, "payload");
        Directory.CreateDirectory(payload);
        try
        {
            string archive = Path.Combine(stage, "official-node.zip");
            File.Copy(Path.GetFullPath(args[0]), archive, false);
            Type launcher = typeof(Launcher);
            const BindingFlags flags = BindingFlags.Static | BindingFlags.NonPublic;
            object spec = launcher.GetMethod("ReadNodeBootstrapSpec", flags).Invoke(null, null);
            if (spec == null) throw new InvalidOperationException("Minimal fixture has no pinned Node bootstrap descriptor.");
            launcher.GetMethod("CommitVerifiedNodeArchive", flags).Invoke(null, new object[] { archive, payload, spec, null });
            bool ready = (bool)launcher.GetMethod("NodeBootstrapReady", flags).Invoke(null, new object[] { spec });
            if (!ready) throw new InvalidOperationException("The official Node runtime did not pass its receipt and local version checks.");
            Console.WriteLine("pinned-node-archive-prepared-and-validated");
            return 0;
        }
        catch (TargetInvocationException error)
        {
            Console.Error.WriteLine(error.InnerException ?? error);
            return 1;
        }
        finally
        {
            if (Path.GetDirectoryName(stage) != runtime || !Path.GetFileName(stage).StartsWith(".collector-node-stage-", StringComparison.Ordinal))
                throw new InvalidOperationException("Unexpected verification staging directory.");
            if (Directory.Exists(stage)) Directory.Delete(stage, true);
        }
    }
}
