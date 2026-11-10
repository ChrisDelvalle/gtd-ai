import { test, expect } from "@playwright/test";
import { build } from "esbuild";

for (const enabled of [true, false]) test(`task-list intent reads respect the adapter capability (${enabled})`, async ({page}) => {
  const bundle = await build({
    stdin: {loader:"tsx",resolveDir:process.cwd(),contents:`
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {Mutations} from './src/actions';
      import {Environment} from './src/app-context';
      import {TaskList} from './src/task-list';
      const task={id:'intent-task',title:'Prepare this task',version:1,status:'next',importance:'normal',deleted:false,archived:false,created_at:'2026-01-01T00:00:00Z'};
      window.reads=[];
      const api={taskPreparation:${enabled},call:async(name,args)=>{
        window.reads.push({name,args});return {items:[{...task,notes:'Prepared description'}],next_cursor:null,next_offset:null};
      }};
      createRoot(document.getElementById('root')).render(
        <Environment.Provider value={{api,embedded:${!enabled},compact:false}}>
          <Mutations api={api} onChange={()=>{}}>
            <TaskList api={api} input={{status:'next'}} initial={{items:[task],next_cursor:null,next_offset:null}}/>
          </Mutations>
        </Environment.Provider>
      );
    `},
    bundle:true,write:false,platform:"browser",format:"iife",
    define:{"process.env.NODE_ENV":'"production"'},
  });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const task = page.getByRole("button",{name:"Details: Prepare this task",exact:true});
  await task.waitFor();
  await task.dispatchEvent("pointerenter",{pointerType:"mouse"});
  await task.dispatchEvent("pointerleave",{pointerType:"mouse"});
  await page.waitForTimeout(150);
  expect(await page.evaluate(()=>(window as any).reads)).toHaveLength(0);
  await task.hover();
  if (enabled) await page.waitForFunction(()=>(window as any).reads.length === 1);
  else await page.waitForTimeout(200);
  expect(await page.evaluate(()=>(window as any).reads.length)).toBe(enabled ? 1 : 0);
  await task.click();
  await expect(page.getByText("Prepared description",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).reads.filter((r:any)=>r.args.task_id))).toEqual([
    {name:"list_items",args:{task_id:"intent-task",include_deleted:true,detail:"full"}},
  ]);
});
