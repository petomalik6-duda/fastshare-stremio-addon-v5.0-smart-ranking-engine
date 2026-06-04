FastShare v6.1 General Year + Audio Patch

Toto je maly patch pre funkcnu verziu 6.1.

Co opravuje:
1. Rok:
   - ak nazov sedi silno a rok je posunuty o 1 rok, vysledok sa nezahodi
   - ak nazov nesedi a rok je iny, stale sa penalizuje
   - funguje vseobecne, nie len pre Winter in Sokcho

2. Audio:
   - CZ tit / CZ subs / CZ title uz nebude CZ Audio
   - SK tit / SK subs uz nebude SK Audio
   - CZ Dabing a SK Dabing ostavaju preferovane

Subory:
- PATCH-v6.1.js obsahuje funkcie, ktore mas vlozit do funkcneho server.js

Test po uprave:
<config>/debug/stream/movie/tt30519830.json
