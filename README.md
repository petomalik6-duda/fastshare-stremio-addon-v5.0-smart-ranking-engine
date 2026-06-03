# FastShare Stremio Addon v6.0 Configurator

## Render env

Required:

```txt
PORT=10000
BASE_URL=https://your-render-service.onrender.com
```

Optional fallback account:

```txt
FASTSHARE_USERNAME=your_fastshare_login
FASTSHARE_PASSWORD=your_fastshare_password
```

## Build command

```txt
npm install --omit=dev --no-audit --no-fund
```

## Start command

```txt
npm start
```

## Install

Open:

```txt
https://your-render-service.onrender.com/configure
```

Enter FastShare login/password and install generated manifest URL.


## v6.2
- Strict audio detection: CZ/SK dabing only from explicit dab/audio markers.
- Bare CZ/SK is shown as probable language, not confirmed dabing.
- CZ/EN and SK/EN detection improved.
