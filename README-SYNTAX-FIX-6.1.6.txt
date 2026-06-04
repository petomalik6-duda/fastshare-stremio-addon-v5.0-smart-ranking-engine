FastShare v6.1.6 Syntax Fixed

Toto je oprava v6.1.5, ktorá padala na:
SyntaxError: Invalid or unexpected token

Príčina:
- pri generovaní balíka sa join('\n') rozbil na nový riadok v JS stringu.

Overené:
- node --check server.js prešlo úspešne.

Zachované z v6.1.5:
- hlavný /stream endpoint má description aj externalUrl
- odstránené behaviorHints z hlavného stream objektu
- jednoduchšie resources: ['stream']
- kompatibilnejší výstup pre Nuvio
