// Called only by the ignored Rust/PostgreSQL fixture. stdin contains ephemeral
// signed test tokens; no personal configuration, provider or production access.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request} from 'node:http';
import {gzipSync,brotliCompressSync} from 'node:zlib';
import {createAuthenticatedAdapter} from '../http-server.mjs';
import {presentation} from '../presentation.mjs';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv-provider.js';

let raw='';for await(const chunk of process.stdin)raw+=chunk;
const fixture=JSON.parse(raw);raw='';
assert.equal(fixture.kind,'disposable-account-http');
assert.match(fixture.backendOrigin,/^http:\/\/127\.0\.0\.1:\d+$/);
const config={port:0,environment:'staging',backendOrigin:fixture.backendOrigin,
  resource:'https://gtd.invalid/mcp',issuer:'https://identity.invalid/storage-fixture',
  ingresses:[{host:'gtd.invalid',metadataOrigin:'https://gtd.invalid',uiHost:'claude'}]};
const app=await createAuthenticatedAdapter(config,{bundle:presentation('<html data-account-binding="1">Isolated widget fixture</html>')});
app.listen(0,'127.0.0.1');await once(app,'listening');
const origin=`http://127.0.0.1:${app.address().port}`;
const watchdog=setTimeout(()=>{app.closeAllConnections();process.exitCode=1;},40_000);
watchdog.unref();
let id=1;
async function rpc(who,method,params={},endpoint=origin,status=200,token=fixture[who].token) {
  const json=JSON.stringify({jsonrpc:'2.0',id:id++,method,params});
  // Many clients serialize Unicode as escapes. The canonical business payload
  // remains the same even when its wire encoding is substantially larger.
  const message=params.name==='apply_changes'?json.replace(/[^\x00-\x7f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')):json;
  return new Promise((resolve,reject)=>{
    const req=request(endpoint+'/mcp',{method:'POST',headers:{Host:'gtd.invalid',Authorization:token,
      Accept:'application/json, text/event-stream','Content-Type':'application/json','Content-Length':Buffer.byteLength(message)}},res=>{
      res.setEncoding('utf8');
      let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>{
        try {assert.equal(res.statusCode,status);const result=JSON.parse(data);
          if(status!==200) return resolve({headers:res.headers,result});
          assert.equal(result.error,undefined);resolve(result.result);}catch(e){reject(e);}
      });
    });req.on('error',reject);req.end(message);
  });
}
const tool=(who,name,args={},meta)=>rpc(who,'tools/call',{name,arguments:args,
  ...(name.startsWith('gtd_ui_')?{_meta:{'gtd/expectedAccount':fixture[who].id,'gtd/expectedEnvironment':'staging'}}:{}),
  ...(meta?{_meta:meta}:{})});
try {
  const init=await rpc('a','initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'native-fixture',version:'1'}});
  assert.equal(init.serverInfo.name,'private-gtd');assert.match(init.instructions,/STAGING/);
  const tools=(await rpc('a','tools/list')).tools;assert.equal(tools.length,19);
  const validator=new AjvJsonSchemaValidator();
  const validate=(name,result)=>{
    assert.equal(result.isError,false,JSON.stringify(result.structuredContent));
    const schema=tools.find(t=>t.name===name).outputSchema;
    const checked=validator.getValidator(schema)(result.structuredContent);
    assert.equal(checked.valid,true,checked.errorMessage);
    if(name.startsWith('gtd_ui_')) {
      assert.throws(()=>JSON.parse(result.content[0].text));
      return result.structuredContent;
    }
    const textOnly=JSON.parse(result.content[0].text);
    assert.deepEqual(textOnly,result.structuredContent);
    return textOnly;
  };
  const profiles=await Promise.all(['a','b','a','b'].map(w=>tool(w,'get_profile')));
  for(const [i,p] of profiles.entries()) {
    assert.equal(validate('get_profile',p).id,fixture[i%2?'b':'a'].id);
    assert.deepEqual(JSON.parse(p.content[0].text),p.structuredContent);
  }
  const input={request_id:'same-request-two-accounts',title:'HTTP integration task',status:'next',importance:'normal',estimated_minutes:30,effort:'low',
    brief:'Verify account-bound HTTP operations.',notes:'Human context',agent_notes:'Disposable integration fixture.',reason:'Integration fixture'};
  const [savedA,savedB]=await Promise.all([tool('a','capture_item',input),tool('b','capture_item',input)]);
  const a=validate('capture_item',savedA),b=validate('capture_item',savedB);
  assert.notEqual(a.task.id,b.task.id);
  const replay=validate('capture_item',await tool('a','capture_item',input));
  assert.equal(replay.replayed,true);assert.equal(replay.task.id,a.task.id);assert.equal(replay.change.id,a.change.id);
  const tasks=validate('list_items',await tool('a','list_items',{task_id:a.task.id,detail:'summary',include_agent_notes:false}));
  assert.equal(tasks.items[0].agent_notes,input.agent_notes);assert.equal(tasks.items[0].brief,input.brief);assert.equal(tasks.items[0].notes,input.notes);
  // This entire edit uses only identifiers/version decoded from text content.
  const edited=validate('update_item',await tool('a','update_item',{task_id:tasks.items[0].id,
    expected_version:tasks.items[0].version,request_id:'text-only-edit',title:'Renamed through text',reason:'Text-only consumer regression'}));
  assert.equal(edited.task.title,'Renamed through text');
  const shown=validate('show_tasks',await tool('a','show_tasks',{task_id:edited.task.id}));
  assert.equal(shown.items[0].version,edited.task.version);
  const history=validate('list_changes',await tool('a','list_changes',{task_id:edited.task.id}));
  assert.ok(history.changes.some(c=>c.id===edited.change.id));
  const undone=validate('undo_change',await tool('a','undo_change',{change_id:edited.change.id,
    expected_version:edited.task.version,request_id:'text-only-undo',reason:'Restore fixture through text'}));
  assert.equal(undone.task.title,input.title);
  const other=await tool('b','list_items',{task_id:a.task.id});
  assert.ok(other.isError || other.structuredContent.items.length===0);
  assert.equal((await tool('a','capture_item',{...input,request_id:'no-handoff',agent_notes:''})).isError,true);
  const human=validate('gtd_ui_write',await tool('a','gtd_ui_write',{operation:'capture_item',arguments:{request_id:'human-inbox',title:'Human inbox',importance:'normal',reason:'Human capture'}}));
  assert.ok(human.task.id);
  const pinned={operation:'capture_item',arguments:{request_id:'pinned-draft',title:'Pinned draft',importance:'normal',reason:'Human capture'}};
  for (const meta of [{},{'gtd/expectedAccount':fixture.a.id},{'gtd/expectedEnvironment':'staging'}]) {
    const stale=await tool('a','gtd_ui_write',pinned,meta);
    assert.equal(stale.isError,true);assert.equal(stale.structuredContent.code,'account_changed');
  }
  const wrong=await tool('b','gtd_ui_write',pinned,{'gtd/expectedAccount':fixture.a.id,'gtd/expectedEnvironment':'staging'});
  assert.equal(wrong.isError,true);assert.equal(wrong.structuredContent.code,'account_changed');
  const env=await tool('a','gtd_ui_write',pinned,{'gtd/expectedAccount':fixture.a.id,'gtd/expectedEnvironment':'production'});
  assert.equal(env.isError,true);assert.equal(env.structuredContent.code,'environment_changed');
  const pinnedResult=await tool('a','gtd_ui_write',pinned,{'gtd/expectedAccount':fixture.a.id,'gtd/expectedEnvironment':'staging'});
  assert.equal(validate('gtd_ui_write',pinnedResult).replayed,false);
  assert.equal(pinnedResult._meta['gtd/accountId'],fixture.a.id);
  assert.equal(pinnedResult._meta['gtd/timezone'],'America/New_York');
  const long='字'.repeat(10000);
  const batch={request_id:'long-content-batch',operations:Array.from({length:2},(_,i)=>({operation:'capture',
    title:'Long fixture '+i,importance:'normal',notes:long,agent_notes:long,reason:'Long-content transport fixture'}))};
  assert.ok(Buffer.byteLength(JSON.stringify(batch))<128*1024);
  assert.ok(Buffer.byteLength(JSON.stringify(batch).replace(/字/g,'\\u5b57'))>128*1024);
  const batchResult=validate('apply_changes',await tool('a','apply_changes',batch));assert.equal(batchResult.results.length,2);
  const complete=validate('list_items',await tool('a','list_items',{task_id:batchResult.results[0].entity_id}));
  assert.equal(complete.items[0].notes,long);assert.equal(complete.items[0].agent_notes,long);
  const tooLarge=await tool('a','apply_changes',{...batch,request_id:'business-limit',operations:[...batch.operations,...batch.operations]});
  assert.equal(tooLarge.isError,true);assert.match(tooLarge.structuredContent.message,/128 KiB/);
  const sync=validate('sync_state',await tool('a','sync_state',{limit:1}));
  assert.ok(sync.next_cursor);
  const continued=validate('sync_state',await tool('a','sync_state',{limit:1,cursor:sync.next_cursor}));
  assert.notEqual(continued.records[0].id,sync.records[0].id);
  assert.equal((await tool('b','sync_state',{cursor:sync.next_cursor})).structuredContent.code,'reset_required');
  assert.equal((await tool('a','gtd_ui_read',{operation:'sync_state',arguments:{cursor:sync.next_cursor}})).structuredContent.code,'reset_required');
  const reviewOn=new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
  const snapshot=(params={})=>({operation:'view_snapshot',arguments:{query:{view:'home',arguments:{review_on:reviewOn,loading:'top-three'}},...params}});
  const expected={'gtd/expectedAccount':fixture.a.id,'gtd/expectedEnvironment':'staging'};
  const widgetRead=(args,meta=expected)=>({name:'gtd_ui_read',arguments:args,_meta:meta});
  const expired=await rpc('a','tools/call',widgetRead(snapshot()),origin,401,'Bearer invalid');
  assert.match(expired.headers['www-authenticate'],/resource_metadata="https:\/\/gtd.invalid\//);
  assert.equal((await rpc('b','tools/call',widgetRead(snapshot()))).structuredContent.code,'account_changed');
  const absentPins=await rpc('a','tools/call',widgetRead(snapshot(),{}));
  assert.equal(absentPins.structuredContent.code,'account_changed');
  assert.equal(absentPins._meta['gtd/accountId'],fixture.a.id);
  const shifted=await rpc('a','tools/call',widgetRead(snapshot(),{...expected,'gtd/expectedEnvironment':'production'}));
  assert.equal(shifted.structuredContent.code,'environment_changed');
  const snapshotCall=async(args,endpoint=origin)=>{
    const result=await rpc('a','tools/call',widgetRead(args),endpoint);
    assert.equal(result._meta['gtd/accountId'],fixture.a.id);
    return validate('gtd_ui_read',result);
  };
  const first=await snapshotCall(snapshot());
  assert.equal(first.kind,'full');
  assert.equal((await snapshotCall(snapshot({token:first.token}))).kind,'unchanged');

  const timing={};
  if(fixture.baselineOrigin) {
    assert.match(fixture.baselineOrigin,/^http:\/\/127\.0\.0\.1:\d+$/);
    const legacy=await createAuthenticatedAdapter({...config,backendOrigin:fixture.baselineOrigin},
      {bundle:presentation('<html data-account-binding="1">Isolated widget fixture</html>')});
    legacy.listen(0,'127.0.0.1');await once(legacy,'listening');
    const endpoints=[`http://127.0.0.1:${legacy.address().port}`,origin];
    const stats=values=>{values.sort((a,b)=>a-b);return {n:values.length,median:values[values.length/2],p95:values[Math.ceil(values.length*.95)-1]};};
    try {
      for(const [kind,args] of [['unchanged',snapshot({token:first.token})],['full',snapshot()]]) {
        for(const endpoint of endpoints) await snapshotCall(args,endpoint);
        const samples=[[],[]];
        for(let pair=0;pair<30;pair++) for(const i of [pair%2,1-pair%2]) {
          const at=performance.now();
          const result=await snapshotCall(args,endpoints[i]);
          samples[i].push(performance.now()-at);
          assert.equal(result.kind,kind);
        }
        timing[kind]={separate:stats(samples[0]),inTransaction:stats(samples[1])};
      }
    } finally {legacy.closeAllConnections();await new Promise(resolve=>legacy.close(resolve));}
  }

  const syntheticNotes=i=>Array.from({length:42},(_,line)=>`Checkpoint ${i+line}. Verify the booking reference and confirm the expected arrival window with the coordinator. Track ${(i+line+3)*2654435761%1000003} and record any remaining work.`).join('\n\n');
  const notesTasks=[];
  for(let i=0;i<3;i++) notesTasks.push(validate('capture_item',await tool('a','capture_item',{
    ...input,request_id:`home-notes-${i}`,title:`Priority fixture ${i}`,importance:'critical',notes:syntheticNotes(i),
  })).task);
  let base=await snapshotCall(snapshot());
  for(const [i,task] of notesTasks.entries())
    assert.ok(base.data.next.items.find(x=>x.id===task.id).notes===syntheticNotes(i));
  await tool('a','update_item',{task_id:notesTasks[0].id,expected_version:notesTasks[0].version,request_id:'home-rename',title:'Renamed priority',reason:'Fixture'});
  const current=await snapshotCall(snapshot());
  const reduced=await snapshotCall(snapshot({token:base.token,reuse_home_notes:true}));
  assert.equal(reduced.reused_home_notes.length,3);
  const sizes=value=>{const bytes=Buffer.from(JSON.stringify(value));return [bytes.length,gzipSync(bytes).length,brotliCompressSync(bytes).length];};
  const noteBytes={plain:sizes(current),reuse:sizes(reduced)};
  const yearStart=new Date(reviewOn+'T12:00:00Z');
  yearStart.setUTCDate(yearStart.getUTCDate()-363);
  const chartQuery={view:'charts',arguments:{
    from:yearStart.toISOString().slice(0,10),through:reviewOn,metric:'changes',
  }};
  const chart=await snapshotCall({operation:'view_snapshot',arguments:{query:chartQuery}});
  const sparse=await snapshotCall({operation:'view_snapshot',arguments:{query:chartQuery,sparse_chart:true}});
  assert.equal(sparse.chart_today,reviewOn);
  const expectedDays=chart.data.days.filter(day=>day.count>0 || day.partial);
  assert.deepEqual(sparse.data.days,expectedDays);
  const sparseDay=await tool('a','gtd_ui_read',{operation:'activity_day',arguments:{
    ...chartQuery.arguments, day:reviewOn, snapshot:sparse.data.snapshot,
  }});
  assert.equal(sparseDay.structuredContent.total,expectedDays.at(-1).count);
  const shortChart=await snapshotCall({operation:'view_snapshot',arguments:{
    query:{...chartQuery,arguments:{...chartQuery.arguments,from:reviewOn}},sparse_chart:true,
  }});
  assert.equal(shortChart.chart_today,undefined);
  assert.deepEqual(shortChart.data.days,expectedDays);
  const chartBytes={full:sizes(chart),sparse:sizes(sparse)};
  for(const id of reduced.reused_home_notes) {
    const task=reduced.data.next.items.find(x=>x.id===id);
    assert.equal(task.notes,undefined);
    task.notes=base.data.next.items.find(x=>x.id===id).notes;
  }
  assert.deepEqual(reduced.data.next.items.map(x=>[x.id,x.title,x.notes]),current.data.next.items.map(x=>[x.id,x.title,x.notes]));
  base=reduced;
  await tool('a','update_item',{task_id:notesTasks[1].id,expected_version:notesTasks[1].version,request_id:'home-clear',notes:'',reason:'Fixture'});
  const cleared=await snapshotCall(snapshot({token:base.token,reuse_home_notes:true}));
  assert.equal(cleared.data.next.items.find(x=>x.id===notesTasks[1].id).notes,'');
  assert.ok(!cleared.reused_home_notes.includes(notesTasks[1].id));
  const otherNotes=validate('gtd_ui_read',await tool('b','gtd_ui_read',snapshot({token:base.token,reuse_home_notes:true})));
  assert.equal(otherNotes.reused_home_notes,undefined);
  const ui=tools.find(t=>t.name==='gtd_ui_read');assert.deepEqual(ui._meta.ui.visibility,['app']);
  assert.equal(ui._meta['openai/visibility'],'private');
  for(const t of tools)assert.deepEqual(t.securitySchemes,[{type:'oauth2',scopes:['gtd:access']}]);
  const uri=tools.find(t=>t.name==='show_gtd')._meta.ui.resourceUri;
  const widget=await rpc('b','resources/read',{uri});assert.match(widget.contents[0]._meta.ui.domain,/^[0-9a-f]{32}\.claudemcpcontent\.com$/);
  console.log(JSON.stringify({passed:true,groups:8,transport:'Node HTTP → Rust JWT → PostgreSQL RLS',live_models:0,timing,noteBytes,chartBytes}));
} finally {
  clearTimeout(watchdog);app.closeAllConnections();await new Promise(resolve=>app.close(resolve));
}
