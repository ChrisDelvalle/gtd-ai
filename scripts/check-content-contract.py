#!/usr/bin/env python3
"""Deterministic MCP schema/transport checks. No model or production access.

Requires Python jsonschema. Use --adapter to check the Node adapter.
The checker only launches local binaries with a temporary disposable database.
"""
import json,subprocess,tempfile,os,jsonschema,time,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]; tmp=tempfile.TemporaryDirectory(prefix='gtd-content-contract-')
command=(['node',str(root/'adapter/server.mjs')] if '--adapter' in sys.argv else [str(root/'target/debug/todo-mcp')])
p=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env={**os.environ,'TODO_DB_PATH':tmp.name+'/db','TODO_LOG_DB_PATH':tmp.name+'/logs','TODO_ENVIRONMENT':'test','TODO_WIDGET_ENABLED':'0','GTD_RUST_EXECUTABLE':str(root/'target/debug/todo-mcp')})
i=0; last_rpc_ms=0
try:
 def req(method,params):
  global i,last_rpc_ms;started_rpc=time.perf_counter();i+=1;p.stdin.write(json.dumps(dict(jsonrpc='2.0',id=i,method=method,params=params))+'\n');p.stdin.flush()
  while True:
   msg=json.loads(p.stdout.readline())
   if msg.get('id')==i:
    last_rpc_ms=(time.perf_counter()-started_rpc)*1000
    return msg['result']
 initial=req('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'deterministic-contract-check','version':'1'}})
 p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');p.stdin.flush()
 assert 'needs_brief' not in initial.get('instructions','')
 tools={t['name']:t for t in req('tools/list',{})['tools']}
 for t in tools.values():
  assert 'needs_brief' not in json.dumps(t)
  jsonschema.Draft202012Validator.check_schema(t['inputSchema']);jsonschema.Draft202012Validator.check_schema(t['outputSchema'])
 def call(name,args,valid=True):
  if valid:jsonschema.validate(args,tools[name]['inputSchema'])
  r=req('tools/call',dict(name=name,arguments=args));data=r.get('structuredContent');assert data is not None,r
  try:jsonschema.validate(data,tools[name]['outputSchema'])
  except Exception as e:print(name,json.dumps(data)[:500]);raise
  if valid:assert not r.get('isError'),r
  if '--quiet' not in sys.argv:print(name, 'OK',len(json.dumps(data).encode()))
  return data
 task=call('capture_item',dict(request_id='one',title='Compare venue quotes',brief='Compare the quotes and choose a venue.',agent_notes='Quiet access matters. No booking authorized.',importance='normal',status='someday',reason='Fixture'))['task']
 for name in ['list_items','show_tasks']:call(name,{'view':'all'})
 project=call('create_project',dict(request_id='project',title='Family gathering',brief='Arrange a family gathering.',agent_notes='The venue remains undecided.',reason='Fixture'))['project']
 for name in ['list_projects','show_projects']:call(name,{})
 r=call('update_item',dict(request_id='edit',task_id=task['id'],expected_version=1,brief='Compare the venue costs and accessibility.',reason='Fixture'))
 call('undo_change',dict(request_id='undo',change_id=r['change']['id'],expected_version=2,reason='Fixture'))
 call('update_project',dict(request_id='project-edit',project_id=project['id'],expected_version=1,notes='Choose a venue before inviting guests.',reason='Fixture'))
 series=call('create_recurrence',dict(request_id='repeat',template={'title':'Review week','brief':'Review current commitments.','agent_notes':'Weekly routine; no progress implied.','status':'inbox','importance':'normal'},rule={'start_date':'2090-01-01','frequency':'daily','count':3},reason='Fixture'))['series']
 for args in [{},{'series_id':series['id']},{'series_id':series['id'],'segments_only':True},{'rule':{'start_date':'2090-01-01','frequency':'daily','count':3},'template':{'status':'inbox'}}]:call('list_occurrences',args)
 call('update_recurrence',dict(request_id='segment',series_id=series['id'],expected_version=1,scope='segment',segment_from='2090-01-01',action='edit',brief='Review the coming week.',reason='Fixture'))
 call('apply_changes',{'request_id':'batch','operations':[{'operation':'capture','title':'Call venue','agent_notes':'Ask about quiet access.','importance':'normal','reason':'Fixture'}]})
 call('list_changes',{});call('list_changes',{'change_id':1,'detail':'full'})
 snap=call('sync_state',{});call('sync_state',{'cursor':snap['checkpoint']})
 call('show_gtd',{})
 call('gtd_ui_read',{'operation':'list_items','arguments':{}})
 call('gtd_ui_write',{'operation':'capture_item','arguments':{'request_id':'human','title':'Milk','importance':'normal','reason':'Human fixture'}})
 call('capture_item',{'request_id':'bad','title':'No context','importance':'normal','reason':'Validation'},False)
 if '--measure' in sys.argv:
  import statistics,gzip
  project=call('create_project',dict(request_id='measure-project',title='Payload fixture',brief='Inspect synthetic long records.',agent_notes='Disposable measurement.',reason='Fixture'))['project']
  for n in range(12):
   text=('字' if n==11 else 'x')*10000
   call('capture_item',dict(request_id=f'measure-{n}',title=f'Long record {n}',brief='A short human brief.',notes=text,agent_notes=text,importance='normal',project_id=project['id'],reason='Fixture'))
  args={'project_id':project['id'],'view':'all','limit':100}
  latencies=[];rpc_latencies=[];sizes=[];counts=[];seen=[];cursor=None
  while True:
   started=time.perf_counter();data=call('list_items',{**args,**({'cursor':cursor} if cursor else {})});latencies.append((time.perf_counter()-started)*1000);rpc_latencies.append(last_rpc_ms)
   size=len(json.dumps(data,ensure_ascii=False,separators=(',',':')).encode());sizes.append(size);counts.append(len(data['items']))
   assert size<=32768 or len(data['items'])==1
   for row in data['items']:
    assert row['notes']==row['agent_notes'] and len(row['notes'])==10000 and row['brief']
    seen.append(row['id'])
   cursor=data['next_cursor']
   if not cursor:break
  assert len(set(seen))==12 and len(seen)==12
  ui=call('gtd_ui_read',{'operation':'list_items','arguments':{**args,'detail':'summary'}})
  assert all('agent_notes' not in row for row in ui['items'])
  metrics={'records':12,'agent_pages':len(sizes),'records_per_page':counts,'agent_page_bytes':sizes,'local_debug_rpc_median_ms':round(statistics.median(rpc_latencies),2),'local_debug_page_median_ms':round(statistics.median(latencies),2),'ui_summary_records':len(ui['items']),'ui_summary_bytes':len(json.dumps(ui,ensure_ascii=False,separators=(',',':')).encode()),'scope':'Disposable stdio data, no network latency; validation included in timings.'}
  print('MEASUREMENTS '+json.dumps(metrics))
 assert len(tools)==18
 for name,tool in tools.items():
  assert tool['_meta']['ui']['visibility']==(['app'] if name.startswith('gtd_ui_') else ['model'])
  assert tool['_meta']['openai/widgetAccessible']==name.startswith('gtd_ui_')
  assert tool['outputSchema']['$defs'].get('Receipt',{}).get('description') or name not in ['capture_item','gtd_ui_write']
 if '--adapter' in sys.argv:
  assert tools['show_tasks']['_meta']['ui']['resourceUri'].startswith('ui://widget/gtd-')
 print('All output variants validated. Discovery bytes',len(json.dumps(list(tools.values())).encode()))
finally:
 p.stdin.close()
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:p.kill();p.wait()
 tmp.cleanup()
