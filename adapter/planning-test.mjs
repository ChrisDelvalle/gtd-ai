import {fixtureContent} from "./fixture-content.mjs";
// Deterministic MCP acceptance: no model, no production data or network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('planning fields pass the shipped adapter, sync, repeat previews and undo',async()=>{
 const root=await mkdtemp(join(tmpdir(),'planning-acceptance-'));
 const c=new Client({name:'planning-acceptance',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[new URL('./server.mjs',import.meta.url).pathname],env:{TODO_ENVIRONMENT:'test',TODO_DB_PATH:join(root,'data.db'),TODO_LOG_DB_PATH:join(root,'logs.db'),GTD_RUST_EXECUTABLE:process.env.GTD_RUST_EXECUTABLE||'/usr/local/bin/todo-mcp'},stderr:'pipe'});
 const call=async(name,args)=>{const r=await c.callTool({name,arguments:fixtureContent(name,args)});assert.equal(r.isError,false,JSON.stringify(r));return r.structuredContent;};
 try {
  await c.connect(transport);
  const tools=(await c.listTools()).tools;
  for(const field of ['estimated_minutes','effort','not_before','safety_buffer','work_blocks']) assert(tools.find(t=>t.name==='capture_item').inputSchema.properties[field]);
  assert(tools.find(t=>t.name==='list_items').inputSchema.properties.max_effort);
  assert.match(c.getInstructions(),/remaining active work/);
  const checkpoint=(await call('sync_state',{})).checkpoint;
  const created=await call('capture_item',{request_id:'planning-capture',title:'Draft the application',status:'next',importance:'high',estimated_minutes:30,effort:'medium',due_date:'2027-04-16',deadline_time:{time:'12:00',timezone:'America/New_York'},start_by:{date:'2027-04-15'},planned_start:{date:'2027-04-14',time:'14:00'},planned_finish:{date:'2027-04-14',time:'15:00'},reason:'Isolated acceptance fixture'});
  assert.equal(created.environment,'test');
  const read=await call('list_items',{task_id:created.task.id});
  assert.equal(read.items[0].planned_finish.time,'15:00');assert.equal(read.items[0].importance,'high');assert(Number.isFinite(Date.parse(read.evaluated_at)));
  const begin=await call('update_item',{request_id:'planning-start',task_id:created.task.id,expected_version:created.task.version,started:true,reason:'Confirmed beginning, time unknown'});
  const feed=await call('sync_state',{cursor:checkpoint});assert.equal(feed.changes.at(-1).after.started,true);assert.equal(feed.changes.at(-1).after.started_at,null);
  await call('undo_change',{request_id:'planning-undo',change_id:begin.change.id,expected_version:begin.task.version,reason:'Undo acceptance fixture'});
  assert.equal((await call('list_items',{task_id:created.task.id})).items[0].started,false);
  const preview=await call('list_occurrences',{rule:{start_date:'2027-03-14',frequency:'daily',count:1},from:'2027-03-14',template:{title:'Early review',planned_start:{offset_days:0,time:'02:30'},planned_finish:{offset_days:0,time:'04:00'}}});
  assert.equal(preview.occurrences[0].planning.planned_start.time,'03:30');assert(preview.occurrences[0].timing_adjustments.length);
  const current=(await call('list_items',{task_id:created.task.id})).items[0];
  const blocks=[...current.work_blocks,{id:'second',start:{date:'2027-04-15',time:'09:00'},finish:{date:'2027-04-15',time:'09:30'}}];
  const edit=await call('update_item',{task_id:current.id,expected_version:current.version,request_id:'blocks',reason:'Plan two sessions',work_blocks:blocks,estimated_minutes:75,effort:'medium',safety_buffer:{value:1,unit:'days'},not_before:{date:'2027-04-13'}});
  assert.equal(edit.task.status,'blocked');assert.equal(edit.task.work_blocks,undefined);assert.equal(edit.task.work_block_count,2);assert(edit.task.omitted_fields.includes('work_blocks'));
  const updated=(await call('list_items',{task_id:current.id})).items[0];assert.equal(updated.work_blocks.length,2);assert.equal(updated.buffer_target.date,'2027-04-15');assert(updated.blocking_reasons.some(r=>r.kind==='availability'));
  assert.equal((await call('list_items',{view:'all',max_estimated_minutes:74})).items.length,0);
  assert.equal((await call('list_items',{view:'all',max_estimated_minutes:75,max_effort:'medium'})).items.length,1);
  const legacy=await call('update_item',{task_id:updated.id,expected_version:updated.version,request_id:'legacy-block',reason:'Older client update',planned_finish:{date:'2027-04-14',time:'16:00'}});
  const preserved=(await call('list_items',{task_id:updated.id})).items[0];assert.equal(preserved.work_blocks[1].id,'second');assert.equal(preserved.estimated_minutes,75);
  await call('undo_change',{request_id:'undo-legacy-block',change_id:legacy.change.id,expected_version:legacy.task.version,reason:'Restore original block'});
  assert.equal((await call('list_items',{task_id:updated.id})).items[0].work_blocks[0].finish.time,'15:00');
  const recurrence=await call('create_recurrence',{request_id:'edge-series',reason:'Legacy compatibility edge',rule:{start_date:'2090-01-01',frequency:'daily',count:2},template:{title:'Recurring fixture',status:'next',importance:'normal',estimated_minutes:30,effort:'medium',work_blocks:[{id:'a',start:{offset_days:0}},{id:'b',start:{offset_days:1}}]}});
  const replaced=await call('update_recurrence',{request_id:'remove-designated',reason:'Remove designated block',series_id:recurrence.series.id,expected_version:recurrence.series.version,action:'edit',scope:'all',template:{title:'Recurring fixture',work_blocks:[{id:'b',start:{offset_days:1}}]}});
  const orphan=await c.callTool({name:'update_recurrence',arguments:{request_id:'orphan',reason:'Reject finish without start',series_id:replaced.series.id,expected_version:replaced.series.version,action:'edit',scope:'all',template:{title:'Recurring fixture',planned_finish:{offset_days:1}}}});assert.equal(orphan.isError,true);assert.equal(orphan.structuredContent.code,'invalid_input');
  assert.equal((await call('list_items',{view:'all'})).items.length,1);
 } finally {await c.close();await rm(root,{recursive:true,force:true});}
});
