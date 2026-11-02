// Access Monitoring Tool installer helper: runs a PowerShell script without a console window (end users see no
// black windows). "--show" (or SMK_SHOW=1 in the .msi) shows the window again, for IT support.
//   run-hidden.exe [--show] [--nowait] <script.ps1|program.cmd> [arguments...]
using System;
using System.Diagnostics;
using System.Text;

static class RunHidden {
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    int bs = 0;
    foreach (char c in a) {
      if (c == '\\') { bs++; continue; }
      if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
      sb.Append('\\', bs); bs = 0; sb.Append(c);
    }
    sb.Append('\\', bs * 2); sb.Append('"');
    return sb.ToString();
  }
  static int Main(string[] args) {
    bool show = false, wait = true; int i = 0;
    for (; i < args.Length; i++) {
      if (args[i] == "--show" || args[i] == "1") show = true;
      else if (args[i] == "--nowait") wait = false;
      else if (args[i] == "--hide" || args[i] == "0" || args[i] == "") { }
      else break;
    }
    if (i >= args.Length) return 87;
    string target = args[i];
    var rest = new StringBuilder();
    for (int k = i + 1; k < args.Length; k++) { if (args[k].Trim().Length == 0) continue; rest.Append(' ').Append(Quote(args[k])); }
    var psi = new ProcessStartInfo();
    if (target.EndsWith(".ps1", StringComparison.OrdinalIgnoreCase)) {
      psi.FileName = Environment.ExpandEnvironmentVariables(@"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe");
      // The remaining arguments are passed as typed in the .msi (they may hold -Switches and quoted values).
      psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass" + (show ? "" : " -WindowStyle Hidden") + " -File " + Quote(target) + rest.ToString();
    } else {
      psi.FileName = Environment.ExpandEnvironmentVariables(@"%SystemRoot%\System32\cmd.exe");
      psi.Arguments = "/c \"" + Quote(target) + rest.ToString() + "\"";
    }
    psi.UseShellExecute = false;
    psi.CreateNoWindow = !show;
    psi.WindowStyle = show ? ProcessWindowStyle.Normal : ProcessWindowStyle.Hidden;
    try {
      using (var p = Process.Start(psi)) {
        if (!wait) return 0;
        p.WaitForExit();
        return p.ExitCode;
      }
    } catch (Exception) { return 1; }
  }
}
