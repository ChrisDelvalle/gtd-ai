// Authenticated Streamable HTTP service. Local stdio remains a development path.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema,McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {privateBackend,BackendFailure} from './http-backend.mjs';
import {guidance,presentation,authenticatedPresentation,decorateTools,registerWidget,displayTools} from './presentation.mjs';

// Allow the RPC envelope, escaped Unicode and complete records with many blocks.
// Rust still enforces the existing 128 KiB normalized batch contract.
const MAX_BODY = 4 * 1024 * 1024;
const MAX_BUFFERED_BODIES = 16 * 1024 * 1024;
const AUTH_CODES = new Set(['invalid_token','insufficient_scope']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNCONFIRMED = 'Backend response was not confirmed. A write may have committed; retry only with the identical request_id and arguments.';
// Classify standard optional host probes without logging arbitrary caller text.
// This does not advertise capabilities or register handlers for unsupported RPCs.
const RPC_METHODS = new Set(['initialize','ping','tools/list','tools/call','resources/list','resources/read',
  'resources/templates/list','resources/subscribe','resources/unsubscribe','prompts/list','prompts/get',
  'logging/setLevel','completion/complete','notifications/initialized','notifications/cancelled',
  'notifications/roots/list_changed']);

function exactURL(value, {loopback = false} = {}) {
  const u = new URL(value);
  if ((u.protocol !== 'https:' && !(loopback && u.protocol === 'http:' && u.hostname === '127.0.0.1')) ||
      u.username || u.password || u.search || u.hash || u.href !== value) throw Error('Invalid configured URL');
  return u;
}

export function validateConfig(input) {
  const config = structuredClone(input);
  const resource = exactURL(config.resource), issuer = exactURL(config.issuer);
  if (resource.pathname !== '/mcp' || issuer.pathname.endsWith('/') ||
      !['staging','production'].includes(config.environment) ||
      !Array.isArray(config.ingresses) || !config.ingresses.length) throw Error('Invalid HTTP adapter configuration');
  const hosts = new Set();
  for (const ingress of config.ingresses) {
    const origin = exactURL(ingress.metadataOrigin+'/',{loopback:true});
    if (origin.origin !== ingress.metadataOrigin || origin.host !== ingress.host || hosts.has(ingress.host) ||
        !['openai','claude'].includes(ingress.uiHost)) throw Error('Invalid ingress');
    if (ingress.resource !== undefined &&
        (ingress.uiHost !== 'openai' || exactURL(ingress.resource).href !== origin.origin+'/mcp'))
      throw Error('Invalid ingress resource');
    if (ingress.launchMode !== undefined &&
        (ingress.uiHost !== 'openai' || !['requested','full','deferred','nearby','summaries'].includes(ingress.launchMode)))
      throw Error('Invalid widget launch mode');
    hosts.add(ingress.host);
  }
  config.allowedOrigins ??= [];
  for (const origin of config.allowedOrigins) {
    if (exactURL(origin+'/').origin !== origin) throw Error('Invalid allowed origin');
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw Error('Invalid port');
  return config;
}

// Node normalizes some duplicate headers; inspect raw headers before using them.
function singleHeader(req, name) {
  let count=0, value;
  for(let i=0;i<req.rawHeaders.length;i+=2) if(req.rawHeaders[i].toLowerCase()===name) {
    count++; value=req.rawHeaders[i+1];
  }
  return count > 1 ? null : value;
}

async function body(req, reserve, signal) {
  const chunks=[]; let length=0;
  signal.throwIfAborted();
  const stop=()=>req.destroy();
  signal.addEventListener('abort',stop,{once:true});
  try {
    // Keep the socket long enough to send a useful 413/503 for streamed bodies.
    for await (const chunk of req.iterator({destroyOnReturn:false})) {
      length+=chunk.length;
      if(length>MAX_BODY) throw new BackendFailure(413,{error:'request_too_large'});
      reserve(chunk.length);
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort',stop);
  }
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!value || Array.isArray(value) || typeof value!=='object') throw Error('Single message required');
  return value;
}

function pinsFor(params) {
  const meta=params._meta ?? {}, pins={};
  for(const [key,target] of [['gtd/expectedAccount','account'],['gtd/expectedEnvironment','environment']]) {
    if(Object.hasOwn(meta,key)) {
      if(typeof meta[key]!=='string' || !meta[key].length || meta[key].length>64 || /[^\x20-\x7e]/.test(meta[key]))
        throw new McpError(ErrorCode.InvalidParams,'Invalid account/environment binding');
      pins[target]=meta[key];
    }
  }
  return pins;
}

export async function createAuthenticatedAdapter(input, {bundle = presentation(), log = ()=>{}} = {}) {
  const config=validateConfig(input), backend=privateBackend(config.backendOrigin);
  const contract=await backend('/internal/contract');
  if(contract.contract_version!==1 || contract.environment!==config.environment || typeof contract.instructions!=='string' ||
      typeof contract.version!=='string') throw Error('Incompatible backend contract');
  const uiEnabled=config.uiEnabled!==false;
  const presentationByHost=new Map(config.ingresses.map(ingress=>{
    const asset=authenticatedPresentation(bundle);
    return [ingress.host,{asset,descriptors:decorateTools(contract.tools,{uri:asset.uri,uiEnabled,authenticated:true})}];
  }));
  const names=new Set(contract.tools.map(t=>t.name));
  const instructions=contract.instructions+'\n\n'+guidance.adapter_instruction_suffix[uiEnabled?'ui_enabled':'ui_disabled'];
  const metadataPath='/.well-known/oauth-protected-resource/mcp';
  let active=0, bufferedBodies=0;
  const http=createServer({maxHeaderSize:24*1024},async(req,res)=>{
    const supplied=singleHeader(req,'x-request-id');
    const requestId=typeof supplied==='string' && UUID.test(supplied) ? supplied.toLowerCase() : randomUUID();
    const started=performance.now(); let operation='other', admitted=false, server, requestBytes=0, profileMs=0, toolMs=0, responseBytes=0;
    const abort=new AbortController();
    const deadline=setTimeout(()=>{
      abort.abort();
      if(!res.headersSent) reply(504,{error:'response_unconfirmed',message:UNCONFIRMED}); else res.end();
    },20_000);
    deadline.unref();
    const finish=()=>{clearTimeout(deadline);abort.abort();};
    res.once('close',finish);
    res.once('finish',()=>log({component:'mcp-http',request_id:requestId,operation,status:res.statusCode,duration_ms:Math.round(performance.now()-started),profile_ms:profileMs,tool_ms:toolMs,request_bytes:requestBytes,response_bytes:responseBytes}));
    res.setHeader('X-Request-ID',requestId);
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    function reply(status,data) {
      if(res.writableEnded || res.destroyed) return;
      res.writeHead(status,{'Content-Type':'application/json'});
      res.end(JSON.stringify({...data,request_id:requestId}));
    }
    let metadataURL;
    const challenge=code=>`Bearer resource_metadata="${metadataURL}", error="${code}", scope="gtd:access"`;
    try {
      const host=singleHeader(req,'host'), origin=singleHeader(req,'origin');
      const ingress=config.ingresses.find(i=>i.host===host);
      if(!ingress) return reply(403,{error:'invalid_host'});
      const {asset,descriptors}=presentationByHost.get(ingress.host);
      const resource=ingress.resource ?? config.resource;
      if(origin===null || (origin!==undefined && !config.allowedOrigins.includes(origin))) return reply(403,{error:'invalid_origin'});
      // No proxy-controlled host reconstruction, URL queries, cookie identity,
      // or session-ID account selection. The ingress is fixed operator config.
      if(!req.url?.startsWith('/') || req.url.includes('?') || req.url.includes('#')) return reply(400,{error:'invalid_request'});
      metadataURL=ingress.metadataOrigin+metadataPath;
      if(req.method==='GET' && [metadataPath,'/.well-known/oauth-protected-resource'].includes(req.url)) {
        operation='discovery';
        return reply(200,{resource,authorization_servers:[config.issuer],
          scopes_supported:['gtd:access'],bearer_methods_supported:['header']});
      }
      if(req.url!=='/mcp') return reply(404,{error:'not_found'});
      operation='mcp';
      const authorization=singleHeader(req,'authorization');
      if(typeof authorization!=='string' || authorization.length>16_391 || !/^Bearer [A-Za-z0-9_.-]+$/i.test(authorization)) {
        res.setHeader('WWW-Authenticate',challenge('invalid_token'));
        return reply(401,{error:'invalid_token'});
      }
      if(active>=32) {res.setHeader('Retry-After','1');return reply(503,{error:'service_busy'});}
      active++;admitted=true;
      const profileStarted=performance.now();
      const profile=await backend('/internal/profile',{authorization,requestId,resource:ingress.resource,signal:abort.signal});
      profileMs=Math.round(performance.now()-profileStarted);
      if(typeof profile.id!=='string' || !UUID.test(profile.id)) throw Error('Invalid profile response');
      if(typeof profile.timezone!=='string' || profile.timezone.length>100) throw Error('Invalid account timezone');
      const accountMeta={'gtd/accountId':profile.id,'gtd/environment':config.environment,'gtd/timezone':profile.timezone};
      if(req.method!=='POST') {res.setHeader('Allow','POST');return reply(405,{error:'method_not_allowed'});}
      if(req.headers['content-encoding'] && req.headers['content-encoding']!=='identity') return reply(415,{error:'unsupported_encoding'});
      if(!req.headers['content-type']?.toLowerCase().startsWith('application/json')) return reply(415,{error:'unsupported_media_type'});
      const length=req.headers['content-length'];
      if(length && Number(length)>MAX_BODY) return reply(413,{error:'request_too_large'});
      let message;
      try {
        message=await body(req,bytes=>{
          if(bufferedBodies+bytes>MAX_BUFFERED_BODIES) throw new BackendFailure(503,{error:'service_busy'});
          bufferedBodies+=bytes;requestBytes+=bytes;
        },abort.signal);
      } catch(error) {
        req.resume();res.setHeader('Connection','close');
        return reply(error instanceof BackendFailure?error.status:400,{error:error instanceof BackendFailure?error.body.error:'invalid_request'});
      }
      operation=RPC_METHODS.has(message.method)?message.method:
        Object.keys(message).length===0?'empty_probe':
        !Object.hasOwn(message,'method')?'missing_method':'unknown';
      if(operation==='tools/call' && names.has(message.params?.name)) operation=message.params.name;
      server=new McpServer({name:'private-gtd',version:contract.version},{instructions});
      server.server.registerCapabilities({tools:{}});
      server.server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:descriptors}));
      server.server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
        const {name,arguments:args={}}=request.params;
        if(!names.has(name)) throw new McpError(ErrorCode.InvalidParams,'Unknown tool');
        const pins=pinsFor(request.params);
        try {
          const toolStarted=performance.now();
          const result=await backend('/internal/mcp/'+name,{authorization,requestId,arguments:args,pins,
            resource:ingress.resource,widgetLaunch:uiEnabled && displayTools.has(name) ? ingress.launchMode : undefined,
            signal:AbortSignal.any([abort.signal,extra.signal])});
          toolMs=Math.round(performance.now()-toolStarted);
          responseBytes=Buffer.byteLength(JSON.stringify(result));
          return {...result,_meta:{...result._meta,...accountMeta,...(result._meta?.['gtd/widgetBundle'] ? {'gtd/requestId':requestId} : {})}};
        } catch(error) {
          if(error instanceof BackendFailure && [400,409].includes(error.status) && typeof error.body?.code==='string' && typeof error.body?.message==='string')
            return {isError:true,content:[{type:'text',text:error.body.message}],structuredContent:error.body,_meta:accountMeta};
          if(error instanceof BackendFailure && [401,403].includes(error.status)) {
            const code=AUTH_CODES.has(error.body?.error)?error.body.error:'account_unavailable';
            return {isError:true,content:[{type:'text',text:code==='account_unavailable'?'This GTD account is unavailable.':'Reconnect GTD to continue.'}],
              _meta:AUTH_CODES.has(code)?{'mcp/www_authenticate':[challenge(code)]}:{}};
          }
          throw new McpError(ErrorCode.InternalError,UNCONFIRMED);
        }
      });
      if(uiEnabled) registerWidget(server,asset,{host:ingress.uiHost,resource,
        log:(event,_level,fields)=>log({component:'mcp-resource',request_id:requestId,event,...fields})});
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,maxRequestBodySize:MAX_BODY});
      await server.connect(transport);
      await transport.handleRequest(req,res,message);
    } catch(error) {
      if(error instanceof BackendFailure && [401,403].includes(error.status)) {
        const code=AUTH_CODES.has(error.body?.error)?error.body.error:'account_unavailable';
        if(AUTH_CODES.has(code)) res.setHeader('WWW-Authenticate',challenge(code));
        reply(error.status,{error:code});
      } else if(!res.headersSent) reply(503,{error:'service_unavailable'});
      else res.end();
    } finally {
      clearTimeout(deadline);
      if(admitted) active--;
      bufferedBodies-=requestBytes;
      await server?.close();
    }
  });
  http.requestTimeout=10_000;
  http.headersTimeout=8_000;
  http.keepAliveTimeout=5_000;
  http.maxConnections=128;
  return http;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const config=JSON.parse(await readFile(process.argv[2],'utf8'));
    const app=await createAuthenticatedAdapter(config,{log:entry=>console.error(JSON.stringify(entry))});
    app.listen(config.port,'127.0.0.1',()=>console.error(JSON.stringify({component:'mcp-http',operation:'ready'})));
    for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
      app.close();setTimeout(()=>app.closeAllConnections(),5_000).unref();
    });
  } catch {
    console.error(JSON.stringify({component:'mcp-http',operation:'startup_failed'}));process.exitCode=1;
  }
}
