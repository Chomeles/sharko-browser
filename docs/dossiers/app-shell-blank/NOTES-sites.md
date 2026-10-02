# app-shell-blank: Stand der Sites

Gefixt (PR #48): nzz.ch (blob:-Skripte + async-Module-Reihenfolge, 0 → 3357 Wörter), o2online.de (11 → 187 Wörter, Chromium 1568).

Bot-Wall in der Sandbox (Chromium sieht ebenfalls nichts Brauchbares), nicht bewertbar:
- kicker.de: DataDome-Captcha (`geo.captcha-delivery.com`).
- microsoft.com/de-de: Akamai-Block ("Your request has been blocked"); die JSON.parse-Fehler stammen von der Block-Seite.
- ebay.de: sitediff `chromium blocked`.
- tiktok.com: Chromium rendert hier ebenfalls nur ein Toast; Sharko-Fehler `new Request(usedRequest)` und `Timezone "UTC" not found` (Intl) sind separat prüfenswert.

Offen:
- o2online.de: `tef-scope`-Sektionen (Lit, Shadow DOM) bleiben ohne Text; Shadow-Root enthält nur `<!---->`. Ursache nicht gefunden (keine Konsolenfehler).
- airbnb.de: Wörter gleich (620 vs 587), Score 77 durch fehlende Stylesheet-Regeln (`stylesheets-missing`); nicht untersucht.
