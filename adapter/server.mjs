// ChatGPT-facing MCP/UI adapter. Rust owns task contracts and all persistence.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema,McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {toolNames, guidance, presentation, decorateTools, registerWidget} from './presentation.mjs';

const version='0.19.0';
const bundle=presentation();
const {sha256,uri}=bundle;
const uiEnabled=process.env.TODO_ADAPTER_UI_ENABLED!=='0';
const log=(operation,level='info',extra={})=>console.error(JSON.stringify({time:new Date().toISOString(),component:'mcp-adapter',operation,level,...extra}));
const backend=new Client({name:'gtd-ui-adapter',version});
const childEnv={TODO_WIDGET_ENABLED:'0'};
for(const key of ['PATH','TODO_DB_PATH','TODO_LOG_DB_PATH','TODO_ENVIRONMENT','TODO_SEARCH_URL','TODO_SEARCH_KEY_FILE']) if(process.env[key]!==undefined)childEnv[key]=process.env[key];
const transport=new StdioClientTransport({command:process.env.GTD_RUST_EXECUTABLE||'/usr/local/bin/todo-mcp',env:childEnv,stderr:'pipe'});
// Backend application calls already have structured audit/log entries. Raw stderr may contain task text.
transport.stderr.on('data',()=>{});
let server,closing=false;
async function shutdown(code=0){
 if(closing)return;closing=true;log('adapter.stop',code?'error':'info');
 const forced=setTimeout(()=>process.exit(1),7000);forced.unref();
 try{await backend.close();if(server)await server.close();}finally{clearTimeout(forced);process.exit(code);}
}
process.on('SIGTERM',()=>void shutdown());
process.on('SIGINT',()=>void shutdown());
process.stdin.on('end',()=>void shutdown());
process.stdin.on('error',()=>void shutdown(1));
process.stdout.on('error',()=>void shutdown(1));
process.on('uncaughtException',()=>{log('adapter.uncaught','error');void shutdown(1);});
process.on('unhandledRejection',()=>{log('adapter.rejection','error');void shutdown(1);});
backend.onclose=()=>{if(!closing){log('backend.closed','error');void shutdown(1);}};
backend.onerror=()=>{log('backend.transport','error');void shutdown(1);};
const startup=setTimeout(()=>{log('adapter.startup_timeout','error');void shutdown(1);},20000);
try {
 await backend.connect(transport);
 const {tools}=await backend.listTools();
 const expected=toolNames;
 const descriptors=decorateTools(tools,{uri,uiEnabled});
 if(process.env.GTD_ADAPTER_SYNTHETIC==='1'){
  if(!process.env.TODO_DB_PATH?.startsWith('/tmp/adapter-'))throw Error('Synthetic mode requires isolated database');
  const seed=await backend.callTool({name:'capture_item',arguments:{importance:'normal',agent_notes:'Isolated adapter transport fixture.',request_id:'adapter-synthetic-seed',title:'Synthetic Rust-backed task',status:'inbox',due_date:'2026-10-09',reason:'Seed isolated adapter verification'}});
  if(seed.isError)throw Error('Synthetic seed failed');
 }
 const instructions=(backend.getInstructions()||'')+'\n\n'+guidance.adapter_instruction_suffix[uiEnabled?'ui_enabled':'ui_disabled'];
 server=new McpServer({name:'private-gtd',version},{instructions});
 server.server.registerCapabilities({tools:{listChanged:true}});
 server.server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:descriptors}));
 server.server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
  const started=performance.now();
  const operation=expected.includes(request.params.name)?request.params.name:'unknown_tool';
  log(operation+'.start');
  try{
   const result=await backend.callTool(request.params,undefined,{timeout:15000,signal:extra.signal});
   log(operation+'.finish',result.isError?'warning':'info',{duration_ms:Math.round(performance.now()-started),status:result.isError?0:1});
   return result;
  }catch{
   log(operation+'.failed','error',{duration_ms:Math.round(performance.now()-started)});
   throw new McpError(ErrorCode.InternalError,'Backend response was not confirmed. A write may have committed; retry only with the identical request_id and arguments.');
  }
 });
 if(uiEnabled)registerWidget(server,bundle,{log});
 server.server.onclose=()=>void shutdown();
 await server.connect(new StdioServerTransport());
 clearTimeout(startup);log('adapter.ready','info',{uri,sha256});
}catch{clearTimeout(startup);log('adapter.startup_failed','error');await shutdown(1);}
