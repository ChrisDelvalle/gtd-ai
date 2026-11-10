import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({entryPoints:['src/environment-guard.ts'], bundle:true, write:false, platform:'node', format:'esm'});
const {environmentGuard} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
test('pins the first known environment and rejects a later switch permanently', () => {
  const guard=environmentGuard(); let notifications=0; guard.subscribe(()=>notifications++);
  guard.observe(undefined); assert.equal(guard.expected,undefined);
  guard.observe('demo'); guard.observe('demo'); assert.equal(guard.expected,'demo');
  assert.throws(()=>guard.observe('production'),{code:'environment_changed',uncertain:false});
  assert.equal(notifications,1); assert.equal(guard.expected,'demo');
  assert.throws(()=>guard.observe('demo'),{code:'environment_changed'});
});
test('a server rejection locks the session even before a replacement response',()=>{
  const guard=environmentGuard();guard.observe('test');
  assert.throws(()=>guard.reject(),{code:'environment_changed'});
  assert.throws(()=>guard.assert(),{code:'environment_changed'});
});
