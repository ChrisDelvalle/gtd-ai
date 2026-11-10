import { test, expect } from "@playwright/test";
import { build } from "esbuild";

test("hydration retains resolved server HTML while its optional module loads", async ({page}) => {
  const result = await build({stdin:{contents:`
    import React,{Suspense,useState} from 'react';
    import {hydrateRoot} from 'react-dom/client';
    import {renderToString} from 'react-dom/server.browser';
    import {deferred} from './src/deferred-component';
    function Screen(){const [draft,setDraft]=useState('Server draft');return <input aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)}/>;}
    async function start(){
      const server=deferred(async()=>({default:Screen}));
      await server.preload();
      const root=document.getElementById('root');
      root.innerHTML=renderToString(<Suspense fallback="Loading"><server.Component/></Suspense>);
      window.serverInput=root.querySelector('input');
      const client=deferred(()=>new Promise(resolve=>{window.release=()=>resolve({default:Screen});}));
      window.recoveries=[];
      hydrateRoot(root,<Suspense fallback="Loading"><client.Component/></Suspense>,{onRecoverableError:e=>window.recoveries.push(e.message)});
    }
    void start();
  `,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}});
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({content:result.outputFiles[0].text});
  await page.waitForFunction(() => typeof (window as any).release === 'function');
  await expect(page.getByRole('textbox',{name:'Draft'})).toHaveValue('Server draft');
  expect(await page.evaluate(() => document.querySelector('input') === (window as any).serverInput)).toBe(true);
  await page.evaluate(() => (window as any).release());
  await page.getByRole('textbox',{name:'Draft'}).fill('Hydrated draft');
  await expect(page.getByRole('textbox',{name:'Draft'})).toHaveValue('Hydrated draft');
  expect(await page.evaluate(() => ({same:document.querySelector('input') === (window as any).serverInput,errors:(window as any).recoveries}))).toEqual({same:true,errors:[]});
});

test("a failed optional module retries without losing another draft", async ({page}) => {
  const result = await build({stdin:{contents:`
    import React,{Suspense,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {deferred} from './src/deferred-component';
    let attempts=0;
    const screen=deferred(async()=>{if(++attempts===1)throw Error('Temporary connection failure');return {default:()=> <p>Optional screen ready</p>};});
    function App(){const [draft,setDraft]=useState('Keep this draft');return <><input aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)}/><Suspense fallback="Loading"><screen.Component/></Suspense></>;}
    createRoot(document.getElementById('root')).render(<App/>);
  `,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}});
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({content:result.outputFiles[0].text});
  await expect(page.getByRole('alert')).toContainText('Could not load this view.');
  await page.getByRole('textbox',{name:'Draft'}).fill('Retained through retry');
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByText('Optional screen ready')).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Draft'})).toHaveValue('Retained through retry');
});

test("a deferred editor retains its draft after resolving and parent updates", async ({
  page,
}) => {
  const result = await build({
    stdin: {
      contents: `
      import React, {Suspense, useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {deferred} from './src/deferred-component';
      let resolve;
      const editor=deferred(()=>new Promise(r=>{resolve=r;}));
      function Editor({revision}) {
        const [draft,setDraft]=useState('Initial');
        return <><input aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)}/><span>Revision {revision}</span></>;
      }
      function App() {
        const [revision,setRevision]=useState(0);
        return <><button onClick={()=>resolve({default:Editor})}>Load</button><button onClick={()=>setRevision(r=>r+1)}>Update parent</button><Suspense fallback="Loading"><editor.Component revision={revision}/></Suspense></>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    `,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Draft" })
    .fill("Keep my unsaved draft");
  await page.getByRole("button", { name: "Update parent" }).click();
  await expect(page.getByText("Revision 1")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue(
    "Keep my unsaved draft",
  );
});
