FastShare v6.1.3 Nuvio Series Fix

Postavené nad funkčnou v6.1.2.

Opravy:
- Stremio routy ostávajú:
  /<config>/stream/series/tt0944947:1:1.json

- Pridané Nuvio kompatibilné routy:
  /<config>/stream/series/tt0944947/1/1.json
  /<config>/streams/series/tt0944947/1/1.json

- Pridané aj nekonfigurované debug varianty:
  /<config>/debug/stream/series/tt0944947/1/1.json

Test:
1. /health musí ukázať version 6.1.3
2. Stremio formát:
   /<config>/debug/stream/series/tt0944947:1:1.json
3. Nuvio formát:
   /<config>/debug/stream/series/tt0944947/1/1.json
