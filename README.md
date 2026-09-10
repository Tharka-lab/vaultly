# Publication et mises à jour signées

Le plugin updater de Tauri est intégré à Vaultly et le bouton de vérification est disponible dans l’application. La publication automatique utilise SignPath Foundation pour la signature Authenticode gratuite du projet open source ; la clé privée du certificat reste dans le coffre matériel de SignPath.

1. Générer une clé de signature locale avec `npm run tauri signer generate -- -w chemin\vaultly.key` et conserver la clé privée hors du dépôt.
2. Créer le projet Vaultly dans SignPath Foundation, installer le connecteur GitHub et configurer une politique de signature Authenticode pour l’installeur NSIS.
3. Construire avec `TAURI_SIGNING_PRIVATE_KEY` et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` définis dans l’environnement de publication. Cette clé concerne la signature updater et n’est pas le certificat Authenticode.
4. Définir `TAURI_UPDATER_PUBLIC_KEY` et `TAURI_UPDATER_ENDPOINT` (HTTPS), puis lancer `npm run prepare:updater`. Le fichier `src-tauri/tauri.release.conf.json` est généré localement et ignoré par Git ; il active la signature updater et les artefacts nécessaires à SignPath.
5. Construire avec `npm run tauri:build -- --config src-tauri/tauri.release.conf.json`, déposer l’installeur non signé comme artefact GitHub Actions, puis le soumettre à SignPath.
6. Après récupération de l’installeur signé, définir `TAURI_UPDATER_BASE_URL` avec l’URL HTTPS du dossier de publication et lancer `npm run release:manifest`. Le script vérifie qu’un bundle `.nsis.zip` et sa signature `.sig` existent, puis génère `release/latest.json`.
7. Lancer `npm run release:verify` : la publication est refusée si l’installeur n’est pas Authenticode valide ou si le manifeste updater est incomplet.
8. Publier le bundle signé et `latest.json` sur la release GitHub.

Pour un build local non signé, `npm run prepare:updater` accepte l’absence de certificat Authenticode. La signature de production est effectuée uniquement par SignPath dans le workflow GitHub Actions.

## Publication GitHub Actions

Le workflow `.github/workflows/release.yml` automatise la publication Windows lorsqu’un tag `v*` est poussé. Ajoute dans les secrets du dépôt `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `TAURI_UPDATER_PUBLIC_KEY`, `SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG` et `SIGNPATH_SIGNING_POLICY_SLUG`. Le workflow construit l’installeur, le dépose temporairement comme artefact GitHub Actions, le soumet à SignPath, récupère l’artefact signé, vérifie Authenticode et publie le bundle NSIS, sa signature updater, l’installeur et `latest.json` dans la release GitHub.

Ne jamais committer la clé privée, son mot de passe ou un manifeste contenant des valeurs fictives dans une version de production.
