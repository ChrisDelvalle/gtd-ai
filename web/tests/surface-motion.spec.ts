import { test, expect, type Locator } from "@playwright/test";
import { openWidget, title } from "./helpers/widget-host";

async function settled(surface: Locator) {
  await expect.poll(() => surface.evaluate(el => {
    const target = Math.min(450, el.querySelector('.widget-content')!.getBoundingClientRect().height + 2);
    return Math.abs(el.getBoundingClientRect().height - target) < 1 && el.getAnimations().length === 0;
  })).toBe(true);
}

// Sample actual layout, not just a transition declaration: the host measures it too.
async function sample(control: Locator, action: "click" | "escape" = "click") {
  return control.evaluate(async (element, action) => {
    const surface = document.querySelector<HTMLElement>(".widget-surface")!;
    const values: {height: number; body: number; time: number}[] = [];
    const start = performance.now();
    const read = () => values.push({height: surface.getBoundingClientRect().height,
      body: document.body.getBoundingClientRect().height, time: performance.now() - start});
    read();
    if (action === "escape") element.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    else (element as HTMLElement).click();
    await new Promise<void>(resolve => {
      const frame = () => { read(); performance.now() - start < 500 ? requestAnimationFrame(frame) : resolve(); };
      requestAnimationFrame(frame);
    });
    return values;
  }, action);
}
function smooth(samples: Awaited<ReturnType<typeof sample>>, direction: 1 | -1) {
  const first = samples[0].height, last = samples.at(-1)!.height;
  expect((last - first) * direction).toBeGreaterThan(60);
  expect(samples.filter(s => (s.height - first) * direction > 2 && (last - s.height) * direction > 2).length).toBeGreaterThan(2);
  for (let i = 1; i < samples.length; i++) {
    expect((samples[i].height - samples[i - 1].height) * direction).toBeGreaterThanOrEqual(-1);
    expect(samples[i].height).toBeLessThanOrEqual(450);
    expect(Math.abs(samples[i].body - samples[i].height)).toBeLessThan(1);
  }
}
for (const width of [390, 760]) {
  for (const control of ["navigation", "filters", "task menu"] as const) {
    test(`${control} grows and shrinks the actual card smoothly at ${width}px`, async ({page}, info) => {
      const {frame, surface, requests} = await openWidget(page, {width, long: false});
      const trigger = frame.getByRole("button", {name: control === "navigation" ? "GTD navigation" : control === "filters" ? "Sort and filter tasks" : `More options: ${title}`, exact: true});
      await expect(trigger).toBeVisible();
      await settled(surface);
      const before = (await surface.boundingBox())!.height;
      const opening = await sample(trigger);
      smooth(opening, 1);
      const menu = frame.locator('.floating-panel');
      await expect(menu).toBeVisible();
      const bounds = (await menu.boundingBox())!, box = (await surface.boundingBox())!;
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(box.y + box.height + 1);
      await page.screenshot({path: info.outputPath('menu-open.png')});
      const closing = await sample(trigger, "escape");
      smooth(closing, -1);
      expect(Math.abs(closing.at(-1)!.height - before)).toBeLessThan(1);
      const sizes = (await requests('ui/notifications/size-changed')).map(m => m.params.height);
      expect(new Set(sizes).size).toBeGreaterThan(6);
    });
  }
}
test('rapid menu reversal stays bounded and reduced motion skips the transition', async ({page}) => {
  const {frame, surface} = await openWidget(page, {long:false, maxHeight:330});
  const trigger = frame.getByRole('button', {name:'GTD navigation', exact:true});
  await trigger.click();
  await trigger.click();
  await trigger.click();
  await expect(frame.getByRole('menu', {name:'GTD views'})).toBeVisible();
  await expect.poll(async () => (await surface.boundingBox())!.height).toBeLessThanOrEqual(330);
  await trigger.click();
  await page.emulateMedia({reducedMotion:'reduce'});
  const samples = await sample(trigger);
  expect(samples.at(-1)!.height).toBeLessThanOrEqual(330);
  expect(samples.filter(s=>s.height > samples[0].height + 2 && s.height < samples.at(-1)!.height - 2)).toHaveLength(0);
});

test('navigation to an empty view animates the release of menu space', async ({page}) => {
  const {frame, surface} = await openWidget(page, {long:false});
  await frame.getByRole('button', {name:'GTD navigation', exact:true}).click();
  await expect.poll(async () => (await surface.boundingBox())!.height).toBe(450);
  const samples = await sample(frame.getByRole('menuitemradio', {name:'Projects', exact:true}));
  smooth(samples, -1);
  await expect(frame.getByText('No projects in this view.', {exact:true})).toBeVisible();
});

test('task disclosure uses its existing motion without an outer flash or second animation', async ({page}) => {
  const {frame, surface} = await openWidget(page, {width:760});
  const trigger = frame.getByRole('button', {name:`Details: ${title}`, exact:true});
  await expect(trigger).toBeVisible();
  await settled(surface);
  const opening = await sample(trigger);
  // Long descriptions may reach the cap in one frame of their own animation;
  // they must never visit the final height and then rewind below it.
  for (let i=1;i<opening.length;i++) expect(opening[i].height).toBeGreaterThanOrEqual(opening[i-1].height-1);
  expect(opening.at(-1)!.height).toBe(450);
  const closing = await sample(trigger);
  for (let i=1;i<closing.length;i++) expect(closing[i].height).toBeLessThanOrEqual(closing[i-1].height+1);
  expect(closing.at(-1)!.height).toBeLessThan(450);
  await expect.poll(() => surface.evaluate(el=>el.getAnimations().length)).toBe(0);
});

test('unexpected asynchronous content growth and removal use the same surface policy', async ({page}) => {
  const {frame, surface} = await openWidget(page, {long:false});
  await expect(frame.getByRole('button', {name:`Details: ${title}`, exact:true})).toBeVisible();
  await settled(surface);
  // Model a future screen/loading/error panel without giving it an animation.
  // Its only contract is normal document flow inside the shared application.
  const trace = await surface.evaluate(async box => {
    const body = box.querySelector('.widget-content')!;
    const extra = document.createElement('div');
    extra.style.height='220px';
    const measure = async (change:()=>void) => {
      const values=[box.getBoundingClientRect().height];
      const start=performance.now(); change();
      await new Promise<void>(resolve=>{const tick=()=>{values.push(box.getBoundingClientRect().height); performance.now()-start<400?requestAnimationFrame(tick):resolve();};requestAnimationFrame(tick);});
      return values;
    };
    const opening=await measure(()=>body.append(extra));
    const closing=await measure(()=>extra.remove());
    return {opening,closing};
  });
  for (const [values, direction] of [[trace.opening, 1],[trace.closing, -1]] as const) {
    expect(new Set(values).size).toBeGreaterThan(4);
    for(let i=1;i<values.length;i++) expect((values[i]-values[i-1])*direction).toBeGreaterThanOrEqual(-1);
  }
});
