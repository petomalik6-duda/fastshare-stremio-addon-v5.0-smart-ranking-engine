FastShare v6.1.2 Series Fix

Postavené priamo nad funkčnou v6.1.1.

Opravy:
- lepšie termy pre seriály:
  Názov S01E01
  Názov S1E1
  Názov 1x01
  Názov 1x1
  Názov season 1 episode 1
  Názov ep 1
- scoring dá veľký bonus za správny pattern epizódy
- ak je epizóda jasne iná, výsledok sa vyhodí
- pri seriáloch je miernejší threshold skóre
- filmy, Winter in Sokcho a audio opravy ostávajú z v6.1.1

Test:
<config>/debug/stream/series/tt0944947:1:1.json
<config>/debug/search?term=Game%20of%20Thrones%20S01E01
