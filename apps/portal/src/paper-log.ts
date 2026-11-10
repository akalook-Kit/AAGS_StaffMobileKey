/**
 * 2.31 The paper battery log kept in the lock (Armel, 9 Nov: photos of the cards of 804, 809, 404, 415): one line per
 * entry, "22/07/2026 LCU Serge", "14/04/2026 LCA + piles Serge", "04/09/2026 porte batterie Augustin". A line with only
 * a date and a name is a battery change (that is what the card records). Read, shown for checking, then saved.
 */
export function parsePaperLog(text: string, model: string | null) {
  const alfa = model === 'classic-alfa';
  const out: { line: string; doneOn: string | null; parts: string[]; batteryType: string; doneBy: string; notes: string; error: string | null }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2,4})/.exec(line);
    let doneOn: string | null = null, error: string | null = null;
    if (m) {
      const d = +m[1]!, mo = +m[2]!; let y = +m[3]!; if (y < 100) y += 2000;
      const ok = mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && y >= 2000 && y <= 2100;
      doneOn = ok ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
      if (!ok) error = 'date not valid (day/month/year)';
    } else error = 'no date (day/month/year)';
    // Remarks in brackets, e.g. "(?)" or "(date torn)", stay in the notes only.
    let rest = (m ? line.replace(m[0], ' ') : line).replace(/\([^)]*\)/g, ' ').replace(/^\s*(le|on)\b/i, ' ');
    const parts = new Set<string>();
    const take = (re: RegExp, part: string) => { if (re.test(rest)) { parts.add(part); rest = rest.replace(new RegExp(re.source, 'gi'), ' '); } };
    take(/\b(porte[\s-]?batteries?|porte[\s-]?piles?|bloc[\s-]?piles?|battery[\s-]?holders?|support[\s-]?piles?)\b/i, 'battery-holder');
    take(/\b(c[aâ]bles?)\b/i, 'battery-cable');
    take(/\b(lock[\s-]?case|lockcase|serrure|mortaise|bo[iî]tier)\b/i, alfa ? 'classic-lockcase' : 'lockcase');
    take(/\b(lc[uo]|lgu)\b/i, alfa ? 'lcu' : 'door-unit');
    take(/\b(lca)\b/i, alfa ? 'lca' : 'reader');
    take(/\b(piles?|pil|batter(y|ies)|varta|duracell|procell|energizer)\b/i, 'batteries');
    let batteryType = 'unknown';
    if (/industri/i.test(line)) batteryType = 'industrial-alkaline'; else if (/alcalin|alkalin/i.test(line)) batteryType = 'alkaline'; else if (/lithium/i.test(line)) batteryType = 'lithium';
    rest = rest.replace(/\b(industri\w*|alcalin\w*|alkalin\w*|lithium|remplac\w*|replac\w*|install\w*|neuf|new|et|and|d'un|d'une|un|une|de|des)\b/gi, ' ').replace(/[+/&,;:()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!parts.size) parts.add('batteries');
    out.push({ line, doneOn, parts: [...parts], batteryType, doneBy: rest.slice(0, 80), notes: `From the paper log: ${line}`.slice(0, 1000), error });
  }
  return out;
}

