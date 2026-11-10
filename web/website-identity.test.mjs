import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const buildModule = async (file) => {
  const compiled = await build({ entryPoints:[file], bundle:true, write:false, platform:'node', format:'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
};
const {identityGuard}=await buildModule('src/website-identity.ts');
const status=(id='00000000-0000-4000-8000-000000000001',environment='staging')=>({
  method:'oidc',authenticated:true,enabled:true,environment,csrf:'a'.repeat(64),
  account:{id,username:'fixture',display_name:null,timezone:'Europe/Paris',administrator:false},
});
test('signing out retains identity; only the same account/environment resumes',()=>{
  const guard=identityGuard();
  guard.observe(status());
  guard.observe({authenticated:false,enabled:true,method:'oidc',environment:'staging'});
  assert.equal(guard.expected,status().account.id);
  guard.observe({...status(),csrf:'b'.repeat(64)});
  assert.equal(guard.headers()['X-GTD-CSRF'],'b'.repeat(64));
  assert.equal(guard.timezone,'Europe/Paris');
  let notices=0;guard.subscribe(()=>notices++);
  assert.throws(()=>guard.observe(status('00000000-0000-4000-8000-000000000002')),{code:'account_changed'});
  assert.throws(()=>guard.headers(),{code:'account_changed'});
  assert.throws(()=>guard.observe(status()),{code:'account_changed'});
  assert.equal(notices,1);
});
test('environment changes, downgrade, missing claims, and malformed zones fail closed',()=>{
  for(const bad of [status(undefined,'production'),{authenticated:true,enabled:false},
    {...status(),account:undefined},{...status(),csrf:''},{...status(),account:{...status().account,timezone:'not-a-zone'}}]) {
    const guard=identityGuard();guard.observe(status());
    assert.throws(()=>guard.observe(bad),{code:'account_changed'});
  }
  const legacy=identityGuard();legacy.observe({authenticated:true,enabled:false});
  assert.deepEqual(legacy.headers(),{});
});
test('late website reads and writes cannot enter a new login generation',async()=>{
  const {websitePost,get,setWebsiteLocked}=await buildModule('src/api.ts');
  const previousFetch=globalThis.fetch;
  let resolve;
  globalThis.fetch=()=>new Promise(yes=>{resolve=yes;});
  try {
    setWebsiteLocked(false);
    const pending=websitePost('/api/tools/update_item',{request_id:'unchanged-intent'});
    setWebsiteLocked(true);setWebsiteLocked(false);
    resolve(new Response(JSON.stringify({task:{id:'old'}}),{status:200}));
    await assert.rejects(pending,{code:'session_changed',uncertain:true});
    const read=get('/api/users');
    setWebsiteLocked(true);
    resolve(new Response(JSON.stringify({records:['old']}),{status:200}));
    await assert.rejects(read,{code:'session_changed',uncertain:false});
  } finally {globalThis.fetch=previousFetch;}
});
