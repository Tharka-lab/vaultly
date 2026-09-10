# Extension Vaultly

Cette extension est volontairement locale. Elle ne stocke pas les mots de passe : elle demande les identifiants au pont `127.0.0.1` uniquement quand Vaultly est déverrouillé.

1. Dans Chrome ou Edge, ouvre la page des extensions et active le mode développeur.
2. Choisis « Charger l’extension non empaquetée » et sélectionne ce dossier `browser-extension`.
3. Dans Vaultly, ouvre Paramètres → Autoremplissage web → Copier la configuration.
4. Ouvre les options de l’extension, colle le port et le jeton, puis teste la connexion.

Le bouton Vaultly apparaît uniquement sur les pages dont le domaine correspond à une entrée enregistrée. L’extension surveille aussi les formulaires ajoutés après le chargement, ce qui couvre mieux les interfaces web dynamiques. Elle remplit un champ TOTP détecté lorsque l’entrée contient un secret 2FA ; le code et ses paramètres sont calculés localement dans l’extension.

L’autoremplissage agit seulement sur les champs de connexion HTML visibles détectés dans la page courante ; les formulaires isolés dans un contexte inaccessible ou les parcours sans champ standard peuvent nécessiter une adaptation du site.
