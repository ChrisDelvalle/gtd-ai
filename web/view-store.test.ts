import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ViewStore} from './src/view-store.ts';
test('recent screen state survives remount; old screens are evicted at a fixed bound',()=>{
 const store=new ViewStore(3);
 const first=store.open('all');
 first.cell('filters',()=>({sort:'created',page:0})).update({sort:'importance',page:2});
 store.open('projects');store.open('home');
 const returned=store.open('all');
 assert.equal(returned.restored,true);
 assert.deepEqual(returned.cell('filters',()=>({sort:'created',page:0})).snapshot(),{sort:'importance',page:2});
 for(let i=0;i<1000;i++)store.open('task-'+i);
 assert.equal(store.size,3);
 assert.equal(store.open('all').restored,false);
});
