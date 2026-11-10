import { test, expect, type Page } from "@playwright/test";
const owner = "00000000-0000-4000-8000-000000000001";
const guest = "00000000-0000-4000-8000-000000000002";
const operationId = "00000000-0000-4000-8000-000000000003";
const users = [
  {
    id: owner,
    username: "owner",
    display_name: "Alex",
    administrator: true,
    enabled: true,
    state: "active",
    expires_at: null,
    operation: null,
  },
  {
    id: guest,
    username: "guest",
    display_name:
      "A very long display name that should remain legible on a narrow phone",
    administrator: false,
    enabled: true,
    state: "pending",
    expires_at: "2026-10-23T12:00:00Z",
    operation: null,
  },
];
function session(admin = true, csrf = "a") {
  return {
    authenticated: true,
    enabled: true,
    method: "oidc",
    environment: "test",
    csrf: csrf.repeat(64),
    account: {
      id: owner,
      username: "owner",
      display_name: "Alex",
      timezone: "America/New_York",
      administrator: admin,
    },
    security_url: "https://identity.invalid/account/",
  };
}
function operation(state = "complete", kind = "invite") {
  return { id: operationId, target_id: guest, kind, state, lease_until: null };
}
async function fixtures(page: Page, admin = true) {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: session(admin) }),
  );
  await page.route("**/api/users?*", (route) => route.fulfill({ json: users }));
}
async function invite(page: Page) {
  await page.getByRole("button", { name: "Invite user", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Invite user", exact: true });
  await dialog.getByLabel("Username", { exact: true }).fill("new-guest");
  await dialog
    .getByRole("button", { name: "Invite user", exact: true })
    .click();
  return dialog;
}
for (const mobile of [false, true]) {
  test(`Users and one-time credentials (${mobile ? "mobile dark" : "desktop"})`, async ({
    page,
  }, info) => {
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: "dark" });
    }
    await fixtures(page);
    let writes = 0;
    await page.route("**/api/users/operations", (route) => {
      writes++;
      const input = route.request().postDataJSON();
      expect(input.command).toEqual({
        action: "invite",
        username: "new-guest",
        display_name: null,
      });
      expect(input.request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(route.request().headers()["x-gtd-account"]).toBe(owner);
      return route.fulfill({
        json: {
          operation: operation(),
          temporary_password: "Synthetic-fixture-only-9!",
          sign_in_url: "https://website.invalid/",
        },
      });
    });
    if (!mobile) {
      await page.goto("/");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("menuitem", { name: "Users", exact: true }).click();
      await expect(page).toHaveURL(/\/users$/);
    } else await page.goto("/users");
    await expect(
      page.locator(".gtd-topbar").getByText("Users", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Manage ${users[0].username}`, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Manage guest", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("users.png"),
      fullPage: true,
    });
    const dialog = await invite(page);
    await expect(
      dialog.getByLabel("Temporary password", { exact: true }),
    ).toHaveValue("Synthetic-fixture-only-9!");
    await expect(
      dialog.getByRole("button", { name: "Copy temporary password" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: info.outputPath("invitation.png"),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(
      await page.evaluate(() => JSON.stringify([sessionStorage, localStorage])),
    ).not.toContain("Synthetic-fixture-only");
    expect(writes).toBe(1);
  });
}
test("lost invitation response is inspected without retry or password regeneration", async ({
  page,
}) => {
  await fixtures(page);
  let writes = 0,
    checks = 0;
  await page.route("**/api/users/operations", (route) => {
    writes++;
    return route.fulfill({
      status: 504,
      json: { code: "response_unconfirmed", message: "Response unconfirmed." },
    });
  });
  await page.route("**/api/users/requests/*", (route) => {
    checks++;
    return route.fulfill({ json: { operation: operation() } });
  });
  await page.goto("/users");
  const dialog = await invite(page);
  await expect(
    dialog.getByRole("button", { name: "Check status", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
  expect(checks).toBe(0);
  await dialog
    .getByRole("button", { name: "Check status", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "temporary password cannot be shown again",
  );
  await expect(
    dialog.getByLabel("Temporary password", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toBe(1);
  expect(checks).toBe(1);
});
test("pending work is inspected and resumed only on explicit Continue", async ({
  page,
}) => {
  await fixtures(page);
  let resumes = 0,
    checks = 0;
  await page.route("**/api/users?*", (route) =>
    route.fulfill({
      json: [users[0], { ...users[1], operation: operation("pending") }],
    }),
  );
  await page.route(`**/api/users/operations/${operationId}`, (route) => {
    checks++;
    return route.fulfill({ json: { operation: operation("pending") } });
  });
  await page.route(`**/api/users/operations/${operationId}/resume`, (route) => {
    resumes++;
    return route.fulfill({
      json: {
        operation: operation(),
        temporary_password: "Synthetic-recovery-9!",
        sign_in_url: "https://website.invalid/",
      },
    });
  });
  await page.goto("/users");
  await page.getByRole("button", { name: "Manage guest", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Continue pending operation" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Invite user" });
  await dialog
    .getByRole("button", { name: "Check status", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Continue", exact: true }),
  ).toBeEnabled();
  expect(resumes).toBe(0);
  expect(checks).toBe(1);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByLabel("Temporary password", { exact: true }),
  ).toHaveValue("Synthetic-recovery-9!");
  expect(resumes).toBe(1);
});
test("recent sign-in preserves the request and does not retry automatically", async ({
  page,
  context,
  baseURL,
}) => {
  await fixtures(page);
  let csrf = "a",
    writes: any[] = [];
  await context.route("**/api/auth/session", (route) =>
    route.fulfill({ json: session(true, csrf) }),
  );
  // Page routes take precedence; use the same evolving session for both tabs.
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: session(true, csrf) }),
  );
  await page.route("**/api/users/operations", (route) => {
    writes.push(route.request().postDataJSON());
    return writes.length === 1
      ? route.fulfill({
          status: 403,
          json: {
            code: "reauthentication_required",
            message: "Sign in again to manage accounts",
          },
        })
      : route.fulfill({
          json: {
            operation: operation(),
            temporary_password: "Synthetic-renewed-9!",
            sign_in_url: "https://website.invalid/",
          },
        });
  });
  await context.route("**/api/auth/login", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      reauthenticate: true,
      return_to: "/?gtd_sign_in=complete",
    });
    return route.fulfill({
      json: { authorization_url: "https://identity.invalid/recent-login" },
    });
  });
  await context.route("https://identity.invalid/recent-login", (route) => {
    csrf = "b";
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>location.replace(${JSON.stringify(baseURL + "/?gtd_sign_in=complete")})</script>`,
    });
  });
  await page.goto("/users");
  const dialog = await invite(page);
  await dialog
    .getByRole("button", { name: "Sign in again", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Continue", exact: true }),
  ).toBeEnabled();
  expect(writes).toHaveLength(1);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByLabel("Temporary password", { exact: true }),
  ).toHaveValue("Synthetic-renewed-9!");
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});
test("ordinary users have no account administration entry", async ({
  page,
}) => {
  await fixtures(page, false);
  await page.goto("/users");
  await expect(page.getByRole("alert")).toHaveText(
    "Administrator access is required.",
  );
  await expect(
    page.getByRole("button", { name: "Invite user", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Users", exact: true }),
  ).toHaveCount(0);
});

test("an account change closes the credential dialog and blocks the old page", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/users/operations", (route) =>
    route.fulfill({
      status: 409,
      json: {
        code: "account_changed",
        message: "The signed-in account changed.",
      },
    }),
  );
  await page.goto("/users");
  const dialog = await invite(page);
  await expect(
    page.getByText("This session has ended.", { exact: true }),
  ).toBeVisible();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Invite user", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reopen", exact: true }),
  ).toBeVisible();
});

test("revoked accounts retain pending recovery and disabled accounts cannot reset", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/users?*", (route) =>
    route.fulfill({
      json: [
        users[0],
        {
          ...users[1],
          state: "revoked",
          enabled: false,
          operation: operation("pending", "revoke"),
        },
        {
          ...users[1],
          id: operationId,
          username: "disabled",
          state: "active",
          enabled: false,
          operation: null,
        },
      ],
    }),
  );
  await page.goto("/users");
  await expect(
    page.getByRole("button", { name: "Manage disabled", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Manage guest", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Continue pending operation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Reset password", exact: true }),
  ).toHaveCount(0);
});
