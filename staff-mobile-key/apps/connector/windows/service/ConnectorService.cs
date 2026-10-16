// Windows service host for the Staff Mobile Key hotel connector.
//
// Compiled ON the Visionline PC by install.ps1 with the C# compiler that ships with Windows
// (.NET Framework 4.x csc.exe), so no third-party service wrapper binary is needed and this file is the
// whole source. It starts "node connector.mjs", restarts it if it stops unexpectedly, writes its output to
// rotating log files, and on service stop closes the connector's input so it can shut down cleanly
// (it removes its Visionline callback and closes the Visionline session).
//
// Usage (binPath of the service):
//   StaffMobileKeyConnector.exe --node "C:\Program Files\nodejs\node.exe" --script "...\app\connector.mjs"
//       --config "C:\ProgramData\StaffMobileKey\Connector\connector.config.json" --logs "C:\ProgramData\StaffMobileKey\Connector\logs"
// Add --console to run in a console window for troubleshooting (Ctrl+C to stop).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace StaffMobileKey
{
    public class ConnectorService : ServiceBase
    {
        public const string Name = "StaffMobileKeyConnector";
        private readonly Dictionary<string, string> opts;
        private readonly object logLock = new object();
        private Thread supervisor;
        private volatile bool stopping;
        private Process child;
        private const long MaxLogBytes = 10L * 1024 * 1024;
        private const int KeepLogs = 5;

        public ConnectorService(Dictionary<string, string> options)
        {
            opts = options;
            ServiceName = Name;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }

        public static int Main(string[] args)
        {
            Dictionary<string, string> o = Parse(args);
            foreach (string k in new string[] { "node", "script", "config", "logs" })
            {
                if (!o.ContainsKey(k)) { Console.Error.WriteLine("Missing --" + k); return 2; }
            }
            ConnectorService svc = new ConnectorService(o);
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
                Log("service", "Stopping the connector");
                try { RequestAdditionalTime(20000); } catch (Exception) { /* console mode */ }
                // The connector treats end of input as a request to shut down cleanly.
                try { p.StandardInput.Close(); } catch (Exception) { }
                if (!p.WaitForExit(15000)) { Log("service", "The connector did not stop in 15 s; ending it"); p.Kill(); p.WaitForExit(5000); }
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
                    si.EnvironmentVariables["CONNECTOR_CONFIG"] = opts["config"];
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
                    Log("service", "Connector started (process " + p.Id + ")");
                    p.WaitForExit();
                    Log("service", "Connector exited with code " + p.ExitCode);
                    child = null;
                }
                catch (Exception ex)
                {
                    child = null;
                    Log("service", "Could not start the connector: " + ex.Message);
                }
                if (stopping) break;
                // Restart with a growing pause; a run longer than 10 minutes resets the pause.
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
                    string file = Path.Combine(opts["logs"], "connector.log");
                    FileInfo fi = new FileInfo(file);
                    if (fi.Exists && fi.Length > MaxLogBytes)
                    {
                        for (int i = KeepLogs - 1; i >= 1; i--)
                        {
                            string older = Path.Combine(opts["logs"], "connector." + i + ".log");
                            string newer = i == 1 ? file : Path.Combine(opts["logs"], "connector." + (i - 1) + ".log");
                            if (File.Exists(older)) File.Delete(older);
                            if (File.Exists(newer)) File.Move(newer, older);
                        }
                    }
                    string prefix = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + (stream == "err" ? " ! " : stream == "service" ? " * " : "   ");
                    File.AppendAllText(file, prefix + line + Environment.NewLine, new UTF8Encoding(false));
                    if (opts.ContainsKey("console")) Console.WriteLine(prefix + line);
                }
                catch (Exception) { /* never let logging stop the service */ }
            }
        }
    }
}
