FastShare v6.1.4 Nuvio Stream Format Fix

Postavené nad funkčnou v6.1.3.

Čo sa mení:
- stream objekty majú okrem title a url aj description
- stream objekty majú aj externalUrl = url
- pridané /nuvio/stream/... routy bez behaviorHints
- Stremio routy ostávajú zachované

Test:
1. /health -> version 6.1.4
2. Stremio:
   /<config>/stream/series/tt0944947:1:1.json
3. Nuvio fallback:
   /<config>/nuvio/stream/series/tt0944947:1:1.json
   /<config>/nuvio/stream/series/tt0944947/1/1.json

Ak Nuvio normálnu manifest URL stále ukazuje prázdnu, použi v Nuvio manifest z tejto verzie a v logu skontroluj,
či volá /stream alebo /nuvio/stream.
