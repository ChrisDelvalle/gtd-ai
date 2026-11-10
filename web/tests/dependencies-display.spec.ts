import { test, expect } from "@playwright/test";

for (const width of [320, 390, 1280]) {
  test(`dependency metadata stays concise and opens complete lists at ${width}`, async ({ page, request, baseURL }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light", reducedMotion: "reduce" });
    const make = async (title: string, blocked_by: string[] = [], status = "next") => {
      const response = await request.post("/api/tools/capture_item", {
        headers: { Origin: baseURL!, "X-GTD-Request": "1" },
        data: { brief: "Complete this dependency fixture.", title, blocked_by, status, importance: "normal", estimated_minutes: 30, effort: "medium", reason: "Disposable dependency display fixture", request_id: crypto.randomUUID() },
      });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).task;
    };
    const suffix = crypto.randomUUID().slice(0, 8);
    const prerequisites = [
      await make(`Gather the supporting documents and confirm the submission requirements with the team ${suffix}`),
      await make(`Choose target ${suffix}`, [], "done"),
      await make(`Confirm details ${suffix}`),
    ];
    const task = await make(`Prepare application ${suffix}`, prerequisites.map(t => t.id));
    const dependents = [];
    for (let i = 0; i < 4; i++) dependents.push(await make(`Follow-up ${i + 1} ${suffix}`, [task.id]));
    const reads: any[] = [];
    let fail = width === 390;
    await page.route("**/api/tools/list_items", async route => {
      const args = route.request().postDataJSON();
      reads.push(args);
      if (args.blocked_by_id === task.id && fail) {
        fail = false;
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary dependency read failure" }) });
      }
      await route.continue();
    });
    await page.goto("/");
    if (width < 1041) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("navigation", { name: "Task views" }).getByRole("button", { name: "Blocked", exact: true }).click();
    expect(reads.some(r => r.blocked_by_id === task.id)).toBe(false);
    await page.getByRole("button", { name: `Details: ${task.title}`, exact: true }).click();
    const context = page.locator(".dependency-context:visible");
    const blockedBy = context.locator(".metadata-row").filter({ hasText: "Blocked by:" });
    const blocking = context.locator(".metadata-row").filter({ hasText: "Blocking:" });
    if (width === 390) {
      await expect(context.getByRole("alert")).toBeVisible();
      await context.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(context.getByRole("alert")).toHaveCount(0);
    }
    await expect(blockedBy.locator(".dependency-link")).toHaveCount(2);
    await expect(blocking.locator(".dependency-link")).toHaveCount(2);
    await expect(blockedBy.getByRole("button", { name: `${prerequisites[1].title}, completed`, exact: true }).locator("svg")).toBeVisible();
    await expect(blockedBy.getByRole("button", { name: "Blocked by: +1 more", exact: true })).toBeVisible();
    await expect(blocking.getByRole("button", { name: "Blocking: View all", exact: true })).toBeVisible();
    expect(reads.filter(r => r.blocked_by_id === task.id).every(r => r.limit === 3 && r.detail === "summary" && r.group_recurrences === false)).toBe(true);
    expect(reads.some(r => r.task_ids?.length === 2 && r.task_ids.includes(prerequisites[0].id))).toBe(true);
    const title = blockedBy.locator(".dependency-title").first();
    expect(await title.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(title).toHaveCSS("text-overflow", "ellipsis");
    await expect(blockedBy.locator(".dependency-link").first()).toHaveAttribute("title", prerequisites[0].title);
    await context.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("dependency-metadata.png") });

    // The complete prerequisite list includes completed records and restores this disclosure on Back.
    await blockedBy.getByRole("button", { name: "Blocked by: +1 more", exact: true }).click();
    for (const prerequisite of prerequisites) await expect(page.getByRole("button", { name: `Details: ${prerequisite.title}`, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to previous view", exact: true }).click();
    await expect(blocking).toBeVisible();
    await blocking.getByRole("button", { name: "Blocking: View all", exact: true }).click();
    for (const dependent of dependents) await expect(page.getByRole("button", { name: `Details: ${dependent.title}`, exact: true })).toBeVisible();
    expect(reads.some(r => r.blocked_by_id === task.id && r.limit !== 3 && r.group_recurrences === false)).toBe(true);
    await page.getByRole("button", { name: "Back to previous view", exact: true }).click();

    // Full task names remain accessible to keyboard users, despite visual truncation.
    const firstLink = blockedBy.getByRole("button", { name: prerequisites[0].title, exact: true });
    await firstLink.focus();
    await expect(firstLink).toBeFocused();
    await firstLink.press("Enter");
    await page.getByRole("button", { name: `Details: ${prerequisites[0].title}`, exact: true }).click();
    const single = page.locator(".dependency-context:visible");
    await expect(single.locator(".metadata-key")).toHaveText("Blocking:");
    await expect(single.locator(".dependency-link")).toHaveCount(1);
    await expect(single.locator(".dependency-more")).toHaveCount(0);
    await single.getByRole("button", { name: task.title, exact: true }).click();
    await expect(page.getByRole("button", { name: `Details: ${task.title}`, exact: true })).toBeVisible();
  });
}
