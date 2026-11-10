import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {createAuthenticatedAdapter,validateConfig} from '../http-server.mjs';
import {privateBackend} from '../http-backend.mjs';
import {presentation,authenticatedPresentation,toolNames} from '../presentation.mjs';

const a=randomUUID(), b=randomUUID();
const resource='https://mcp.invalid/mcp', issuer='https://identity.invalid/realms/test';
const bundle=presentation('<html data-account-binding="1">Disposable transport fixture</html>');
const authenticatedBundle=authenticatedPresentation(bundle);
const tools=[...toolNames,'get_profile'].map(name=>({name,description:name,inputSchema:{type:'object'},
  outputSchema:{type:'object'},_meta:{ui:{visibility:name.startsWith('gtd_ui_')?['app']:['model']},
    'openai/profile':name==='get_profile',securitySchemes:[{type:'oauth2',scopes:['gtd:access']}]}}));
async function listen(app) {app.listen(0,'127.0.0.1');await once(app,'listening');return `http://127.0.0.1:${app.address().port}`;}
async function close(app) {app.closeAllConnections();await new Promise(resolve=>app.close(resolve));}
const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'deterministic-test',version:'1'}}};
const call=(name,args={},meta)=>({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args,...(meta?{_meta:meta}:{})}});

test('authenticated HTTP boundary, transport, metadata and failure recovery',async t=>{
  const seen=[], logs=[]; let fail, profileFailure;
  const rust=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/internal/contract') return res.end(JSON.stringify({contract_version:1,environment:'staging',version:'0.18.0',instructions:'Fixture',tools}));
    const identity=req.headers.authorization==='Bearer a'?a:req.headers.authorization==='Bearer b'?b:null;
    if(!identity || profileFailure) {res.statusCode=profileFailure?.status??401;return res.end(JSON.stringify({error:profileFailure?.error??'invalid_token'}));}
    if(req.url==='/internal/profile') return res.end(JSON.stringify({id:identity,name:'Fixture',timezone:'Europe/Paris'}));
    let raw='';for await(const chunk of req)raw+=chunk;
    const args=JSON.parse(raw);
    seen.push({path:req.url,identity,args,id:req.headers['x-request-id'],account:req.headers['x-gtd-expected-account'],environment:req.headers['x-gtd-expected-environment']});
    if(fail){res.statusCode=fail.status;return res.end(JSON.stringify(fail.body));}
    const value={id:identity,args};
    res.end(JSON.stringify({content:[{type:'text',text:'Fixture result'}],structuredContent:value}));
  });
  const backendOrigin=await listen(rust);
  const config={resource,issuer,environment:'staging',backendOrigin,port:0,ingresses:[
    {host:'mcp.invalid',metadataOrigin:'https://mcp.invalid',uiHost:'claude'},
    {host:'127.0.0.1:18444',metadataOrigin:'http://127.0.0.1:18444',uiHost:'openai'}]};
  const app=await createAuthenticatedAdapter(config,{bundle,log:e=>logs.push(e)});
  const address=await listen(app);
  const send=async(message=init,{token='a',path='/mcp',method='POST',headers={}}={})=>{
    return new Promise((resolve,reject)=>{
      const raw=method==='POST'?JSON.stringify(message):undefined;
      const req=request(address+path,{method,headers:{Host:'mcp.invalid',Accept:'application/json, text/event-stream',
        'Content-Type':'application/json',...(raw?{'Content-Length':Buffer.byteLength(raw)}:{}),
        ...(token?{Authorization:'Bearer '+token}:{}),...headers}},res=>{
        res.setEncoding('utf8');
        let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{
          try {resolve({status:res.statusCode,headers:new Headers(res.headers),body:text?JSON.parse(text):null});}catch(e){reject(e);}
        });
      });req.on('error',reject);req.end(raw);
    });
  };
  try {
    await t.test('discovery uses configured ingress, never forwarded host; every MCP request authenticates',async()=>{
      for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']) {
        const result=await send(null,{path,method:'GET',token:null});assert.equal(result.status,200);assert.equal(result.body.resource,resource);
      }
      let result=await send(init,{token:null,headers:{'X-Forwarded-Host':'evil.invalid',Host:'127.0.0.1:18444'}});
      assert.equal(result.status,401);assert.match(result.headers.get('www-authenticate'),/http:\/\/127.0.0.1:18444\//);
      result=await send(init,{token:null});assert.equal(result.status,401);assert.match(result.headers.get('www-authenticate'),/https:\/\/mcp.invalid\//);
      assert.equal((await send(init,{headers:{Origin:'https://evil.invalid'}})).status,403);
      assert.equal((await send(init,{headers:{Host:'evil.invalid'}})).status,403);
      assert.equal((await send(init,{path:'/mcp?account='+a})).status,400);
      assert.equal((await send(init,{token:null,headers:{Cookie:'account='+a}})).status,401);
      result=await send();assert.equal(result.status,200);assert.equal(result.body.result.serverInfo.name,'private-gtd');
      assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('mcp-session-id'),null);
    });
    await t.test('stateless concurrent users and unchanged write arguments',async()=>{
      const args={request_id:'same-key',title:'Fixture',notes:null,blocked_by:[]};
      const results=await Promise.all(Array.from({length:12},(_,i)=>send(call('capture_item',args),{token:i%2?'a':'b',headers:{'MCP-Session-ID':'shared'}})));
      for(const [i,r] of results.entries()) {assert.equal(r.body.result.structuredContent.id,i%2?a:b);assert.deepEqual(r.body.result.structuredContent.args,args);
        assert.deepEqual(r.body.result._meta,{'gtd/accountId':i%2?a:b,'gtd/environment':'staging','gtd/timezone':'Europe/Paris'});}
      assert.equal(seen.length,12);for(const r of seen)assert.deepEqual(r.args,args);
    });
    await t.test('model/app visibility, schemas and host-specific immutable resource',async()=>{
      const listed=await send({jsonrpc:'2.0',id:3,method:'tools/list'});
      assert.equal(listed.body.result.tools.length,19);
      assert.deepEqual(listed.body.result.tools.find(t=>t.name==='gtd_ui_write')._meta.ui.visibility,['app']);
      assert.deepEqual(listed.body.result.tools.find(t=>t.name==='capture_item')._meta.ui.visibility,['model']);
      assert.ok(listed.body.result.tools.find(t=>t.name==='get_profile')._meta['openai/profile']);
      for (const tool of listed.body.result.tools) assert.equal(!!tool._meta.ui?.resourceUri, ['show_tasks','show_projects','show_gtd'].includes(tool.name));
      const msg={jsonrpc:'2.0',id:4,method:'resources/read',params:{uri:authenticatedBundle.uri}};
      const claude=await send(msg), openai=await send(msg,{headers:{Host:'127.0.0.1:18444'}});
      const c=claude.body.result.contents[0], o=openai.body.result.contents[0];
      assert.equal(c.uri,authenticatedBundle.uri);assert.equal(c.text,authenticatedBundle.html);
      assert.notEqual(c.uri,bundle.uri);assert.match(c.text,/data-account-required="true"/);
      assert.equal(c._meta.ui.domain,createHash('sha256').update(resource).digest('hex').slice(0,32)+'.claudemcpcontent.com');
      assert.equal(o._meta.ui.domain,undefined);assert.deepEqual(o._meta['openai/ui'].availableDisplayModes,['inline','fullscreen']);
    });
    await t.test('account/environment pins and safe correlation survive dispatch',async()=>{
      const id=randomUUID();
      await send(call('gtd_ui_write',{operation:'update_item',arguments:{request_id:'pending',notes:''}},
        {'gtd/expectedAccount':a,'gtd/expectedEnvironment':'staging'}),{headers:{'X-Request-ID':id,'X-Account-ID':b}});
      const last=seen.at(-1);assert.equal(last.id,id);assert.equal(last.account,a);assert.equal(last.environment,'staging');assert.equal(last.identity,a);
      const before=seen.length;
      assert.ok((await send(call('gtd_ui_write',{}, {'gtd/expectedAccount':null}))).body.error);
      assert.equal(seen.length,before);
      const response=await send(init,{headers:{'X-Request-ID':'private-untrusted-string'}});
      assert.notEqual(response.headers.get('x-request-id'),'private-untrusted-string');
    });
    await t.test('bounded protocol inputs and duplicate credentials',async()=>{
      assert.equal((await send([init])).status,400);
      assert.equal((await send(call('unknown_tool'))).body.error.code,-32602);
      await send({jsonrpc:'2.0',id:5,method:'prompts/list'});
      assert.equal(logs.at(-1).operation,'prompts/list');
      await send({jsonrpc:'2.0',id:6,method:'private-untrusted-method'});
      assert.equal(logs.at(-1).operation,'unknown');
      await send({});
      assert.equal(logs.at(-1).operation,'empty_probe');
      assert.equal((await send(call('capture_item',{notes:'x'.repeat(4*1024*1024)}))).status,413);
      assert.equal((await send(null,{method:'GET'})).status,405);
      assert.equal((await send(init,{headers:{'Content-Encoding':'gzip'}})).status,415);
      assert.equal((await send(init,{headers:{'Content-Type':'text/plain'}})).status,415);
      const status=await new Promise((resolve,reject)=>{
        const req=request(address+'/mcp',{method:'POST',headers:['Host','mcp.invalid','Authorization','Bearer a','Authorization','Bearer b','Content-Type','application/json','Accept','application/json, text/event-stream']},res=>{res.resume();resolve(res.statusCode);});
        req.on('error',reject);req.end(JSON.stringify(init));
      });assert.equal(status,401);
      const streamed=await new Promise((resolve,reject)=>{
        const req=request(address+'/mcp',{method:'POST',headers:{Host:'mcp.invalid',Authorization:'Bearer a',
          'Content-Type':'application/json',Accept:'application/json, text/event-stream','Transfer-Encoding':'chunked'}},res=>{
          res.resume();resolve(res.statusCode);
        });req.on('error',reject);req.end('x'.repeat(4*1024*1024+1));
      });assert.equal(streamed,413);
    });
    await t.test('business errors, expiry after preflight and uncertain writes never auto-retry',async()=>{
      fail={status:409,body:{code:'account_changed',message:'Reopen GTD.',retryable:false}};
      let r=await send(call('gtd_ui_write',{}));assert.equal(r.body.result.isError,true);assert.equal(r.body.result.structuredContent.code,'account_changed');
      fail={status:401,body:{error:'invalid_token'}};
      r=await send(call('list_items'));assert.match(r.body.result._meta['mcp/www_authenticate'][0],/resource_metadata=/);
      fail={status:504,body:{error:'response_unconfirmed',unsafe:'secret internal diagnostic'}};
      const before=seen.length;r=await send(call('capture_item',{request_id:'unknown-outcome'}));
      assert.equal(seen.length,before+1);assert.match(r.body.error.message,/identical request_id/);assert.doesNotMatch(JSON.stringify(r),/secret internal/);
      fail=undefined;
      profileFailure={status:403,error:'account_unavailable'};r=await send();assert.equal(r.status,403);assert.equal(r.headers.get('www-authenticate'),null);
      profileFailure={status:503,error:'unsafe-provider-diagnostic'};r=await send();assert.equal(r.status,503);assert.doesNotMatch(JSON.stringify(r),/unsafe-provider/);profileFailure=undefined;
      const serialized=JSON.stringify(logs);assert.doesNotMatch(serialized,/Bearer|same-key|pending|notes|private-untrusted|secret/);
    });
  } finally {await close(app);await close(rust);}
});

test('configuration cannot select untrusted upstreams or ambiguous ingress',()=>{
  assert.throws(()=>authenticatedPresentation(presentation('<html>Legacy published widget</html>')),
    /account-bound widget build/);
  for(const url of ['https://evil.invalid/','http://localhost:80','http://127.0.0.1:80/path','http://u:p@127.0.0.1:80'])
    assert.throws(()=>privateBackend(url));
  const config={port:0,resource,issuer,environment:'staging',ingresses:[{host:'mcp.invalid',metadataOrigin:'https://mcp.invalid',uiHost:'claude'}]};
  assert.equal(validateConfig(config).resource,resource);
  assert.throws(()=>validateConfig({...config,resource:resource+'?token=secret'}));
  assert.throws(()=>validateConfig({...config,ingresses:[...config.ingresses,...config.ingresses]}));
  assert.throws(()=>validateConfig({...config,ingresses:[{...config.ingresses[0],host:'evil.invalid'}]}));
});
