// Disposable manual host harness. Never included in dist or deployment images.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { testOrigin } from './test-environment.mjs';
const origin = testOrigin(process.env.GTD_BASE_URL || 'http://127.0.0.1:18102');
const health = await fetch(origin + '/api/health').then(r => r.json());
if (health.environment !== 'test') throw Error('Manual host requires disposable data');
const port = Number(process.env.GTD_HOST_PORT || 18103);
createServer(async (req, res) => {
  if (req.method === 'POST' && /^\/api\/tools\/[a-z_]+$/.test(req.url || '')) {
    if ((await fetch(origin + '/api/health').then(r => r.json())).environment !== 'test') { res.writeHead(503).end(); return; }
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const response=await fetch(origin+req.url,{method:'POST',headers:{'Content-Type':'application/json','Origin':origin,'X-GTD-Request':'1'},body:Buffer.concat(chunks)});
    res.writeHead(response.status,{'Content-Type':'application/json'}).end(await response.text()); return;
  }
  const html=await readFile(new URL('dist/widget-adapter.html',import.meta.url),'utf8');
  res.writeHead(200,{'Content-Type':'text/html'}).end(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:15px system-ui;background:#f7f7f7;color:#111}header{padding:12px;display:flex;gap:12px;flex-wrap:wrap}iframe{border:0;display:block;width:100%;height:100px}#host{max-width:760px;margin:0 auto}button{font:inherit;padding:8px;border:1px solid #aaa;border-radius:8px;background:white}footer{height:1000px;padding:16px}</style><header><strong>Disposable host</strong><button id="inline">Return to conversation</button><button id="expand">Expand</button><button id="theme">Switch theme</button><button id="projects">Launch projects</button><button id="tasks">Launch tasks</button><button id="narrow">390px</button><button id="wide">1200px</button><button id="website">Website</button></header><div id="host"></div><footer>Conversation continues below the card.</footer><script>
const widgetHtml=${JSON.stringify(html).replaceAll('<','\\u003c')};
let frame, mode='inline',theme='light',launch='show_tasks';
const messages=[];window.auditMessages=messages;
function context(){return {theme,displayMode:mode,availableDisplayModes:['inline','fullscreen'],containerDimensions:mode==='inline'?{maxHeight:450}:{height:innerHeight-140,width:document.querySelector('#host').clientWidth}}}
function send(value){frame.contentWindow.postMessage({jsonrpc:'2.0',...value},'*')}
async function call(name,args){const r=await fetch('/api/tools/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});return {structuredContent:await r.json(),isError:!r.ok}}
function change(value){mode=value;if(mode==='fullscreen')frame.style.height=(innerHeight-140)+'px';send({method:'ui/notifications/host-context-changed',params:context()})}
function mount(){mode='inline';frame=document.createElement('iframe');frame.title='GTD isolated card';frame.sandbox='allow-scripts allow-forms';document.querySelector('#host').replaceChildren(frame);frame.srcdoc=widgetHtml}
addEventListener('message',async event=>{if(event.source!==frame.contentWindow)return;const m=event.data;messages.push({method:m.method,params:m.params});
if(m.method==='ui/initialize')send({id:m.id,result:{hostContext:context()}});
else if(m.method==='ui/notifications/initialized'){send({method:'ui/notifications/tool-input',params:{arguments:{}}});send({method:'ui/notifications/tool-result',params:await call(launch,{})})}
else if(m.method==='tools/call')send({id:m.id,result:await call(m.params.name,m.params.arguments)});
else if(m.method==='ui/request-display-mode'){change(m.params.mode);send({id:m.id,result:{mode}})}
else if(m.method==='ui/notifications/size-changed' && mode!=='fullscreen')frame.style.height=m.params.height+'px';
else if(m.method==='ui/open-link')send({id:m.id,result:{isError:false}});
});
document.querySelector('#inline').onclick=()=>change('inline');document.querySelector('#expand').onclick=()=>change('fullscreen');document.querySelector('#theme').onclick=()=>{theme=theme==='light'?'dark':'light';change(mode)};
document.querySelector('#projects').onclick=()=>{launch='show_projects';mount()};document.querySelector('#tasks').onclick=()=>{launch='show_tasks';mount()};document.querySelector('#narrow').onclick=()=>{document.querySelector('#host').style.maxWidth='390px';change(mode)};document.querySelector('#wide').onclick=()=>{document.querySelector('#host').style.maxWidth='1200px';change(mode)};document.querySelector('#website').onclick=()=>{frame.removeAttribute('srcdoc');frame.src='${origin}';frame.style.height='780px'};mount();
</script>`);
}).listen(port,'127.0.0.1',()=>console.log('Disposable host: http://127.0.0.1:'+port));
