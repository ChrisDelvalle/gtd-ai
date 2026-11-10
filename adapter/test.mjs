import {fixtureContent} from "./fixture-content.mjs";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const rust=process.env.GTD_RUST_EXECUTABLE||'/usr/local/bin/todo-mcp';
const adapter=new URL('./server.mjs',import.meta.url).pathname;
async function start(command,args,env){
 const client=new Client({name:'adapter-regression',version:'1'});
 const transport=new StdioClientTransport({command,args,env,stderr:'pipe'});
 let stderr='';transport.stderr.on('data',b=>stderr+=b.toString());
 await client.connect(transport);
 return {client,transport,stderr:()=>stderr};
}
const rawCall=(c,name,args)=>c.callTool({name,arguments:fixtureContent(name,args)});
// Separate reads evaluate time independently. Compare every other adapter value
// exactly, and validate each evaluation timestamp instead of requiring equality.
function normalizeEvaluation(value){
 if(Array.isArray(value))return value.map(normalizeEvaluation);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>{
  if(k==='evaluated_at'){assert.equal(typeof v,'string');assert(Number.isFinite(Date.parse(v)));return [k,'<evaluation time>'];}
  if((k==='checkpoint'||k==='next_cursor')&&typeof v==='string') {
   const cursor=JSON.parse(Buffer.from(v,'hex').toString());
   return [k,normalizeEvaluation(cursor)];
  }
  return [k,normalizeEvaluation(v)];
 }));
 return value;
}
const call=async(c,name,args)=>normalizeEvaluation(await rawCall(c,name,args));
function deadline(p,ms=7000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('deadline')),ms);p.then(v=>{clearTimeout(timer);resolve(v)},e=>{clearTimeout(timer);reject(e)})})}

test('exact schemas/results, validation, retries, conflicts, undo/redo and logging privacy',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adapter-regression-'));
 const env={TODO_DB_PATH:join(dir,'tasks.db'),TODO_LOG_DB_PATH:join(dir,'events.db'),TODO_WIDGET_ENABLED:'0',GTD_RUST_EXECUTABLE:rust};
 const direct=await start(rust,[],env);const proxy=await start(process.execPath,[adapter],env);
 try{
  const original=(await direct.client.listTools()).tools;
  const exposed=(await proxy.client.listTools()).tools;
  assert.equal(exposed.length,18);
  assert(!JSON.stringify(exposed).includes('todo.home'));assert(!proxy.client.getInstructions().includes('todo.home'));
  const guidance=proxy.client.getInstructions();
  assert(guidance.startsWith(direct.client.getInstructions()));
  assert(exposed.find(t=>t.name==='capture_item').inputSchema.required.includes('importance'));
  assert(exposed.find(t=>t.name==='capture_item').inputSchema.required.includes('agent_notes'));
  const missing=await call(proxy.client,'capture_item',{request_id:'missing-importance',title:'Invalid new task',reason:'Required field regression'});
  assert.equal(missing.isError,true);
  assert.equal(missing.structuredContent.code,'invalid_input');
  for(const t of original){const x=exposed.find(x=>x.name===t.name);assert.deepEqual(x.inputSchema,t.inputSchema);assert.deepEqual(x.outputSchema,t.outputSchema);assert.deepEqual(x.annotations,t.annotations);}
  const uiUri=exposed.find(t=>t.name==='show_tasks')._meta.ui.resourceUri;
  for(const tool of exposed){
   if(['show_tasks','capture_item','update_item','undo_change','show_projects','show_gtd','create_project','update_project'].includes(tool.name))assert.equal(tool._meta.ui.resourceUri,uiUri);
   else assert.equal(tool._meta?.ui?.resourceUri,undefined);
  }
  assert(guidance.includes('brief')); 
  const resource=await proxy.client.readResource({uri:exposed.find(t=>t.name==='show_tasks')._meta.ui.resourceUri});assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app');
  assert.deepEqual(resource.contents[0]._meta['openai/ui'].availableDisplayModes,['inline','fullscreen']);
  const secret='DO_NOT_LOG_TASK_OR_REASON_8140';
  const args={importance:'normal',estimated_minutes:30,effort:'medium',request_id:'capture-one',title:secret,notes:secret,links:[{url:'https://example.com/'+secret,label:secret}],location:secret,reason:secret};
  const first=await call(proxy.client,'capture_item',args);assert.equal(first.isError,false);assert.equal(first.structuredContent.response_version,2);assert.equal(first.structuredContent.task.link_count,1);assert.equal(first.structuredContent.task.has_location,true);assert.equal(first.structuredContent.task.links,undefined);assert.equal(first.structuredContent.change.after,undefined);const full=(await call(proxy.client,'list_items',{task_id:first.structuredContent.task.id,detail:'full'})).structuredContent.items[0];assert.deepEqual(full.links,args.links);assert.equal(full.location,secret);
  const replay=await call(proxy.client,'capture_item',args);assert.equal(replay.structuredContent.replayed,true);assert.equal(replay.structuredContent.change.id,first.structuredContent.change.id);
  assert.deepEqual(await call(proxy.client,'list_items',{include_history:true}),await call(direct.client,'list_items',{include_history:true}));
  const invalid={request_id:'invalid',title:'',reason:'test'};
  assert.deepEqual(await call(proxy.client,'capture_item',invalid),await call(direct.client,'capture_item',invalid));
  const task=first.structuredContent.task;
  const updates=await Promise.all(['a','b'].map(request_id=>call(proxy.client,'update_item',{request_id,task_id:task.id,expected_version:1,status:'done',reason:'concurrent test'})));
  assert.equal(updates.filter(x=>!x.isError).length,1);assert.equal(updates.filter(x=>x.isError).length,1);
  const done=updates.find(x=>!x.isError).structuredContent;
  const undone=(await call(proxy.client,'undo_change',{request_id:'undo',change_id:done.change.id,expected_version:done.task.version,reason:'undo test'})).structuredContent;assert.equal(undone.task.status,'inbox');
  const redone=(await call(proxy.client,'undo_change',{request_id:'redo',change_id:undone.change.id,expected_version:undone.task.version,reason:'redo test'})).structuredContent;assert.equal(redone.task.status,'done');
  const dated=(await call(proxy.client,'update_item',{request_id:'due',task_id:task.id,expected_version:redone.task.version,due_date:'2026-10-20',reason:'date test'})).structuredContent;
  const clear=(await call(proxy.client,'update_item',{request_id:'clear',task_id:task.id,expected_version:dated.task.version,clear_due_date:true,reason:'clear date test'})).structuredContent;assert.equal(clear.task.due_date,null);
  const args2={task_id:task.id,include_deleted:true,include_history:true};assert.deepEqual(await call(proxy.client,'show_tasks',args2),await call(direct.client,'show_tasks',args2));
  assert.deepEqual(await call(proxy.client,'list_changes',{task_id:task.id}),await call(direct.client,'list_changes',{task_id:task.id}));
  assert.equal(proxy.stderr().includes(secret),false);
 }finally{await proxy.client.close();await direct.client.close();await rm(dir,{recursive:true,force:true});}
});

test('disabled UI retains conversational contracts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adapter-disabled-'));
 const p=await start(process.execPath,[adapter],{TODO_DB_PATH:join(dir,'tasks.db'),TODO_LOG_DB_PATH:join(dir,'logs.db'),TODO_ADAPTER_UI_ENABLED:'0',GTD_RUST_EXECUTABLE:rust});
 try{assert((await p.client.listTools()).tools.every(t=>!t._meta?.ui?.resourceUri));assert.deepEqual((await p.client.listTools()).tools.find(t=>t.name==='gtd_ui_write')._meta.ui.visibility,['app']);assert.equal((await call(p.client,'list_items',{})).isError,false);}finally{await p.client.close();await rm(dir,{recursive:true,force:true});}
});

for(const scenario of ['eof','sigterm','backend-died'])test('cleanup: '+scenario,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adapter-lifecycle-'));
 const proc=spawn(process.execPath,[adapter],{env:{...process.env,TODO_DB_PATH:join(dir,'tasks.db'),TODO_LOG_DB_PATH:join(dir,'logs.db'),GTD_RUST_EXECUTABLE:rust},stdio:['pipe','pipe','pipe']});
 const exited=once(proc,'exit');let logs='';
 try{
  await deadline(new Promise(resolve=>{proc.stderr.on('data',b=>{logs+=b;if(logs.includes('adapter.ready'))resolve()})}));
  const children=process.platform==='linux'
   ?(await readFile(`/proc/${proc.pid}/task/${proc.pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number)
   :execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)).filter(([,parent])=>parent===proc.pid).map(([pid])=>pid);
  assert.equal(children.length,1);const child=children[0];
  if(scenario==='eof')proc.stdin.end();else if(scenario==='sigterm')proc.kill('SIGTERM');else process.kill(child,'SIGKILL');
  const [code]=await deadline(exited);assert.equal(code,scenario==='backend-died'?1:0);
  assert.throws(()=>process.kill(child,0));
 }finally{proc.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});

test('missing backend fails startup without leaking exception text',async()=>{
 const p=spawn(process.execPath,[adapter],{env:{...process.env,GTD_RUST_EXECUTABLE:'/missing/private-path-DO_NOT_LOG'},stdio:['pipe','pipe','pipe']});let log='';p.stderr.on('data',b=>log+=b);const [code]=await deadline(once(p,'exit'));assert.equal(code,1);assert(!log.includes('DO_NOT_LOG'));
});

test('bulk calls remain data-only, preserve results, and never partially apply rejected edits',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adapter-bulk-'));
 const env={TODO_DB_PATH:join(dir,'tasks.db'),TODO_LOG_DB_PATH:join(dir,'logs.db'),TODO_WIDGET_ENABLED:'0',GTD_RUST_EXECUTABLE:rust};
 const proxy=await start(process.execPath,[adapter],env);const direct=await start(rust,[],env);
 try{
  const tool=(await proxy.client.listTools()).tools.find(t=>t.name==='apply_changes');
  assert(tool);assert.equal(tool._meta?.ui?.resourceUri,undefined);
  const secret='BULK_CONTENT_MUST_NOT_BE_LOGGED';
  const args={request_id:'batch',operations:[{operation:'capture',importance:'normal',estimated_minutes:30,effort:'medium',title:secret,reason:secret},{operation:'capture',importance:'normal',estimated_minutes:30,effort:'medium',title:'B',reason:'test'}]};
  const created=await call(proxy.client,'apply_changes',args);assert(!created.isError);assert.equal(created.structuredContent.results.length,2);
  assert.deepEqual(await call(proxy.client,'apply_changes',args),await call(direct.client,'apply_changes',args));
  const tasks=created.structuredContent.results.map(r=>({id:r.entity_id,version:r.version}));
  const selection={task_ids:tasks.map(t=>t.id),include_history:true};
  const before=await call(proxy.client,'list_items',selection);
  const edits={request_id:'invalid-batch',operations:tasks.map((t,i)=>({operation:'update',task_id:t.id,expected_version:i?99:t.version,status:'done',reason:'test'}))};
  const rejected=await call(proxy.client,'apply_changes',edits);assert(rejected.isError);assert.equal(rejected.structuredContent.code,'conflict');
  assert.deepEqual(rejected,await call(direct.client,'apply_changes',edits));
  assert.deepEqual(await call(proxy.client,'show_tasks',selection),before);
  assert.equal(proxy.stderr().includes(secret),false);
 }finally{await proxy.client.close();await direct.client.close();await rm(dir,{recursive:true,force:true});}
});

test('project cards preserve v2 receipts, full context, task resolution and audit selectors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adapter-projects-'));
 const env={TODO_DB_PATH:join(dir,'tasks.db'),TODO_LOG_DB_PATH:join(dir,'logs.db'),TODO_WIDGET_ENABLED:'0',GTD_RUST_EXECUTABLE:rust};
 const proxy=await start(process.execPath,[adapter],env);const direct=await start(rust,[],env);
 try{
  const create={request_id:'project-create',title:'Workshop delivered',notes:'Private outcome context',review_date:'2026-10-03',reason:'Synthetic project integration'};
  const created=await call(proxy.client,'create_project',create);assert(!created.isError);
  const p=created.structuredContent.project;assert.equal(p.entity_type,'project');assert.equal(p.status,'active');assert.equal(p.detail,'summary');assert.equal(p.notes,undefined);assert.equal(created.structuredContent.task,undefined);
  const full=await call(proxy.client,'show_projects',{project_id:p.id});assert.equal(full.structuredContent.projects[0].notes,create.notes);assert.deepEqual(full,await call(direct.client,'show_projects',{project_id:p.id}));
  const replay=await call(proxy.client,'create_project',create);assert.equal(replay.structuredContent.replayed,true);assert.equal(replay.structuredContent.project.id,p.id);
  const captured=await call(proxy.client,'capture_item',{importance:'normal',estimated_minutes:30,effort:'medium',request_id:'project-task',title:'Prepare materials',status:'planned',project_id:p.id,reason:'Synthetic project action'});assert(!captured.isError);
  const task=captured.structuredContent.task;
  const projects=await call(proxy.client,'list_projects',{project_id:p.id});assert.equal(projects.structuredContent.projects[0].task_counts.blocked,1);assert.equal(projects.structuredContent.projects[0].needs_next_action,true);
  const rejected=await call(proxy.client,'update_project',{request_id:'premature-project-completion',project_id:p.id,expected_version:p.version,status:'done',reason:'Verify unresolved action protection'});assert.equal(rejected.isError,true);
  const batch={request_id:'project-completion',operations:[{operation:'update',task_id:task.id,expected_version:task.version,status:'done',completion_result:'Materials ready',reason:'Resolve remaining action'},{operation:'update_project',project_id:p.id,expected_version:p.version,status:'done',completion_result:'Workshop delivered',reason:'Complete outcome'}]};
  const completed=await call(proxy.client,'apply_changes',batch);assert(!completed.isError);assert.deepEqual(completed.structuredContent.results.map(r=>r.entity_type),['task','project']);assert(completed.structuredContent.results.every(r=>r.entity_id&&r.change_id&&r.version&&!r.task&&!r.project));
  assert.deepEqual(await call(proxy.client,'apply_changes',batch),await call(direct.client,'apply_changes',batch));
  const history=await call(proxy.client,'list_changes',{project_id:p.id});assert(history.structuredContent.changes.every(c=>c.entity_type==='project'&&c.project_id===p.id&&!c.task_id&&!c.before));
  const change=history.structuredContent.changes[0];const detail=await call(proxy.client,'list_changes',{change_id:change.id,detail:'full'});assert.equal(detail.structuredContent.changes[0].after.completion_result,'Workshop delivered');assert.equal(detail.structuredContent.changes[0].before.status,'active');
  const review=await call(proxy.client,'list_projects',{review_on:'2026-10-03'});assert.equal(review.structuredContent.projects.length,0);
  assert.deepEqual(await call(proxy.client,'sync_state',{}),await call(direct.client,'sync_state',{}));
 }finally{await proxy.client.close();await direct.client.close();await rm(dir,{recursive:true,force:true});}
});

test('adapter preserves test environment when sharing the worker database',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adapter-test-environment-'));
 const env={TODO_DB_PATH:join(dir,'tasks.db'),TODO_LOG_DB_PATH:join(dir,'logs.db'),TODO_ENVIRONMENT:'test',GTD_RUST_EXECUTABLE:rust};
 const direct=await start(rust,[],env);
 let proxy;
 try{
  assert.equal((await call(direct.client,'list_items',{})).structuredContent.environment,'test');
  proxy=await start(process.execPath,[adapter],env);
  const result=await call(proxy.client,'show_tasks',{});
  assert.equal(result.isError,false);assert.equal(result.structuredContent.environment,'test');
  const created=await call(proxy.client,'capture_item',{importance:'normal',estimated_minutes:30,effort:'medium',request_id:'isolated',title:'Test data stays isolated',reason:'Adapter environment regression'});
  assert.equal(created.structuredContent.environment,'test');
  assert.deepEqual(await call(proxy.client,'list_items',{}),await call(direct.client,'list_items',{}));
 }finally{if(proxy)await proxy.client.close();await direct.client.close();await rm(dir,{recursive:true,force:true});}
});

test('adapter forwards pinned UI environment metadata before writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adapter-environment-'));
 const p=await start(process.execPath,[adapter],{TODO_DB_PATH:join(dir,'tasks.db'),TODO_LOG_DB_PATH:join(dir,'logs.db'),TODO_ENVIRONMENT:'production',GTD_RUST_EXECUTABLE:rust});
 try{
  const args={importance:'normal',estimated_minutes:30,effort:'medium',request_id:'guarded-capture',title:'Synthetic metadata guard',reason:'Test metadata forwarding'};
  const rejected=await p.client.callTool({name:'capture_item',arguments:fixtureContent('capture_item',args),_meta:{'gtd/expectedEnvironment':'demo'}});
  assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.code,'environment_changed');
  assert.equal((await call(p.client,'list_items',{})).structuredContent.items.length,0);
  const accepted=await p.client.callTool({name:'capture_item',arguments:fixtureContent('capture_item',args),_meta:{'gtd/expectedEnvironment':'production'}});
  assert.equal(accepted.isError,false);assert.equal(accepted.structuredContent.replayed,false);
 }finally{await p.client.close();await rm(dir,{recursive:true,force:true});}
});
