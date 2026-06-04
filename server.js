const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const VERSION = '6.3.0';
const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const API = 'https://fastshare.cz/api/api_kodi.php';

function getBase(req){ return BASE_URL || `${req.protocol}://${req.get('host')}`; }
function enc(o){ return Buffer.from(JSON.stringify(o),'utf8').toString('base64url'); }
function dec(s){ try{return JSON.parse(Buffer.from(String(s||''),'base64url').toString('utf8'))}catch{return {}} }
function cfg(req){ const d=req.params.config?dec(req.params.config):{}; return {username:d.username||process.env.FASTSHARE_USERNAME||'',password:d.password||process.env.FASTSHARE_PASSWORD||'',maxStreams:Number(d.maxStreams||process.env.MAX_STREAMS||25)}; }
function norm(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/[^a-z0-9]+/g,' ').trim();}
function words(s){const stop=new Set(['the','a','an','and','or','of','to','in','on','for','from','with','cz','sk','en','eng','dabing','dab','audio','tit','titulky','subs','sub','mkv','mp4','avi','1080p','720p','2160p','4k','hd','uhd','fhd','fullhd','bluray','bdrip','webrip','web','dl','x264','x265','h264','h265']);return norm(s).split(/\s+/).filter(w=>w&&w.length>1&&!stop.has(w));}
function extOf(n){const m=String(n||'').match(/\.([a-z0-9]{2,5})(?:$|[\s._-])/i);return m?m[1].toUpperCase():'';}
function qOf(n){const x=norm(n); if(/2160p|4k|uhd|uhdr/.test(x))return '4K'; if(/1080p|fullhd|fhd/.test(x))return '1080p'; if(/720p| hd /.test(' '+x+' '))return '720p'; if(/480p|sd/.test(x))return '480p'; return '';}
function sizeText(b){const n=Number(b||0); if(!n)return ''; const gb=n/(1024**3); if(gb>=1)return `${gb>=10?Math.round(gb):gb.toFixed(1)} GB`; return `${Math.round(n/(1024**2))} MB`;}
function durText(s){s=Number(s||0); if(!s)return ''; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60); return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;}

function detectAudio(name){
  const n=norm(name);
  const czSubs=/\b(cz\s*tit|cztit|cz\s*titulky|cz\s*sub|cz\s*subs|cz\s*subtitle|cz\s*title|czforced|czech\s*subs|ceske\s*titulky)\b/.test(n);
  const skSubs=/\b(sk\s*tit|sktit|sk\s*titulky|sk\s*sub|sk\s*subs|sk\s*subtitle|sk\s*title|slovak\s*subs|slovenske\s*titulky)\b/.test(n);
  const czDub=/\b(cz\s*dab|czdab|cz\s*dabing|czech\s*(audio|dub|dabing)|cesky\s*dabing|cze\s*(audio|dub))\b/.test(n);
  const skDub=/\b(sk\s*dab|skdab|sk\s*dabing|slovak\s*(audio|dub|dabing)|slovensky\s*dabing|svk\s*(audio|dub))\b/.test(n);
  const en=/\b(en|eng|english)\s*(audio|dabing|dub)?\b/.test(n)||/\b(en|eng)\b/.test(n);
  const cz=/\b(cz|cze|ces|cs|czech)\b/.test(n);
  const sk=/\b(sk|svk|slovak)\b/.test(n);
  let label='Audio neznáme', lang='any', score=0;
  if(czDub){label='CZ Dabing';lang='CZ';score=110}
  else if(skDub){label='SK Dabing';lang='SK';score=90}
  else if(cz&&en&&!czSubs){label='CZ/EN Audio';lang='CZEN';score=80}
  else if(sk&&en&&!skSubs){label='SK/EN Audio';lang='SKEN';score=65}
  else if(en){label='EN Audio';lang='EN';score=35}
  else if(/\b(multi\s*audio|dual\s*audio|dual)\b/.test(n)){label='Multi Audio';lang='MULTI';score=25}
  const subs=[]; if(czSubs)subs.push('CZ titulky'); if(skSubs)subs.push('SK titulky');
  if(subs.length&&label==='Audio neznáme'&&en){label='EN Audio';lang='EN';score=35}
  if(czSubs)score+=18; if(skSubs)score+=12;
  return {label,lang,subs,score};
}

async function meta(type,id){try{const r=await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`);const j=await r.json();const m=j.meta||{};return{type,imdbId:id,title:m.name||m.title||id,year:String(m.year||m.releaseInfo||'').slice(0,4),runtime:parseInt(String(m.runtime||'').match(/\d+/)?.[0]||'0',10),raw:m}}catch{return{type,imdbId:id,title:id,year:'',runtime:0,raw:{}}}}

async function login(username,password){
 if(!username||!password)return{ok:false,reason:'missing credentials'};
 const p=new URLSearchParams({process:'login',kodi:'1',username,password});
 const r=await fetch(`${API}?${p}`,{headers:{'user-agent':'Kodi/20 FastShare Stremio Addon'}}); const t=await r.text(); let j=null; try{j=JSON.parse(t)}catch{}
 const h=j?.login?.hash||j?.hash||j?.user?.hash||j?.status?.hash||null; if(h)return{ok:true,hash:h,source:'login',status:r.status}; return{ok:false,status:r.status,preview:t.slice(0,500)};
}
let cache={key:'',hash:'',ts:0};
async function getHash(c){const e=process.env.FASTSHARE_HASH||process.env.FASTSHARE_SESSION||''; if(e)return{ok:true,hash:e,source:'env'}; const k=`${c.username}:${c.password}`; if(cache.key===k&&cache.hash&&Date.now()-cache.ts<21600000)return{ok:true,hash:cache.hash,source:'cache'}; const l=await login(c.username,c.password); if(l.ok){cache={key:k,hash:l.hash,ts:Date.now()};return l} return l;}
async function searchFS(term,hash){const p=new URLSearchParams({process:'search',pagination:'200',term,adult:'0'}); if(hash)p.set('hash',hash); const u=`${API}?${p}`; const r=await fetch(u,{headers:{'user-agent':'Kodi/20 FastShare Stremio Addon'}}); const t=await r.text(); let j=null; try{j=JSON.parse(t)}catch{} const arr=j?.search?.file||j?.file||j?.files||[]; const files=(Array.isArray(arr)?arr:[arr]).filter(Boolean).map(f=>{const size=Number(f?.data?.value||f?.size||0);const name=f.filename||f.name||'';const url=f.download_url||f.url||'';const du=Number(f?.duration?.value||0);return{id:String(f.id||''),name,size,url,image:f.thumbnail||f.image||'',duration:du,durationText:f.duration_f||durText(du),raw:f}}).filter(f=>f.id&&f.name&&f.url); return{status:r.status,apiUrl:u,resultCount:files.length,files,preview:t.slice(0,500)}}
function terms(m){const w=words(m.title), out=[]; if(m.title&&m.year)out.push(`${m.title} ${m.year}`); if(m.title)out.push(m.title); if(w.length>=2)out.push(w.join(' ')); if(w.length>2)out.push(w.slice(0,3).join(' ')); return[...new Set(out.filter(Boolean))]}
function titleScore(name,m){const n=norm(name), title=norm(m.title), tw=words(m.title), nw=new Set(words(name)); if(!title)return{score:0,reason:'no-title'}; if(n.includes(title))return{score:110,reason:'title-phrase +110'}; if(tw.length>=2){const matched=tw.filter(w=>nw.has(w)).length, ratio=matched/tw.length; if(ratio>=0.67)return{score:70,reason:'relaxed-title +70'}; return{score:-220,reason:'title-mismatch -220'}} const one=tw[0]; if(one&&nw.has(one))return{score:40,reason:'single-word-title +40'}; return{score:-220,reason:'single-word-mismatch -220'}}
function badYear(name,m){const y=norm(name).match(/\b(19\d{2}|20\d{2})\b/);return Boolean(m.year&&y&&y[1]!==m.year)}
function sequel(name,m){const tw=words(m.title); if(tw.length!==1)return false; return new RegExp(`\\b${tw[0]}\\s*(2|3|4|5|ii|iii|iv|v)\\b`).test(norm(name))}
function scoreFile(f,m,type){let score=0,reasons=[];const n=norm(f.name), ts=titleScore(f.name,m);score+=ts.score;reasons.push(ts.reason); if(m.year&&n.includes(m.year)){score+=65;reasons.push('year +65')} if(badYear(f.name,m)){score-=260;reasons.push('different-year -260')} if(type==='movie'&&sequel(f.name,m)){score-=260;reasons.push('sequel-mismatch -260')} if(type==='movie'&&/\b(s\d{1,2}e\d{1,2}|\d{1,2}x\d{1,2})\b/.test(n)){score-=260;reasons.push('episode-in-movie -260')} const a=detectAudio(f.name); score+=a.score; reasons.push(`${a.label} +${a.score}`); const q=qOf(f.name); if(q==='4K'){score+=30;reasons.push('4K +30')}else if(q==='1080p'){score+=20;reasons.push('1080p +20')}else if(q==='720p'){score+=10;reasons.push('720p +10')} const ext=extOf(f.name); if(ext==='MKV'){score+=10;reasons.push('MKV +10')}else if(ext==='MP4'){score+=8;reasons.push('MP4 +8')}else if(ext==='AVI'){score-=3;reasons.push('AVI -3')} const gb=Number(f.size||0)/(1024**3); if(gb>15){score+=25;reasons.push('size >15GB +25')}else if(gb>10){score+=20;reasons.push('size >10GB +20')}else if(gb>6){score+=15;reasons.push('size >6GB +15')}else if(gb>3){score+=10;reasons.push('size >3GB +10')}else if(gb>1){score+=5;reasons.push('size >1GB +5')} if(/\b(cam|ts|hdcam|telesync|trailer|ukazka)\b/.test(n)){score-=150;reasons.push('bad-quality -150')} if(!/\.(mkv|mp4|avi|m4v|mov|webm)(?:$|[\s._-])/i.test(f.name)){score-=80;reasons.push('unknown-video-ext -80')} if(type==='movie'&&f.size&&f.size<200*1024*1024){score-=180;reasons.push('too-small-movie -180')} return{...f,score,reasons,audio:a,quality:q,ext,sizeText:sizeText(f.size)}}
function streamUrl(f,hash){const sep=f.url.includes('?')?'&':'?';return `${f.url}${sep}stream=1&session=${encodeURIComponent(hash)}&${encodeURIComponent(f.name||'video.mp4')}`}
function manifest(config=''){return{id:config?'community.fastshare.smart.streams.v63.configured':'community.fastshare.smart.streams.v63',version:VERSION,name:config?'FastShare Smart':'FastShare Smart Configure',description:'FastShare stream addon with relaxed matching and strict subtitles/audio detection.',logo:'https://www.stremio.com/website/stremio-logo-small.png',resources:[{name:'stream',types:['movie','series'],idPrefixes:['tt']}],types:['movie','series'],catalogs:[],idPrefixes:['tt'],behaviorHints:config?{configurable:false,configurationRequired:false}:{configurable:true,configurationRequired:true},config:[{key:'username',type:'text',title:'FastShare username'},{key:'password',type:'password',title:'FastShare password'}]}}
function confPage(req,url='',err=''){const su=url?'stremio://'+url.replace(/^https?:\/\//,''):'';return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FastShare Configure</title><style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 20px}input,button,a.button{font-size:16px;padding:12px;margin:7px 0;width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #bbb}button,a.button{background:#111;color:white;text-align:center;text-decoration:none;display:block}code{word-break:break-all;background:#f0f0f0;padding:10px;display:block;border-radius:8px;color:#111}.err{background:#ffe9e9;color:#900;padding:10px;border-radius:8px}.ok{background:#eaffea;padding:10px;border-radius:8px}</style></head><body><h1>FastShare Smart konfigurácia</h1>${err?`<div class="err">${err}</div>`:''}<form method="post" action="/configure"><input name="username" placeholder="FastShare login" required><input name="password" placeholder="FastShare heslo" type="password" required><button type="submit">Vygenerovať manifest URL</button></form>${url?`<div class="ok"><b>Manifest URL:</b><code id="u">${url}</code></div><a class="button" href="${su}">Otvoriť v Stremio</a><button onclick="navigator.clipboard.writeText(document.getElementById('u').textContent).then(()=>alert('Skopírované'))">Kopírovať manifest URL</button>`:''}</body></html>`}
app.get('/health',(req,res)=>res.json({ok:true,version:VERSION}));
app.get('/configure',(req,res)=>res.type('html').send(confPage(req)));
app.post('/configure',(req,res)=>{const u=String(req.body.username||'').trim(),p=String(req.body.password||''); if(!u||!p)return res.type('html').send(confPage(req,'','Chýba login alebo heslo.')); const c=enc({username:u,password:p}); res.type('html').send(confPage(req,`${getBase(req)}/${c}/manifest.json`))});
app.get('/manifest.json',(req,res)=>res.json(manifest(''))); app.get('/:config/manifest.json',(req,res)=>res.json(manifest(req.params.config)));
async function handle(req,res,debug=false){const c=cfg(req), {type,id}=req.params, real=String(id||'').split(':')[0], m=await meta(type,real), auth=await getHash(c); if(!auth.ok)return res.json(debug?{ok:true,version:VERSION,auth,streams:[]}:{streams:[]}); let all=[], search=[]; for(const term of terms(m)){const s=await searchFS(term,auth.hash); search.push({term,status:s.status,resultCount:s.resultCount,apiUrl:s.apiUrl,firstFiles:s.files.slice(0,3)}); all.push(...s.files)} const seen=new Set(); const ranked=all.filter(f=>!seen.has(f.id)&&seen.add(f.id)).map(f=>scoreFile(f,m,type)).filter(f=>f.score>20).sort((a,b)=>b.score-a.score).slice(0,c.maxStreams||25); const streams=ranked.map((f,i)=>{const info=[f.quality,f.sizeText,f.ext,f.durationText].filter(Boolean).join(' • '), aud=[f.audio.label,...(f.audio.subs||[])].filter(Boolean).join(' • '); return{name:`FastShare ${f.audio.lang&&f.audio.lang!=='any'?f.audio.lang:''}`.trim(),title:`${i===0?'⭐ Odporúčané\n':''}${f.name}\n${info}\n${aud}`,url:streamUrl(f,auth.hash),behaviorHints:{bingeGroup:`fastshare-${f.quality||'auto'}-${f.audio.lang||'any'}`}}}); if(debug)return res.json({ok:true,version:VERSION,request:{type,id},meta:m,terms:terms(m),auth:{ok:true,source:auth.source,hasHash:!!auth.hash},search,streamCount:streams.length,files:ranked,streams}); return res.json({streams})}
async function dbgLogin(req,res){const c=cfg(req), a=await getHash(c);res.json({ok:true,version:VERSION,hasUsername:!!c.username,hasPassword:!!c.password,login:a})}
async function dbgSearch(req,res){const c=cfg(req),a=await getHash(c); if(!a.ok)return res.json({ok:true,version:VERSION,auth:a,resultCount:0,results:[]}); const term=req.query.term||'avatar',s=await searchFS(term,a.hash);res.json({ok:true,version:VERSION,term,auth:{ok:true,source:a.source},status:s.status,resultCount:s.resultCount,apiUrl:s.apiUrl,results:s.files.slice(0,50)})}
app.get('/debug/login',dbgLogin); app.get('/:config/debug/login',dbgLogin); app.get('/debug/search',dbgSearch); app.get('/:config/debug/search',dbgSearch); app.get('/debug/stream/:type/:id.json',(req,res)=>handle(req,res,true)); app.get('/:config/debug/stream/:type/:id.json',(req,res)=>handle(req,res,true)); app.get('/stream/:type/:id.json',(req,res)=>handle(req,res,false)); app.get('/:config/stream/:type/:id.json',(req,res)=>handle(req,res,false)); app.get('/',(req,res)=>res.redirect('/configure'));
app.listen(PORT,()=>console.log(`FastShare Stremio addon v${VERSION} running on port ${PORT}`));
