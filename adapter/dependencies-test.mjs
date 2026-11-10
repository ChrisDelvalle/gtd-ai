import {fixtureContent} from "./fixture-content.mjs";
// Deterministic acceptance through the shipped adapter. No model or production access.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('dependency schemas, automatic transitions, inherited ranking, clearing, sync and grouped undo',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dependencies-acceptance-'));
 const c=new Client({name:'dependency-acceptance',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[new URL('./server.mjs',import.meta.url).pathname],env:{TODO_ENVIRONMENT:'test',TODO_DB_PATH:join(root,'data.db'),TODO_LOG_DB_PATH:join(root,'logs.db'),GTD_RUST_EXECUTABLE:process.env.GTD_RUST_EXECUTABLE||'/usr/local/bin/todo-mcp'},stderr:'pipe'});
 const raw=(name,args)=>c.callTool({name,arguments:fixtureContent(name,args)});
 const call=async(name,args)=>{const r=await raw(name,args);assert.equal(r.isError,false,JSON.stringify(r));return r.structuredContent;};
 let serial=0;
 const create=(title,patch={})=>call('capture_item',{request_id:`capture-${++serial}`,title,importance:'normal',estimated_minutes:30,effort:'medium',status:'next',reason:'Disposable acceptance fixture',...patch});
 const update=(t,patch)=>call('update_item',{request_id:`update-${++serial}`,task_id:t.id,expected_version:t.version,reason:'Disposable acceptance fixture',...patch});
 const get=async(id)=>(await call('list_items',{task_id:id})).items[0];
 try {
  await c.connect(transport);
  const tools=(await c.listTools()).tools;
  const capture=tools.find(t=>t.name==='capture_item').inputSchema;
  assert(capture.properties.blocked_by);
  assert(capture.$defs.TaskStatus.enum.includes('blocked'));
  assert(!capture.$defs.TaskStatus.enum.includes('planned'));
  assert(tools.find(t=>t.name==='list_items').inputSchema.properties.blocked_by_id);
  assert.match(c.getInstructions(),/manual hold/i);
  assert.match(c.getInstructions(),/dependency/i);
  const a=(await create('Choose the target',{importance:'low'})).task;
  const b=(await create('Submit the application',{blocked_by:[a.id],importance:'critical',estimated_minutes:30,effort:'medium',due_date:'2000-01-01'})).task;
  assert.equal(b.status,'blocked');assert.equal(b.manual_block,false);
  assert.deepEqual((await get(b.id)).unresolved_blocker_ids,[a.id]);
  const page=await call('list_items',{status:'next',sort:'action'});
  assert.equal(page.items[0].id,a.id);assert.equal(page.items[0].importance,'low');
  assert.equal(page.items[0].recommendation.source_task_id,b.id);
  assert.equal((await call('list_items',{view:'all',blocked_by_id:a.id})).items[0].id,b.id);
  const checkpoint=(await call('sync_state',{})).checkpoint;
  const done=await update(a,{status:'done'});
  assert.equal((await get(b.id)).status,'next');
  const sync=await call('sync_state',{cursor:checkpoint});
  assert.equal(sync.changes.length,2);assert(sync.changes.some(c=>c.task_id===b.id));
  await call('undo_change',{request_id:'undo-completion',change_id:done.change.id,expected_version:done.task.version,reason:'Undo whole dependency action'});
  assert.equal((await get(b.id)).status,'blocked');assert.equal((await get(a.id)).status,'next');
  const cycle=await raw('update_item',{request_id:'cycle',task_id:a.id,expected_version:(await get(a.id)).version,blocked_by:[b.id],reason:'Reject cycle'});
  assert.equal(cycle.isError,true);
  const preserved=(await update(await get(b.id),{blocked_by:null,notes:'Human-readable context'})).task;
  assert.deepEqual(preserved.blocked_by,[a.id]);assert.equal(preserved.manual_block,false);
  const held=(await update(preserved,{status:'blocked'})).task;assert.equal(held.manual_block,true);
  const cleared=(await update(held,{blocked_by:[],status:'next'})).task;
  assert.deepEqual(cleared.blocked_by,[]);assert.equal(cleared.manual_block,false);assert.equal(cleared.status,'next');
  const legacy=(await create('Legacy hold',{status:'planned'})).task;assert.equal(legacy.status,'blocked');assert.equal(legacy.manual_block,true);
  assert.equal((await call('list_items',{status:'planned'})).items[0].id,legacy.id);
 } finally {await c.close();await rm(root,{recursive:true,force:true});}
});
