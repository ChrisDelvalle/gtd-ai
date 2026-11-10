import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("Home uses one composed read and supplied descriptions without loading private notes", async ({page,request,baseURL}) => {
  const title = `Release ${randomUUID()}`;
  const headers = {Origin:baseURL!,"X-GTD-Request":"1"};
  const response = await request.post('/api/tools/capture_item', {headers, data:{brief:'Review the prepared description.',title,status:'next',importance:'critical',due_date:'2000-01-01',notes:'Prepared human description',agent_notes:'PRIVATE_RELEASE_SENTINEL',estimated_minutes:10,effort:'low',request_id:randomUUID(),reason:'Disposable release acceptance'}});
  expect(response.ok()).toBeTruthy();
  const id = (await response.json()).task.id;
  const calls: {url:string;args:any}[]=[];
  page.on('request',r=>{if(r.method()==='POST')calls.push({url:r.url(),args:r.postDataJSON()});});
  const home = page.waitForResponse('**/api/view');
  await page.goto('/');
  const body=await (await home).json();
  expect(JSON.stringify(body)).not.toContain('PRIVATE_RELEASE_SENTINEL');
  await page.getByRole('button',{name:`Details: ${title}`,exact:true}).click();
  await expect(page.getByText('Prepared human description',{exact:true})).toBeVisible();
  expect(calls.filter(c=>c.url.endsWith('/api/view'))).toHaveLength(1);
  expect(calls.filter(c=>c.url.endsWith('/list_items')&&c.args.task_id===id)).toHaveLength(0);
  expect(calls.some(c=>c.args.include_agent_notes)).toBeFalsy();
});

test("a delayed optional screen leaves navigation working", async ({page}) => {
  let release:()=>void=()=>{};
  const held=new Promise<void>(yes=>release=yes);
  await page.route('**/assets/projects-*.js',async route=>{await held;await route.continue();});
  await page.goto('/');
  await page.getByRole('button',{name:'Projects',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Loading…'})).toBeVisible();
  await page.getByRole('button',{name:'Home',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();
  release();
  await page.getByRole('button',{name:'Projects',exact:true}).click();
  await expect(page.getByRole('button',{name:'Create project',exact:true}).first()).toBeVisible();
});

for (const status of [404, 405]) test(`an open new client reads Home after rollback (${status})`, async ({page}) => {
  let attempts=0;
  await page.route('**/api/view',route=>{attempts++;return route.fulfill({status,contentType:'text/html',body:'Not found'});});
  await page.goto('/');
  await expect(page.getByRole('region',{name:'Next action',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'All tasks',exact:true}).click();
  await page.getByRole('button',{name:'Home',exact:true}).click();
  await expect(page.getByRole('region',{name:'Next action',exact:true})).toBeVisible();
  expect(attempts).toBe(1);
});


test("a failed screen chunk can retry without reloading the application", async ({page}) => {
  let attempts=0;
  await page.route('**/assets/projects-*.js',route=>++attempts===1 ? route.abort('failed') : route.continue());
  await page.goto('/');
  await page.getByRole('button',{name:'Projects',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'Could not load this view.'})).toBeVisible();
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByRole('button',{name:'Create project',exact:true}).first()).toBeVisible();
  // Playwright routing disables HTTP caching: checked code is requested again by import.
  expect(attempts).toBe(3);
});
