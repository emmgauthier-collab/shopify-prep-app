# CLAUDE.md — Back-office RXWEAR (shopify-prep-app)

Contexte de travail pour Claude Code. À lire au début de chaque session. Réponds en français.

## Le projet

RXWEAR (rxwear.fr / .eu / .be) : vêtements de sport personnalisés (CrossFit, Hyrox, running) à Toulouse, en impression DTF faite à l'atelier. Emmanuel travaille seul et utilise ce back-office tous les jours. Il gère tout le cycle d'une commande custom : commande fournisseur, préparation de l'impression, expédition.

Flux de production :
- Deux étapes en parallèle : la commande fournisseur (export CSV IMBRETEX) et l'impression DTF.
- Les fichiers d'impression vont sur le PC atelier dans `DTF/print_AAAAMMJJ/`, déjà dézippés. Pas de Google Drive pour ordinateur sur ce PC.
- Chaque fichier passe ensuite par un script d'import Illustrator, puis par le RIP.
- Les étiquettes d'expédition sont faites dans Sendcloud, ouvert en permanence sur un 2e écran. Sendcloud crée les fulfillments Shopify.

## Architecture

- **`index.html`** : toute l'application, une SPA d'environ 430 Ko en un seul fichier (HTML + CSS + JS, sans build). Onglets : Tableau de bord, Commandes custom, Fournisseur, Impression, Incidents, Commandes pro, Délais & FOMO, Galerie.
- **`api/`** : fonctions serverless Vercel. Chaque nouveau fichier doit aussi être déclaré dans `vercel.json` (`rewrites`).
  - `shopify.js` : proxy GraphQL Admin. Protégé par l'en-tête `X-App-Password`, il relaie aussi les appels au GAS.
  - `order-delai-webhook.js` : webhook `orders/create`. Calcule `custom.date_limite_traitement` et `custom.est_rush`.
  - `delai-public.js` : délais affichés sur le storefront.
  - `gallery.js` : galerie d'inspiration et pages design.
  - `create-draft-order.js` : brouillons de commandes pro.
- **`lib/`** : code partagé entre endpoints.
  - `shopifyAdmin.js` : jeton OAuth client_credentials, `adminGql`, `getDelaiConfig`.
  - `delaiCalc.js` : **toute** la logique de délais et de fermetures. Source unique, ne jamais dupliquer.
  - `designPageSync.js`.
  - ⚠️ `api/delaiCalc.js` est une vieille copie, différente et inutilisée (tout importe `lib/delaiCalc.js`). Ne pas la modifier : proposer de la supprimer.
- **Google Apps Script (hors repo)** : génère les ZIP d'impression et les sauvegarde dans Drive.
  - Le proxy passe par `GAS_URL` / `GAS_SECRET`. Les gros fichiers vont en direct du navigateur au GAS (`doGet`).
  - Tout changement côté GAS est à faire à la main par Emmanuel : donne-lui la ligne exacte à modifier.
- **Variables Vercel** : `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `APP_PASSWORD`, `GAS_URL`, `GAS_SECRET`, `SHOPIFY_STORE_DOMAIN`.
  - Tu ne peux pas y accéder : Emmanuel les modifie dans le dashboard Vercel.

## Identifiants

- **Boutique Shopify :** `therxshop.myshopify.com` pour l'admin. Shop GID : `gid://shopify/Shop/29315137635`.
- **App Shopify custom :** `prep-orders`. Les webhooks doivent être créés **par cette app**, sinon la vérification HMAC échoue avec `SHOPIFY_CLIENT_SECRET`.
  - On passe pour ça par le bouton « Vérifier / activer les webhooks » de l'onglet Délais & FOMO, qui appelle le proxy.
  - Ne jamais les créer depuis un autre connecteur.
- **Vercel :** projet `shopify-prep-app` (`prj_acQjQrm2o7DAXouXK0TczbNL9DZ5`), équipe `team_z6evk2hViZt4Goi2pvxITfdw`. Production sur `shopify-prep-app.vercel.app`.
  - Chaque push sur `main` part en production.
  - Les journaux d'exécution ne sont gardés qu'environ 1 h.
- **Thème Shopify :** thème publié « prod 0307 » (`gid://shopify/OnlineStoreTheme/202161062213`).
  - Consigne permanente : les modifications du thème se font sur le **dernier thème non publié**, en indiquant dans son titre la fonctionnalité ajoutée.
  - Le code `.liquid` n'est pas dans ce repo.

## Données Shopify

- **Metafields de commande (`custom`) :**
  - `date_limite_traitement` (date) : tri de la liste custom et calendrier ;
  - `est_rush` (booléen) ;
  - `incident` (JSON, journal des incidents par ligne).
- **Metafields boutique, délais (`custom`) :**
  - `delai_production`, `delai_rush` : toujours numérique, jamais vidé par le code ;
  - `rush_actif` (booléen) : c'est **lui** l'interrupteur du rush, ne pas se servir d'un `delai_rush` vide comme signal ;
  - `fomo_actif`, `rush_product` (référence produit), `delai_plancher_fermeture`, `vacances` (liste de metaobjects) ;
  - `alerte_delai_impression`, `alerte_delai_fournisseur`.
- **Metafields boutique écrits par l'app :** `rxwear_print.lots` (historique des lots), `rxwear_gallery.items`, `rxwear_pro.demandes` (JSON des commandes pro).
- **Balises de workflow :**
  - `custom` (commande à préparer), `urgent` ;
  - `TOORDER` → `order_AAAAMMJJ` (fournisseur) ;
  - `TODOPRINT` → `print_AAAAMMJJ` (impression) ;
  - `INCIDENT`, `REEXPEDIER`, `incident_hist` ;
  - `custompro`.
- **Lignes non physiques :** RUSH (« Traitement Commande personnalisée RUSH (48h/72h) ») et frais (ex. « Frais template extra large texte ») ont `requiresShipping = false`. Utiliser `isPhysicalLine()` pour les exclure de la préparation.

## Pièges connus (à respecter)

- **`currentQuantity`, pas `quantity` :** `quantity` inclut les unités retirées ou remboursées. Filtrer avec `activeLineItemEdges()` partout où c'est question de préparation, d'export fournisseur, de ZIP ou de fulfillment.
- **Historique :** ne pas mettre `status:open` dans une requête qui doit couvrir l'historique (ça exclut les commandes archivées). Filtrer par balise seule.
- **Vercel coupe les réponses à 4,5 Mo :** pas de ZIP ni de gros binaire par une fonction Vercel. Passer en direct du navigateur au GAS.
- **Erreurs GAS :** le GAS renvoie ses erreurs en HTTP 200, le message d'erreur dans le corps. Lire le contenu, pas seulement le code HTTP.
- **Apostrophes françaises :** dans les template literals et les chaînes JS, elles cassent le script. Utiliser la concaténation et les échappements Unicode (`é`, `’`…), comme dans le reste du code.
- **Écritures de gros JSON en metafield :** relire après écriture et vérifier les comptes.
- **Recherche Shopify :** elle met quelques secondes à prendre en compte une nouvelle balise. `refreshProdBadges()` relit tout de suite, puis à +3 s et +8 s.
- **Webhooks :** toujours répondre 200, même en cas d'erreur interne (log + 200), sinon Shopify renvoie la notification en boucle. Toujours vérifier le HMAC sur le body brut (`bodyParser: false`).
- **Nommage des fichiers d'impression :** `{commande}_x{qte}_design_L{ligne}_{PRODUIT}.ai`. Il est dupliqué entre `generateZips()` (GAS) et `buildPrintFileList` (index.html) : les modifier ensemble.

## UI

- **Vue Commandes custom :** elle sert au poste de préparation, qui n'a qu'un **écran tactile et un pavé numérique**. Grosses cibles, pas de survol.
- **Autres onglets :** interface bureau classique (souris et clavier). Ne pas y appliquer le mode tactile.
- **Modale de note client :** elle reste bloquante et réapparaît à chaque ouverture. La croix ferme sans valider, c'est voulu.
- **Vocabulaire :** « Incident » et non « SAV ». Préférer des libellés parlants (« Marquer comme imprimé ») aux noms de balises.

## Façon de travailler

- **Discuter avant de coder** dès que l'architecture est touchée. Expliquer l'impact sur le code existant avant de modifier.
- **Simplicité avant tout :** éviter la maintenance manuelle, la logique dupliquée et les réglages à faire à la main (« flemme »).
- **Une seule source de vérité :** mettre la logique commune dans `lib/`, ne pas la copier.
- **Opérations ponctuelles sur les données** (reconstruction rétroactive…) : les exécuter directement sur la boutique plutôt que d'ajouter un bouton dans l'UI.
- **Git :** travailler sur une branche et pousser la branche. Vercel crée une préversion. Ne fusionner sur `main` (= production) que si Emmanuel le demande.
- **Livraison :** récapitulatif court en français, avec ce qui a changé, ce qu'il doit faire à la main (GAS, bouton webhooks, variables Vercel) et comment vérifier.

## Vérification avant chaque commit

Vérifier la syntaxe de tout le JS de `index.html` :

```bash
python3 -c "import re;s=open('index.html').read();open('/tmp/all.js','w').write('\n'.join(re.findall(r'<script(?![^>]*src)[^>]*>(.*?)</script>',s,re.S)))" && node --check /tmp/all.js
```

Pour les endpoints, ils mélangent `export` et `require` : copier le fichier en `.mjs`, puis lancer `node --check`.

Valider toute requête GraphQL Admin contre le schéma avant de l'exécuter.

## En cours (au 30/09/2026)

**Webhook `fulfillments/create`**, préparé dans Cowork, pas encore dans le repo si ces fichiers sont absents. Quand Sendcloud a expédié tous les articles physiques, il marque aussi les lignes RUSH et frais comme traitées, sans notifier le client. La commande passe ainsi en « Traitée » et non plus en « Partielle ».

Fichiers :
- `api/fulfillment-webhook.js` (nouveau) ;
- `lib/webhookAuth.js` (nouveau : HMAC partagé) ;
- `api/order-delai-webhook.js` (utilise `webhookAuth`) ;
- `vercel.json` ;
- `index.html` : `physFulfillStatus()`, et le bouton qui enregistre les deux webhooks.

À vérifier à la mise en ligne :
- l'app doit avoir le droit `write_merchant_managed_fulfillment_orders` ;
- cliquer une fois sur « Vérifier / activer les webhooks ».

**Pistes suivantes :** stock tampon des références custom pour l'export IMBRETEX, détection des risques de retard, tableau de bord visuel des pools de commandes, optimisation des lots fournisseur et DTF, écran d'atelier / mode veille.
