// Access Monitoring Tool installer: the questions asked at the start of a new installation (.msi, interactive only).
// The answers go to %ProgramData%\AccessMonitoringToolSetup\answers.json, readable by administrators and SYSTEM only;
// the connector token in it is encrypted for this computer (DPAPI) and the file is deleted by the installation.
// Exit code 0 = install, 1602 = cancelled.
using System;
using System.Drawing;
using System.IO;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Windows.Forms;

class AskSetup : Form {
  RadioButton rAll, rPortal, rConn;
  Panel pAll, pPortal, pConn;
  TextBox vlAll, portAll, portPortal, connFrom, portalUrl, token, vlConn;
  Label fp;
  CheckBox show;
  string pin = "";
  static readonly Color Brand = Color.FromArgb(28, 23, 21), Brass = Color.FromArgb(201, 168, 106);

  static Label L(string t, int x, int y, int w, bool bold = false, int h = 20) {
    var l = new Label { Text = t, Left = x, Top = y, Width = w, Height = h, AutoSize = false, AutoEllipsis = false };
    if (bold) l.Font = new Font(SystemFonts.MessageBoxFont, FontStyle.Bold);
    return l;
  }
  static TextBox T(string v, int x, int y, int w, bool secret = false) { return new TextBox { Text = v, Left = x, Top = y, Width = w, UseSystemPasswordChar = secret }; }

  AskSetup() {
    Text = "Access Monitoring Tool - setup";
    Font = SystemFonts.MessageBoxFont;
    FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
    StartPosition = FormStartPosition.CenterScreen; ClientSize = new Size(640, 540); TopMost = true;
    var head = new Panel { Left = 0, Top = 0, Width = 640, Height = 64, BackColor = Brand };
    var h1 = new Label { Text = "Access Monitoring Tool", ForeColor = Brass, Left = 20, Top = 10, Width = 580, Height = 26, Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 14, FontStyle.Bold) };
    var h2 = new Label { Text = "A few questions before installing.", ForeColor = Color.White, Left = 20, Top = 38, Width = 580, Height = 20 };
    head.Controls.Add(h1); head.Controls.Add(h2); Controls.Add(head);

    Controls.Add(L("What should this computer run?", 20, 78, 580, true));
    rAll = new RadioButton { Text = "Everything: portal and connector (this is the Visionline server)", Left = 28, Top = 102, Width = 570, Checked = true };
    rPortal = new RadioButton { Text = "Portal only: the connector runs on another computer", Left = 28, Top = 128, Width = 570 };
    rConn = new RadioButton { Text = "Connector only: the portal is on another computer", Left = 28, Top = 154, Width = 570 };
    Controls.Add(rAll); Controls.Add(rPortal); Controls.Add(rConn);

    pAll = new Panel { Left = 20, Top = 188, Width = 580, Height = 230 };
    pAll.Controls.Add(L("Visionline Web API address", 0, 4, 560));
    vlAll = T("https://localhost/api/v1", 0, 26, 560); pAll.Controls.Add(vlAll);
    pAll.Controls.Add(L("Port staff computers use to open the portal", 0, 60, 560));
    portAll = T("8443", 0, 82, 120); pAll.Controls.Add(portAll);
    pAll.Controls.Add(L("The installation reads Visionline's certificate itself.\r\nAt the end the browser opens the setup page: your organisation\r\n(hotel or institution) and the first administrator.", 0, 120, 570, false, 64));

    pPortal = new Panel { Left = 20, Top = 188, Width = 580, Height = 230, Visible = false };
    pPortal.Controls.Add(L("Port staff computers use to open the portal", 0, 4, 560));
    portPortal = T("8443", 0, 26, 120); pPortal.Controls.Add(portPortal);
    pPortal.Controls.Add(L("Connector computer's IP address (optional; also in Settings -> Connector later)", 0, 60, 570));
    connFrom = T("", 0, 82, 220); pPortal.Controls.Add(connFrom);
    pPortal.Controls.Add(L("Only that address may use the connector entrance. Then run this same\r\nfile on the connector computer and choose \"Connector only\".", 0, 118, 570, false, 44));

    pConn = new Panel { Left = 20, Top = 188, Width = 580, Height = 230, Visible = false };
    pConn.Controls.Add(L("Portal address (as this computer reaches it)", 0, 0, 560));
    portalUrl = T("https://", 0, 20, 440); pConn.Controls.Add(portalUrl);
    var check = new Button { Text = "Check", Left = 450, Top = 17, Width = 110, Height = 26 }; check.Click += (s, e) => CheckPortal(); pConn.Controls.Add(check);
    fp = L("", 0, 46, 570, false, 34); fp.ForeColor = Color.DimGray; pConn.Controls.Add(fp);
    pConn.Controls.Add(L("Connector token (portal: Settings -> Connector -> Make a token)", 0, 84, 560));
    token = T("", 0, 104, 560, true); pConn.Controls.Add(token);
    pConn.Controls.Add(L("Visionline Web API address (as this computer reaches it)", 0, 136, 560));
    vlConn = T("https://localhost/api/v1", 0, 156, 560); pConn.Controls.Add(vlConn);
    pConn.Controls.Add(L("First, on the portal server: set-connector-access.ps1 -Allow <this IP>\r\n(see Settings -> Connector in the portal).", 0, 186, 570, false, 40));
    Controls.Add(pAll); Controls.Add(pPortal); Controls.Add(pConn);

    EventHandler sw = (s, e) => { pAll.Visible = rAll.Checked; pPortal.Visible = rPortal.Checked; pConn.Visible = rConn.Checked; };
    rAll.CheckedChanged += sw; rPortal.CheckedChanged += sw; rConn.CheckedChanged += sw;

    show = new CheckBox { Text = "Show the installation steps in a window (for IT support)", Left = 20, Top = 432, Width = 580 };
    Controls.Add(show);
    var ok = new Button { Text = "Install", Left = 400, Top = 472, Width = 100, Height = 30 };
    var cancel = new Button { Text = "Cancel", Left = 506, Top = 472, Width = 94, Height = 30, DialogResult = DialogResult.Cancel };
    ok.Click += (s, e) => { if (Valid()) { DialogResult = DialogResult.OK; Close(); } };
    Controls.Add(ok); Controls.Add(cancel); AcceptButton = ok; CancelButton = cancel;
  }

  static bool Url(string u) { Uri x; return Uri.TryCreate(u.Trim(), UriKind.Absolute, out x) && x.Scheme == "https"; }
  static bool Port(string p) { int n; return int.TryParse(p.Trim(), out n) && n > 0 && n < 65536; }
  bool Fail(string m) { MessageBox.Show(this, m, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning); return false; }
  bool Valid() {
    if (rAll.Checked) { if (!Url(vlAll.Text)) return Fail("Give the Visionline Web API address, e.g. https://localhost/api/v1"); if (!Port(portAll.Text)) return Fail("Give a port number, e.g. 8443"); }
    if (rPortal.Checked) {
      if (!Port(portPortal.Text)) return Fail("Give a port number, e.g. 8443");
      System.Net.IPAddress ip; if (connFrom.Text.Trim().Length > 0 && !System.Net.IPAddress.TryParse(connFrom.Text.Trim(), out ip)) return Fail("The connector computer's address is an IP address, e.g. 192.168.1.50");
    }
    if (rConn.Checked) {
      if (!Url(portalUrl.Text)) return Fail("Give the portal address, e.g. https://monitoring-server:8443");
      if (token.Text.Trim().Length < 20) return Fail("Paste the connector token made in the portal (Settings -> Connector -> Make a token).");
      if (!Url(vlConn.Text)) return Fail("Give the Visionline Web API address, e.g. https://localhost/api/v1");
      if (pin.Length == 0 && !CheckPortal()) return false;
      var r = MessageBox.Show(this, "The portal's certificate fingerprint is:\r\n\r\n" + pin + "\r\n\r\nIt must be the same as the one shown on the portal server by set-connector-access.ps1. Is it?", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
      if (r != DialogResult.Yes) return false;
    }
    return true;
  }

  bool CheckPortal() {
    pin = ""; fp.Text = "";
    try {
      var u = new Uri(portalUrl.Text.Trim());
      using (var tcp = new TcpClient()) {
        var ar = tcp.BeginConnect(u.Host, u.Port, null, null);
        if (!ar.AsyncWaitHandle.WaitOne(6000)) throw new Exception("no answer from " + u.Host + ":" + u.Port);
        tcp.EndConnect(ar);
        X509Certificate seen = null;
        using (var ssl = new SslStream(tcp.GetStream(), false, (s, c, ch, e) => { seen = c; return true; })) {
          ssl.AuthenticateAsClient(u.Host);
        }
        var c2 = new X509Certificate2(seen);
        using (var sha = SHA256.Create()) pin = BitConverter.ToString(sha.ComputeHash(c2.RawData)).Replace("-", ":");
        fp.Text = "Reached. Certificate " + c2.GetNameInfo(X509NameType.SimpleName, false) + ", fingerprint " + pin;
        fp.ForeColor = Color.DarkGreen;
        return true;
      }
    } catch (Exception ex) {
      fp.Text = "Could not reach the portal: " + ex.Message; fp.ForeColor = Color.Firebrick;
      return Fail("Could not reach the portal at " + portalUrl.Text.Trim() + ".\r\n" + ex.Message);
    }
  }

  static string J(string s) {
    var sb = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }

  void Save() {
    var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "AccessMonitoringToolSetup");
    Directory.CreateDirectory(dir);
    // Only SYSTEM, Administrators and the person installing may read it.
    var sec = new DirectorySecurity();
    sec.SetAccessRuleProtection(true, false);
    var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
    sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
    sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
    sec.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
    try { Directory.SetAccessControl(dir, sec); } catch { }
    string mode = rAll.Checked ? "all" : rPortal.Checked ? "portal" : "connector";
    string tok = "";
    if (rConn.Checked) tok = Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(token.Text.Trim()), Encoding.UTF8.GetBytes("AccessMonitoringTool"), DataProtectionScope.LocalMachine));
    var json = "{\"mode\":" + J(mode) + ",\"visionlineUrl\":" + J(rConn.Checked ? vlConn.Text.Trim() : vlAll.Text.Trim())
      + ",\"lanPort\":" + J(rPortal.Checked ? portPortal.Text.Trim() : portAll.Text.Trim()) + ",\"connectorFrom\":" + J(connFrom.Text.Trim())
      + ",\"portalUrl\":" + J(portalUrl.Text.Trim().TrimEnd('/')) + ",\"portalPin\":" + J(pin) + ",\"token\":" + J(tok)
      + ",\"show\":" + (show.Checked ? "true" : "false") + ",\"at\":" + J(DateTime.UtcNow.ToString("o")) + "}";
    File.WriteAllText(Path.Combine(dir, "answers.json"), json, new UTF8Encoding(false));
    // The installation itself runs as SYSTEM, out of sight. For IT support, a window follows its log live.
    if (show.Checked) {
      var cmd = "$host.UI.RawUI.WindowTitle='Access Monitoring Tool - installation log'; $d=Join-Path $env:ProgramData 'StaffMobileKey\\setup-logs'; $t=(Get-Date).AddSeconds(-5); "
        + "Write-Host 'Waiting for the installation to start...'; while (-not ($f = Get-ChildItem $d -Filter 'msi-*.log' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $t } | Sort-Object LastWriteTime | Select-Object -Last 1)) { Start-Sleep 1 }; "
        + "Get-Content $f.FullName -Wait";
      try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("powershell.exe", "-NoProfile -NoExit -ExecutionPolicy Bypass -Command \"" + cmd + "\"") { UseShellExecute = true }); } catch { }
    }
  }

  [STAThread]
  static int Main(string[] args) {
    Application.EnableVisualStyles();
    using (var f = new AskSetup()) {
      foreach (var a in args) { if (a == "--connector") f.rConn.Checked = true; if (a == "--portal") f.rPortal.Checked = true; }
      if (f.ShowDialog() != DialogResult.OK) return 1602;
      try { f.Save(); } catch (Exception ex) { MessageBox.Show("The answers could not be saved: " + ex.Message, "Access Monitoring Tool"); return 1603; }
      return 0;
    }
  }
}
