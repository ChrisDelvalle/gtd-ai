// Explicit manual comparison, never part of routine regression or model testing.
import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
test('manual cold and warm Home comparison',async({browser,request,baseURL})=>{
  test.skip(process.env.GTD_ACTIVITY_LOADING_BENCH!=='1');
  test.setTimeout(180000);
  const response=await request.post('/api/tools/apply_changes',{headers:{Origin:baseURL!,'X-GTD-Request':'1'},data:{request_id:randomUUID(),operations:Array.from({length:30},(_,i)=>({operation:'capture',title:`Loading fixture ${i}`,brief:'Open this disposable task.',notes:'Supporting context. '.repeat(40),importance:'normal',status:'next',estimated_minutes:10,effort:'low',reason:'Isolated performance fixture'}))}});
  expect(response.ok(),await response.text()).toBeTruthy();
  const rows=[];
  for(let run=0;run<5;run++){
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const page=await context.newPage();const cdp=await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:120,downloadThroughput:5*1024*1024/8,uploadThroughput:1024*1024/8});
    await cdp.send('Performance.enable');let bytes=0;
    cdp.on('Network.loadingFinished',e=>bytes+=e.encodedDataLength);
    for(const cache of ['cold','warm']){
      bytes=0;const started=performance.now();
      await page.goto(baseURL!);
      await expect(page.getByRole('region',{name:'Next action',exact:true})).toBeVisible();
      const task_ready_ms=performance.now()-started;
      await page.waitForLoadState('networkidle');
      const metrics=await cdp.send('Performance.getMetrics');
      rows.push({run,cache,task_ready_ms,transfer_bytes:bytes,js_heap_bytes:metrics.metrics.find(m=>m.name==='JSHeapUsedSize')?.value, resources:await page.evaluate(()=>performance.getEntriesByType("resource").map(e=>({url:new URL(e.name).pathname,start:e.startTime,duration:e.duration,bytes:(e as PerformanceResourceTiming).transferSize})))});
    }
    await context.close();
  }
  if(process.env.GTD_ACTIVITY_LOADING_OUTPUT)await writeFile(process.env.GTD_ACTIVITY_LOADING_OUTPUT,JSON.stringify({network:{latency_ms:120,download_mbps:5,upload_mbps:1},rows},null,2));
});
