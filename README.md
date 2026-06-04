FastShare Stremio Addon v6.2.2 Winter Sokcho Hotfix

Build Command:
npm install --omit=dev --no-audit --no-fund

Start Command:
npm start

Test:
/health
/configure
/<config>/debug/search?term=winter%20in%20sokcho
/<config>/debug/search?term=hiver%20a%20sokcho
/<config>/debug/stream/movie/tt30519830.json

Fixes:
- adds Winter in Sokcho / Hiver a Sokcho / Sokcho search aliases
- CZ tit/subs/title is no longer shown as CZ Audio
- keeps the stable v6.2 login/playback style
