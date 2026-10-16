// Windows service host for the Staff Mobile Key platform and gateway (on-premises installation).
//
// Compiled ON the server by install-onprem.ps1 with the C# compiler that ships with Windows (.NET Framework
// 4.x csc.exe): no third-party service wrapper, and this file is the whole source. It:
//   - reads plain settings from --env (KEY=VALUE lines) and secrets from --secrets, a file encrypted with
//     Windows DPAPI for this machine (LocalMachine scope) and readable only by SYSTEM, Administrators and the
//     service account; the secrets are handed to Node.js in its environment, never written out in clear;
//   - starts "node <script>", restarts it with a growing pause if it stops unexpectedly;
//   - writes its output to rotating log files;
//   - on service stop closes Node's input, which the platform and the gateway treat as "shut down cleanly".
//
// binPath:  StaffMobileKeyHost.exe --name StaffMobileKeyPlatform --node "...\node.exe" --script "...\app\platform.mjs"
//             --env "...\platform.env" --secrets "...\platform.secrets" --logs "...\logs" --logname platform
// Add --console to run in a console window for troubleshooting (Ctrl+C to stop).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace StaffMobileKey
{
    public class NodeService : ServiceBase
    {
        // Must match the entropy used by install-onprem.ps1 when it protects the secrets file.
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("StaffMobileKey.OnPrem.v1");
        private readonly Dictionary<string, string> opts;
        private readonly object logLock = new object();
        private Thread supervisor;
        private volatile bool stopping;
        private Process child;
        private const long MaxLogBytes = 10L * 1024 * 1024;
        private const int KeepLogs = 5;

        public NodeService(Dictionary<string, string> options)
        {
            opts = options;
            ServiceName = options["name"];
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }

        public static int Main(string[] args)
        {
            Dictionary<string, string> o = Parse(args);
            foreach (string k in new string[] { "name", "node", "script", "logs", "logname" })
            {
                if (!o.ContainsKey(k)) { Console.Error.WriteLine("Missing --" + k); return 2; }
            }
            NodeService svc = new NodeService(o);
            if (o.ContainsKey("console"))
            {
                svc.OnStart(new string[0]);
                Console.WriteLine("Running in the console. Press Ctrl+C to stop.");
                ManualResetEvent done = new ManualResetEvent(false);
                Console.CancelKeyPress += delegate (object s, ConsoleCancelEventArgs e) { e.Cancel = true; done.Set(); };
                done.WaitOne();
                svc.OnStop();
                return 0;
            }
            ServiceBase.Run(svc);
            return 0;
        }

        private static Dictionary<string, string> Parse(string[] args)
        {
            Dictionary<string, string> o = new Dictionary<string, string>();
            for (int i = 0; i < args.Length; i++)
            {
                if (!args[i].StartsWith("--")) continue;
                string key = args[i].Substring(2);
                if (i + 1 < args.Length && !args[i + 1].StartsWith("--")) { o[key] = args[i + 1]; i++; }
                else o[key] = "true";
            }
            return o;
        }

        private static void ReadPairs(string text, Dictionary<string, string> into)
        {
            foreach (string raw in text.Split('\n'))
            {
                string line = raw.Trim('\r', ' ', '﻿');
                if (line.Length == 0 || line.StartsWith("#")) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                into[line.Substring(0, eq).Trim()] = line.Substring(eq + 1);
            }
        }

        private Dictionary<string, string> Environment()
        {
            Dictionary<string, string> env = new Dictionary<string, string>();
            if (opts.ContainsKey("env") && File.Exists(opts["env"])) ReadPairs(File.ReadAllText(opts["env"], Encoding.UTF8), env);
            if (opts.ContainsKey("secrets") && File.Exists(opts["secrets"]))
            {
                byte[] clear = ProtectedData.Unprotect(File.ReadAllBytes(opts["secrets"]), Entropy, DataProtectionScope.LocalMachine);
                try { ReadPairs(Encoding.UTF8.GetString(clear), env); }
                finally { Array.Clear(clear, 0, clear.Length); }
            }
            return env;
        }

        protected override void OnStart(string[] args)
        {
            Directory.CreateDirectory(opts["logs"]);
            stopping = false;
            supervisor = new Thread(Supervise);
            supervisor.IsBackground = true;
            supervisor.Start();
        }

        protected override void OnStop() { StopChild(); }
        protected override void OnShutdown() { StopChild(); }

        private void StopChild()
        {
            stopping = true;
            Process p = child;
            if (p == null) return;
            try
            {
                Log("service", "Stopping");
                try { RequestAdditionalTime(20000); } catch (Exception) { /* console mode */ }
                try { p.StandardInput.Close(); } catch (Exception) { }
                if (!p.WaitForExit(15000)) { Log("service", "Did not stop in 15 s; ending it"); p.Kill(); p.WaitForExit(5000); }
            }
            catch (Exception ex) { Log("service", "Stop error: " + ex.Message); }
            if (supervisor != null) supervisor.Join(5000);
        }

        private void Supervise()
        {
            int[] delays = new int[] { 5, 10, 30, 60 };
            int failures = 0;
            while (!stopping)
            {
                DateTime started = DateTime.UtcNow;
                try
                {
                    ProcessStartInfo si = new ProcessStartInfo(opts["node"], "\"" + opts["script"] + "\"");
                    si.UseShellExecute = false;
                    si.CreateNoWindow = true;
                    si.RedirectStandardInput = true;
                    si.RedirectStandardOutput = true;
                    si.RedirectStandardError = true;
                    si.StandardOutputEncoding = Encoding.UTF8;
                    si.StandardErrorEncoding = Encoding.UTF8;
                    si.WorkingDirectory = Path.GetDirectoryName(opts["script"]);
                    foreach (KeyValuePair<string, string> kv in Environment()) si.EnvironmentVariables[kv.Key] = kv.Value;
                    si.EnvironmentVariables["NODE_ENV"] = "production";
                    si.EnvironmentVariables["SMK_SERVICE_STDIN_SHUTDOWN"] = "1";
                    Process p = new Process();
                    p.StartInfo = si;
                    p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log("out", e.Data); };
                    p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log("err", e.Data); };
                    p.Start();
                    child = p;
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    Log("service", "Started (process " + p.Id + ")");
                    p.WaitForExit();
                    Log("service", "Exited with code " + p.ExitCode);
                    child = null;
                }
                catch (Exception ex)
                {
                    child = null;
                    Log("service", "Could not start: " + ex.Message);
                }
                if (stopping) break;
                if ((DateTime.UtcNow - started).TotalMinutes > 10) failures = 0;
                int wait = delays[Math.Min(failures, delays.Length - 1)];
                failures++;
                Log("service", "Restarting in " + wait + " s");
                for (int i = 0; i < wait * 10 && !stopping; i++) Thread.Sleep(100);
            }
        }

        private void Log(string stream, string line)
        {
            lock (logLock)
            {
                try
                {
                    string name = opts["logname"];
                    string file = Path.Combine(opts["logs"], name + ".log");
                    FileInfo fi = new FileInfo(file);
                    if (fi.Exists && fi.Length > MaxLogBytes)
                    {
                        for (int i = KeepLogs - 1; i >= 1; i--)
                        {
                            string older = Path.Combine(opts["logs"], name + "." + i + ".log");
                            string newer = i == 1 ? file : Path.Combine(opts["logs"], name + "." + (i - 1) + ".log");
                            if (File.Exists(older)) File.Delete(older);
                            if (File.Exists(newer)) File.Move(newer, older);
                        }
                    }
                    string prefix = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + (stream == "err" ? " ! " : stream == "service" ? " * " : "   ");
                    File.AppendAllText(file, prefix + line + System.Environment.NewLine, new UTF8Encoding(false));
                    if (opts.ContainsKey("console")) Console.WriteLine(prefix + line);
                }
                catch (Exception) { /* never let logging stop the service */ }
            }
        }
    }
}
