import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['src/widget-identity.ts'],bundle:true,write:false,platform:'node',format:'esm'});
globalThis.document={documentElement:{dataset:{}}};
const {widgetIdentityGuard}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
delete globalThis.document;
const a='00000000-0000-4000-8000-000000000001', b='00000000-0000-4000-8000-000000000002';
const result=(id=a,zone='Europe/Paris',environment='staging')=>({_meta:{'gtd/accountId':id,'gtd/timezone':zone,'gtd/environment':environment},structuredContent:{environment}});
test('authenticated widgets require identity before any operation and keep a permanent binding',()=>{
  const zones=[];const guard=widgetIdentityGuard(true,zone=>zones.push(zone));
  assert.equal(guard.ready,false);assert.throws(()=>guard.metadata(),{code:'account_changed'});
  guard.observe(result());assert.equal(guard.ready,true);
  assert.deepEqual(guard.metadata(),{'gtd/expectedAccount':a,'gtd/expectedEnvironment':'staging'});
  guard.observe(result(a,'Asia/Tokyo'));assert.deepEqual(zones,['Europe/Paris','Asia/Tokyo']);
  let notices=0;guard.subscribe(()=>notices++);
  assert.throws(()=>guard.observe(result(b)),{code:'account_changed'});
  assert.throws(()=>guard.observe(result()),{code:'account_changed'}); // Late old response never unlocks.
  assert.throws(()=>guard.metadata(),{code:'account_changed'});
  assert.equal(notices,1);assert.equal(zones.length,2);
});
test('missing, inconsistent, malformed and downgraded context fails closed',()=>{
  for(const bad of [{},result('invalid'),result(a,'Invalid/Zone'),result(a,'UTC','test'),
    {...result(),structuredContent:{environment:'production'}}]) {
    const guard=widgetIdentityGuard(true);
    assert.throws(()=>guard.observe(bad),{code:'account_changed'});
    assert.equal(guard.blocked,true);
  }
  for(const bad of [{},result(a,'UTC','production'),{isError:true,structuredContent:{code:'account_changed'}}]) {
    const guard=widgetIdentityGuard(false);guard.observe(result());
    assert.throws(()=>guard.observe(bad),{code:'account_changed'});
  }
});
test('legacy single-user cards remain compatible without accepting a bound downgrade',()=>{
  const guard=widgetIdentityGuard(false);guard.observe({structuredContent:{environment:'test'}});
  assert.equal(guard.ready,true);assert.deepEqual(guard.metadata(),{});
  guard.observe(result());assert.equal(guard.expected,a);
  assert.throws(()=>guard.observe({structuredContent:{environment:'staging'}}),{code:'account_changed'});
});
