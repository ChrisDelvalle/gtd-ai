// Run only inside the isolated diagnostic container, never against production.
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
assert.equal(process.env.TODO_DB_PATH,'/tmp/adapter-todo.sqlite3');
assert.equal(process.env.TODO_LOG_DB_PATH,'/tmp/adapter-events.sqlite3');
const client=new Client({name:'synthetic-refresh-check',version:'1'});
await client.connect(new StdioClientTransport({command:'/usr/local/bin/todo-mcp',env:{TODO_DB_PATH:process.env.TODO_DB_PATH,TODO_LOG_DB_PATH:process.env.TODO_LOG_DB_PATH,TODO_ENVIRONMENT:'test',TODO_WIDGET_ENABLED:'0'},stderr:'ignore'}));
try {
 const response=await client.callTool({name:'list_items',arguments:{}});
 assert.equal(response.isError,false,'Test backend read must succeed');
 assert.equal(response.structuredContent.environment,'test','Refusing mutation outside test mode');
 const items=response.structuredContent.items;
 assert.equal(items.length,1);const task=items[0];
 const r=await client.callTool({name:'update_item',arguments:{request_id:'adapter-refresh-demonstration',task_id:task.id,expected_version:task.version,title:'Synthetic Rust-backed task — refresh verified',reason:'Isolated test: verify card Refresh reads a changed Rust record'}});
 assert.equal(r.isError,false);console.log(JSON.stringify({version:r.structuredContent.task.version,change_id:r.structuredContent.change.id}));
}finally{await client.close();}
