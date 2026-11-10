import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DraftStore} from './src/draft-store.ts';
const initial=()=>({base:1,text:'',reason:''});
const dirty=(value:ReturnType<typeof initial>)=>!!value.text || !!value.reason;
test('unsaved intent survives clean LRU pressure, and discard is explicit',()=>{
 const store=new DraftStore(2);
 const cell=store.cell('task',initial,dirty);
 cell.update(value=>({...value,text:'Unsaved text'}));
 for(let i=0;i<100;i++)store.cell(String(i),initial,dirty);
 assert.equal(store.cell('task',initial,dirty),cell);
 assert.equal(cell.snapshot().text,'Unsaved text');
 assert(store.size<=4);
 store.discard('task');
 assert.equal(cell.snapshot().text,'');
});
test('acknowledgement can rebase after unmount, without erasing later typing',()=>{
 const store=new DraftStore();
 const cell=store.cell('task',initial,dirty);
 const unsubscribe=cell.subscribe(()=>{});
 cell.update(v=>({...v,text:'submitted'}));
 const submitted=cell.snapshot();
 cell.update(v=>({...v,text:'typed while saving'}));
 unsubscribe();
 cell.update(v=>({...v,base:2,text:v.text === submitted.text?'':v.text}));
 assert.deepEqual(store.cell('task',initial,dirty).snapshot(),{base:2,text:'typed while saving',reason:''});
});
test('mounted clean cells and separate sessions are isolated',()=>{
 const a=new DraftStore(0),b=new DraftStore(0);
 const cell=a.cell('id',initial,dirty);
 const unsubscribe=cell.subscribe(()=>{});
 for(let i=0;i<5;i++)a.cell(String(i),initial,dirty);
 assert.equal(a.cell('id',initial,dirty),cell);
 cell.update(v=>({...v,text:'private'}));
 assert.equal(b.cell('id',initial,dirty).snapshot().text,'');
 unsubscribe();
});
