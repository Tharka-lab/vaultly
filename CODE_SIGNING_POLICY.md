# Politique de signature de Vaultly

Vaultly est un projet open source distribué sous licence MIT.

Les releases Windows sont construites depuis ce dépôt GitHub par GitHub Actions. Les artefacts de production sont soumis à SignPath Foundation pour signature de code gratuite dans le cadre de son programme open source.

Free code signing provided by SignPath.io, certificate by SignPath Foundation. La clé privée de signature est conservée par SignPath Foundation dans un module matériel sécurisé et n'est jamais stockée dans ce dépôt ni dans GitHub Actions.

## Rôles

- Mainteneur et relecteur : [Tharka-lab](https://github.com/Tharka-lab), propriétaire du dépôt GitHub.
- Approbateur de signature : [Tharka-lab](https://github.com/Tharka-lab), mainteneur autorisé à approuver une release vérifiée.

## Chaîne de confiance

1. Une release est déclenchée par un tag de version `vX.Y.Z`.
2. GitHub Actions construit l'application sur un runner Windows hébergé par GitHub.
3. L'artefact non signé est enregistré comme artefact GitHub Actions.
4. SignPath vérifie l'origine du dépôt et du build, puis signe l'installateur.
5. La release GitHub publie l'installateur signé et son manifeste updater.

Les fichiers de coffre, mots de passe, clés updater privées, jetons SignPath et autres secrets ne doivent jamais être commités dans ce dépôt.

## Confidentialité

Vaultly est local-first. La signature de code ne transmet à SignPath que les artefacts de build et les métadonnées nécessaires à la vérification de leur origine. Les coffres et identifiants des utilisateurs ne sont jamais inclus dans les artefacts de release.
