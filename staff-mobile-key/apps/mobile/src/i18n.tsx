import { createContext, useContext } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { getLocales } from 'expo-localization';

/** English and French (Cameroon). Hotel wording overrides from the portal apply to English. */
const en = {
  keys: 'Keys', support: 'Help', profile: 'Profile',
  goodMorning: 'Good morning', goodAfternoon: 'Good afternoon', goodEvening: 'Good evening',
  accessAreas: 'Access areas', validUntil: 'Valid until', validFrom: 'From', regNo: 'Reg. no.',
  startsAt: (d: string) => `Starts ${d}`, endedWrongDoor: 'Cancelled: wrong doors', endedVisionline: 'Cancelled by the hotel', doors: 'Doors', door: 'door', doorsN: 'doors',
  noKeyH: 'No key for you right now', noKeyT: 'When your supervisor assigns your rooms, your key appears here and you’ll get a notification.',
  st_ISSUED: 'Ready to use', st_ISSUING: 'Arriving on your phone', st_QUEUED: 'Being prepared', st_SCHEDULED: 'Starts later',
  st_REVOKING: 'Being removed', st_REVOKED: 'Removed by the hotel', st_EXPIRED: 'Expired', st_FAILED: 'Could not be delivered',
  failedHint: 'Open the app with internet on. If this continues, contact your supervisor.',
  issuingHint: 'Keep the app open with internet on. This usually takes a few seconds.',
  tap: 'Hold your phone near the lock', tapSim: 'Tap, then choose a door', talking: 'Talking to the lock…',
  bluetoothOn: 'Bluetooth on', bluetoothOff: 'Bluetooth off', online: 'Online', offline: 'Offline — keys still work',
  keyReady: 'Key ready', simulated: 'Simulated lock',
  opened: (d: string) => `${d} unlocked`, notOpened: (d: string) => `${d || 'Door'} did not open`,
  deniedHelp: 'If you should have access, contact your supervisor.',
  doorsOnKey: 'Doors on your key', showDoors: 'Show doors', hideDoors: 'Hide doors',
  timeLeft: (h: number, m: number) => (h ? `${h} h ${m} min left` : `${m} min left`), endsSoon: 'Ends soon',
  earlier: 'Earlier', whichDoor: 'Which door are you at?', simOnly: 'Simulator only: a real phone talks to the closest lock over Bluetooth.',
  notOnKey: 'Not on key', cancel: 'Cancel', openMap: 'Open map', address: 'Address',
  // Sign in / set-up
  signInH: 'Sign in with your work account', workEmail: 'Work email', password: 'Password', signIn: 'Sign in', signingIn: 'Signing in…',
  troubleSignIn: (phone?: string) => `Trouble signing in? Ask your supervisor${phone ? ` or call ${phone}` : ''}.`,
  setupH: 'Set up this phone', setupIntro: (n: string) => `Hi ${n}. This takes about a minute and is done once per phone.`,
  stepSignedIn: 'Signed in', stepRegistered: 'Phone registered for mobile keys', stepReady: 'Phone ready to receive keys',
  beforeStart: 'Before you start', bs1: 'Turn on Bluetooth: the locks read your key over Bluetooth.', bs2: 'Stay connected to Wi-Fi or mobile data during set-up.',
  bs3: 'Use your own work phone. The key works only on this phone.', simBuild: 'Development build: using the lock simulator instead of the ASSA ABLOY SDK.',
  setupBtn: 'Set up this phone', settingUp: 'Setting up…', signOut: 'Sign out', setupSlow: 'Set-up is taking longer than usual. Keep the app open with internet on, then try again.',
  // Help / profile
  doorWontOpen: 'Door won’t open?', doorWontOpenT: 'Check Bluetooth is on, hold the top of your phone close to the lock, and wait a second.',
  call: (n: string) => `Call ${n}`, privacy: 'Privacy', privacyDefault: 'Your key is stored in your phone’s secure storage and can be removed by the hotel at any time.',
  thisPhone: 'This phone', readySince: (d: string) => `Ready for mobile keys since ${d}.`, changingPhones: 'Changing phones? Ask an administrator to remove this phone first, then set up the new one.',
  notifications: 'Notifications', nothingYet: 'Nothing yet.', language: 'Language', theHotel: 'the hotel', hotelInfo: 'Hotel',
  // Maintenance (Phase 2)
  tasks: 'Tasks', myTasks: 'My tasks', noTasksH: 'No tasks for you', noTasksT: 'Maintenance requests given to you appear here, and you get a notification.',
  report: 'Report a problem', reportH: 'Report a problem', whatsWrong: 'What is wrong?', whatsWrongPh: 'For example: shower drains slowly', where: 'Where?', wherePh: 'Room 204, lobby, kitchen…',
  details: 'Details (optional)', send: 'Send', sending: 'Sending…', reportSent: (n: number) => `Request #${n} sent to the maintenance team.`, reportedByMe: 'Reported by me',
  due: (d: string) => `Due ${d}`, overdue: 'Overdue', unassigned: 'Not assigned yet',
  t_OPEN: 'New', t_ACKNOWLEDGED: 'Acknowledged', t_IN_PROGRESS: 'In progress', t_ON_HOLD: 'On hold', t_RESOLVED: 'Resolved', t_CLOSED: 'Closed', t_CANCELLED: 'Cancelled',
  p_urgent: 'Urgent', p_high: 'High', p_normal: 'Normal', p_low: 'Low',
  c_lock: 'Lock', c_door: 'Door', c_room: 'Room', c_electrical: 'Electrical', c_plumbing: 'Plumbing', c_other: 'Other', c_battery: 'Lock battery',
  acknowledge: 'Acknowledge', startWork: 'Start work', putOnHold: 'Put on hold', resume: 'Resume', resolve: 'Mark done',
  whatDone: 'What did you do?', whatDonePh: 'Required, for example: replaced the batteries', whyHold: 'Why on hold?', whyHoldPh: 'For example: waiting for a part',
  batteryReplaced: 'Lock battery replaced', comment: 'Comment', addComment: 'Add a comment', activity: 'Activity', close: 'Close', confirm: 'Confirm',
  a_created: 'opened the request', a_comment: 'commented', a_assigned: 'assigned it', a_status: 'changed the status', a_priority: 'changed the priority', a_due: 'changed the due time', a_attachment: 'attached a file', a_battery: 'battery update', a_edited: 'edited it',
};
type Dict = typeof en;
const fr: Dict = {
  keys: 'Clés', support: 'Aide', profile: 'Profil',
  goodMorning: 'Bonjour', goodAfternoon: 'Bon après-midi', goodEvening: 'Bonsoir',
  accessAreas: 'Zones d’accès', validUntil: 'Valable jusqu’à', validFrom: 'À partir de', regNo: 'N° d’enreg.',
  startsAt: (d: string) => `Commence ${d}`, endedWrongDoor: 'Annulée : mauvaises portes', endedVisionline: 'Annulée par l’hôtel', doors: 'Portes', door: 'porte', doorsN: 'portes',
  noKeyH: 'Aucune clé pour le moment', noKeyT: 'Quand votre responsable vous attribue vos chambres, votre clé apparaît ici et vous recevez une notification.',
  st_ISSUED: 'Prête', st_ISSUING: 'En cours d’envoi', st_QUEUED: 'En préparation', st_SCHEDULED: 'Commence plus tard',
  st_REVOKING: 'En cours de retrait', st_REVOKED: 'Retirée par l’hôtel', st_EXPIRED: 'Expirée', st_FAILED: 'Non livrée',
  failedHint: 'Ouvrez l’application avec Internet activé. Si le problème persiste, contactez votre responsable.',
  issuingHint: 'Gardez l’application ouverte avec Internet activé. Cela prend quelques secondes.',
  tap: 'Approchez votre téléphone de la serrure', tapSim: 'Touchez, puis choisissez une porte', talking: 'Communication avec la serrure…',
  bluetoothOn: 'Bluetooth activé', bluetoothOff: 'Bluetooth désactivé', online: 'En ligne', offline: 'Hors ligne — les clés fonctionnent',
  keyReady: 'Clé prête', simulated: 'Serrure simulée',
  opened: (d: string) => `${d} déverrouillée`, notOpened: (d: string) => `${d || 'La porte'} ne s’est pas ouverte`,
  deniedHelp: 'Si vous devriez y avoir accès, contactez votre responsable.',
  doorsOnKey: 'Portes sur votre clé', showDoors: 'Voir les portes', hideDoors: 'Masquer les portes',
  timeLeft: (h: number, m: number) => (h ? `encore ${h} h ${m} min` : `encore ${m} min`), endsSoon: 'Se termine bientôt',
  earlier: 'Précédemment', whichDoor: 'Devant quelle porte êtes-vous ?', simOnly: 'Simulateur uniquement : un vrai téléphone parle à la serrure la plus proche en Bluetooth.',
  notOnKey: 'Pas sur la clé', cancel: 'Annuler', openMap: 'Ouvrir le plan', address: 'Adresse',
  signInH: 'Connectez-vous avec votre compte professionnel', workEmail: 'E-mail professionnel', password: 'Mot de passe', signIn: 'Se connecter', signingIn: 'Connexion…',
  troubleSignIn: (phone?: string) => `Un problème ? Demandez à votre responsable${phone ? ` ou appelez le ${phone}` : ''}.`,
  setupH: 'Configurer ce téléphone', setupIntro: (n: string) => `Bonjour ${n}. Cela prend environ une minute, une seule fois par téléphone.`,
  stepSignedIn: 'Connecté', stepRegistered: 'Téléphone enregistré pour les clés mobiles', stepReady: 'Téléphone prêt à recevoir des clés',
  beforeStart: 'Avant de commencer', bs1: 'Activez le Bluetooth : les serrures lisent votre clé en Bluetooth.', bs2: 'Restez connecté au Wi-Fi ou aux données mobiles pendant la configuration.',
  bs3: 'Utilisez votre propre téléphone professionnel. La clé ne fonctionne que sur ce téléphone.', simBuild: 'Version de développement : simulateur de serrure au lieu du SDK ASSA ABLOY.',
  setupBtn: 'Configurer ce téléphone', settingUp: 'Configuration…', signOut: 'Se déconnecter', setupSlow: 'La configuration prend plus de temps que prévu. Gardez l’application ouverte avec Internet, puis réessayez.',
  doorWontOpen: 'La porte ne s’ouvre pas ?', doorWontOpenT: 'Vérifiez que le Bluetooth est activé, approchez le haut du téléphone de la serrure et attendez une seconde.',
  call: (n: string) => `Appeler ${n}`, privacy: 'Confidentialité', privacyDefault: 'Votre clé est conservée dans le stockage sécurisé du téléphone et peut être retirée par l’hôtel à tout moment.',
  thisPhone: 'Ce téléphone', readySince: (d: string) => `Prêt pour les clés mobiles depuis le ${d}.`, changingPhones: 'Vous changez de téléphone ? Demandez d’abord à un administrateur de retirer celui-ci, puis configurez le nouveau.',
  notifications: 'Notifications', nothingYet: 'Rien pour le moment.', language: 'Langue', theHotel: 'l’hôtel', hotelInfo: 'Hôtel',
  tasks: 'Tâches', myTasks: 'Mes tâches', noTasksH: 'Aucune tâche pour vous', noTasksT: 'Les demandes de maintenance qui vous sont confiées apparaissent ici, avec une notification.',
  report: 'Signaler un problème', reportH: 'Signaler un problème', whatsWrong: 'Quel est le problème ?', whatsWrongPh: 'Par exemple : la douche s’écoule mal', where: 'Où ?', wherePh: 'Chambre 204, hall, cuisine…',
  details: 'Détails (facultatif)', send: 'Envoyer', sending: 'Envoi…', reportSent: (n: number) => `Demande n° ${n} envoyée à l’équipe de maintenance.`, reportedByMe: 'Signalés par moi',
  due: (d: string) => `Pour le ${d}`, overdue: 'En retard', unassigned: 'Pas encore attribuée',
  t_OPEN: 'Nouvelle', t_ACKNOWLEDGED: 'Prise en compte', t_IN_PROGRESS: 'En cours', t_ON_HOLD: 'En attente', t_RESOLVED: 'Terminée', t_CLOSED: 'Clôturée', t_CANCELLED: 'Annulée',
  p_urgent: 'Urgente', p_high: 'Haute', p_normal: 'Normale', p_low: 'Basse',
  c_lock: 'Serrure', c_door: 'Porte', c_room: 'Chambre', c_electrical: 'Électricité', c_plumbing: 'Plomberie', c_other: 'Autre', c_battery: 'Pile de serrure',
  acknowledge: 'Prendre en compte', startWork: 'Commencer', putOnHold: 'Mettre en attente', resume: 'Reprendre', resolve: 'Marquer terminé',
  whatDone: 'Qu’avez-vous fait ?', whatDonePh: 'Obligatoire, par exemple : piles remplacées', whyHold: 'Pourquoi en attente ?', whyHoldPh: 'Par exemple : en attente d’une pièce',
  batteryReplaced: 'Pile de la serrure remplacée', comment: 'Commenter', addComment: 'Ajouter un commentaire', activity: 'Historique', close: 'Fermer', confirm: 'Confirmer',
  a_created: 'a ouvert la demande', a_comment: 'a commenté', a_assigned: 'l’a attribuée', a_status: 'a changé le statut', a_priority: 'a changé la priorité', a_due: 'a changé l’échéance', a_attachment: 'a joint un fichier', a_battery: 'mise à jour de la pile', a_edited: 'l’a modifiée',
};
export const DICTS = { en, fr } as const;
export type Lang = keyof typeof DICTS;
export const LANG_NAMES: Record<Lang, string> = { en: 'English', fr: 'Français' };

const KEY = 'smk_lang';
let memory: Lang | null = null;
export async function loadLang(): Promise<Lang> {
  try {
    const saved = (Platform.OS === 'web' ? memory : await SecureStore.getItemAsync(KEY)) as Lang | null;
    if (saved && saved in DICTS) return saved;
  } catch { /* fall through */ }
  const device = getLocales()[0]?.languageCode ?? 'en';
  return device in DICTS ? (device as Lang) : 'en';
}
export async function saveLang(l: Lang) {
  if (Platform.OS === 'web') { memory = l; return; }
  try { await SecureStore.setItemAsync(KEY, l); } catch { /* not critical */ }
}

export const I18nCtx = createContext<{ lang: Lang; t: Dict; setLang: (l: Lang) => void; locale: string }>({ lang: 'en', t: en, setLang: () => {}, locale: 'en' });
export const useT = () => useContext(I18nCtx);
