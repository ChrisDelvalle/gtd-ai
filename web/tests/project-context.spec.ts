import { test, expect } from "@playwright/test";
import { build } from "esbuild";

test("project names survive disclosure remounts and refresh without accepting stale names", async ({ page }) => {
  const bundle = await build({
    stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {Mutations,useActions} from './src/actions';
      import {Environment} from './src/app-context';
      import {ProjectContext} from './src/workflow-fields';
      const api={call:()=>new Promise(resolve=>window.pending.push(resolve))};
      window.pending=[];
      const project=(title,version)=>({id:'project-1',entity_type:'project',title,version,deleted:false});
      window.resolveProject=(title,version)=>window.pending.shift()({projects:title?[project(title,version)]:[]});
      function App(){
        const [open,setOpen]=useState(true),[revision,setRevision]=useState(0);
        const {controller}=useActions();
        return <Environment.Provider value={{api,embedded:false,compact:false,revision}}>
          <button onClick={()=>setOpen(v=>!v)}>Toggle disclosure</button>
          <button onClick={()=>setRevision(v=>v+1)}>Refresh fixture</button>
          <button onClick={()=>controller.observe([project('Newest title',3)])}>Observe rename</button>
          {open&&<ProjectContext api={api} task={{project_id:'project-1'}}/>}
        </Environment.Provider>;
      }
      createRoot(document.getElementById('root')).render(<Mutations api={api} onChange={()=>{}}><App/></Mutations>);
    ` },
    bundle: true, write: false, platform: "browser", format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await expect(page.locator(".project-name")).toHaveText("Loading project…");
  await page.evaluate(() => (window as any).resolveProject("Known project", 1));
  await expect(page.getByRole("button", { name: "Known project", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "Toggle disclosure" }).click();
  await page.getByRole("button", { name: "Toggle disclosure" }).click();
  await page.waitForFunction(() => (window as any).pending.length === 1);
  // The refresh remains unresolved: the known name is immediately available.
  await expect(page.locator(".project-name")).toHaveText("Known project");
  await page.getByRole("button", { name: "Observe rename" }).click();
  await page.evaluate(() => (window as any).resolveProject("Delayed older title", 2));
  await expect(page.locator(".project-name")).toHaveText("Newest title");

  await page.getByRole("button", { name: "Refresh fixture" }).click();
  await page.waitForFunction(() => (window as any).pending.length === 1);
  await page.evaluate(() => (window as any).resolveProject(null, 0));
  await expect(page.getByRole("button", { name: "Project unavailable" })).toBeDisabled();
});
