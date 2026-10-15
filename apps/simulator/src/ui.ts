/** Tiny control page for the simulator: lock events, credentials, fault switches. */
export const simPage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Visionline Simulator</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:0;background:#f4f2ee;color:#1d1b18}
header{background:#1d1b18;color:#f4f2ee;padding:14px 20px}h1{font-size:16px;margin:0}
main{padding:16px 20px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
section{background:#fff;border:1px solid #e3ded5;border-radius:8px;padding:12px 14px;overflow:auto}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#6b645a;margin:0 0 8px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:4px 6px;border-bottom:1px solid #eee}
.OPENED,.ISSUED,.ACTIVE{color:#11703a;font-weight:600}.DENIED,.REVOKED,.DELETED,.ISSUE_FAILED{color:#a3261b;font-weight:600}
label{display:block;margin:4px 0}button{font:inherit;padding:4px 10px}
</style></head><body><header><h1>Visionline + Credential Services simulator — development only</h1></header>
<main>
<section><h2>Lock events</h2><table id="ev"></table></section>
<section><h2>Credentials</h2><table id="cards"></table></section>
<section><h2>Endpoints</h2><table id="eps"></table></section>
<section><h2>Lock batteries</h2><p style="margin:0 0 6px;color:#6b645a">Send a battery event from a lock to Visionline, as the lock would.</p><table id="bat"></table></section>
<section><h2>Lock offline / online</h2><p style="margin:0 0 6px;color:#6b645a">Send any lock event code, e.g. the "offline" / "online" codes set in the portal (Settings → Alert thresholds).</p>
<label>Door <select id="ocdoor"></select></label> <label>Code <input id="occode" type="number" value="9001" style="width:7em"></label> <button id="ocbtn">Send event</button></section>
<section><h2>Alert messages (e-mail and SMS received by the test sinks)</h2><table id="outbox"></table></section>
<section><h2>Fault injection</h2>
<label><input type="checkbox" id="down"> Visionline outage (503)</label>
<label>Fail next card with code <input id="failcode" placeholder="e.g. 40308" size="8"> <button id="failbtn">Arm</button></label>
<label>Session TTL (s) <input id="ttl" size="5"> <button id="ttlbtn">Set</button></label>
<label>Server clock offset (s) <input id="skew" size="6"> <button id="skewbtn">Set</button></label>
<pre id="stats"></pre></section>
</main>
<script>
const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function post(b){await fetch('/sim/faults',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});load()}
$('down').onchange=e=>post({visionlineDown:e.target.checked});
$('failbtn').onclick=()=>post({failNextCard:Number($('failcode').value)||50001});
$('ttlbtn').onclick=()=>post({sessionTtlSec:Number($('ttl').value)});
$('skewbtn').onclick=()=>post({clockOffsetSec:Number($('skew').value)});
async function load(){const s=await (await fetch('/sim/state')).json();
$('down').checked=s.faults.visionlineDown;$('stats').textContent=JSON.stringify({mobileAccessOptions:s.mobileAccessOptions,faults:s.faults,stats:s.stats,sessions:s.sessions},null,1);
$('ev').innerHTML='<tr><th>Time</th><th>Door</th><th>Result</th><th>Reason</th></tr>'+s.events.map(e=>'<tr><td>'+new Date(e.at).toLocaleTimeString()+'</td><td>'+esc(e.doorName)+'</td><td class="'+e.result+'">'+e.result+'</td><td>'+esc(e.reason)+'</td></tr>').join('');
$('cards').innerHTML='<tr><th>Reg. no. / credential</th><th>Holder</th><th>Issued by</th><th>Doors</th><th>Until</th><th>Status</th><th></th></tr>'+s.cards.map(c=>'<tr><td>'+esc(c.cardId)+' / '+c.credentialID+'</td><td>'+esc(c.cardHolder)+'</td><td>'+esc(c.issuedBy)+'</td><td>'+esc(c.doors.join(', '))+'</td><td>'+new Date(c.expireTime).toLocaleString()+'</td><td class="'+c.status+'">'+c.status+(c.cancelled?' · cancelled':'')+'</td><td>'+(c.cancelled?'':'<button data-cancel="'+c.credentialID+'" title="As if hotel staff cancelled the card in Visionline">Cancel in Visionline</button>')+'</td></tr>').join('');
document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=async()=>{await fetch('/sim/cards/'+b.dataset.cancel+'/cancel',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});load()});
$('eps').innerHTML='<tr><th>Endpoint</th><th>Device</th><th>Status</th></tr>'+s.endpoints.map(e=>'<tr><td>'+esc(e.endpointId.slice(0,8))+'…</td><td>'+esc(e.deviceModel)+'</td><td class="'+e.endpointStatus+'">'+e.endpointStatus+'</td></tr>').join('');
$('bat').innerHTML='<tr><th>Door</th><th>Group</th><th>Last sent</th><th></th></tr>'+s.doors.map(d=>'<tr><td>'+esc(d.doorName)+'</td><td>'+esc(d.doorGroup)+'</td><td>'+esc(d.battery??'')+'</td><td><button data-bat="low" data-door="'+esc(d.id)+'">Low</button> <button data-bat="critical" data-door="'+esc(d.id)+'">Critical</button> <button data-bat="exchanged" data-door="'+esc(d.id)+'">Exchanged</button></td></tr>').join('');
document.querySelectorAll('[data-bat]').forEach(b=>b.onclick=async()=>{await fetch('/sim/doors/'+encodeURIComponent(b.dataset.door)+'/battery',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:b.dataset.bat})});load()});}
$('ocbtn').onclick=async()=>{await fetch('/sim/doors/'+encodeURIComponent($('ocdoor').value)+'/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:Number($('occode').value)})});load()};
async function loadOutbox(){const o=await (await fetch('/sim/outbox')).json();$('outbox').innerHTML='<tr><th>Time</th><th>Via</th><th>To</th><th>Message</th></tr>'+(o.length?o.slice(0,30).map(m=>'<tr><td>'+new Date(m.at).toLocaleTimeString()+'</td><td>'+esc(m.via)+'</td><td>'+esc(m.to.join(', '))+'</td><td>'+esc(m.subject||m.text)+'</td></tr>').join(''):'<tr><td colspan=4>Nothing yet.</td></tr>');}
let ocFilled=false;async function fillDoors(){if(ocFilled)return;const s=await (await fetch('/sim/state')).json();$('ocdoor').innerHTML=s.doors.map(d=>'<option value="'+esc(d.id)+'">'+esc(d.doorName)+'</option>').join('');ocFilled=true;}
fillDoors();loadOutbox();setInterval(loadOutbox,4000);
load();setInterval(load,4000);
</script></body></html>`;
