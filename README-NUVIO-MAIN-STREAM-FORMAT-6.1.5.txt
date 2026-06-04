FastShare v6.1.5 Nuvio Main Stream Format Fix

Postavené nad funkčnou v6.1.3.

Čo sa mení:
- hlavný /stream endpoint už vracia Nuvio-kompatibilný objekt:
  name
  title
  description
  url
  externalUrl
- behaviorHints sú odstránené z hlavného stream výstupu
- manifest používa jednoduchšie resources: ['stream']
- odstránené falošné zhody House of the Dragon pri Game of Thrones

Test:
1. /health -> version 6.1.5
2. /<config>/manifest.json
   musí obsahovať:
   "resources":["stream"]
3. /<config>/stream/series/tt0944947:1:1.json
   prvý stream má mať description aj externalUrl
4. Potom v Nuvio odstrániť starý addon a pridať nanovo manifest URL.
