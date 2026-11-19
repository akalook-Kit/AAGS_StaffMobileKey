# Read-only Visionline probe

Use it before connecting the platform to the hotel's real Visionline server, and whenever the connection
misbehaves. It answers: *can we reach the Web API, is its certificate trusted, does the operator sign in,
and are the doors, user groups and mobile access account there?*

**It changes nothing in Visionline.** It opens one session (`POST /sessions`), sends only `GET` requests
(resources, doors, the user groups you list, mobile access accounts, time schedules) and closes the
session (`DELETE /sessions/{id}`). It never creates users, cards or keys.

**Secrets.** You type the password into the probe; it is not shown, not saved and not written to the report.
The report contains no password, session id, access key or signature.

## Run it

From the project folder (`C:\khb\staff-mobile-key\staff-mobile-key`) in PowerShell, after Step 5 of
WINDOWS-SETUP.md:

| Where is Visionline? | Command |
|---|---|
| Same PC, step 1: look at the certificate | `.\scripts\windows\visionline-probe.ps1 -TlsOnly` |
| Same PC, full check | `.\scripts\windows\visionline-probe.ps1 -User sym -CaFile C:\khb\visionline-ca.crt` |
| Another PC on the network | add `-Url https://<visionline-pc>/api/v1` |
| On the Visionline PC with Node.js (no Docker) | add `-Native` |

Other options: `-AccessId <id>` if the Web API client needs an access ID, `-Pin <sha256>` to also require
an exact certificate fingerprint, `-ServerName <name>` if the certificate is issued to another host name,
`-Groups "Housekeeping,Maintenance,Security"` to choose which user groups to look for, `-Uuid 9`.

The default address is `https://localhost/api/v1`, the address used in the ASSA ABLOY Mobile Access
portal's Visionline settings.

## Trusting the Visionline certificate

The probe and the connector always verify Visionline's certificate; there is no option to turn that off.
Visionline usually has a self-signed certificate or one from the hotel's own CA, so you give it a file
to trust:

1. Capture the certificate the server presents:
   ```powershell
   .\scripts\windows\visionline-probe.ps1 -TlsOnly -SaveCert C:\khb\visionline-ca.crt
   ```
   The probe prints its SHA-256 fingerprint. If it warns that the server did not send its root
   certificate, export the issuing CA certificate on the Visionline server instead (step 2) and use that.
2. Confirm it is really Visionline's, on the Visionline PC itself: open **certlm.msc** → find the
   certificate used by the Visionline Web API → **Details → Copy to File… → DER** and save it, then in
   PowerShell `Get-FileHash -Algorithm SHA256 <file>.cer`. The hash must equal the fingerprint the probe
   printed (ignore the colons and letter case). If you are unsure which certificate Visionline uses, ask the
   ASSA ABLOY installer.
3. Use the file: `-CaFile C:\khb\visionline-ca.crt`. The connector uses the same file (`VL_CA_FILE`).

### When Visionline's CA cannot be found

Visionline's certificate is usually issued to **Visionline WebService** by a private **VisionlineRootCA**.
Visionline doesn't send that CA's certificate, and it is often not installed in Windows. In that case,
give the probe and the connector **Visionline's own certificate**, the file saved with `-SaveCert`. A file
holding a single non-CA certificate is trusted **exactly**: the server must present that same certificate,
with the same SHA-256 fingerprint. The host name check is not needed then, because `Visionline WebService`
is not a host name. This needs Node.js 22.9 or newer. When Visionline's certificate is renewed, save the
new one and reinstall the connector with it.

### When Visionline's certificate has expired (2.38.1)

Visionline's own programs often do not check the date, so an expired certificate can go unnoticed for years; the
connector refuses it ("certificate has expired"). The fix is to have it renewed on the Visionline server
(ASSA ABLOY). To work meanwhile, run on the server **Start menu → Access Monitoring Tool - Visionline certificate**
(`Trust-Visionline-Certificate.cmd`, as administrator). It reads the certificate Visionline presents, shows its name,
dates and SHA-256, and after you type **ACCEPT** trusts exactly that certificate although it has expired:

- only Visionline's own certificate (not a CA), and only the one with that SHA-256: any other is refused;
- the connection is still encrypted and checked; only the expiry date is waived;
- the connector checks the certificate before anything is sent (no password or session goes to another server);
- the portal shows a warning (Settings → Visionline, and an alert *Visionline certificate*) until it is renewed.

After the renewal, run the same shortcut again: the new certificate is trusted normally and the acceptance ends.

**Renewing it (ASSA ABLOY FAQ "How to install a new SSL certificate for Visionline").** Visionline's Web API runs on
Tomcat; its self-signed certificate (valid 1 year when Visionline is installed) is in the keystore
`C:\ProgramData\ASSA ABLOY\Visionline\webserver\tomcat\conf\keystore`. A hotel that wants a certificate that stays
the same for a long time can use its own domain certificate instead. Outline, best with the ASSA ABLOY technician and
outside busy hours (the PMS interface and mobile access use the same Web API):

1. Copy `tomcat\conf\keystore` and `tomcat\conf\server.xml` somewhere safe.
2. In `server.xml`, the HTTPS `<Connector>` gives the keystore password (`keystorePass`) and, if set, `keyAlias`.
3. With `keytool.exe` (from the Java that Visionline uses): `keytool -list -v -keystore "<keystore>"` shows the alias
   and the expiry date.
4. Keep the old entry under another name, then make the new one under the same alias, with the same password as the
   keystore:
   `keytool -changealias -alias <alias> -destalias <alias>-old -keystore "<keystore>"`
   `keytool -genkeypair -alias <alias> -keyalg RSA -keysize 2048 -validity 1095 -dname "CN=Visionline WebService" -ext "SAN=dns:localhost,ip:127.0.0.1,dns:<server name>" -keystore "<keystore>"`
5. Restart the Visionline web server (Tomcat) service. Check `https://localhost/api/v1` answers.
6. Run **Access Monitoring Tool - Visionline certificate** on the server: the new certificate is trusted normally,
   the expired acceptance ends and the portal warning closes. Other programs that check Visionline's certificate
   (interfaces) may need the new one too.

If anything goes wrong, put the two copied files back and restart the service.
`connector.config.json` keeps it as `visionline.acceptExpiredSha256`; the probe takes `--accept-expired <sha256>`.

## Reading the result

Each line is PASS, WARN, FAIL or INFO. The end shows the number of problems and the report path
(`visionline-probe-report\probe-<time>.json` and `.txt`).

| Message | What to do |
|---|---|
| Cannot open a TLS connection | Check the address and port, that the Visionline Web API service is running, and the firewall. |
| Not trusted with the current settings | Follow *Trusting the Visionline certificate*. Use `-ServerName` if the name in the certificate is not `localhost`. |
| Visionline rejected the username or password (40102) | Check the operator in Visionline. |
| Operator not allowed to use the Web API (40107) | Give the operator Web API rights in Visionline. |
| API resources: Missing … | The operator lacks rights, or a Visionline option/licence (mobile access) is not enabled. |
| Doors have no door group | Floors are door groups on the platform's door map. Put rooms into floor groups in Visionline. |
| User group does not exist | Create it in Visionline, or later from the portal (**Settings → Visionline → Add and create in Visionline**). |
| No Credential Services account | Set up Mobile Access in Visionline (Options → Mobile Access). The systemID shown goes into **Settings → Credential Services**. |
| Clock differs by more than 5 minutes | Sync this PC and Visionline with the same time server. Visionline refuses requests more than 15 minutes off. |

The Mobile Access **UUID** (9 at K Hotel) and **Revoke mobile key when overridden** are not exposed by the
Web API, so the probe lists them as INFO: check them in Visionline Options → Mobile Access and make sure
**Settings → Visionline** in the portal shows the same values.
