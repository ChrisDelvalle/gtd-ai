import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {openWidget,title} from "./helpers/widget-host";
for (const width of [390,1280]) for(const theme of ["light","dark"] as const) {
 test(`brief and notes editor ${width} ${theme}`,async({page,request,baseURL},info)=>{
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
  const headers={Origin:baseURL!,"X-GTD-Request":"1"};
  const response=await request.post('/api/tools/capture_item',{headers,data:{request_id:randomUUID(),reason:"Disposable brief interface fixture",title:`Compare the venue quotes ${width} ${theme}`,brief:"Compare price and accessibility, then choose a venue.",notes:"## Check before choosing\n\n- Step-free access\n- Quiet space\n\nKeep both quotes for comparison.",importance:"high",status:"next",estimated_minutes:30,effort:"low"}});
  expect(response.ok(),await response.text()).toBeTruthy();const task=(await response.json()).task;
  await page.goto(`/tasks/${task.id}`);
  await expect(page.locator('.task-brief')).toHaveText(task.brief);
  await expect(page.getByRole('heading',{name:'Check before choosing'})).toBeVisible();
  await page.getByRole('button',{name:`More options: ${task.title}`,exact:true}).click();await page.getByRole('menuitem',{name:'Edit',exact:true}).click();
  const editor=page.getByRole('region',{name:'Task details',exact:true});
  await expect(editor).toBeVisible(); 
  const brief=editor.getByRole('textbox',{name:'Brief',exact:true});
  await expect(brief).toHaveValue(task.brief);
  await expect(brief).toHaveAttribute('required','');
  await brief.fill(' ');
  await expect.poll(()=>brief.evaluate(e=>(e as HTMLTextAreaElement).checkValidity())).toBe(false);
  await expect(editor.getByRole('textbox',{name:'Notes',exact:true})).toHaveValue(/Check before choosing/);
  await editor.getByRole('textbox',{name:'Brief',exact:true}).fill('Compare the two quotes and confirm accessibility.');
  await editor.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(editor.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
  const saved=await request.post('/api/tools/list_items',{headers,data:{task_id:task.id}});
  expect((await saved.json()).items[0].brief).toBe('Compare the two quotes and confirm accessibility.');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await editor.getByRole('textbox',{name:'Brief',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('brief-editor.png'),fullPage:true});
 });
}
for(const width of [390,760]) test(`widget brief and app-only transport ${width}`,async({page},info)=>{
 const {frame}=await openWidget(page,{width,long:false});
 await frame.getByRole("button",{name:"Expand view",exact:true}).click();
 await frame.getByRole('button',{name:`Details: ${title}`,exact:true}).click();
 await expect(frame.locator('.task-brief')).toHaveText('Review the material and choose a next action.');
 await frame.getByRole('button',{name:`More options: ${title}`,exact:true}).click();
 await frame.getByRole('menuitem',{name:'Edit',exact:true}).click();
 const brief=frame.getByRole('textbox',{name:'Brief',exact:true});await expect(brief).toBeVisible();await expect(brief).toHaveAttribute('required','');await brief.fill('Choose a useful next action.');
 await frame.getByRole('button',{name:'Save changes',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__wireCalls?.some((m:any)=>m.params.name==='gtd_ui_write'&&m.params.arguments.operation==='update_item'&&m.params.arguments.arguments.brief==='Choose a useful next action.'))).toBe(true);
 await brief.scrollIntoViewIfNeeded();
 await page.screenshot({path:info.outputPath('widget-brief.png'),fullPage:true});
});
