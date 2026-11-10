import {test, expect} from '@playwright/test';
import {openWidget} from './helpers/widget-host';
test('demo card labels the session, pins tool requests and locks on a changed environment', async ({page}) => {
  const {frame,requests}=await openWidget(page,{environment:'demo',long:false});
  await expect(frame.getByRole('status')).toHaveText('Demo Mode');
  await frame.getByRole('button',{name:'Refresh tasks',exact:true}).click();
  await expect.poll(async()=> (await requests('tools/call')).length).toBeGreaterThan(0);
  expect((await requests('tools/call')).every(call=>call.params._meta['gtd/expectedEnvironment']==='demo')).toBe(true);
  await page.evaluate(()=> (window as any).displayTest.sendResult({environment:'production',items:[],history:[]}));
  await expect(frame.getByRole('alert')).toContainText('This session has ended');
  await expect(frame.getByRole('button',{name:'Refresh tasks',exact:true})).not.toBeVisible();
  await expect(frame.getByRole('button',{name:'Expand view',exact:true})).not.toBeVisible();
  await expect(frame.getByRole('button',{name:'Open full view',exact:true})).not.toBeVisible();
});
for (const outcome of ['accepted','rejected'] as const) test(`ended card can request a fresh card without unlocking or retrying writes: ${outcome}`, async ({page}) => {
  const {frame,requests}=await openWidget(page,{environment:'demo',messageSupport:outcome});
  await page.evaluate(()=> (window as any).displayTest.sendResult({environment:'production',items:[],history:[]}));
  await frame.getByRole('button',{name:'Reopen',exact:true}).click();
  await expect.poll(async()=> (await requests('ui/message')).length).toBe(1);
  expect((await requests('ui/message'))[0].params.content[0].text).toContain('Do not resume or retry');
  await expect(frame.getByRole('button',{name:'Expand view',exact:true})).not.toBeVisible();
  expect(await requests('tools/call')).toHaveLength(0);
  if(outcome==='accepted') await expect(frame.getByRole('button',{name:'Requested in chat'})).toBeDisabled();
  else await expect(frame.getByRole('alert')).toContainText('Ask ChatGPT to open GTD again');
});
test('website demo waits for identification and sends pinned headers before writes', async ({page})=> {
  await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,enabled:false,environment:'demo'}}));
  await page.route('**/api/health',r=>r.fulfill({json:{environment:'demo'}}));
  await page.route('**/api/view',async r=>{
    expect(r.request().headers()['x-gtd-environment']).toBe('demo');
    await r.fulfill({status:409,json:{code:'environment_changed',message:'Environment changed'}});
  });
  await page.route('**/api/tools/*',async r=>{
    expect(r.request().headers()['x-gtd-environment']).toBe('demo');
    await r.fulfill({status:409,json:{code:'environment_changed',message:'Environment changed'}});
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('This session has ended');
  await expect(page.getByRole('button',{name:'Add to inbox',exact:true})).not.toBeVisible();
});
