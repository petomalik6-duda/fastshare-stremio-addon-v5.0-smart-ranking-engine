# FastShare Stremio Addon v5.0 beta Language Priority

Používa FastShare Kodi API.

## Render env

```text
PORT=10000
BASE_URL=https://tvoja-sluzba.onrender.com
FASTSHARE_USERNAME=tvoje_meno
FASTSHARE_PASSWORD=tvoje_heslo
FASTSHARE_PLAYBACK_MODE=direct_stream
FASTSHARE_MAX_RESULTS=12
```

Voliteľne namiesto mena/hesla:

```text
FASTSHARE_HASH=...
```

## Testy

```text
/health
/manifest.json
/debug/login
/debug/search?term=avatar
/debug/stream/movie/tt0499549.json
```

## v5.0 beta

- zjednotené označenia: CZ Dabing, SK Dabing, EN Audio, CZ/SK titulky
- `cz title`, `cz tit`, `cz subs` už nie je dabing
- priorita výsledkov: CZ Dabing > SK Dabing > EN Audio > neznáme
- v rámci rovnakého jazyka: 4K > 1080p > 720p, MKV > MP4 > AVI
- kvalitné EN/4K výsledky sa nezahadzujú
