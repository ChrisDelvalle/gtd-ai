import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {mkdir,readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {openWidget,title} from "./helpers/widget-host";

test("public documentation uses only fresh fictional records",async({page,request,baseURL},info)=>{
  test.skip(process.env.GTD_DOC_SCREENSHOTS!=="1","Explicit documentation capture only");
  const call=async(name:string,args:any)=>{
    const r=await request.post(`/api/tools/${name}`,{headers:{Origin:baseURL!,"X-GTD-Request":"1"},data:args});
    expect(r.ok()).toBeTruthy();return r.json();
  };
  const {project}=await call("create_project",{title:"Launch the neighborhood repair café",brief:"Organize a friendly afternoon for sharing skills and repairing everyday items.",reason:"Fictional documentation",request_id:randomUUID()});
  const date=(days:number)=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
  const examples=[
    ["Confirm the workshop room with the library","high",1,"Ask for a room with two large tables, outlets, and step-free access."],
    ["Draft the volunteer welcome note","normal",3,"Include the arrival time, the tools we will provide, and a link to the sign-up sheet."],
    ["Test the sign-up form on a phone","very_high",0,"Check keyboard navigation, clear labels, and the confirmation message."],
    ["Collect spare cables and basic repair tools","normal",10,"Check the shared kit before buying anything new."],
    ["Sketch a small herb garden for the balcony","low",25,"Choose plants that will be happy with morning sun."],
    ["Compare two weekend hiking routes","very_low",40,"Find a route with a short train journey and an easy return option."],
  ];
  const tasks=[];
  for(const [title,importance,days,brief] of examples){const {task}=await call("capture_item",{title,importance,brief,status:"next",estimated_minutes:25,effort:"medium",due_date:date(days as number),project_id:tasks.length<4?project.id:null,notes:"Keep the next step small and concrete. Record what we learn here so the next conversation can pick up where we left off.",reason:"Fictional documentation",request_id:randomUUID()});tasks.push(task);}
  await page.setViewportSize({width:1440,height:1060});
  await page.emulateMedia({colorScheme:"light",reducedMotion:"reduce"});
  await page.goto("/");
  await page.getByRole("button",{name:/^Chart: /}).click();
  await page.getByRole("menuitemradio",{name:"Priorities",exact:true}).click();
  await expect(page.locator(".priority-square:enabled").first()).toBeVisible();
  await expect(page.getByText(examples[0][0] as string,{exact:true}).first()).toBeVisible();
  const output=resolve("../docs/images");await mkdir(output,{recursive:true});
  await page.screenshot({path:resolve(output,"home.png")});
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator(".priority-square")).toHaveCount(49);
  await page.screenshot({path:info.outputPath("home-phone.png")});
  await page.goto("/help");
  const source=page.getByRole("link",{name:"Source code",exact:true});
  await expect(source).toHaveAttribute("href",/github.com\/ChrisDelvalle\/todo-mcp/);
  await expect(page.getByRole("link",{name:"AGPL-3.0-only"})).toBeVisible();
});


test("public widget screenshot uses a deterministic fictional host",async({page},info)=>{
  test.skip(process.env.GTD_DOC_SCREENSHOTS!=="1","Explicit documentation capture only");
  const {frame,surface,changeMode}=await openWidget(page,{width:760,theme:"dark",long:false});
  await changeMode("fullscreen",500);
  await frame.getByRole("button",{name:`Details: ${title}`,exact:true}).click();
  await expect(frame.getByText("Review the material and choose the next action.",{exact:true})).toBeVisible();
  await expect(frame.locator(".task-expansion[data-resizing]")).toHaveCount(0);
  await surface.screenshot({path:resolve("../docs/images/widget.png")});
  await page.screenshot({path:info.outputPath("widget-context.png")});
});
