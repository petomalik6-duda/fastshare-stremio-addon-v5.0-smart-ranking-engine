# FastShare Stremio Addon v6.3.3

Táto verzia všeobecne dopĺňa české a slovenské názvy pre filmy aj seriály podľa IMDb ID. Už nie je odkázaná iba na ručne zapísaný alias jedného filmu.

## Ako funguje lokalizované vyhľadávanie

Pri požiadavke na stream addon zostaví názvy z viacerých zdrojov:

1. názov a alternatívne názvy z Cinemety,
2. české a slovenské názvy z TMDB, ak je nastavený TMDB token alebo API kľúč,
3. české, slovenské a anglické názvy z Wikidata bez potreby API kľúča,
4. voliteľné ručné aliasy z `TITLE_ALIASES_JSON`,
5. vstavané aliasy iba ako núdzový fallback pre overené problematické tituly.

Výsledky sa držia v pamäťovej cache, aby sa externé zdroje nevolali pri každom otvorení filmu.

## Odporúčané nastavenie TMDB

Wikidata funguje bez kľúča, ale najširšie pokrytie lokalizovaných názvov poskytne TMDB. Na Renderi nastav jednu z týchto premenných:

```txt
TMDB_READ_ACCESS_TOKEN=tvoj_TMDB_Read_Access_Token
```

alebo:

```txt
TMDB_API_KEY=tvoj_TMDB_API_key
```

Stačí jedna z nich. Read Access Token je odporúčaný.

## Render nastavenie

Build command:

```txt
npm install --omit=dev --no-audit --no-fund
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

Voliteľné:

```txt
MAX_STREAMS=60
MAX_SEARCH_TERMS=24
MAX_TITLE_ALIASES=12
SEARCH_CONCURRENCY=3
METADATA_CACHE_TTL_MS=2592000000
METADATA_NEGATIVE_CACHE_TTL_MS=21600000
METADATA_CACHE_MAX=2000
HTTP_TIMEOUT_MS=9000
ENABLE_WIKIDATA_ALIASES=1
```

`METADATA_CACHE_TTL_MS=2592000000` je približne 30 dní. Neúspešné alebo prázdne dohľadanie sa cacheuje iba približne 6 hodín, aby sa po dočasnom výpadku zdroj skúsil znova. Cache je v pamäti a po reštarte Render služby sa vytvorí znova.

## Nasadenie

1. Nahraj celý obsah balíka do GitHub repozitára.
2. V Renderi doplň TMDB token alebo API kľúč.
3. Spusti **Manual Deploy → Clear build cache & deploy**.
4. Otvor `/health`; musí vrátiť `"version":"6.3.3"`.
5. Odstráň starú inštaláciu addonu zo Stremia a znova ho nainštaluj cez `/configure`.

## Kontrola názvov

Bez FastShare prihlásenia môžeš skontrolovať získané aliasy:

```txt
/debug/meta/movie/tt33612209.json
```

Pre seriál s konkrétnou epizódou:

```txt
/debug/meta/series/tt0944947:1:1.json
```

Odpoveď obsahuje:

- `meta.localizedAliases` – automaticky nájdené názvy,
- `meta.localizedTitleData.sources` – ktoré zdroje odpovedali,
- `aliases` – finálny zoznam názvov použitý rankingom,
- `terms` – vyhľadávacie dotazy odoslané na FastShare; pri názvoch s diakritikou obsahujú aj variant bez diakritiky.

Po prihlásení môžeš skontrolovať celý stream proces:

```txt
/<config>/debug/stream/movie/tt33612209.json
```

## Vlastné aliasy

Ručný alias zostáva ako posledná možnosť pre titul, ktorý nemá lokalizovaný názov ani v TMDB, ani vo Wikidata:

```txt
TITLE_ALIASES_JSON={"tt1234567":["Cesky nazov","Slovensky nazov"]}
```

## Lokálne testy

```txt
npm install
npm test
npm start
```
