import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { createHarness } from "./fleet-environments-harness.mjs";
const { chromium } = await import(
  process.env.C15_PLAYWRIGHT_MODULE ?? "playwright"
);
const f = await createHarness();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.C15_CHROME ? { executablePath: process.env.C15_CHROME } : {}),
});
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const evidence = process.env.C15_EVIDENCE;
if (evidence) mkdirSync(evidence, { recursive: true });
let reached = 0;
const layouts = new Map([1440, 1024, 390].map((width) => [width, true]));
function check(value, label) {
  console.log("reached: " + label);
  reached++;
  if (!process.env.C15_ASSERTION || process.env.C15_ASSERTION === label)
    assert.ok(value, label);
}
async function screenshot(name) {
  if (evidence)
    await page.screenshot({
      path: join(evidence, name + ".png"),
      fullPage: true,
    });
}
async function scene(name) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await screenshot(name + "-" + width);
    const fits =
      (await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )) &&
      (await page.locator("dialog").evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return (
          el.scrollWidth <= el.clientWidth &&
          rect.left >= 0 &&
          rect.right <= innerWidth
        );
      }));
    layouts.set(width, layouts.get(width) && fits);
  }
}
async function waitStage(stage) {
  return page
    .locator(`[data-stage="${stage}"]`)
    .waitFor({ timeout: 7000 })
    .then(
      () => true,
      () => false
    );
}
try {
  await page.goto(f.origin + "/environments");
  await page.locator("[data-add]").click();
  check(
    await page
      .locator('[name="name"]')
      .evaluate((el) => el === document.activeElement),
    "create initial focus"
  );
  await page.locator('[name="name"]').fill("   ");
  await page
    .getByRole("button", { name: "Create environment", exact: true })
    .click();
  check(
    (await page.locator('[name="name"]').getAttribute("aria-invalid")) ===
      "true",
    "invalid name recovery"
  );
  check(
    !(await page.locator("dialog [data-retry]").isVisible()),
    "create errors have no inert retry"
  );
  await page.locator('[name="name"]').fill("build-host");
  await page
    .getByRole("button", { name: "Create environment", exact: true })
    .click();
  assert.ok(await waitStage("token-ready"));
  await scene("token-ready");
  const token = await page.locator("#enrollment-token").textContent();
  check(
    !(await page.locator("#setup-command").textContent()).includes(token) &&
      (await page
        .getByRole("button", { name: "Copy token", exact: true })
        .count()) === 1,
    "browser token separation"
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copied = text;
        },
      },
    });
  });
  await page
    .getByRole("button", { name: "Copy setup command", exact: true })
    .click();
  check(
    (await page.evaluate(() =>
      window.copied.startsWith("gh-symphony agent setup --server ")
    )) &&
      (await page.locator("#connection-feedback").textContent()) ===
        "Setup command copied. Paste into the host terminal.",
    "clipboard success"
  );
  await page.locator("#enrollment-token").focus();
  await page.keyboard.press("Tab");
  const tokenForward = await page
    .getByRole("button", { name: "Copy token", exact: true })
    .evaluate((el) => el === document.activeElement);
  await page.keyboard.press("Shift+Tab");
  check(
    tokenForward &&
      (await page
        .locator("#enrollment-token")
        .evaluate((el) => el === document.activeElement)),
    "token field tab order"
  );
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw Error("synthetic denied clipboard");
    };
  });
  await page.getByRole("button", { name: "Copy token", exact: true }).click();
  check(
    (await page.locator("#connection-feedback").textContent()).includes(
      "Could not copy"
    ) &&
      (await page
        .locator("#enrollment-token")
        .evaluate((el) =>
          el.value.slice(el.selectionStart, el.selectionEnd)
        )) === token,
    "clipboard failure manual fallback"
  );
  await page.locator("dialog [data-retry]").focus();
  await page.keyboard.press("Tab");
  const forward = await page
    .locator("[data-host-os]")
    .evaluate((el) => el === document.activeElement);
  await page.keyboard.press("Shift+Tab");
  check(
    forward &&
      (await page
        .locator("dialog [data-retry]")
        .evaluate((el) => el === document.activeElement)),
    "modal focus containment"
  );
  await page.keyboard.press("Escape");
  check(
    (await page.locator("#connection-content").textContent()) === "" &&
      (await page
        .locator("[data-add]")
        .evaluate((el) => el === document.activeElement)),
    "close clears secret and restores focus"
  );
  await page.locator("[data-connect]").waitFor();
  await page.locator("[data-connect]").click();
  assert.ok(await waitStage("pending"));
  await scene("reopened");
  check(
    !(await page.locator("#connection-content").textContent()).includes(token),
    "browser reopen secret absent"
  );
  await page
    .getByRole("button", { name: "Generate new token", exact: true })
    .click();
  assert.ok(await waitStage("token-ready"));
  const replacement = await page.locator("#enrollment-token").textContent();
  // Force the browser's displayed expiry into the past; real service expiry is independent.
  await page.locator("[data-expiry]").evaluate((el) => {
    el.dataset.expiry = "2000-01-01T00:00:00Z";
  });
  check(
    (await waitStage("token-expired")) &&
      (await page.locator("#enrollment-token").count()) === 0,
    "expired secret removed"
  );
  await page
    .getByRole("button", { name: "Generate new token", exact: true })
    .click();
  assert.ok(await waitStage("token-ready"));
  const current = await page.locator("#enrollment-token").inputValue();
  let rejected = false;
  try {
    await f.enroll(replacement);
  } catch {
    rejected = true;
  }
  let identity;
  try {
    identity = await f.enroll(current);
  } catch {}
  check(
    rejected && current !== replacement && !!identity,
    "browser regenerate fences token"
  );

  check(
    (await waitStage("awaiting-signal")) &&
      (await page
        .getByRole("button", { name: "Copy resume command", exact: true })
        .count()) === 1,
    "automatic enrollment transition"
  );
  await scene("enrolled");
  await f.signal(identity);
  check(
    (await waitStage("online")) &&
      (await page.locator(".connection-card").textContent()).includes(
        "No projects yet"
      ),
    "automatic zero project success"
  );
  await scene("online");
  f.failReads(true);
  await page.waitForTimeout(2300);
  check(
    (await page.locator("#connection-feedback").textContent()).includes(
      "Unable to check connection"
    ) && (await page.locator("dialog [data-retry]").isVisible()),
    "browser error preserves environment"
  );
  await scene("error");
  f.failReads(false);
  await page.locator("dialog [data-retry]").click();
  await page.locator("summary").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  check(
    await page
      .locator('[name="acknowledged"]')
      .evaluate((el) => el === document.activeElement),
    "keyboard revoke confirmation"
  );
  await page.locator('[name="acknowledged"]').check();
  await page
    .getByRole("button", { name: "Revoke agent access", exact: true })
    .click();
  check(
    (await waitStage("revoked")) &&
      (await page.locator("#connection-content").textContent()).includes(
        "Local execution continues"
      ),
    "browser revocation"
  );
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await screenshot("revoked-" + width);
    check(
      layouts.get(width) &&
        (await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )) &&
        (await page.locator("dialog").evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return (
            el.scrollWidth <= el.clientWidth &&
            rect.left >= 0 &&
            rect.right <= innerWidth
          );
        })),
      "responsive scenes " + width
    );
    await page.locator("[data-close]").click();
    await screenshot("list-" + width);
    const images = await page.locator("img").evaluateAll((images) =>
      images.map((el) => ({
        w: el.naturalWidth,
        h: el.naturalHeight,
        renderW: el.width,
        renderH: el.height,
      }))
    );
    check(
      images.every(
        (img) =>
          img.w > 0 &&
          img.h > 0 &&
          Math.abs(img.w / img.h - img.renderW / img.renderH) < 0.01
      ),
      "local asset geometry " + width
    );
    await page.locator("[data-connect]").click();
    assert.ok(await waitStage("revoked"));
  }
  await page.locator("[data-close]").click();
  await page.setViewportSize({ width: 1440, height: 960 });
  check(
    await page
      .locator(".environment-row dt")
      .evaluateAll(
        (labels) =>
          labels.length === 4 &&
          labels.every((el) => getComputedStyle(el).display !== "none")
      ),
    "accessible row labels"
  );
  check(
    await page
      .waitForFunction(
        () => document.activeElement?.matches("[data-connect]"),
        null,
        { timeout: 3000 }
      )
      .then(
        () => true,
        () => false
      ),
    "row opener focus restored"
  );
  let listRecovered = true;
  for (const manual of [false, true]) {
    f.failReads(true);
    await page.locator('#environment-status[role="alert"]').waitFor();
    listRecovered &&= await page.locator("main > [data-retry]").isVisible();
    f.failReads(false);
    if (manual) await page.locator("main > [data-retry]").click();
    const recovered = await page
      .waitForFunction(
        () =>
          document.getElementById("environment-status").getAttribute("role") ===
          "status",
        null,
        { timeout: 7000 }
      )
      .then(
        () => true,
        () => false
      );
    listRecovered &&=
      recovered && !(await page.locator("main > [data-retry]").isVisible());
  }
  check(listRecovered, "closed list error recovery");
  console.log(
    JSON.stringify({
      suite: "C15 Chromium",
      os: platform(),
      reached,
      result: "pass",
    })
  );
} finally {
  await browser.close();
  await f.close();
}
