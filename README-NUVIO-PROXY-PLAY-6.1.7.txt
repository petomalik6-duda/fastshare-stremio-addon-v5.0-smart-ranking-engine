FastShare v6.1.7 Nuvio Proxy Play

Postavené nad funkčnou v6.1.6.

Čo sa mení:
- hlavný /stream endpoint vracia url ako lokálnu addon URL:
  /play/<token>
- /play/<token> iba 302 presmeruje na FastShare stream URL
- externalUrl a directUrl obsahujú pôvodný FastShare odkaz
- toto pomáha klientom ako Nuvio, ktoré môžu odmietať priame data*.fastshare.cloud URL
- manifest je vrátený do klasického objektového resources formátu

Test:
1. /health -> 6.1.7
2. /<config>/stream/series/tt0944947:1:1.json
   prvý stream má url začínajúcu tvojou doménou /play/
3. Otvor url z prvého streamu v prehliadači.
   Má presmerovať na FastShare.
4. V Nuvio odstráň starý addon a pridaj nanovo manifest URL.
