# FastShare Stremio Addon v5.1 Smart Matching Fix

Fixes v5.0 ranking:
- stronger different-year penalty (`-200`)
- filters sequel mismatch, e.g. Avatar 2 / Fire and Ash when opening Avatar 2009
- better CZE/CS/ENG multi-audio detection
- detects `SK dub`, `ENG+CZE`, `Cs+En-Dab+Tit`, `audio CZE-ENG-SPA-HUN`
- keeps playback mode from working v5.0/direct stream

## Render

Environment:

```text
NODE_VERSION=20
PORT=10000
BASE_URL=https://your-app.onrender.com
FASTSHARE_USERNAME=your_login
FASTSHARE_PASSWORD=your_password
FASTSHARE_PLAYBACK_MODE=direct_stream
FASTSHARE_MAX_RESULTS=12
```

Build command:

```text
npm install --omit=dev --no-audit --no-fund
```

Start command:

```text
npm start
```
