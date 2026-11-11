# Access Monitoring Tool — manuel d'utilisation (2.33.1)

Nouveau ? Commencez par le **démarrage rapide** (5 étapes, ajouter des personnes, tâches courantes).

Le portail fonctionne à côté d'ASSA ABLOY Visionline. Visionline reste le système qui encode les badges et dialogue
avec les serrures ; le portail y lit des informations (personnes, badges, événements de serrure), ajoute ce que
Visionline ne fait pas (rapports, présence en direct, cartes d'identité, pointage…) et, là où c'est activé, délivre
les clés mobiles du personnel par son intermédiaire.

Rien dans le portail ne peut bloquer quelqu'un : les portes continuent de fonctionner exactement comme Visionline le
dit, même quand le portail ou son serveur est arrêté.

## 1. Se connecter et s'orienter

- Ouvrez l'adresse du portail donnée par votre service informatique (par exemple `https://vl01.hotel.local:9443`)
  dans Chrome ou Edge.
- Connectez-vous avec votre e-mail et votre mot de passe. Si la connexion en deux étapes est activée, saisissez aussi
  le code à 6 chiffres de votre application d'authentification. Après 5 mauvais mots de passe, le compte attend
  15 minutes.
- **Rechercher partout** : appuyez sur **Ctrl K** (⌘K sur Mac) et tapez une page, une personne, une porte ou un
  numéro de badge.
- **Votre menu** : *Votre compte → Menu et apparence* — décochez les pages que vous n'utilisez jamais. Elles
  disparaissent seulement de votre menu (elles restent accessibles avec Ctrl K). « L'essentiel Visionline seulement »
  ne garde que les pages Visionline.
- **Clair ou sombre** : le bouton en bas du menu (Automatique suit Windows), ou *Votre compte → Menu et apparence*.
  Votre choix vous suit sur tout ordinateur.
- **Aide** : *Aide et manuel* en bas du menu ouvre ce manuel.
- **Aide au survol (2.29)** : posez la souris sur un élément du menu, un onglet, un raccourci ou un bouton : une
  courte explication apparaît, et disparaît dès que la souris s'éloigne (ou qu'une touche est pressée). Au clavier,
  elle apparaît au focus. Désactivez-la dans *Mon compte → Menu et apparence* (sur cet ordinateur).

Ce que vous voyez dépend de votre rôle. Un administrateur d'hôtel peut aussi désactiver des modules entiers
(*Paramètres → Modules*), ou choisir **Orientation du portail : Visionline uniquement**, qui masque les clés mobiles, le
pointage, le petit-déjeuner, les piles et la maintenance à tous sauf aux administrateurs.

## 2. Accueil

La première page commence par **À faire maintenant** : seulement ce qui vous attend *vous* (demandes de badge à
traiter, blocages à approuver, départs à libérer, badges qui se terminent cette semaine, une urgence), mis à jour
tout seul, avec des actions rapides en dessous. Puis les chiffres du jour et ce qui demande de l'attention. Cliquez sur
une carte pour ouvrir la page correspondante.

## 3. Badges et personnes Visionline

Tout ce que Visionline sait des personnes et de leurs badges, en lecture seule.

- **Personnes** : chaque utilisateur Visionline (par groupe d'utilisateurs), ses badges valides, ses portes, leur
  validité et qui les a délivrés.
- **Recherche de badge** : tapez un numéro de badge, ou posez le badge sur l'encodeur et cliquez sur **Lire le badge
  sur l'encodeur** : le portail indique à qui il est, ses portes, sa validité, s'il peut passer outre le verrou, et
  les portes qu'il a ouvertes récemment. La lecture sur l'encodeur est limitée à quelques lectures par minute pour
  laisser Visionline disponible pour la réception et le GRMS.
- Les données sont actualisées par la synchronisation *Analyses* (*Paramètres → Rapports et synchronisation*).
  Choisissez **Uniquement la nuit (22:00–06:00)** pour laisser Visionline au PMS et au GRMS pendant la journée.

## 4. Historique des accès

« Quelles portes cette personne a-t-elle ouvertes ? » et « Qui est passé par cette porte ? ».

1. Tapez un nom, une porte, ou choisissez parmi les suggestions.
2. Choisissez la période (7, 30, 90 jours…).
3. Lisez les chiffres, le graphique par jour, la liste des portes et la chronologie. Cliquez sur une porte pour voir qui
   d'autre y est passé.

Seul ce que les serrures ont transmis à Visionline est connu. Les serrures hors ligne transmettent quand un badge passé
par elles est utilisé sur un lecteur en ligne ou quand la serrure est lue.

## 5. Journal des événements

Chaque événement de serrure reçu de Visionline (entrées, entrées refusées, alarmes, piles), chaque événement de clé
mobile et les événements système, avec des filtres (période, type, porte, personne, badge connu/inconnu).
**Imprimer** produit un PDF avec une empreinte (SHA-256) qui peut être vérifiée plus tard dans *Vérifier un PDF* :
toute modification du fichier se voit.

### 5l. Nouveau en 2.33.1 : tout en français, État du connecteur épuré, code de configuration

- **Tout en français.** Avec Auto (un ordinateur en français) ou Français, chaque page est en français, y compris les
  messages d'erreur du serveur (« E-mail ou mot de passe incorrect. »), les alertes, les dates et ce manuel.
- **État du connecteur** n'affiche plus que ce qui concerne cette installation : les contrôles de préparation (les
  contrôles des clés mobiles seulement quand les clés mobiles sont activées) et les portes et groupes lus dans
  Visionline. Les notes sur les réponses d'ASSA ABLOY à un autre site ne sont plus affichées.
- **Code de configuration.** La page de configuration indique où trouver le code. Sur le serveur : menu Démarrer →
  **Access Monitoring Tool - setup code** ; Windows demande l'autorisation d'administrateur, puis affiche le code et
  le copie dans le presse-papiers. Le fichier `setup-code.txt` reste lisible par les administrateurs uniquement.
- **Installation propre** : voir le démarrage rapide, *Installation propre*.

### 5k. Nouveau en 2.27 : Rapports, les deux rapports de configuration, un menu plus court et le français

**Rapports** (menu → *Rapports*) réunit tous les rapports au même endroit. Choisissez un rapport à gauche, puis
**Jour** ou **Mois** (hier et le mois dernier sont à un clic). Chaque rapport affiche ses chiffres, puis la liste
complète, et peut être **téléchargé en PDF** (avec empreinte, vérifiable dans *Vérifier un PDF*), **téléchargé pour
Excel (CSV)**, ou **envoyé par e-mail immédiatement** à une ou plusieurs adresses (le PDF et le CSV sont joints).

| Rapport | Ce qu'il indique |
|---|---|
| Résumé quotidien | Entrées, entrées refusées, badges clients et du personnel délivrés, demandes de badge, alarmes de piles, serrures hors ligne, alarmes ouvertes, maintenance : une page par jour ou par mois |
| Badges clients délivrés | Combien de badges clients Visionline a créés, et dans quelles chambres ils ont servi ; pour un mois, une ligne par jour |
| Badges du personnel délivrés | Chaque badge du personnel créé dans la journée ou le mois : pour qui, groupe d'utilisateurs, badge, qui l'a délivré, valable jusqu'au, encore en service ou non |
| Qui détient les badges du personnel | Chaque badge du personnel valide actuellement : titulaire, groupe d'utilisateurs, numéro de badge et de registre, portes, passe-outre du verrou, valable jusqu'au, qui l'a délivré, dernière utilisation. Noms génériques en rouge ; personnes avec deux badges ou badges se terminant sous 30 jours en orange |
| Demandes et retours de badges | Demandes de nouveau badge, de remplacement, de retour et d'annulation, leur état et qui les a traitées |
| Activité des portes | Pour chaque porte : entrées, entrées refusées, nombre de badges du personnel et clients utilisés, dernière utilisation |
| Entrées refusées | Chaque entrée refusée : quand, porte, badge, à qui, pourquoi |
| Serrures et piles | Alarmes et changements de piles, état actuel des piles, depuis combien de temps les piles sont en place, serrures hors ligne |

*Plus de rapports*, sur la même page, renvoie vers les Analyses, Mes graphiques, le Journal des événements imprimable,
Badges par chambre, le rapport quotidien Comptabilité et les deux rapports de configuration.

**Envoyés par e-mail chaque jour ou chaque mois** (administrateurs) : dans *Rapports envoyés par e-mail*, choisissez le
rapport, *Chaque jour* (la veille, à l'heure choisie) ou *Chaque mois* (le mois précédent, le 1er), et les adresses.
L'e-mail doit d'abord être configuré (*Paramètres → Alertes et notifications*). *Arrêter* y met fin. L'Hôtel de
démonstration n'en envoie jamais.

Comment les badges clients sont comptés : le flux en direct de Visionline signale chaque badge qu'il crée ; le rapport
compte ceux qui ne sont ni des badges du personnel ni des clés mobiles. Un badge client créé pendant que le connecteur
était arrêté est compté à sa première utilisation à une porte.

**Deux rapports de configuration** (*Administration → Rapports de configuration*) :

- **Rapport de configuration Visionline** : Visionline uniquement. Sa première page, *En un coup d'œil*, indique
  clairement la **version de Visionline**, si le **chiffrement AES est activé**, le **nombre de serrures** (en ligne et
  autonomes, par catégorie et par groupe de portes), les groupes d'utilisateurs, les groupes de portes, les encodeurs,
  les personnes et les badges valides, puis le code et l'ID système, la version de l'API Web, le paquet de
  micrologiciel, les options sous licence et les réglages par défaut des badges clients. La version et l'AES viennent
  du **rapport des paramètres système** de Visionline : importez-le sur la même page (*Importer un rapport
  Visionline*). Si le rapport ne mentionne pas l'AES, la page le dit et indique où vérifier dans Visionline, plutôt
  que de deviner.
- **Rapport de configuration du portail** : ce portail uniquement : sa version, le connecteur, l'opérateur Visionline
  qu'utilise le portail, la licence, qui peut se connecter (avec ou sans connexion en deux étapes), quelle personne
  est chaque opérateur Visionline, les types de badge et les paramètres du portail.

2.27.1 : pendant la préparation du rapport de configuration, la page l'indique et compte les secondes. Au-delà de
90 secondes, elle dit quelle étape est lente et ce qui occupe la base de données, au lieu de rester vide. Le rapport de
configuration du portail est préparé à part, il s'affiche donc même quand la partie Visionline est lente.

**Fermeture des alertes (2.27.1)** : une alerte se ferme d'elle-même en moins d'une minute une fois le problème
réglé ; la ligne sous chaque alerte indique comment (la porte transmet de nouveau, piles neuves enregistrées, alarme
terminée dans Visionline, connecteur revenu…). **Marquer comme vu** (ou **Tout marquer comme vu**, pour toutes ou un
type) indique que quelqu'un s'en occupe : elle sort du compteur rouge du menu et passe dans *Vues*, toujours listée
jusqu'à sa résolution. Les alertes de porte silencieuse peuvent être désactivées dans *Paramètres → Alertes et
notifications*.

**Mode de clé AES (2.28)** : la première page lit la section *[Security enhancement process]* que Visionline 1.28 ou
plus récent écrit dans ses paramètres système (guide ASSA ABLOY *Switch to AES key mode*, 66 5013 166-1B) :

| Mode de clé dans Visionline | La première page affiche | Signification |
|---|---|---|
| Non commencé | Mode de clé ancien (rouge) | Les badges utilisent le mode de clé ancien |
| En cours | En cours (orange) | Clé de site AES générée ; serrures en cours de mise à jour et d'initialisation ; badges encore en mode ancien |
| Terminé | AES (terminé) (vert) | Visionline crée des badges AES ; quand le badge *Désactiver le mode de clé ancien* a été créé, elle l'indique (les serrures n'acceptent plus les anciens badges dès qu'il leur est présenté) |

Les *informations d'authentification connues* (par exemple *Ultralight AES signature*) sont listées à part comme
authentifications de badge que Visionline sait lire : ce n'est pas le mode de clé. La ligne *clé de chiffrement PMS*
concerne l'interface PMS, pas les badges.

Aussi sur la première page : **Clients autorisés** (d'après les lignes de licence du rapport), **Licence clés
mobiles** (Sous licence, Démo ou Aucune, d'après les options sous licence ou une ligne de licence qui indique démo /
essai), **Interface PMS** (les options et réglages PMS et, quand une liste des badges avec l'opérateur a été importée,
combien de badges ont été créés par l'opérateur de l'interface PMS et quand le dernier l'a été), et **Amélioration
DESFire EV1**. Quand le rapport ne contient pas l'une de ces informations, la page le dit : Visionline → *Aide → À
propos* / *Outils → Code d'option* affichent la licence.

**Un menu plus court** : Accueil, Rapports et Alertes en haut, puis quatre sections qui s'ouvrent une à la fois :
*Portes et sécurité*, *Badges et personnel*, *Serrures* et *Administration*. La section de la page où vous êtes
s'ouvre d'elle-même ; une section fermée affiche un nombre quand quelque chose demande de l'attention (piles
critiques, serrures hors ligne…).

**Langues** : **Auto**, English ou Français, en bas du menu et sur la page de connexion. **Auto** (par défaut,
2.27.1) suit la langue du navigateur, qui suit normalement Windows (*Paramètres → Heure et langue → Langue* ; dans
Chrome ou Edge, *Paramètres → Langues*) : un ordinateur réglé en français ouvre le portail en français. Choisir
English ou Français garde cette langue sur cet ordinateur et avec votre compte. Depuis 2.33.1, tout le portail est en
français : chaque page, bouton, info-bulle et message, les erreurs renvoyées par le serveur, les dates et les nombres,
et ce manuel. Un mot pas encore traduit reste en anglais plutôt que de casser la page.

### 5j. Nouveau en 2.26 : lire un badge sur l'encodeur

Visionline n'utilise pas partout le même nom pour « lire le badge sur l'encodeur ». Quand il répond *Invalid query
parameter value*, le connecteur (0.16.1) essaie une fois l'autre nom (la lecture ne modifie rien), et la plateforme
garde celui qui fonctionne (Paramètres → Rapports et synchronisation → Encodeurs). 2.26.1 (connecteur 0.16.2) essaie
aussi le nom de l'encodeur avec son espace écrit « + » (pour des noms comme « Encoder .96 »), retient la forme qui
fonctionne aussi pour l'encodage et, quand rien ne fonctionne, liste la réponse de Visionline à chaque forme. Si le
connecteur du serveur Visionline est plus ancien, le message le dit : installez le dernier installateur avec
**Everything** (État du connecteur affiche la version du connecteur).

### 5i. Nouveau en 2.25 : Hôtel de démonstration, testeurs et avis

- **Avis** (en bas à droite de chaque page) : quelques mots et une note facultative de 1 à 5, avec la page où vous
  étiez.
- **Administration → Hôtel de démonstration et testeurs** (administrateurs de la plateforme) : un site avec des
  données fictives, des liens d'invitation à usage unique pour des testeurs avec un accès de 1, 7 ou 14 jours, l'état
  des testeurs, et tous les avis (export CSV). Les testeurs ne voient que l'Hôtel de démonstration ; rien n'y est
  envoyé à Visionline.

### 5h. Nouveau en 2.24 : page de connexion et orientation

- **Page de connexion :** le logo et le nom de l'établissement, un badge présenté à une serrure, ce que fait chaque
  équipe dans le portail, les publications publiques du tableau d'affichage, et *Mot de passe oublié ou première
  visite ?* (lien d'invitation, lien de mot de passe d'un administrateur, réinitialisation des deux étapes, contacts
  d'aide de l'établissement définis dans Paramètres → Nom et coordonnées). Elle fonctionne aussi sur téléphone.
- **Raccourcis de l'Accueil :** les tâches courantes que cette personne peut faire, à un clic : vérifier ou prolonger
  un badge, rechercher un badge, demande de badge, client impayé, qui est dans le bâtiment, qui a ouvert une porte,
  piles des serrures, alertes.
- Chaque page a son propre titre d'onglet ; *Aller au contenu* pour les utilisateurs du clavier ; sur téléphone, le
  menu est une seule liste.
- Sur une adresse publique (Cloudflare Tunnel), les moteurs de recherche sont priés de ne pas référencer le portail
  (robots.txt et en-tête no-index), et le portail peut être ajouté à l'écran d'accueil d'un téléphone.

### 5g. Nouveau en 2.23 : vérifier un badge sur un encodeur et le prolonger

**Badges du personnel → Vérifier et prolonger** (aussi sur une demande délivrée : *Vérifier ce badge sur un encodeur,
ou le prolonger*) :

1. Posez le badge sur un encodeur, choisissez l'encodeur et cliquez sur **Lire le badge**. Visionline répond lui-même :
   à qui est le badge (et son numéro HK …), ses portes et groupes de portes, s'il fonctionne et jusqu'à quand — ou
   qu'il a pris fin, a été annulé ou remplacé par un badge plus récent. Un badge à un nom générique est signalé.
2. Pour lui donner plus de temps : choisissez **180 / 360 / 730 jours** ou une date, et cliquez sur **Prolonger
   jusqu'au …** pendant que le badge reste sur l'encodeur. Le badge est réécrit avec le même titulaire, les mêmes
   portes, groupes de portes et plage horaire ; seule la date d'expiration change. Le registre et la demande suivent
   la nouvelle date (et le nouveau numéro de badge Visionline).
3. Un badge qui avait **pris fin ou été annulé** peut être remis en service de la même façon, après avoir coché la
   confirmation.

Visionline garde un seul badge du personnel par personne : si le titulaire a un autre badge du personnel valide, le
portail le signale avant, car ce badge cesse de fonctionner. Prolonger nécessite le droit de délivrer des badges et
l'encodage activé (Paramètres → Badges et encodeurs) ; les badges avec des groupes de portes nécessitent le
connecteur 0.16.0 (dans l'installateur 2.23). La recherche de badge renvoie vers cette page (« Le badge en main ? »).

### 5f. Nouveau en 2.22 : vérifier un badge

**Vérifier avec Visionline** (Badges et personnes Visionline → Recherche de badge) et **Vérifier le badge** (Badges
du personnel → une demande avec un numéro de badge Visionline) demandent à Visionline *maintenant* si le badge est
valide, sa date de fin et ses portes. Les listes du portail sont lues à la demande, elles peuvent donc être plus
anciennes que Visionline ; Vérifier ne lit que le titulaire de ce badge (une personne), ce qui est léger pour
Visionline. Le même badge peut être vérifié de nouveau après 30 secondes. Un badge qui n'a jamais été lu dans
Visionline ne peut pas être vérifié par son titulaire : lisez-le sur un encodeur (Recherche de badge) ou cliquez sur
Actualiser depuis Visionline.

### 5e. Nouveau en 2.21

- **« Délivré depuis Visionline »** remplace « Bureau Visionline » pour les badges créés dans Visionline. Quand
  l'opérateur Visionline qui a créé le badge est connu, il est affiché, avec la personne derrière cet opérateur :
  *Délivré depuis Visionline · jdupont (Jean Dupont)*. L'opérateur est connu quand le badge a été enregistré sur la
  page Badges du personnel (champ *Opérateur Visionline qui l'a créé* ; vide = votre propre opérateur Visionline) ou
  d'après un journal des badges importé dans le rapport de configuration. L'API Web Visionline elle-même n'indique pas
  qui a créé un badge.
- **Qui est chaque opérateur Visionline :** Rapport de configuration → Opérateurs Visionline → *Qui est chaque
  opérateur Visionline* : un administrateur lie chaque opérateur Visionline à un utilisateur du portail. Les
  utilisateurs qui ont enregistré leur propre connexion Visionline sont liés automatiquement.
- **Les badges du personnel enregistrent qui les a délivrés :** la liste des demandes, la page d'une demande, le
  registre des badges et son export RH affichent *Délivré par* (l'utilisateur du portail), quand, et comment (encodé
  depuis le portail, délivré depuis Visionline avec l'opérateur, ou badge existant lié).
- **L'alarme de piles disparaît après 2 badges** acceptés par la serrure sans l'indicateur de piles faibles (au lieu
  de 3).
- **Les badges à un nom générique** sont aussi envoyés par e-mail aux administrateurs du site (chaque badge une fois),
  en plus de l'avertissement dans le portail et les Alertes.
- **Moins de fausses alarmes « Visionline injoignable » :** voir Alertes, connecteur 0.15.0.

### 5d. Nouveau en 2.20

- **« Ancien » revient** dans État des piles pour une serrure dont on n'a pas de nouvelles depuis le nombre de jours
  défini dans les Paramètres.
- **Durée de chaque jeu de piles.** État des piles indique, par serrure, depuis combien de jours les piles actuelles
  sont en place, combien de temps le jeu précédent a duré et la moyenne sur tous les jeux ; la page de la serrure liste
  chaque jeu (mis en place, retiré, jours, jours jusqu'au premier signalement de piles faibles). Le diagnostic des
  serrures affiche la même chose d'après un relevé chargé (« Les jeux ont duré 5, 10 jours »).
- **Une alarme de piles disparaît d'elle-même quand les badges fonctionnent normalement.** Quand la serrure accepte
  3 badges de suite (personnel ou client) sans enregistrer de nouveau l'indicateur de piles faibles, l'alarme et sa
  demande se ferment d'elles-mêmes — sauf si un relevé de tension indique que les piles sont à ou sous votre seuil.
  Paramètres → Piles et maintenance (3 par défaut ; 0 = désactivé).
- **Visionline est lu à la demande.** Les portes, groupes d'utilisateurs, personnes et badges sont lus quand quelqu'un
  clique sur **Actualiser depuis Visionline** (Badges et personnes Visionline, État des piles, Rapport de
  configuration) — par exemple après le chargement des données des serrures dans Visionline ou l'actualisation de ses
  ressources — au plus une fois toutes les 5 minutes. Les badges utilisés aux portes et les relevés de piles arrivent
  toujours au fil de l'eau. Paramètres → Rapports et synchronisation → *Selon un calendrier* rétablit les lectures
  régulières.
- **L'expiration d'un badge du personnel est une date.** Le formulaire de demande, la page de demande par QR code et
  le formulaire de délivrance ont une **Date d'expiration** ; le badge fonctionne jusqu'à la fin de ce jour. Vide : la
  durée définie dans les Paramètres.
- **Badges à un nom générique** (« Personnel », « HK 2 », « Réserve », un numéro…) : listés dans Badges du personnel
  et signalés aux administrateurs dans les Alertes tant qu'il en existe, car personne ne peut savoir qui les a
  utilisés.
- **Rapport de configuration :** *À voir* (chambres qu'aucun groupe d'utilisateurs n'ouvre, groupes qui ouvrent toutes
  les chambres, passe-outre du verrou, chambres clients ouvertes par des groupes du personnel, badges génériques…),
  **Groupes d'utilisateurs et chambres** (chaque chambre face à chaque groupe d'utilisateurs : ✓ directement, ◐ par un
  groupe de portes, et combien de personnes peuvent l'ouvrir ; filtres à l'écran, tout sur papier), et **Paramètres
  système** tirés du rapport des paramètres système de Visionline.
- **Accès extérieur sans IP publique** via Cloudflare Tunnel et votre propre domaine : voir EXTERNAL-ACCESS.md. Les
  invitations comportent alors aussi un lien extérieur.
- **Sécurité :** les autres sessions se terminent quand un mot de passe change ou que la connexion en deux étapes est
  réinitialisée ; chaque code à deux étapes ne fonctionne qu'une fois ; les mots de passe personnels doivent avoir
  12 caractères.

### 5c. Nouveau en 2.19

- **Une alarme de piles après des piles neuves est un défaut du micrologiciel.** Si une serrure déclenche une alarme
  de piles (même une seule fois) dans les 14 jours (Paramètres → Piles et maintenance) après le changement de ses
  piles, et que ses relevés de tension depuis le changement ne confirment pas des piles faibles, ce n'est pas un
  problème de piles : pas d'alarme de piles ni de demande « remplacer les piles ». Le portail ouvre à la place
  **Programmer la serrure et charger le micrologiciel**, et le note dans la piste d'audit
  (`battery.firmware_suspected`).
- **Seuil de 3,6 V.** Sur les serrures 3–4,8 V, un relevé de 3,6 V ou moins est critique : une alarme de piles et une
  demande « remplacer les piles ». Modifiable dans Paramètres → Piles et maintenance.
- *(2.20 a rétabli le mot « ancien » ; voir 5d.)*
- **Le diagnostic des serrures** demande maintenant de quelle serrure il s'agit : la porte (suggérée d'après le fichier)
  et le **modèle de serrure** (VingCard Signature RFID, Essence, Classic RFID, Allure ou autre), mémorisé pour la porte.
  Le relevé indique de quelle porte et de quel modèle il parle, et prévient quand le fichier concerne une autre
  chambre.
  - **Trouver la cause, étape par étape** (méthode d'élimination) : piles, porte-piles et contacts, mécanique de la
    porte et de la serrure, utilisation de la porte, lecteur de badge, Bluetooth, radio en ligne et passerelle,
    électronique de la serrure, micrologiciel, emplacement et climat. Chaque étape montre ce que dit le relevé
    (probable / possible / peu probable / à vérifier sur place) et ce qu'il faut vérifier sur la porte ; le technicien
    la marque *OK, écarté* ou *Problème trouvé*, avec une remarque. Un défaut du micrologiciel peut aussi user les
    piles : les autres causes sont donc écartées d'abord.
- **Serrures en ligne et passerelles** : les serrures que Visionline gère en ligne, si chacune est en contact (avec son
  dernier contact, sa passerelle, son modèle et ses piles), et les **passerelles** avec leur **EEID**, adresse,
  emplacement et les serrures derrière elles. Les administrateurs ajoutent des passerelles ou importent la liste (un
  tableau avec Nom, EEID, IP / Adresse, Emplacement, Portes). Une passerelle est hors ligne quand une alarme Visionline
  la nomme (son EEID, ou son nom avec « gateway »/« offline »…) ou quand toutes ses serrures sont hors ligne. **Les
  serrures et passerelles hors ligne déclenchent une alarme dans les Alertes qui se ferme d'elle-même à leur retour** ;
  la page liste ce qui est revenu. L'état en direct des passerelles venant de l'intégrateur réseau (Ruckus, Cisco…)
  sera ajouté dès que leur système pourra être lu.

### 5b. Nouveau en 2.18

- **Des piles neuves ferment l'alarme d'elles-mêmes.** Juste après des piles neuves, une serrure relève le haut de son
  échelle (« Niveau des piles inférieur à 4,8 volts », ou 9,0 V pour les paquets 6–9 V). Ce relevé ferme désormais
  l'alarme de piles et résout sa demande de maintenance, et compte comme un changement de piles. Paramètres → Piles et
  maintenance permet de le désactiver.
- *(2.19 a changé le traitement des alarmes de piles après des piles neuves et du mot « ancien » ; voir 5c.)*
- **Historique des serrures et méthode d'élimination (2.30)**, dans *Serrures → Diagnostic des serrures*, pour chaque
  hôtel. Le premier tableau liste chaque serrure avec un historique : son état (*Use ses piles*, *En attente d'un
  relevé*, *Résolu*), combien de fois ses piles ont été changées, combien de jours dure un jeu, les derniers travaux et
  la **prochaine pièce à vérifier**.
  1. Après chaque intervention, **Enregistrer des travaux sur une serrure** : la date, le modèle de serrure, le
     technicien et tout ce qui a été changé ou vérifié, regroupé dans l'ordre de la méthode d'élimination (le plus
     simple d'abord) : *Piles* → *Porte-piles, contacts et câble* → *Mécanique de la porte et de la serrure* (gâche,
     alignement, vis et carré, ressorts de poignée, boîtier de serrure, ferme-porte) → *Lecteur de badge* →
     *Bluetooth* → *Radio en ligne et passerelle* → *Électronique et micrologiciel de la serrure*. Les serrures
     **Novel** affichent leurs propres pièces (unité de lecture, unité intérieure / bloc piles, boîtier de serrure,
     module d'alimentation du modèle sans piles). Quand des piles sont posées, leur **type** est obligatoire : **les
     piles AA alcalines industrielles sont recommandées** ; les autres sont signalées.
  2. Environ 3 semaines plus tard, lisez la serrure et chargez son relevé comme d'habitude. La page de la serrure
     (cliquez sur la porte) compare la consommation des piles **avant et après** chaque intervention et indique :
     *Corrigé* (la consommation a baissé de moitié ou plus : cette pièce était la cause), *Mieux*, *Pas de
     changement* (cette pièce n'était pas la cause), *Pire*, *Use toujours ses piles* (piles de nouveau nécessaires
     sous 4 mois, ou alarmes depuis), *Piles correctes*, ou *En attente d'un relevé* (avec la date à laquelle lire la
     serrure).
  3. Tant que la serrure use encore ses piles, la page nomme la **prochaine pièce à vérifier** : la première pas encore
     changée ni trouvée correcte, en commençant par ce qu'indique le relevé de la serrure (*probable*).

  **2.31 :**
  - **VingCard Classic Alfa (hors ligne)** est un modèle de serrure avec ses propres pièces : **LCU** (unité de
    commande, intérieure), **LCA** (unité extérieure avec le lecteur de badge), **boîtier de serrure** et
    **porte-piles** (et les piles). Le Bluetooth et la radio en ligne sont exclus de ses étapes d'élimination.
  - **Ajouter depuis le carnet papier** (sur la page de la serrure) : recopiez la fiche des piles gardée dans la
    serrure, une ligne par entrée — `14/04/2026 LCA + piles Serge`, `22/07/2026 LCU`, `04/09/2026 porte batterie
    Augustin`, `02/10/2026 Augustin`. *Piles*, *LCU* (aussi écrit LCO / LGU), *LCA*, *porte batterie*, *lock case*,
    *câble*, *Varta industriel* sont reconnus ; une ligne avec seulement une date et un nom est un changement de piles.
    Les lignes sont affichées pour vérification avant d'être enregistrées ; les lignes déjà enregistrées sont omises.
  - **Jeux de piles dans les relevés de serrure** : chaque jeu, d'un changement de piles au suivant, avec ce qui a été
    changé à la pose, sa durée, les ouvertures par jour, les jours jusqu'à 4,4 / 4,2 / 4,0 V, la première alarme de
    piles, les redémarrages et les erreurs de badge. Les jeux de moins de 4 mois sont en rouge. Si les jeux durent
    toujours autant après le changement d'une pièce, cette pièce n'était pas la cause.
  - Les serrures sans capteur de porte (Classic) comptent une ouverture pour chaque badge accepté, ouverture électrique
    ou clé mécanique.
  - Le tableau des serrures affiche **la durée des jeux, par année, sur toutes les serrures** : une baisse sur beaucoup
    de serrures à la fois indique une cause commune (approvisionnement en piles, un réglage, le micrologiciel).

  **2.32 — une seule page courte pour tout un hôtel :**
  - Le diagnostic des serrures s'ouvre sur les chiffres (serrures qui usent leurs piles / en attente d'un relevé /
    résolues), les **mises à jour du micrologiciel** avec la durée des jeux de piles avant et après chacune, et la
    durée d'un jeu par année ; puis des onglets : **À faire** (la tournée des techniciens, imprimable avec une case
    *Fait*), **Serrures** (recherche, état, étage, 25 par page), **Relevés de serrure** (recherche, 25 par page) et
    **Fonctionnement**.
  - **À faire** liste, pour chaque serrure : les serrures à lire maintenant, *l'autonomie des piles a baissé après une
    mise à jour du micrologiciel : contacter ASSA ABLOY*, *mettre des piles AA alcalines industrielles*, la prochaine
    pièce à vérifier, les relevés à actualiser, les changements de piles vus mais non enregistrés (ajoutez-les depuis le
    carnet papier), et les relevés à venir.
  - **Enregistrer une mise à jour du micrologiciel** (responsables des piles) : la date, les versions avant et après si
    elles sont connues, toutes les serrures ou une liste de portes. Pour les serrures concernées, le portail compare la
    durée des jeux de piles avant et après (carnets papier et relevés de serrure) ; quand ils durent deux fois moins ou
    moins encore, l'À faire de la serrure le dit en premier et l'étape électronique/micrologiciel devient *probable*.
    Les relevés de serrure affichent aussi *Signes d'une incompatibilité de micrologiciel / logiciel* (événements sans
    nom dans Visionline, « Unknown command » répondu à l'appareil de service, chargements de programme).
  - La page de la serrure : l'état et **que faire, dans l'ordre**, avec les chiffres clés à côté ; puis les onglets
    **Jeux de piles**, **Travaux faits**, **Changements de piles**, **Niveau des piles**, **Relevés** (Imprimer les
    imprime tous).
  - Enregistrer des travaux accepte aussi la **tension du paquet avant et après** (multimètre), le **lot** des piles,
    et la **version du micrologiciel** quand il est mis à jour. Un paquet neuf sous 4,6 V (3 piles alcalines) est
    signalé comme stock ancien ou faible.

  La page de la serrure liste aussi chaque changement de piles (d'après Visionline, les relevés de serrure et les
  travaux enregistrés) avec la durée de chaque jeu et les piles posées, le niveau des piles de tous ses relevés avec
  les travaux marqués, et ses relevés. Les enregistrements de travaux peuvent être supprimés par les responsables des
  piles ; les techniciens peuvent enregistrer des travaux.
- **Diagnostic des serrures** (Serrures → Diagnostic des serrures, ou *Diagnostiquer une serrure* dans État des
  piles), surtout pour les serrures hors ligne. Il fonctionne que le suivi des piles soit activé ou non.
  1. Lisez la serrure avec l'appareil de service et chargez ses événements dans Visionline comme d'habitude.
  2. Dans Visionline, ouvrez les événements de la serrure et enregistrez-les en rapport (.xls), ex. `1115.xls`.
     L'ancienne présentation (Time, Event…) comme la nouvelle (Door, S/N, Event time, Read-out time, Seq.No…) sont
     lues.
  3. Chargez le fichier, vérifiez les événements les plus récents (inversez *Jour/mois* si le jour et le mois sont
     permutés), choisissez la porte (suggérée d'après le fichier) et confirmez.

  Le relevé commence par un verdict (*demande de l'attention*, *quelques points à vérifier*, *aucun problème
  trouvé*) et **que faire, dans l'ordre**, puis chaque constat avec sa raison. Il couvre :
  - **Piles :** relevés dans le temps avec chaque changement de piles ; chaque période de piles avec les jours jusqu'à
    4,4 / 4,2 / 4,0 V, la consommation par 30 jours et par 1 000 ouvertures, les alarmes ; combien de temps dure un jeu
    à ce rythme ; les alarmes qui comptent, et les alertes de piles faibles ignorées après un changement.
  - **Serrure :** erreurs internes, erreurs de lecture de badge et Bluetooth, badges d'un autre système, redémarrages
    (ceux juste après un changement de piles sont normaux et non comptés), horloge perdue, erreurs de données ; un
    tableau semaine par semaine.
  - **Porte :** laissée ouverte trop longtemps (combien de fois, combien de temps), ouverte de l'extérieur sans badge
    ni clé juste avant (pêne qui ne s'enclenche pas, ou porte forcée), ouvertures à la clé mécanique, utilisation du
    verrou, entrées refusées par motif.
  - **Utilisation :** ouvertures par jour, par heure et par jour de la semaine, badges utilisés par type.
  - **Service et données :** lectures avec l'appareil de service, réglages de l'heure et chargements de programme avec
    leurs dates, interrogations du serveur pour les serrures en ligne, et la qualité du relevé lui-même (lignes lues
    deux fois comptées une fois, événements avec horloge perdue, relevés exclus pendant la programmation de la
    serrure).

  Chaque type d'événement et chaque motif de refus est expliqué en mots simples, par exemple :
  - Les événements *Door Unit Internal* sont ceux de la serrure elle-même, surtout mécaniques (porte ouverte ou fermée,
    double verrouillage mis ou retiré).
  - *Deadbolt thrown / released* : le bouton à l'intérieur de la chambre a mis / retiré le double verrouillage.
  - *Error, Door unit dead bolted* : quelqu'un a essayé d'ouvrir pendant que le double verrouillage était mis ; seuls
    les badges ayant le droit de passer outre le verrou ouvrent alors la chambre. Intimité normale, pas un défaut.
  - *Error, Card has expired* : un badge expiré a été utilisé ; la porte ne s'ouvre pas.
  - *Mechanical key* : la clé mécanique a servi à ouvrir ou verrouiller la porte.

  Les refus sont présentés comme des questions de badge ou de droits, pas comme des défauts de serrure.

  *Ouvrir une demande de maintenance* met les constats dans une demande ; *Imprimer* en fait une copie papier. Les
  noms, ID utilisateur, numéros de badge et numéros de série du fichier ne sont pas conservés.

### 5a. Nouveau en 2.17

- **Nom** : le produit s'appelle désormais *Access Monitoring Tool*. Les clés mobiles du personnel sont un module
  facultatif, désactivé par défaut (Paramètres → Modules).
- **La page de connexion** affiche les publications publiques du tableau d'affichage et des rappels de bonnes
  pratiques. **Tableau d'affichage** (Accueil) : les administrateurs publient des nouvelles, des astuces ou des
  messages importants, avec une image, épinglés ou jusqu'à une date ; les publications « aussi sur la page de
  connexion » sont vues avant la connexion (rien de confidentiel).
- **Mes graphiques** : toute personne qui peut lire certaines données crée des graphiques (barres, colonnes, lignes ou
  tableau) à partir des événements de porte, des badges, des clés mobiles, des alarmes, de la maintenance ou du
  petit-déjeuner, les enregistre, les partage et les épingle sur l'Accueil.
- **Les clés mobiles créées dans Visionline** sont reconnues : Visionline affiche le « numéro de série » d'un
  téléphone comme FFFFFFFF. Elles apparaissent comme *Clé mobile* dans Badges et personnes Visionline et dans les
  rapports.
- **Délivré par** : chaque badge encodé depuis ce portail enregistre l'utilisateur du portail. Les badges créés dans
  Visionline affichent *Délivré depuis Visionline* (2.21), avec l'opérateur et la personne liée à cet opérateur
  quand elle est connue (enregistrée sur la page Badges du personnel, ou liste des badges avec l'opérateur importée :
  Rapport de configuration → Rapports Visionline). Quand l'utilisateur Visionline du connecteur est partagé
  (utilisateur PMS / interface), le portail prévient : donnez aux personnes des opérateurs Visionline nominatifs.
- **Délivrer un badge du personnel** : choisissez la personne déjà présente dans Visionline (pas de doublon), ou
  *Badge existant* pour lier un badge que la personne détient déjà, avec son groupe d'utilisateurs.
- **Utilisateurs et titulaires de badge** : les opérateurs se connectent au portail ; les titulaires de badge ont des
  badges dans Visionline ; une personne peut être les deux. Utilisateurs → *Lier un titulaire de badge* affiche ses
  badges ; les personnes Visionline affichent *Utilisateur du portail*.
- **Encodeur** : la recherche de badge affiche toujours l'encodeur sur lequel lire (mémorisé sur cet ordinateur),
  défini dans les Paramètres ou lu dans Visionline.
- **Rapport de configuration** : paramètres système et opérateurs Visionline (rapports importés), l'utilisateur
  Visionline qu'utilise le portail, l'accès par groupe d'utilisateurs et par personne (filtre par nom, porte ou groupe
  d'utilisateurs).

### 5b. Qui peut ouvrir une porte, passes généraux (2.16.1)

**Badges et personnes Visionline → Badges** a un filtre simple : *Ouvre : <porte>* liste chaque badge (avec son
titulaire et son groupe d'utilisateurs) qui ouvre cette porte — par exemple la porte de la caisse — en comptant les
portes du badge, ses groupes de portes et un groupe d'utilisateurs à accès uniforme. Boutons rapides : **Qui a un passe
général** (ouvre toutes les chambres), **Qui peut passer outre le verrou**, et *Qui peut ouvrir …* pour des portes comme
la caisse, le coffre, les réserves ou les bureaux. À combiner avec un groupe d'utilisateurs.

### 5c. Badges par chambre (2.15)

**Badges par chambre** (dans le menu, sous Journal des événements) liste, pour chaque chambre client (ou chaque porte),
les badges qui l'ont ouverte ou qui ont été refusés sur une période : numéro de badge, type (clé mobile, badge du
personnel, badge client ou autre), titulaire, **qui l'a délivré**, entrées, entrées refusées, première et dernière
utilisation. **Imprimer en PDF** produit le même PDF avec empreinte que le Journal des événements.

*Délivré par* affiche l'utilisateur du portail pour les clés mobiles et pour les badges traités sur la page Badges
(encodés sur un encodeur depuis le portail ou enregistrés là). Les badges créés dans Visionline affichent **Délivré
depuis Visionline** (2.21), avec l'opérateur Visionline et la personne derrière lui quand elle est connue ; l'API Web
Visionline n'indique pas qui a encodé un badge. Pour un badge client, le nom du client est affiché quand la liste des
clients présents du jour (import du Petit-déjeuner) contient un séjour dans cette chambre.

**Serrures hors ligne et systèmes hors ligne.** Un événement de serrure atteint la plateforme quand Visionline l'a :
- *Les serrures en ligne* transmettent tout de suite.
- *Les serrures hors ligne (autonomes)* gardent leurs événements dans la mémoire de la serrure ; ils atteignent
  Visionline quand cette mémoire est lue avec l'outil de service (unité de programmation portable) ou LockLink et
  chargée. La plateforme classe chaque événement à l'heure que la **serrure** a enregistrée : un chargement fait des
  jours plus tard remplit donc la bonne place dans l'historique et dans ce rapport. Vérifiez une fois sur place que
  Visionline transmet à l'API Web les mémoires chargées (lisez la mémoire d'une serrure, chargez-la, puis cherchez ses
  entrées ici) ; sinon, le rapport du bureau Visionline reste la source pour ces serrures.
- *Si la plateforme ou le connecteur est arrêté*, Visionline garde les changements dans la file de rappels du
  connecteur et le connecteur les relit à son retour ; rien n'est perdu tant que la file les conserve. Vérifiez la
  durée de conservation de la file de votre version de Visionline pour les longues coupures.

## 6. Analyses et vos propres rapports

Tableaux de bord de direction : personnes et badges par groupe, activité des clés, entrées refusées, piles et
alarmes. Chaque graphique a un bouton **Tableau**. **Créer un rapport** permet de choisir ce qu'il faut compter
(entrées, refus, badges…), comment regrouper (porte, personne, groupe, jour…) et de filtrer ; enregistrez-le dans
**Mes rapports** et exportez en CSV ou PDF.

## 7. Présence en direct (poste de sécurité / écran du guide-file)

Qui est dans le bâtiment **maintenant** :

- **Personnel sur place** : les personnes dont le badge ou la clé mobile a ouvert une porte au cours des dernières
  heures (10 par défaut), plus les personnes pointées à l'arrivée et pas au départ.
- **Clients présents** : les chambres de la liste des clients présents du jour (rapport du PMS importé dans
  Petit-déjeuner, ou tenu par la réception), avec le nombre de clients et leurs noms. Les hôtels qui n'utilisent pas
  l'écran du restaurant activent le Petit-déjeuner uniquement pour tenir cette liste.
- **Autres chambres ouvertes** : les portes de chambre ouvertes récemment avec un badge qui n'est pas sur la liste.

Affichez-la sur un écran dédié : connectez-vous avec un compte ayant le rôle **Sécurité / guide-file** (il ne voit que
cette page et Urgence), ouvrez *Présence en direct* et cliquez sur **Plein écran**. Elle s'actualise toutes les
20 secondes.

**Imprimer la liste d'évacuation** produit un PDF avec chaque chambre occupée et chaque personne sur place, avec une
colonne à cocher.

Les serrures enregistrent qui **entre**, pas qui sort. Utilisez l'écran comme point de départ de la ronde, pas comme
preuve qu'une zone est vide. Les durées se règlent dans *Paramètres → Sécurité et urgence*.

## 8. Urgence

1. **Déclencher** : choisissez Incendie, Évacuation, Exercice ou Autre, décrivez quoi et où, cliquez sur
   **Déclencher**, ressaisissez votre mot de passe.
2. **Confirmer** : une deuxième personne ayant les droits d'urgence ouvre *Urgence* et clique sur **Confirmer
   l'urgence** (mot de passe de nouveau). Deux personnes sont toujours nécessaires ; une personne ne peut pas
   confirmer sa propre demande.
3. **Appel** : dans *Présence en direct*, cliquez sur chaque chambre et cochez chaque personne en sécurité. Le bandeau
   compte combien de personnes sont pointées. Le PDF de la liste d'évacuation les marque EN SÉCURITÉ.
4. **Clés d'urgence** (pas pendant un exercice) : choisissez des intervenants dont le téléphone est configuré ; ils
   reçoivent une clé mobile avec le modèle d'urgence pour quelques heures. La confirmation à deux personnes vaut
   approbation de l'accès large.
5. **Terminer** : écrivez une note (par exemple « fin d'alerte donnée par les pompiers ») et cliquez sur **Terminer
   l'urgence**.

Tout figure dans la piste d'audit avec les noms et les heures.

**Ouvrir toutes les chambres clients d'un coup (2.14)** : pendant une urgence confirmée (pas un exercice),
*Ouverture d'urgence de toutes les chambres clients* envoie la commande d'ouverture d'urgence de Visionline à chaque
chambre client équipée d'une serrure **en ligne** ; la page montre quelles serrures ont répondu, et *Retour à la
normale* (aussi automatique à la fin de l'urgence) les remet à la normale. Les chambres avec des serrures **hors
ligne** sont listées : utilisez le **badge d'urgence** (encodez-en un dans *Badges du personnel → Encodeurs et badges
spéciaux* ; il ouvre toutes les serrures, même verrou mis). Activez la commande dans *Paramètres → Sécurité et
urgence* après l'avoir testée sur une porte.

## 9. Cartes d'identité du personnel

Un profil par personne — photo, nom complet, numéro d'identification, service, fonction, validité — imprimé sur le
badge (CR80, 85,6 × 54 mm) avec n'importe quelle imprimante à cartes, ou sur papier pour une pochette porte-badge. Le
code-barres contient le numéro d'identification : les postes de pointage et les caisses de la cantine peuvent le lire
avec un lecteur USB.

- **Créer à partir de…** : créez d'un coup les profils des personnes Visionline (par groupe d'utilisateurs), de la
  liste de pointage ou du personnel avec clé mobile. Les profils existants ne sont pas dupliqués.
- **Photo** : ouvrez un profil, **Utiliser la caméra** (webcam au bureau) ou **Choisir une image**. Elle est recadrée
  en 3:4 et gardée légère (moins de 300 Ko). Fond clair uni, visage centré.
- **Imprimer** : cochez les personnes, **Imprimer les cartes** ; choisissez l'imprimante à cartes, **taille réelle /
  100 %, sans marges**. Cochez *Imprimer aussi le verso* avec une imprimante recto verso. Après l'impression,
  confirmez : le nombre d'impressions est enregistré.
- **Mise en page** : *Paramètres → Mise en page des cartes d'identité* (portrait ou paysage, titre, ce qui est
  affiché, le texte au verso, la marge de sécurité de l'imprimante).

L'impression ne touche pas la puce : imprimez avant ou après l'encodage du badge dans Visionline.

**Imprimantes recommandées**

| Usage | Imprimantes |
|---|---|
| Badges RFID (le mieux : impression sur un film posé sur la carte, bord à bord, non abîmée par la puce) | HID Fargo HDP5000 / HDP6600, Evolis Avansia, Matica MC310, Entrust Datacard CR805 |
| Badges en PVC plat, moins cher (impression directe ; garder une marge de 1–1,5 mm) | Zebra ZC300 / ZC350, Evolis Primacy 2, Magicard Rio Pro 360, HID Fargo DTC1500 |

Demandez à votre fournisseur de badges une version à surface imprimable (certains badges brillants prennent mal
l'encre).

## 9b. Badges du personnel (demandes, registre, annulations)

*Personnel et clés → Badges du personnel.* Visionline reste le système de clés : chaque badge est créé dans
Visionline, soit encodé depuis le portail sur un encodeur, soit délivré depuis Visionline et enregistré ici, avec qui
l'a délivré.

- **Demande** : *Nouvelle demande* (ou la **page QR code** : la réception imprime le QR code depuis *Page QR code* ;
  les responsables le scannent avec leur téléphone, sans connexion). Choisissez Nouveau / Remplacement / Annulation,
  personnel permanent ou journalier, prénom, nom, service, fonction, matricule, numéro de badge (ex. **HK 001**), le
  responsable qui demande (ex. le responsable des étages), l'e-mail des RH, le motif. Le personnel journalier peut
  demander plusieurs badges à la fois.
- **Délivrance** : ouvrez la demande, choisissez le groupe d'utilisateurs Visionline et la validité. *Encoder ici* :
  posez un badge vierge sur l'encodeur choisi et cliquez sur *Encoder le badge* (la personne est créée dans Visionline
  si besoin). *Délivré depuis Visionline* : enregistrez le numéro de badge Visionline et l'opérateur Visionline qui l'a
  créé (vide = le vôtre). Le personnel permanent a besoin du numéro de badge (HK 001) ; il va dans le **Registre**.
- **Démission / annulation** : ouvrez la demande, indiquez si le badge a été rendu, perdu ou endommagé, et
  désactivez-le : *En l'écrasant sur l'encodeur* (le badge rendu est réécrit pour expirer une minute plus tard),
  *En annulant son numéro dans Visionline*, ou *Fait dans Visionline*. Les RH et le responsable sécurité reçoivent un
  e-mail (« badge annulé et rendu »).
- **Envoyer aux RH** envoie une demande par e-mail ; **Registre → Export pour les RH** donne toute la liste (CSV).
- **Renouvellements et doublons** : badges du personnel qui se terminent sous 7/30/60 jours (aussi dans *À faire
  maintenant*, et une fois par jour un e-mail aux RH et au responsable sécurité liste les badges qui se terminent sous
  14 jours), et les personnes qui détiennent plus d'un badge valide. Une demande de *Remplacement* encode le nouveau
  badge avec *override*, ce qui annule tous les badges plus anciens de cette personne dans Visionline.
- **Clients impayés** : la réception demande (chambre, client, montant, motif) ; un responsable approuve (jamais la
  même personne). Serrure en ligne : la commande de départ de Visionline arrête les badges du client à la porte.
  Serrure hors ligne : un badge client d'une minute est encodé pour la chambre avec *override* ; posez-le dans la
  serrure et les badges du client cessent de fonctionner. Chaque cas est listé (et dans le rapport Comptabilité).
  *Réglé* le clôture ; délivrez une nouvelle clé dans Opera.
- **Départs** : les chambres qui partent aujourd'hui. Serrures en ligne : *Envoyer le départ* et voir quelles serrures
  l'ont confirmé. Serrures hors ligne : posez le **badge de libération** sur la serrure et cochez *Badge de libération
  posé*.
- **Encodeurs et badges spéciaux** : les encodeurs lus dans Visionline et leur dernière utilisation ; encodez des
  badges d'**urgence**, de **maintien ouvert**, de **libération** et à **usage unique**. Choisissez les encodeurs que
  le portail peut utiliser dans *Paramètres → Badges et encodeurs*.

## 9c. Rapports pour la Comptabilité et rapport de configuration

- **Rapport quotidien Comptabilité** (*Paramètres → Rapport quotidien Comptabilité*) : un e-mail chaque matin avec les
  clients arrivés la veille, les clients présents et le nombre de chambres occupées (à rapprocher de l'audit de nuit
  d'Opera), les **chambres avec plus d'un badge client actif** (lus dans Visionline 30 minutes avant le rapport ; une
  chambre absente de la liste des clients présents est signalée), et les blocages de clients impayés. *Envoyer
  maintenant* l'envoie tout de suite ; la page en montre un aperçu. Il lit la liste des clients présents d'Opera
  importée dans Petit-déjeuner.
- **Rapport de configuration** (*Administration → Rapport de configuration*) : établissement, types de badge, groupes
  d'utilisateurs, groupes de portes et chambres, serrures (en ligne/hors ligne), plages horaires, qui a accès, et les
  principaux paramètres — une section par page, dans la présentation du System Setup Report de Visionline.
  *Imprimer / PDF*.

## 10. Personnel et clés mobiles (quand le module est activé)

- **Personnel** : les personnes qui peuvent recevoir une clé mobile, la configuration de leur téléphone (code
  d'invitation dans l'application du personnel) et leur clé.
- **Délivrer une clé** : choisissez la personne, un modèle ou des portes, la validité ; l'accès large nécessite
  l'approbation d'une deuxième personne. La clé apparaît sur le téléphone en moins d'une minute ; **Révoquer** la
  retire.
- Visionline autorise une clé mobile du personnel par personne. **Changer les portes** remplace une clé active.

## 11. Pointage, Petit-déjeuner, Piles, Maintenance

- **Pointage** : les entrées aux portes de présence, l'accueil de pointage et les corrections des RH deviennent des
  feuilles de temps et des exports de paie. Le code-barres de la carte d'identité peut servir à l'accueil.
- **Petit-déjeuner** : la liste des clients présents du jour (importez le rapport du PMS), le pointage du restaurant
  par chambre, la feuille du jour. La même liste alimente la Présence en direct.
- **État des piles** : niveaux et alarmes des piles des serrures depuis Visionline ; les piles faibles deviennent des
  demandes de maintenance.
  - **Dernier changement de piles** (2.15) est affiché par serrure : d'après l'événement *Piles remplacées* de la
    serrure ou — cet événement étant rare dans les journaux — d'après une hausse brusque des relevés de tension (par
    exemple *sous 3,6 V* suivi de *sous 4,6 V* ; le saut se règle dans *Paramètres → Piles*, 0,8 V par défaut), ou
    d'après une demande de maintenance résolue avec « piles remplacées ».
  - **Piles changées, la serrure est toujours en alarme** (2.15) : si une serrure signale une alarme de piles dans les
    14 jours suivant un changement de piles, la plateforme ouvre une demande de maintenance de priorité haute
    *« Programmer la serrure et charger le micrologiciel »* au lieu d'une nouvelle demande de piles. Programmez la
    serrure et chargez son micrologiciel avec l'outil de service, puis vérifiez que l'alarme disparaît. Changer les
    piles à temps, avant qu'elles soient critiques, évite cela.
- **Maintenance** : demandes venant du portail, de l'application du personnel et des alarmes de piles, attribuées aux
  techniciens.

## 12. Administration (administrateurs uniquement)

- **Utilisateurs** (2.16, auparavant *Opérateurs*) : **Inviter quelqu'un** — nom, e-mail professionnel et ce que fait
  la personne (Administrateur, Réception, Responsable sécurité, Chef de service, Direction, Responsable de
  maintenance, RH, Sécurité, Auditeur ; ou *Choisir plutôt des rôles*). La personne reçoit un lien à usage unique
  (72 heures, aussi par e-mail quand l'e-mail est configuré), choisit son mot de passe et est connectée. **Nouveau
  lien** pour une invitation expirée, **Lien de mot de passe** pour un mot de passe oublié (votre mot de passe est
  demandé d'abord), **Retirer** pour supprimer l'accès. *Ajouter avec un mot de passe* fonctionne toujours. Aussi :
  modules par personne (préréglages *Visionline uniquement* / *Tout afficher*) et *Réinitialiser les deux étapes*
  quand quelqu'un a perdu son téléphone. Rôles : Administrateur, Responsable sécurité, Émetteur de clés, Approbateur,
  Responsable de maintenance, Technicien, Direction (rapports), Responsable RH, Pointeur, Restaurant, Sécurité /
  guide-file, Chef de service, Auditeur, Lecture seule.
- **Hôtel ou institution** (2.16) : *Paramètres → Nom et coordonnées → Type*. Une institution ne voit pas les
  fonctions clients (Petit-déjeuner, Clients impayés, Départs, le rapport Comptabilité) et le portail dit
  « chambres », pas « chambres clients ».
- **Connecteur sur un autre ordinateur** (2.16) : *Paramètres → Connecteur*. Choisissez *Sur un autre ordinateur*,
  saisissez l'adresse de l'ordinateur du connecteur, l'adresse de ce serveur telle que cet ordinateur la joint, et
  l'adresse de l'API Web Visionline. La page écrit les commandes : `set-connector-access.ps1 -Allow <adresse>` sur ce
  serveur (seule cette adresse peut utiliser l'entrée du connecteur ; il enregistre le certificat du serveur
  `gateway.cer`), puis sur l'ordinateur du connecteur `visionline-probe.ps1 … -SaveCert` et `install.ps1 -PlatformUrl
  … -PlatformCaFile .\gateway.cer -VisionlineUrl … -CaFile …` avec un jeton créé sur la même page. La liste des
  connecteurs montre d'où chacun communique. Les deux certificats sont vérifiés ; rien n'est ouvert vers Internet.
- **Pour commencer** (2.16) : sur l'Accueil, les administrateurs voient les premières étapes jusqu'à ce qu'elles soient
  faites.
- **Menu** (2.16.1) : cliquez sur le titre d'un groupe pour le replier ; le choix est mémorisé sur cet ordinateur. Le
  menu défile quand il est plus long que l'écran.
- **Rapport de configuration** (2.16.1) : le tableau des groupes d'utilisateurs affiche *Passe outre le verrou* et
  *Passe outre la confidentialité* (réglages des groupes d'utilisateurs Visionline) et combien de badges valides de
  chaque groupe passent outre le verrou. Lancez une fois la découverte des ressources avec le connecteur 0.13.1 pour le
  remplir.
- **Paramètres** : utilisez la zone de recherche en haut pour trouver un paramètre. Chaque enregistrement est une
  nouvelle version que vous pouvez restaurer.
  - *Sécurité et urgence* : durées sur place, groupes de visiteurs, étages, modèle et durée des clés d'urgence.
  - *Mise en page des cartes d'identité* : orientation, titre, champs, texte au verso, marge de l'imprimante.
  - *Confidentialité et conservation* : combien de jours sont conservés les événements de serrure, les listes de
    clients et les statistiques d'utilisation.
  - *Protection des administrateurs* : **Exiger la connexion en deux étapes pour les administrateurs** — Paramètres,
    Opérateurs, Marque et le connecteur restent fermés à un administrateur tant que la connexion en deux étapes n'est
    pas activée.
  - *Licence* : l'ID d'installation et la clé de licence.
- **Utilisation** : qui utilise le portail et ce qu'il a fait (clés, recherches, rapports, enregistrements), avec une
  estimation du temps gagné (les minutes par élément sont modifiables). **Résumé pour le fournisseur** télécharge un
  résumé anonyme signé (comptages uniquement).
- **Piste d'audit** : chaque modification avec nom et heure, chaînée pour que les modifications ou suppressions se
  voient.

## 12b. Version Light (2.34) : diagnostic des serrures

La version Light (`AccessMonitoringTool-Light-…msi`) est destinée à l'équipe technique. Son menu comprend
**Accueil**, **Serrures**, **Rapport du jour**, **État des piles** et **Rapports** ; pas d'administration, pas
d'utilisateurs, pas de page connecteur.

**Premier démarrage.** La page demande seulement l'utilisateur et le mot de passe Visionline (et, si vous le
souhaitez, le nom de l'hôtel). Le mot de passe est chiffré dans le navigateur pour le connecteur du serveur. Le
portail teste le compte avec Visionline, lit les portes et active seul le suivi des piles. Si le mot de passe change
plus tard : Accueil → *Changer le compte Visionline*. Nom et logo de l'hôtel : Accueil → *Changer le nom ou le logo
de l'hôtel*.

**Sans connexion.** Sur le réseau de l'hôtel, le portail s'ouvre directement. Hors du réseau de l'hôtel, il ne
s'ouvre pas.

**Accueil.** Serrures qui se déchargent, serrures en attente d'un relevé, piles faibles d'ici 7 jours, rappels, et
graphiques : piles faibles prévues par semaine (si rien ne change : le dernier changement de piles + la durée d'un
jeu sur cette serrure, ou sur les serrures de l'hôtel), les serrures dont les piles durent le moins, et la durée d'un
jeu par année.

**Diagnostiquer une serrure, dans cet ordre.**
1. *Câbles et alignement* : aucun câble coupé ou pincé, rien de désaligné ; tout rebrancher correctement.
2. *Porte-piles* : rouille ou dépôts ? Le nettoyer, ou le remplacer s'il est rouillé, et continuer à surveiller.
3. *Piles* : AA alcalines industrielles d'un même lot ; mesurer au repos et en charge (une chute de plus de 0,6 V à
   l'ouverture indique des piles faibles, un porte-piles rouillé ou un mauvais contact).
4. Si les piles chutent de nouveau : **Signaler un problème** ce jour-là. Le portail rappelle à l'équipe
   d'*Importer le dernier rapport de cette serrure* (la lire avec le terminal de service, enregistrer ses événements
   depuis Visionline en .xls, importer).
5. Si le rapport montre la chute : changer le **LCA** (adaptateur de boîtier de serrure), puis le **LCU** (unité de
   contrôle de la serrure), puis le boîtier de serrure sur les anciens modèles — un à la fois. Pour tester une pièce,
   l'échanger avec une serrure qui fonctionne et noter la porte dans *Échangé avec la pièce de la porte* ; si le
   problème suit la pièce, la pièce est défectueuse.
6. Relire la serrure environ 3 semaines après chaque intervention : le portail indique *Réparé*, *Aucun changement*
   ou *Se décharge encore*.

Chaque entrée peut porter jusqu'à 6 photos ou captures (carnet papier, multimètre, porte-piles, Visionline).

**Rapport du jour** (menu, ou Serrures → Rapport du jour) : choisir un jour ou une période (jusqu'à 93 jours). Il
liste, par date et par étage, chaque porte, ce qui a été fait ou constaté, les pièces changées ou vérifiées, les
piles, les tensions, qui l'a fait et l'état actuel de la serrure ; puis les rappels et les serrures dont les piles
seront bientôt faibles. **Imprimer** donne la copie papier ; **Excel (CSV)** s'ouvre dans Excel. Le registre des
serrures (Serrures → Serrures) a son propre bouton *Excel (CSV)*.

## 13. Licence

Le portail affiche un rappel avant la fin de la licence et une fenêtre pour saisir la nouvelle licence quand elle a
pris fin. Collez la clé (ou ouvrez le fichier `.smklic`) et cliquez sur **Installer**. D'ici là, après 14 jours de
grâce, les modifications sont suspendues ; la connexion, la révocation des clés, la lecture des rapports, la Présence
en direct et l'Urgence continuent de fonctionner.

## 14. Partager Visionline avec le PMS et le GRMS

Le portail est un client Visionline discipliné :

- Au plus 2 requêtes à la fois vers Visionline (réglage `VL_MAX_CONCURRENT` du connecteur) ; le travail sur les clés et
  les badges passe d'abord, les lectures de fond attendent.
- Quand Visionline répond lentement ou se dit occupé, les lectures de fond s'arrêtent 30 secondes.
- Les lectures complètes des personnes et des badges peuvent n'avoir lieu que la nuit.
- Les lectures sur l'encodeur sont limitées à quelques-unes par minute.

## 15. Sécurité

- Les mots de passe sont stockés sous forme d'empreintes scrypt salées ; la connexion prend le même temps qu'un compte
  existe ou non.
- Les mots de passe Visionline et Credential Services sont chiffrés dans votre navigateur pour le connecteur et ne sont
  plus jamais affichés.
- Les actions sensibles (urgence) redemandent le mot de passe. Les administrateurs peuvent être obligés d'utiliser la
  connexion en deux étapes.
- Chaque réponse du serveur porte des protections du navigateur (pas d'inclusion dans un cadre, pas de détection de
  type, politique de contenu stricte).

## 16. Quand quelque chose ne fonctionne pas

| Vous voyez | Faites ceci |
|---|---|
| « Connecteur hors ligne » | Sur le serveur Visionline : *Services* Windows → *Access Monitoring Tool Connector* → Démarrer. |
| La recherche de badge n'affiche rien | *Paramètres → Rapports et synchronisation* : la lecture des personnes et des badges est-elle activée ? Attendez la prochaine synchronisation ou cliquez sur Actualiser depuis Visionline. |
| La Présence en direct n'a pas de clients | Importez le rapport des clients présents du jour (Petit-déjeuner → Importer). |
| « La connexion en deux étapes est obligatoire » | *Votre compte → Connexion en deux étapes*, scannez le code, saisissez-le, reconnectez-vous. |
| « Licence requise » | *Paramètres → Licence*, saisissez la nouvelle clé de votre fournisseur. |
| La page de configuration demande un code | Menu Démarrer → *Access Monitoring Tool - setup code* (en tant qu'administrateur). |
| Les cartes d'identité s'impriment trop petites ou décentrées | Fenêtre d'impression : taille réelle / 100 %, aucune marge, format du papier = le CR80 de l'imprimante à cartes. |
