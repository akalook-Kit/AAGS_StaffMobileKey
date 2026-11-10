/**
 * 2.27 Languages (Armel, 4 Nov: "allow it to be in multiple languages"). English and French. Texts are looked up by
 * their English wording: anything not translated yet stays in English, so a page never breaks. The choice is kept on
 * this computer and in the person's preferences.
 */
export type Lang = 'en' | 'fr';
/** What a person chose: a language, or 'auto' = the language of this browser / computer (the default). */
export type LangChoice = Lang | 'auto';
export const LANGS: { id: LangChoice; label: string }[] = [{ id: 'auto', label: 'Auto' }, { id: 'en', label: 'English' }, { id: 'fr', label: 'Français' }];

/** The browser's languages (Windows → Settings → Language, or the browser's own setting), first one we offer. */
export function browserLang(): Lang {
  const list = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language ?? ''];
  for (const l of list) { const b = (l || '').toLowerCase().split('-')[0]; if (b === 'fr' || b === 'en') return b; }
  return 'en';
}
let choice: LangChoice = (() => { try { const v = localStorage.getItem('smk.lang'); if (v === 'en' || v === 'fr' || v === 'auto') return v; } catch { /* ignore */ } return 'auto'; })();
let current: Lang = choice === 'auto' ? browserLang() : choice;
if (typeof document !== 'undefined') document.documentElement.lang = current;

export const lang = () => current;
export const langChoice = () => choice;
export const hasLangChoice = () => { try { return localStorage.getItem('smk.lang') != null; } catch { return false; } };
export function setLang(l: LangChoice) {
  choice = l;
  current = l === 'auto' ? browserLang() : l;
  try { localStorage.setItem('smk.lang', l); } catch { /* ignore */ }
  if (typeof document !== 'undefined') document.documentElement.lang = current;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('smk:lang'));
}
// When the computer's language changes while the portal is open, Auto follows it.
if (typeof window !== 'undefined') window.addEventListener('languagechange', () => { if (choice === 'auto') setLang('auto'); });

/** Translate an English text (exact wording); unknown texts are returned as they are. */
export function tr(s: string): string {
  if (current === 'en' || !s) return s;
  return FR[s] ?? s;
}
/** Translate a text with {placeholders}. */
export function trf(s: string, vars: Record<string, string | number>): string {
  return tr(s).replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ''));
}

const FR: Record<string, string> = {
  // ---- menu and frame
  'Overview': 'Accueil', 'Reports': 'Rapports', 'Monitoring': 'Alertes', 'Alerts': 'Alertes',
  'Doors & safety': 'Portes et sécurité', 'Keycards & people': 'Badges et personnel', 'Locks': 'Serrures', 'Administration': 'Administration',
  'Event log': 'Journal des événements', 'Access history': 'Historique des accès', 'Keycards per room': 'Badges par chambre', 'Live occupancy': 'Présence en direct',
  'Emergency': 'Urgence', 'Staff keycards': 'Badges du personnel', 'Visionline cards & people': 'Badges et personnes Visionline', 'Staff ID cards': 'Cartes d\'identité du personnel',
  'Staff': 'Personnel', 'Mobile keys': 'Clés mobiles', 'Time & attendance': 'Pointage', 'Breakfast': 'Petit-déjeuner', 'Battery status': 'État des piles',
  'Online locks & gateways': 'Serrures en ligne et passerelles', 'Lock troubleshooting': 'Diagnostic des serrures', 'Maintenance': 'Maintenance', 'Users': 'Utilisateurs',
  'Connector health': 'État du connecteur', 'Branding and logo': 'Marque et logo', 'Settings': 'Paramètres', 'Audit trail': 'Piste d\'audit', 'Usage': 'Utilisation',
  'System setup reports': 'Rapports de configuration', 'Demo Hotel and testers': 'Hôtel de démonstration et testeurs', 'Insights': 'Analyses', 'My charts': 'Mes graphiques',
  'Help and manual': 'Aide et manuel', 'Sign out': 'Se déconnecter', 'Search...': 'Rechercher...', 'Language': 'Langue', 'Menu': 'Menu',
  'Auto': 'Auto', 'Light': 'Clair', 'Dark': 'Sombre', 'Skip to the page': 'Aller au contenu', 'Card lookup': 'Recherche de badge', 'My account': 'Mon compte', 'Licence': 'Licence',
  // ---- sign-in page
  'Sign in': 'Connexion', 'Work email': 'E-mail professionnel', 'Password': 'Mot de passe', 'Signing in…': 'Connexion…', 'Verify': 'Vérifier',
  'Authentication code': 'Code d\'authentification', 'The 6-digit code from your authenticator app.': 'Le code à 6 chiffres de votre application d\'authentification.',
  'Enter the code from your authenticator app.': 'Saisissez le code de votre application d\'authentification.',
  'Forgotten password or first time here?': 'Mot de passe oublié ou première visite ?', 'Skip to sign in': 'Aller à la connexion',
  'First time:': 'Première fois :', 'open the invitation link from your e-mail and choose your password there.': 'ouvrez le lien d\'invitation reçu par e-mail et choisissez-y votre mot de passe.',
  'Forgotten password:': 'Mot de passe oublié :', 'ask an administrator for a password link (Users, then Password link). It works once.': 'demandez un lien de mot de passe à un administrateur (Utilisateurs, puis Lien de mot de passe). Il ne fonctionne qu\'une fois.',
  'Lost the phone with your authenticator app:': 'Téléphone avec l\'application d\'authentification perdu :', 'an administrator can reset your two-step sign-in.': 'un administrateur peut réinitialiser votre connexion en deux étapes.',
  'Help:': 'Aide :', 'Front office and security': 'Réception et sécurité', 'Engineering': 'Service technique', 'Managers and HR': 'Responsables et RH', 'Administrators': 'Administrateurs',
  'Issue, verify and extend staff keycards, look up any card, see who is in the building.': 'Émettre, vérifier et prolonger les badges du personnel, rechercher un badge, voir qui est dans le bâtiment.',
  'Lock batteries, locks offline, troubleshooting reports and maintenance requests.': 'Piles des serrures, serrures hors ligne, diagnostics et demandes de maintenance.',
  'Keycard requests for their team, returns when someone leaves, reports and charts.': 'Demandes de badges pour leur équipe, restitutions au départ, rapports et graphiques.',
  'Users, settings, the setup report and the audit trail.': 'Utilisateurs, paramètres, rapport de configuration et piste d\'audit.',
  'Access Monitoring Tool. Every sign-in and every change is kept in the audit trail.': 'Access Monitoring Tool. Chaque connexion et chaque modification sont conservées dans la piste d\'audit.',
  'Good to know': 'Bon à savoir', 'Important': 'Important', 'Event': 'Événement', 'News': 'Actualité',
  'Lost a keycard?': 'Badge perdu ?', 'Tell front office or security at once: the card is cancelled in minutes and nobody can use it.': 'Prévenez aussitôt la réception ou la sécurité : le badge est annulé en quelques minutes et personne ne peut l\'utiliser.',
  'Leaving the company?': 'Vous quittez l\'entreprise ?', 'Your manager asks for your keycard to be returned and cancelled; it takes one minute.': 'Votre responsable demande la restitution et l\'annulation de votre badge ; cela prend une minute.',
  'Your password is yours': 'Votre mot de passe est personnel', 'Never share it. Turn on two-step sign-in under Your account for extra protection.': 'Ne le partagez jamais. Activez la connexion en deux étapes dans Mon compte pour plus de sécurité.',
  'Lock batteries': 'Piles des serrures', 'When a lock shows a battery alarm, report it: changing batteries in good time avoids lock-outs.': 'Quand une serrure signale une alarme de pile, signalez-la : changer les piles à temps évite les blocages.',
  // ---- overview
  'Verify or extend a keycard': 'Vérifier ou prolonger un badge', 'Card on the encoder': 'Badge sur l\'encodeur', 'Look up a card': 'Rechercher un badge', 'By its number': 'Par son numéro',
  'Keycard request': 'Demande de badge', 'New, replacement or return': 'Nouveau, remplacement ou restitution', 'Unpaid guest': 'Client impayé', 'Lock-out request': 'Demande de blocage',
  'Who is in the building': 'Qui est dans le bâtiment', 'Who opened a door': 'Qui a ouvert une porte', 'Low and critical locks': 'Serrures faibles et critiques', 'Doors, connector, server': 'Portes, connecteur, serveur',
  'Nothing waiting for you': 'Rien en attente pour vous', 'Notice board': 'Tableau d\'affichage', 'Getting started': 'Pour commencer',
  // ---- reports
  'Daily and monthly reports: read them here, download them (PDF or Excel), or have them e-mailed every day or every month.': 'Rapports quotidiens et mensuels : à lire ici, à télécharger (PDF ou Excel) ou à recevoir par e-mail chaque jour ou chaque mois.',
  'Daily and monthly': 'Quotidiens et mensuels', 'Keycards': 'Badges', 'Doors': 'Portes', 'More reports': 'Autres rapports',
  'Daily summary': 'Synthèse du jour', 'Guest keycards issued': 'Badges clients émis', 'Staff keycards issued': 'Badges du personnel émis', 'Who holds staff keycards': 'Qui détient les badges du personnel',
  'Keycard requests and returns': 'Demandes et restitutions de badges', 'Door activity': 'Activité des portes', 'Refused entries': 'Accès refusés', 'Locks and batteries': 'Serrures et piles',
  'Insights and your own reports': 'Analyses et vos propres rapports', 'Event log (printable)': 'Journal des événements (imprimable)', 'Accounts daily report': 'Rapport quotidien pour la comptabilité',
  'Visionline setup report': 'Rapport de configuration Visionline', 'Portal setup report': 'Rapport de configuration du portail',
  'Day': 'Jour', 'Month': 'Mois', 'Yesterday': 'Hier', 'Today so far': 'Aujourd\'hui (en cours)', 'Last month': 'Mois dernier', 'This month so far': 'Ce mois-ci (en cours)',
  'Download PDF': 'Télécharger le PDF', 'Download for Excel (CSV)': 'Télécharger pour Excel (CSV)', 'Nothing in this period.': 'Rien sur cette période.',
  'The first 500 lines are shown; the PDF and the CSV have all of them.': 'Les 500 premières lignes sont affichées ; le PDF et le CSV les contiennent toutes.',
  'E-mail this report now to': 'Envoyer ce rapport maintenant par e-mail à', 'Send by e-mail': 'Envoyer par e-mail', 'Sending…': 'Envoi…', 'Sent to': 'Envoyé à', 'Sent': 'Envoyés', 'Not sent': 'Non envoyés',
  'E-mail is not set up (Settings → Alerts & notifications).': 'L\'e-mail n\'est pas configuré (Paramètres → Alertes et notifications).',
  'Reports sent by e-mail': 'Rapports envoyés par e-mail', 'Report': 'Rapport', 'When': 'Quand', 'To': 'À', 'Last sent': 'Dernier envoi', 'Stop': 'Arrêter', 'not yet': 'pas encore',
  'Every day': 'Chaque jour', 'Every month (1st)': 'Chaque mois (le 1er)', 'How often': 'Fréquence', 'Every day (previous day)': 'Chaque jour (veille)', 'Every month (previous month)': 'Chaque mois (mois précédent)',
  'Time': 'Heure', 'E-mail addresses': 'Adresses e-mail', 'Add': 'Ajouter', 'No report is e-mailed yet.': 'Aucun rapport n\'est encore envoyé par e-mail.',
  'Every day: the previous day\'s report, at the time you choose. Every month: the previous month\'s report, on the 1st. The PDF and the CSV are attached.': 'Chaque jour : le rapport de la veille, à l\'heure choisie. Chaque mois : le rapport du mois précédent, le 1er. Le PDF et le CSV sont joints.',
  'Everything in one page: entrances, refused entries, guest and staff keycards issued, keycards returned, battery alarms, locks offline, open alarms and maintenance.': 'Tout sur une page : entrées, accès refusés, badges clients et personnel émis, badges restitués, alarmes de piles, serrures hors ligne, alarmes ouvertes et maintenance.',
  'How many guest keycards Visionline made, and the rooms where guest keycards were used. For a month: one line per day.': 'Combien de badges clients Visionline a émis, et les chambres où ils ont été utilisés. Pour un mois : une ligne par jour.',
  'Every staff keycard made in the period: for whom, user group, card number, who issued it, until when it is valid, and whether it still works.': 'Chaque badge du personnel émis sur la période : pour qui, groupe, numéro, qui l\'a émis, validité, et s\'il fonctionne encore.',
  'Every valid staff keycard today: holder, user group, card and register number, doors, deadbolt override, valid until, who issued it and when it was last used.': 'Chaque badge du personnel valide aujourd\'hui : titulaire, groupe, numéro de badge et de registre, portes, passage du verrou, validité, émetteur et dernière utilisation.',
  'Requests for new or replacement keycards and returns or cancellations, with their state and who handled them.': 'Demandes de nouveaux badges ou de remplacement, restitutions ou annulations, avec leur état et qui les a traitées.',
  'For each door: entrances, refused entries, how many different staff and guest keycards were used, and the last use.': 'Pour chaque porte : entrées, accès refusés, nombre de badges du personnel et clients différents utilisés, et dernière utilisation.',
  'Every refused entry: when, which door, which card, whose, and why the lock refused it.': 'Chaque accès refusé : quand, quelle porte, quel badge, à qui, et pourquoi la serrure l\'a refusé.',
  'Battery alarms and battery changes in the period, the battery state of each lock now, how long its batteries have been in, and locks offline.': 'Alarmes et changements de piles sur la période, état actuel des piles de chaque serrure, depuis quand elles sont en place, et serrures hors ligne.',
  'Entrances': 'Entrées', 'Refused': 'Refusés', 'Critical batteries': 'Piles critiques', 'Guest keycards used at doors': 'Badges clients utilisés aux portes', 'Rooms': 'Chambres',
  'New guest keycards (issued or first used)': 'Nouveaux badges clients (émis ou premier usage)', 'People': 'Personnes', 'Still valid': 'Encore valides', 'Returned or cancelled (requests)': 'Restitués ou annulés (demandes)',
  'Valid staff keycards': 'Badges du personnel valides', 'End within 30 days': 'Expirent sous 30 jours', 'Generic names': 'Noms génériques', 'People with 2+ cards': 'Personnes avec 2 badges ou plus',
  'Requests': 'Demandes', 'Issued': 'Émis', 'Returned / cancelled': 'Restitués / annulés', 'Waiting': 'En attente', 'Lost cards': 'Badges perdus', 'Doors used': 'Portes utilisées',
  'Refused entries ': 'Accès refusés', 'Battery alarms': 'Alarmes de piles', 'Batteries changed': 'Piles changées', 'Critical now': 'Critiques maintenant',
  'Low now': 'Faibles maintenant', 'Locks offline now': 'Serrures hors ligne maintenant', 'Maintenance opened / solved': 'Maintenance ouverte / résolue',
  'Day ': 'Jour', 'Holder': 'Titulaire', 'User group': 'Groupe', 'Card': 'Badge', 'Register': 'Registre', 'Issued by': 'Émis par', 'Valid until': 'Valide jusqu\'au', 'Now': 'Maintenant',
  'Door': 'Porte', 'Deadbolt': 'Verrou', 'Last used': 'Dernière utilisation', 'Date': 'Date', 'Number': 'Numéro', 'Request': 'Demande', 'Person': 'Personne', 'Department': 'Service', 'State': 'État',
  'Room / door': 'Chambre / porte', 'Guest keycards used': 'Badges clients utilisés', 'Entries': 'Entrées', 'First use': 'Première utilisation', 'Used at doors (first time)': 'Utilisés aux portes (première fois)',
  'Staff keycards ': 'Badges du personnel', 'Guest / other keycards': 'Badges clients / autres', 'Last use': 'Dernière utilisation', 'Why': 'Motif', 'Lock': 'Serrure', 'Door group': 'Groupe de portes',
  'Battery now': 'Pile maintenant', 'Alarms in period': 'Alarmes sur la période', 'Changes in period': 'Changements sur la période', 'Batteries in since': 'Piles en place depuis', 'Last report': 'Dernier relevé', 'Online': 'En ligne',
  'What': 'Quoi', 'Count': 'Nombre', 'Note': 'Remarque', 'Issued ': 'Émis le',
  // ---- feedback, demo, common
  'Feedback': 'Avis', 'What do you think?': 'Votre avis ?', 'Thank you': 'Merci', 'Send feedback': 'Envoyer l\'avis', 'Cancel': 'Annuler', 'Close': 'Fermer',
  'Your feedback was sent. It helps decide what to improve next.': 'Votre avis a été envoyé. Il aide à décider des prochaines améliorations.',
  'About this page or the portal in general: what works, what is confusing, what is missing.': 'Sur cette page ou le portail en général : ce qui fonctionne, ce qui est confus, ce qui manque.',
  'Demo Hotel': 'Hôtel de démonstration',
  'Made-up doors, people and keycards for trying the portal. Nothing is real and nothing is sent to Visionline.': 'Portes, personnes et badges fictifs pour essayer le portail. Rien n\'est réel et rien n\'est envoyé à Visionline.',
  'Good morning': 'Bonjour', 'Good afternoon': 'Bon après-midi', 'Good evening': 'Bonsoir',
  'Doors, keycards and locks, in one place.': 'Portes, badges et serrures, en un seul endroit.',
};
Object.assign(FR, {
  'Main': 'Principal', 'Critical alerts': 'Alertes critiques', 'Awaiting approval': 'En attente d\'approbation', 'Open requests': 'Demandes ouvertes',
  'Every door, keycard and lock, in one place.': 'Chaque porte, badge et serrure, en un seul endroit.',
  'Who opened which door, which keycards are in use, which locks need batteries, and who is in the building in an emergency. Read from Visionline; nothing is changed without a person asking for it.':
    'Qui a ouvert quelle porte, quels badges sont utilisés, quelles serrures ont besoin de piles, et qui est dans le bâtiment en cas d\'urgence. Lu depuis Visionline ; rien n\'est modifié sans qu\'une personne le demande.',
  'With the work e-mail address your hotel\'s administrator invited.': 'Avec l\'adresse e-mail professionnelle invitée par l\'administrateur de votre hôtel.',
  'With the work e-mail address your institution\'s administrator invited.': 'Avec l\'adresse e-mail professionnelle invitée par l\'administrateur de votre établissement.',
} satisfies Record<string, string>);
Object.assign(FR, {
  'What is happening at {site} right now: doors, keycards and locks.': 'Ce qui se passe à {site} en ce moment : portes, badges et serrures.', 'Updated': 'Mis à jour',
  'Issue a key': 'Émettre une clé',
} satisfies Record<string, string>);
Object.assign(FR, {
  'Not useful': 'Pas utile', 'A little useful': 'Un peu utile', 'Useful': 'Utile', 'Very useful': 'Très utile', 'Excellent': 'Excellent', 'How useful is it? (optional)': 'Est-ce utile ? (facultatif)',
} satisfies Record<string, string>);
Object.assign(FR, {
  'Print / PDF': 'Imprimer / PDF',
  'How this portal is set up: version, connector, licence, who can sign in, the Visionline operators linked to people, keycard types and the portal parameters.': 'La configuration de ce portail : version, connecteur, licence, qui peut se connecter, les opérateurs Visionline reliés aux personnes, les types de badges et les paramètres du portail.',
  'Visionline only, in one printable document: the version, AES and the locks on the first page, then every room and the user groups that open it, user groups, door groups, locks, Visionline operators, who has access to what and the Visionline system parameters.': 'Visionline uniquement, dans un document imprimable : la version, l\'AES et les serrures en première page, puis chaque chambre et les groupes qui l\'ouvrent, groupes d\'utilisateurs, groupes de portes, serrures, opérateurs Visionline, qui a accès à quoi et les paramètres système Visionline.',
} satisfies Record<string, string>);
Object.assign(FR, {
  'As of': 'Au', 'Different staff keycards used': 'Badges du personnel différents utilisés', 'Different guest / other keycards used': 'Badges clients / autres différents utilisés',
  'Keycard requests received': 'Demandes de badges reçues', 'Battery alarms from locks': 'Alarmes de piles des serrures', 'Open Visionline alarms now': 'Alarmes Visionline ouvertes maintenant',
  'Maintenance requests opened': 'Demandes de maintenance ouvertes', 'Critical alerts (monitoring)': 'Alertes critiques (surveillance)', 'Staff keycards in a generic name': 'Badges du personnel à un nom générique',
  'Doors opened with a keycard or mobile key': 'Portes ouvertes avec un badge ou une clé mobile', 'See the "Refused entries" report for each one': 'Voir le rapport « Accès refusés » pour le détail',
  'Reported by Visionline as made': 'Signalés par Visionline comme émis', 'New staff keycards in Visionline': 'Nouveaux badges du personnel dans Visionline', 'Put them in the holder\'s name': 'Les mettre au nom du titulaire',
  'Issued = keycards Visionline reported as made on its live feed (not staff keycards, not mobile keys). A keycard made while the connector was off is counted when first used at a door.':
    'Émis = badges que Visionline a signalés comme émis sur son flux en direct (hors badges du personnel et clés mobiles). Un badge émis pendant que le connecteur était arrêté est compté à sa première utilisation à une porte.',
  'Red: keycard in a generic name (nobody can tell who used it). Orange: the person holds more than one card, or the card ends within 30 days.':
    'Rouge : badge à un nom générique (impossible de savoir qui l\'a utilisé). Orange : la personne détient plus d\'un badge, ou le badge expire sous 30 jours.',
} satisfies Record<string, string>);
Object.assign(FR, {
  'Follow this browser / computer language': 'Suivre la langue de ce navigateur / ordinateur',
  'Preparing the report…': 'Préparation du rapport…',
  'It reads every lock, user group and keycard; on a large site this takes a few seconds.': 'Il lit chaque serrure, groupe d\'utilisateurs et badge ; sur un grand site cela prend quelques secondes.',
  'Still working. If nothing comes after 90 seconds the page says which step is slow.': 'Toujours en cours. Si rien n\'arrive après 90 secondes, la page indique l\'étape qui est lente.',
  'The server sent no report. Refresh the page; if it stays empty, send a screenshot of Connector health to support.': 'Le serveur n\'a envoyé aucun rapport. Actualisez la page ; s\'il reste vide, envoyez une capture de l\'État du connecteur au support.',
} satisfies Record<string, string>);
Object.assign(FR, {
 "What needs you now, shortcuts to everyday tasks, notices and the site at a glance.": "Ce qui vous attend, les raccourcis des tâches courantes, les annonces et le site en un coup d'œil.",
 "Daily and monthly reports: guest and staff keycards issued, who holds keycards, refused entries, batteries. Download as PDF or Excel, or have them e-mailed.": "Rapports quotidiens et mensuels : badges clients et du personnel émis, qui détient les badges, accès refusés, piles. En PDF ou Excel, ou par e-mail.",
 "Problems the portal found: doors or connector offline, lock alarms, low batteries. Each alert closes by itself once fixed; Mark as seen takes it off the count.": "Problèmes détectés : portes ou connecteur hors ligne, alarmes de serrures, piles faibles. Chaque alerte se ferme d'elle-même une fois réglée ; « Marquer comme vu » la retire du compteur.",
 "Who opened which door and when. Search by person, door or card number.": "Qui a ouvert quelle porte et quand. Recherche par personne, porte ou numéro de badge.",
 "Who is in the building now, from the last doors they used. Used for roll call in an emergency.": "Qui est dans le bâtiment maintenant, d'après les dernières portes utilisées. Sert à l'appel en cas d'urgence.",
 "Start a fire alarm or drill: roll call, doors and messages, then close it when it is over.": "Lancer une alarme incendie ou un exercice : appel, portes et messages, puis clôturer.",
 "Every lock event received from Visionline, with filters. Print gives a PDF that can be checked later.": "Chaque événement de serrure reçu de Visionline, avec filtres. L'impression donne un PDF vérifiable.",
 "For one room: which keycards opened it, whose they are and who issued them.": "Pour une chambre : quels badges l'ont ouverte, à qui ils sont et qui les a émis.",
 "Ask for, issue, verify and extend staff keycards; returns and cancellations; the register of who holds which card.": "Demander, émettre, vérifier et prolonger les badges du personnel ; restitutions et annulations ; le registre des détenteurs.",
 "The people and keycards in Visionline, which doors each card opens, and Card lookup by number or on the encoder.": "Les personnes et badges de Visionline, les portes que chaque badge ouvre, et la recherche de badge par numéro ou sur l'encodeur.",
 "Print staff ID cards with photo, name and department.": "Imprimer les cartes d'identité du personnel avec photo, nom et service.",
 "Battery state of every lock, from the locks' own alarms. Record new batteries here.": "État des piles de chaque serrure, d'après leurs alarmes. Enregistrez ici les piles changées.",
 "Online locks and gateways that are out of contact, with their EEID, so engineering can find them.": "Serrures en ligne et passerelles hors contact, avec leur EEID, pour que le service technique les retrouve.",
 "Read a lock's event report to find why it drains batteries, refuses cards or misbehaves.": "Lire le rapport d'événements d'une serrure pour comprendre pourquoi elle use ses piles, refuse des badges ou fonctionne mal.",
 "Maintenance requests for locks and doors: open, assign, solve.": "Demandes de maintenance des serrures et portes : ouvrir, attribuer, résoudre.",
 "People who can sign in to this portal: invite, choose their role, reset passwords or two-step sign-in.": "Les personnes qui peuvent se connecter : inviter, choisir le rôle, réinitialiser le mot de passe ou la connexion en deux étapes.",
 "Visionline account, connector, alerts and e-mail, keycard rules, modules and the licence.": "Compte Visionline, connecteur, alertes et e-mail, règles des badges, modules et licence.",
 "The program on the Visionline server that links the portal and Visionline: version, last contact, errors.": "Le programme sur le serveur Visionline qui relie le portail à Visionline : version, dernier contact, erreurs.",
 "The Visionline setup report (version, AES, locks, user groups…) and the portal setup report. Printable.": "Le rapport de configuration Visionline (version, AES, serrures, groupes…) et celui du portail. Imprimables.",
 "Every sign-in and change, who did it and when. Cannot be altered.": "Chaque connexion et modification, par qui et quand. Inaltérable.",
 "Logo, colours and the name shown on the portal, the sign-in page and printed reports.": "Logo, couleurs et nom affichés sur le portail, la page de connexion et les rapports imprimés.",
 "Which pages are used, and by how many people.": "Quelles pages sont utilisées, et par combien de personnes.",
 "Who went where, who is in the building, emergencies and the event log.": "Qui est allé où, qui est dans le bâtiment, urgences et journal des événements.",
 "Staff keycards, Visionline people and cards, ID cards and mobile keys.": "Badges du personnel, personnes et badges Visionline, cartes d'identité et clés mobiles.",
 "Batteries, online locks and gateways, troubleshooting and maintenance.": "Piles, serrures en ligne et passerelles, diagnostic et maintenance.",
 "Users, settings, connector, setup reports and the audit trail (administrators).": "Utilisateurs, paramètres, connecteur, rapports de configuration et piste d'audit (administrateurs).",
 "Put the keycard on an encoder: see whose it is, which doors it opens and until when, then extend it if needed.": "Posez le badge sur un encodeur : à qui il est, quelles portes il ouvre et jusqu'à quand, puis prolongez-le si besoin.",
 "Type the number printed on a card (or read it on an encoder) to find its holder and doors.": "Saisissez le numéro imprimé sur un badge (ou lisez-le sur un encodeur) pour trouver son titulaire et ses portes.",
 "Ask for a new keycard, a replacement or a return when someone leaves.": "Demander un nouveau badge, un remplacement ou une restitution au départ de quelqu'un.",
 "Everyone in the building now, from the last doors they used.": "Toutes les personnes dans le bâtiment maintenant, d'après les dernières portes utilisées.",
 "Every door opened or refused, with who and when.": "Chaque porte ouverte ou refusée, avec qui et quand.",
 "Locks whose batteries are low or critical, to change them before they stop.": "Serrures aux piles faibles ou critiques, à changer avant qu'elles ne s'arrêtent.",
 "Daily and monthly reports to read, download or e-mail.": "Rapports quotidiens et mensuels à lire, télécharger ou envoyer par e-mail.",
 "Open alerts: what is wrong and how it closes.": "Alertes ouvertes : ce qui ne va pas et comment elles se ferment.",
 "Find a page, a person, a door or a card number. Shortcut: Ctrl K.": "Trouver une page, une personne, une porte ou un numéro de badge. Raccourci : Ctrl K.",
 "Tell us what works, what is confusing or what is missing on this page.": "Dites-nous ce qui fonctionne, ce qui est confus ou ce qui manque sur cette page.",
 "Light or dark like this computer": "Clair ou sombre comme cet ordinateur",
 "Always light": "Toujours clair",
 "Always dark": "Toujours sombre",
 "A PDF with a fingerprint: Verify a PDF (Event log) shows whether anyone changed it.": "Un PDF avec empreinte : « Vérifier un PDF » (Journal des événements) montre s'il a été modifié.",
 "A file that opens in Excel, with every line of the report.": "Un fichier qui s'ouvre dans Excel, avec toutes les lignes du rapport."
} satisfies Record<string, string>);
Object.assign(FR, {
  "Find why a lock drains its batteries: battery changes, parts changed (elimination method) and the lock's event reports.": "Trouver pourquoi une serrure use ses piles : changements de piles, pièces changées (méthode d'élimination) et rapports d'événements de la serrure.",
  'Record batteries or parts changed on a lock, and what was checked. The portal then tells from the next lock report whether it worked.': "Enregistrer les piles ou pièces changées sur une serrure et ce qui a été vérifié. Le portail dit ensuite, d'après le rapport suivant, si cela a réglé le problème.",
  'Battery changes, work done on this lock and whether the batteries are fine since.': 'Changements de piles, travaux faits sur cette serrure et si les piles tiennent depuis.',
} satisfies Record<string, string>);
