# WikiMasters Bot

Bot auto-hébergé qui ouvre automatiquement tes paquets WikiMasters à intervalle régulier, avec un tableau de bord web :

- compte à rebours avant le prochain run et barre de progression ;
- boutons **Paramètres**, **Pause / Reprendre** et **Run now** ;
- statistiques (paquets ouverts, cartes trouvées, runs terminés) ;
- dernier run et historique, avec les cartes obtenues classées par rareté (C, PC, R, TR, E, L) ;
- gestion des erreurs : session expirée (`needs reconnect`), limite atteinte (`HTTP 429`, le bot attend `retry_after`), vérification anti-bot.

Aucune dépendance npm : Node.js ≥ 20 suffit.

> **Vérification anti-bot :** si WikiMasters renvoie `human_verification_required`, le bot ne tente **pas** de la contourner. Il se met en attente. Fais la vérification toi-même sur le site, puis clique sur « J'ai fait la vérification, reprendre » dans le tableau de bord.
> Utiliser un bot peut être contraire aux conditions d'utilisation du jeu. Tu le fais à tes risques (sanction possible du compte).

## Installation

```bash
cp .env.example .env    # puis édite .env (DASHBOARD_PASSWORD, SESSION_SECRET…)
npm start               # http://localhost:3000
```

Avec Docker :

```bash
cp .env.example .env
docker compose up -d --build
```

L'état (statistiques, historique, session WikiMasters) est stocké dans `data/state.json`. Ce fichier contient ton cookie ou tes tokens : ne le partage pas. Derrière un reverse proxy HTTPS (Caddy, Nginx, Traefik…), mets `COOKIE_SECURE=true`.

## Configurer l'API WikiMasters

Les endpoints de WikiMasters ne sont pas documentés publiquement. Vérifie-les une fois :

1. Ouvre WikiMasters dans ton navigateur, puis DevTools (F12), onglet **Réseau**.
2. Ouvre un paquet à la main et repère la requête qui l'ouvre.
3. Reporte son URL dans `.env` : `WM_BASE_URL` et `WM_OPEN_PACK_PATH` (ex. `/api/packs/open`).
4. Optionnel : `WM_PACKS_STATUS_PATH` (endpoint GET qui renvoie le nombre de paquets disponibles) et `WM_REFRESH_PATH` (rafraîchissement du token).

Le client lit plusieurs formats de réponse (`cards`, `pack.cards`, `data.cards`… ; champs `title`/`name`, `rarity`/`rarete`). Si tes cartes s'affichent mal, ajuste `extractCards` dans `src/wikimasters.js`.

## Connecter ta session

Dans le tableau de bord, ouvre **Paramètres** (icône curseurs) :

- **Mode cookie** : copie la valeur de l'en-tête `Cookie` d'une requête WikiMasters dans les DevTools. Le bot met à jour automatiquement les cookies renvoyés par le serveur (`Set-Cookie`).
- **Mode token** : colle l'access token et le refresh token. En cas de `401`, le bot rafraîchit le token. Si le refresh est refusé, le run passe en `needs reconnect` et le bot attend une nouvelle session.

Les secrets ne sont jamais renvoyés au navigateur. Le tableau de bord indique seulement s'ils sont présents.

## Paramètres

| Paramètre | Défaut | Notes |
|---|---|---|
| Intervalle | 50 min | minimum 10 min (WikiMasters donne 1 paquet / 10 min, 10 max en stock) |
| Paquets max par run | 5 | limité au nombre de paquets disponibles si `WM_PACKS_STATUS_PATH` est configuré |

## Développement

```bash
npm run dev   # redémarre à chaque modification
npm test      # tests avec un faux serveur WikiMasters
```

Structure :

```
src/server.js       serveur HTTP, auth du dashboard, API /api/*
src/bot.js          planification et exécution des runs
src/wikimasters.js  client WikiMasters (cookie/token, refresh, 403/429)
src/store.js        persistance JSON (data/state.json)
public/             tableau de bord (HTML/CSS/JS vanilla)
```
