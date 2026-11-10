import { test, expect } from "@playwright/test";
import { openWidget, title } from "./helpers/widget-host";
const account = { id: "00000000-0000-4000-8000-000000000001", timezone: "Asia/Tokyo" };
const other = { id: "00000000-0000-4000-8000-000000000002", timezone: "Europe/Paris" };

for (const width of [390, 900]) test(`authenticated widget pins requests and uses account timing (${width})`, async ({ page }, info) => {
  const { frame } = await openWidget(page, { width, long: false, account });
  await frame.getByRole("button", { name: `More options: ${title}`, exact: true }).click();
  await frame.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const editor = frame.getByRole("region", { name: "Task details", exact: true });
  await editor.getByLabel("Deadline", { exact: true }).fill("2027-04-15");
  await editor.getByRole("button", { name: "Timing", exact: true }).click();
  await editor.getByRole("button", { name: "Add time to deadline", exact: true }).click();
  await expect(editor.getByLabel("Deadline timezone", { exact: true })).toHaveValue(account.timezone);
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  const calls = await page.evaluate(() => (window as any).__wireCalls);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call.params._meta).toEqual({ "gtd/expectedAccount": account.id, "gtd/expectedEnvironment": "staging" });
  expect(calls.filter((call: any) => call.params.name === "gtd_ui_write")).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("widget-account-timing.png"), fullPage: true });
});

test("account change conceals the widget and rejects a delayed committed response without replay", async ({ page }, info) => {
  const { frame, requests } = await openWidget(page, { long: false, account });
  await frame.getByRole("button", { name: `More options: ${title}`, exact: true }).click();
  await frame.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const editor = frame.getByRole("region", { name: "Task details", exact: true });
  await editor.getByRole("textbox", { name: "Notes", exact: true }).fill("This draft belongs only to account A.");
  await page.evaluate(() => (window as any).displayTest.holdNextWrite());
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(async () => (await requests("tools/call")).filter((v: any) => v.params.name === "update_item").length).toBe(1);
  await page.evaluate(other => (window as any).displayTest.changeAccount(other), other);
  await expect(frame.getByText("This session has ended.", { exact: true })).toBeVisible();
  await expect(editor).not.toBeVisible();
  await expect(frame.getByRole("button", { name: `Details: ${title}`, exact: true })).not.toBeVisible();
  await page.evaluate(() => (window as any).displayTest.releaseWrites());
  await expect(frame.getByText("This session has ended.", { exact: true })).toBeVisible();
  expect((await requests("tools/call")).filter((v: any) => v.params.name === "update_item")).toHaveLength(1);
  const calls = await page.evaluate(() => (window as any).__wireCalls);
  expect(calls.every((call: any) => call.params._meta["gtd/expectedAccount"] === account.id)).toBeTruthy();
  await page.screenshot({ path: info.outputPath("widget-account-changed.png"), fullPage: true });
});

test("authenticated resource refuses records without account metadata", async ({ page }) => {
  const { frame, requests } = await openWidget(page, { long: false, account, omitAccountMetadata: true });
  await expect(frame.getByText("This session has ended.", { exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: `Details: ${title}`, exact: true })).toHaveCount(0);
  expect(await requests("tools/call")).toHaveLength(0);
});
