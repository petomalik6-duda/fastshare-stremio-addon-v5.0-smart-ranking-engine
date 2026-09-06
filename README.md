# FastShare Stremio Addon v6.4.0

FastShare stream addon pre Stremio/Nuvio s lokalizovaným CZ/SK vyhľadávaním, presným rankingom, NardBadges dizajnom a overovaním audio jazyka z názvu release.

## Čo je nové vo v6.4.0

### Presnejší fuzzy ranking

v6.4 odstránila staré pravidlo, podľa ktorého sa dve dlhšie slová mohli považovať za zhodné iba preto, že mali rovnaké prvé štyri písmená. Ranking teraz používa Levenshtein vzdialenosť a minimálnu podobnosť približne 80–82 %.

To zachováva užitočné CZ/SK tvary ako `Prada` / `Pradu`, ale znižuje falošné zhody podobných názvov.

### Dvojfázové FastShare vyhľadávanie

Addon už neposiela všetky široké dotazy naraz.

1. **Primary stage** skúsi najpresnejšie hlavné/CZ/SK názvy s rokom alebo presným `SxxExx`.
2. Ak už nájde dostatok kvalitných výsledkov, vyhľadávanie skončí.
3. **Fallback stage** sa spustí iba keď primary stage nemá dosť použiteľných streamov.

Výsledkom je menej FastShare API requestov a rýchlejšie otvorenie titulov, ktoré sa nájdu presným názvom.

### Timeout a izolácia chýb

Každý FastShare search má vlastný timeout. Zlyhanie alebo timeout jedného vyhľadávacieho termu už nezruší celý stream request; ostatné termy sa normálne vyhodnotia.

### Krátkodobá FastShare search cache

Úspešné výsledky vyhľadávania sa predvolene cacheujú 3 minúty a cache je oddelená podľa FastShare session. HTTP chyby a timeouty sa necachujú.

### Stabilné poradie aliasov

Hlavný metadata názov je vždy prvý a nemôže vypadnúť po dosiahnutí limitu aliasov. Potom majú prioritu CZ, SK, originálne/EN a ostatné automatické aliasy; ručné fallback aliasy sú až na konci.

### Lepšie seriály

Ranking rozlišuje:

- presnú epizódu,
- multi-episode súbor, napr. `S01E01E02`,
- season pack / complete season,
- nesprávnu epizódu alebo sériu.

Ak sa nájde samostatná požadovaná epizóda, season pack sa z výsledkov odstráni. Pack zostáva fallback iba vtedy, keď samostatná epizóda nie je dostupná.

### Modulárna architektúra

Produkčný runtime sa presunul do `src/`:

- `src/config.js` – konfigurácia a environment premenné,
- `src/utils.js` – spoločné utility, cache a timeout fetch,
- `src/ranking.js` – title/audio/episode ranking a search plán,
- `src/metadata.js` – Cinemeta, TMDB a Wikidata aliasy,
- `src/fastshare.js` – login, FastShare search, timeout a cache,
- `src/badges.js` – Nuvio/NardBadges,
- `src/server.js` – HTTP/Stremio server a dvojfázový stream pipeline.

Pôvodný koreňový `server.js` zostáva dočasne ako legacy referencia. `npm start` už používa `src/server.js`.

## Lokalizované vyhľadávanie

Pre IMDb titul addon používa:

1. hlavný názov z Cinemety,
2. české a slovenské názvy z TMDB, ak je nastavený TMDB token alebo API key,
3. české, slovenské a anglické názvy z Wikidata,
4. alternatívne názvy z metadata,
5. voliteľné `TITLE_ALIASES_JSON`,
6. vstavané overené fallback aliasy.

## Odporúčané Render nastavenie

Build command:

```txt
npm ci --omit=dev --no-audit --no-fund
```

Start command:

```txt
npm start
```

Odporúčané premenné:

```txt
PORT=10000
BASE_URL=https://tvoja-sluzba.onrender.com
TMDB_READ_ACCESS_TOKEN=tvoj_token
```

Voliteľné tuning premenné:

```txt
MAX_STREAMS=60
MAX_SEARCH_TERMS=24
PRIMARY_SEARCH_TERMS=6
PRIMARY_MATCH_TARGET=6
MAX_TITLE_ALIASES=12
SEARCH_CONCURRENCY=3
FASTSHARE_SEARCH_TIMEOUT_MS=7000
FASTSHARE_LOGIN_TIMEOUT_MS=7000
FASTSHARE_SEARCH_CACHE_TTL_MS=180000
FASTSHARE_SEARCH_CACHE_MAX=1000
HTTP_TIMEOUT_MS=9000
METADATA_CACHE_TTL_MS=2592000000
METADATA_NEGATIVE_CACHE_TTL_MS=21600000
METADATA_CACHE_MAX=2000
ENABLE_WIKIDATA_ALIASES=1
```

## Diagnostika

Health:

```txt
/health
```

Musí vracať `"version":"6.4.0"`, `"architecture":"modular-v6.4"` a `"searchMode":"two-stage"`.

Metadata a plán vyhľadávania:

```txt
/debug/meta/movie/tt33612209.json
/debug/meta/series/tt0944947:1:2.json
```

Po prihlásení celý stream pipeline:

```txt
/<config>/debug/stream/movie/tt33612209.json
```

Debug odpoveď v6.4 ukazuje zvlášť `search.primary`, `search.fallback`, `searchPlan.usedFallback` a pri jednotlivých FastShare dotazoch aj `cache`, `error` alebo `timedOut`.

## Nuvio badges

Hlavný NardBadges preset:

```txt
/nuvio-badges.json
```

Alternatívny alias:

```txt
/nuvio-nard-badges.json
```

Lokálne doplnkové filtre:

```txt
/nuvio-badges-extra.json
```

Audio jazyk sa zobrazí iba pri dostatočnom dôkaze (`CZ dabing`, `CZ audio`, `CZ AC3 5.1`, atď.). Samotný token `CZ`, `SK` alebo `EN` sa nepovažuje za dôkaz zvukovej stopy.

## Testy a CI

Lokálne:

```txt
npm ci
npm test
```

GitHub Actions automaticky spúšťa syntax check, unit/regression testy a smoke import runtime na Node.js 20 pri pull requestoch a push do sledovaných vetiev.

## Kompatibilita konfigurácie

v6.4 nemení formát existujúcich konfiguračných URL. Súčasné Base64URL manifest tokeny preto zostávajú kompatibilné. URL stále obsahuje iba zakódované, nie zašifrované prihlasovacie údaje, preto ju nezverejňuj.
