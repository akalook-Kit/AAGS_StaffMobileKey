# Access Monitoring Tool — démarrage rapide (2.34.0)

## Ce que c'est et ce qu'il faut

Access Monitoring Tool est un portail web sur votre propre réseau qui fonctionne avec ASSA ABLOY Visionline. Il
montre qui a ouvert quelle porte et avec quel badge, qui détient quel badge et qui peut ouvrir quelle porte, traite les
demandes de badges du personnel, surveille les piles des serrures et aide en cas d'urgence. Il convient à un hôtel ou
à une institution (bureaux, hôpital, école). Les clés mobiles du personnel sont un module facultatif, désactivé par
défaut.

Il a deux parties : le **portail** (avec sa base de données) et le **connecteur**, qui dialogue avec Visionline. Un
seul fichier installe l'un, l'autre ou les deux : `AccessMonitoringTool-Server-2.34.0.msi`.

| | A. Un ordinateur | B. Deux ordinateurs |
|---|---|---|
| Portail | Sur le serveur Visionline | Sur n'importe quel ordinateur Windows du réseau |
| Connecteur | Sur le même serveur | Sur le serveur Visionline (ou un ordinateur qui le joint) |
| Que lancer | Le .msi, répondre *Everything* (tout) | Le .msi sur chaque ordinateur : *Portal only* sur l'un, *Connector only* sur l'autre |

Il faut aussi Windows 10/11 ou Windows Server 2016+ (64 bits), un utilisateur Visionline autorisé à utiliser l'API Web,
et l'API Web Visionline joignable en https (en général `https://localhost/api/v1` sur le serveur Visionline). Rien
d'autre n'est à installer avant : le .msi contient son propre environnement d'exécution.

## Version Light (2.34.0) : diagnostic des serrures et rapports du jour

`AccessMonitoringTool-Light-2.34.0.msi` est une version allégée du même programme, pour l'équipe technique d'un
hôtel équipé de serrures hors ligne (faite d'abord pour La Falaise : son logo et ses couleurs sont inclus).
Installez-la sur le serveur Visionline, comme le .msi standard, puis :

1. **Une page, un seul réglage.** Le navigateur ouvre *Access Monitoring Tool Light*. Saisissez l'**utilisateur et
   le mot de passe Visionline** (et, si vous le souhaitez, le nom de l'hôtel), puis cliquez sur **Se connecter**. Le
   mot de passe est chiffré dans le navigateur pour le connecteur de ce serveur. C'est tout : le portail teste le
   compte, lit les portes et active seul le suivi des piles. Pas d'administrateur, pas d'utilisateurs, pas de pages
   connecteur ou réglages.
2. **Sans connexion sur le réseau de l'hôtel.** Tout ordinateur du réseau de l'hôtel ouvre `https://<serveur>:8443`.
3. **Accueil** : serrures qui se déchargent, serrures en attente d'un relevé, piles faibles d'ici 7 jours, rappels,
   graphiques (piles faibles prévues par semaine, serrures dont les piles durent le moins, durée d'un jeu par année)
   et raccourcis.
4. **Serrures** : enregistrer des travaux (câbles et alignement → porte-piles → piles → LCA → LCU → boîtier de
   serrure), *Signaler un problème* le jour où les piles chutent (avec la tension au repos et en charge), la porte
   avec laquelle un LCA ou un LCU a été échangé, des photos du carnet papier ou du porte-piles. Quand les piles
   chutent de nouveau, le portail le rappelle à l'équipe : *Importer le dernier rapport de cette serrure*.
5. **Rapport du jour** : un jour ou une période, étage par étage : ce qui a été remplacé (selon les fiches papier),
   les piles, les tensions, l'état de chaque serrure, les rappels et les serrures dont il faut préparer les piles.
   **Imprimer** ou **Excel**.

Les .msi Light et standard peuvent être gardés côte à côte dans le même dépôt GitHub et la même publication ;
n'installez qu'un des deux sur un même serveur (le .msi Light s'installe par-dessus l'édition allégée La Falaise 2.33).

## Première configuration en 5 étapes

1. **Lancez le .msi** en tant qu'administrateur. Une petite fenêtre (en anglais) demande ce que fait cet ordinateur
   (*Everything* = tout, *Portal only* = portail seulement, *Connector only* = connecteur seulement) et les adresses.
   Aucune fenêtre noire n'apparaît ; cochez *Show the installation steps* si le support informatique veut suivre le
   journal. Pour *Connector only*, créez d'abord un jeton de connecteur dans le portail (Paramètres → Connecteur) et lancez
   `set-connector-access.ps1 -Allow <IP de l'ordinateur du connecteur>` sur le serveur du portail ; la fenêtre affiche
   l'empreinte du certificat du portail à comparer avec celle affichée par ce script.
2. **Page de configuration.** Le navigateur l'ouvre à la fin, avec le **code de configuration** déjà rempli. Si la
   page demande le code : menu Démarrer → **Access Monitoring Tool - setup code** (Windows demande l'autorisation
   d'administrateur ; le code s'affiche et est copié dans le presse-papiers). Le fichier `setup-code.txt` n'est
   lisible que par les administrateurs : l'ouvrir avec le Bloc-notes depuis une fenêtre normale échoue, c'est voulu.
   Choisissez **Hôtel** ou **Institution**, le nom, le fuseau horaire et le pays, et créez le premier administrateur.
3. **Compte Visionline.** **Paramètres → Visionline** : l'utilisateur et le mot de passe Visionline (chiffrés pour
   le connecteur). Utilisez un opérateur Visionline nominatif, pas l'utilisateur PMS / interface, pour que le journal
   de Visionline montre qui a créé chaque badge.
4. **Rapports Visionline.** **Administration → Rapports de configuration → Importer un rapport Visionline** : le
   rapport *Paramètres système* tel que Visionline l'enregistre, et si vous les avez la liste des opérateurs et une
   liste des badges avec l'opérateur.
5. **Liste de contrôle.** L'**Accueil** affiche *Pour commencer* jusqu'à ce que tout soit vert.
6. **L'image de votre hôtel.** **Administration → Marque et logo** : le logo de l'hôtel (PNG ou SVG), son nom tel
   qu'affiché (ex. *La Falaise Hotel Bonapriso*) et ses couleurs. Ils apparaissent sur la page de connexion, dans le
   menu et sur chaque rapport imprimé.

## Installation propre (serveur déjà utilisé pour des essais)

Le .msi conserve les données d'une installation précédente (base de données, paramètres, code de configuration) pour
qu'une mise à jour ne perde jamais rien. Pour repartir de zéro, par exemple sur un serveur où un autre hôtel a été
installé pour un essai :

1. **Paramètres Windows → Applications → Access Monitoring Tool Server → Désinstaller** (les services sont retirés,
   les données sont conservées).
2. Dans PowerShell **en tant qu'administrateur**, après avoir copié ce que vous voulez garder de
   `C:\ProgramData\StaffMobileKey\Platform\backups` :
   `Remove-Item C:\ProgramData\StaffMobileKey -Recurse -Force`
3. Lancez le nouveau .msi. La page de configuration s'ouvre avec un nouveau code et l'hôtel est créé de zéro.

## Ajouter des personnes

**Utilisateurs → Inviter quelqu'un** : nom, e-mail professionnel, ce que fait la personne. Elle reçoit un lien
(valable une fois, 72 heures), choisit son mot de passe et accède au portail. **Nouveau lien** s'il a expiré, **Lien
de mot de passe** pour un mot de passe oublié, **Retirer** quand quelqu'un part.

| Choisir | La personne peut |
|---|---|
| Administrateur | Tout, y compris les paramètres et les utilisateurs |
| Réception / bureau des clés | Délivrer les clés mobiles et les badges du personnel ; demander les blocages de clients impayés (hôtels) |
| Responsable sécurité | Approuver les clés larges et les blocages, les urgences, le journal des événements |
| Chef de service | Demander des badges pour son équipe |
| Direction (rapports) | Rapports, journal des événements, badges par chambre |
| Responsable de maintenance | État des piles et demandes de maintenance |
| RH | Pointage, cartes d'identité du personnel |
| Sécurité / guide-file | Présence en direct et appel |
| Auditeur (lecture seule) | Tout lire, ne rien modifier |

## Tâches courantes

| Je veux… | Aller à |
|---|---|
| Voir qui a ouvert une porte | Journal des événements (Imprimer = PDF vérifiable) |
| Trouver pourquoi une serrure use ses piles | Serrures → Diagnostic des serrures : Enregistrer des travaux sur une serrure (piles avec leur type, pièces changées), puis charger son relevé 3 semaines plus tard |
| Chiffres quotidiens ou mensuels : badges clients délivrés, badges du personnel délivrés, qui détient les badges du personnel, entrées refusées, piles | Rapports (PDF, Excel, e-mail immédiat, ou envoi chaque jour / mois) |
| Version de Visionline, AES, nombre de serrures sur une page | Administration → Rapports de configuration → Rapport de configuration Visionline |
| Utiliser le portail en français | Automatique quand l'ordinateur / le navigateur est en français ; ou Français en bas du menu (aussi sur la page de connexion) |
| Voir quels badges ont ouvert chaque chambre, et qui les a délivrés | Badges par chambre |
| Demander / créer un badge du personnel | Badges du personnel (Demandes, Encoder ici, ou lier un *Badge existant*) |
| Qui a un passe général / qui peut ouvrir la porte de la caisse | Badges et personnes Visionline → Badges → filtre *Ouvre* et boutons rapides |
| Lire le badge posé sur un encodeur | Badges et personnes Visionline → Recherche de badge → choisir l'*Encodeur* |
| Créer mon propre graphique | Mes graphiques → Nouveau graphique (l'épingler sur l'Accueil) |
| Informer tout le monde | Accueil → Tableau d'affichage → Nouvelle publication (aussi sur la page de connexion si vous cochez) |
| Vérifier les piles des serrures ; « piles neuves, toujours en alarme » | État des piles |
| Comprendre pourquoi une serrure hors ligne use ses piles ou fonctionne mal | Diagnostic des serrures |
| Voir quelles serrures en ligne et passerelles sont hors ligne, avec leurs EEID (les alarmes se ferment d'elles-mêmes à leur retour) | Serrures en ligne et passerelles |
| Lire les dernières données de Visionline (après chargement des données des serrures ou actualisation des ressources) | Actualiser depuis Visionline (Badges et personnes Visionline, État des piles, Rapport de configuration) |
| Accéder au portail depuis l'extérieur sans IP publique | EXTERNAL-ACCESS.md (Cloudflare Tunnel) |
| Gérer une urgence | Urgence, Présence en direct |
| Savoir ce qui m'attend | Accueil → À faire maintenant |

## En cas de problème

| Ce que vous voyez | Que faire |
|---|---|
| Avertissement de certificat dans le navigateur | Normal avec le certificat propre du serveur ; continuez, ou installez un certificat d'entreprise (`-CertPfx`). |
| La page de configuration demande un code | Menu Démarrer → *Access Monitoring Tool - setup code* (en tant qu'administrateur). |
| Connecteur hors ligne | Paramètres → Connecteur (dernier contact, adresse) ; démarrez *StaffMobileKeyConnector* ; page d'état `http://127.0.0.1:8090`. |
| « Platform unreachable … certificate » | Relancez `set-connector-access.ps1 -Allow <adresse>` ; copiez `gateway.cer` ; `install.ps1 -PlatformCaFile .\gateway.cer`. |
| « Visionline certificate / unreachable » | `visionline-probe.ps1 -TlsOnly -SaveCert .\visionline.crt`, puis `install.ps1 -CaFile .\visionline.crt`. |
| Le lien d'invitation ne fonctionne pas | Utilisateurs → Nouveau lien. |
| L'installation s'est arrêtée | Le journal est dans `C:\ProgramData\StaffMobileKey\setup-logs` ; relancez le .msi avec `SMK_SHOW=1` pour le suivre. |
| Une serrure reste en alarme de piles après des piles neuves | Programmez la serrure et chargez son micrologiciel avec l'outil de service. |
