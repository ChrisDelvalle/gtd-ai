// Manual deterministic regression for the unchanged production transport.
// Build target/debug/todo-mcp first. Uses only a new disposable SQLite directory.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv-provider.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const temp=await mkdtemp(join(tmpdir(),'gtd-stdio-http-regression-'));
const client=new Client({name:'deterministic-stdio-regression',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[join(root,'adapter/server.mjs')],stderr:'pipe',
  env:{PATH:process.env.PATH,TODO_ENVIRONMENT:'test',TODO_DB_PATH:join(temp,'tasks.sqlite3'),TODO_LOG_DB_PATH:join(temp,'logs.sqlite3'),
    GTD_RUST_EXECUTABLE:join(root,'target/debug/todo-mcp')}});
transport.stderr.on('data',()=>{});
try {
  await client.connect(transport);
  const tools=(await client.listTools()).tools;assert.equal(tools.length,18);
  const validator=new AjvJsonSchemaValidator();
  const call=async(name,args)=>{
    const result=await client.callTool({name,arguments:args},undefined,{timeout:10_000});
    assert.equal(Boolean(result.isError),false,JSON.stringify(result.structuredContent));
    const checked=validator.getValidator(tools.find(t=>t.name===name).outputSchema)(result.structuredContent);
    assert.equal(checked.valid,true,checked.errorMessage);
    if(name.startsWith('gtd_ui_')) return result.structuredContent;
    const textOnly=JSON.parse(result.content[0].text);
    assert.deepEqual(textOnly,result.structuredContent);
    return textOnly;
  };
  const args={request_id:'stdio-capture',title:'Fixture',brief:'Validate shared presentation.',notes:'Human detail.',agent_notes:'Disposable regression fixture.',importance:'normal',status:'someday',reason:'Fixture'};
  const saved=await call('capture_item',args);
  const replay=await call('capture_item',args);assert.equal(replay.replayed,true);assert.equal(replay.task.id,saved.task.id);
  const tasks=await call('list_items',{task_id:saved.task.id,include_agent_notes:false,detail:'summary'});
  assert.equal(tasks.items[0].agent_notes,args.agent_notes);
  const changed=await call('update_item',{request_id:'stdio-edit',task_id:saved.task.id,expected_version:1,notes:'Edited fixture.',reason:'Fixture'});
  await call('undo_change',{request_id:'stdio-undo',change_id:changed.change.id,expected_version:2,reason:'Fixture'});
  await call('gtd_ui_write',{operation:'capture_item',arguments:{request_id:'human',title:'Human Inbox',importance:'normal',reason:'Fixture'}});
  const ui=tools.find(t=>t.name==='gtd_ui_read');assert.deepEqual(ui._meta.ui.visibility,['app']);
  assert.equal(tools.some(t=>t.name==='priority_grid'),false);
  const grid=await call('gtd_ui_read',{operation:'priority_grid',arguments:{}});
  assert.equal(grid.counts[3][0].someday,1);
  const square=await call('gtd_ui_read',{operation:'priority_grid',arguments:{snapshot:grid.snapshot,cell:{importance:'normal',urgency:'undated',scope:'someday'}}});
  assert.equal(square.items[0].id,saved.task.id);
  assert.equal(ui._meta['openai/visibility'],'private');assert.equal(ui._meta['openai/widgetAccessible'],true);
  const taskTool=tools.find(t=>t.name==='show_tasks');assert.deepEqual(taskTool._meta.ui.visibility,['model']);
  assert.equal(taskTool._meta['openai/widgetAccessible'],false);
  const uri=taskTool._meta.ui.resourceUri;assert.match(uri,/^ui:\/\/widget\/gtd-[0-9a-f]{20}\.html$/);
  const resource=await client.readResource({uri});assert.equal(resource.contents[0].uri,uri);
  assert.equal(resource.contents[0]._meta.ui.domain,undefined);
  console.log(JSON.stringify({passed:true,groups:5,transport:'Existing Node stdio → Rust SQLite',live_models:0}));
} finally {await client.close();await rm(temp,{recursive:true,force:true});}
