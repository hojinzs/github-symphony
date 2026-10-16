// Run with an externally installed Playwright module; no product dependency.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { createHarness } from "./fleet-command-ui-harness.mjs";
const { chromium } = await import(
  process.env.C17_PLAYWRIGHT_MODULE ?? "playwright"
);
const f = await createHarness();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.C17_CHROME ? { executablePath: process.env.C17_CHROME } : {}),
});
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const evidence = process.env.C17_EVIDENCE;
if (evidence) mkdirSync(evidence, { recursive: true });
function check(value, label) {
  console.log("reached: " + label);
  if (!process.env.C17_ASSERTION || process.env.C17_ASSERTION === label)
    assert.ok(value, label);
}
try {
  const path = `/projects/${f.ids.interactive}/commands/stop`;
  await page.goto(f.origin + path);
  check(
    (await page.locator("dialog").evaluate((el) => el.matches(":modal"))) &&
      (await page
        .locator("[data-cancel]")
        .evaluate((el) => el === document.activeElement)),
    "modal initial focus"
  );
  await page.keyboard.press("Shift+Tab");
  check(
    await page
      .locator("dialog")
      .evaluate((el) => el.contains(document.activeElement)),
    "modal focus containment"
  );
  await page.keyboard.press("Escape");
  const returned = await page
    .waitForURL("**#stop-action", { timeout: 3000 })
    .then(
      () => true,
      () => false
    );
  check(
    returned &&
      (await page
        .locator("#stop-action")
        .evaluate((el) => el === document.activeElement)),
    "escape restores action focus"
  );
  await page.goto(f.origin + `/commands/${f.records.unknown}`);
  await page.locator("textarea").fill("   ");
  await page.getByRole("button", { name: "Review unresolved closure" }).click();
  check(
    (await page.locator("textarea").count()) > 0 &&
      (await page.locator("textarea").getAttribute("aria-invalid")) ===
        "true" &&
      (await page.locator("[data-reason-error]").isVisible()) &&
      (await page
        .locator("textarea")
        .evaluate((el) => el === document.activeElement)),
    "inline reason validation"
  );
  // Observe the live-region update before the native navigation leaves the page.
  await page.evaluate(() => {
    window.c17Announced = false;
    new MutationObserver(() => {
      if (
        document
          .querySelector("[data-command-announcement]")
          ?.textContent.includes("Submitting intent")
      )
        window.c17Announced = true;
    }).observe(document.querySelector("[data-command-announcement]"), {
      childList: true,
    });
  });
  await page.route("**/closure-confirmation", (route) => route.abort());
  await page.locator("textarea").fill("Inspected host; remains uncertain");
  await page.evaluate(() => {
    document
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  check(
    (await page.evaluate(() => window.c17Announced)) &&
      (await page.locator("form").getAttribute("aria-busy")) === "true",
    "submission announcement"
  );
  await page.unroute("**/closure-confirmation");
  const scenes = {
    history: `/projects/${f.ids.closed}/commands`,
    stop: path,
    start: `/projects/${f.ids.interactive}/commands/start`,
    ...Object.fromEntries(
      Object.entries(f.records).map(([name, id]) => [name, `/commands/${id}`])
    ),
    invalid: `/projects/${f.ids.invalid}/commands/start`,
  };
  let layouts = true,
    assets = true,
    closureLayouts = true,
    closureFocus = true,
    staleDisabled = true,
    failureAlert = true,
    rejection = true,
    reasonErrors = true;
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 960 });
    for (const [name, path] of Object.entries(scenes)) {
      await page.goto(f.origin + path);
      layouts &&= await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      );
      assets &&= await page
        .locator("img")
        .evaluateAll((images) =>
          images.every(
            (img) =>
              img.complete &&
              img.naturalWidth > 0 &&
              Math.abs(img.width - img.naturalWidth) < 1 &&
              Math.abs(img.height - img.naturalHeight) < 1
          )
        );
      if (evidence)
        await page.screenshot({
          path: join(evidence, `${name}-${width}.png`),
          fullPage: true,
        });
    }
    await page.goto(f.origin + `/commands/${f.records.unknown}`);
    await page.locator("textarea").fill("   ");
    await page
      .getByRole("button", { name: "Review unresolved closure" })
      .click();
    reasonErrors &&=
      (await page.locator("textarea").getAttribute("aria-invalid")) === "true";
    layouts &&= await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    );
    if (evidence)
      await page.screenshot({
        path: join(evidence, `reason-error-${width}.png`),
        fullPage: true,
      });
    await page.locator("textarea").fill("Inspected host; remains uncertain");
    await page
      .getByRole("button", { name: "Review unresolved closure" })
      .click();
    check((await page.locator("dialog").count()) > 0, "native form CSRF");
    closureLayouts &&=
      (await page.locator("dialog").count()) > 0 &&
      (await page
        .locator("dialog")
        .evaluate(
          (el) =>
            el.matches(":modal") &&
            el.getBoundingClientRect().right <= innerWidth
        ));
    if (evidence)
      await page.screenshot({
        path: join(evidence, `closure-${width}.png`),
        fullPage: true,
      });
    await page.keyboard.press("Escape");
    const closureReturned = await page
      .waitForURL("**#closure-reason", { timeout: 3000 })
      .then(
        () => true,
        () => false
      );
    closureFocus &&=
      closureReturned &&
      (await page
        .locator("textarea")
        .evaluate((el) => el === document.activeElement));
    await page.goto(f.origin + path);
    f.setDisabled(
      "Backend admission changed. Inspect current project eligibility."
    );
    await page.getByRole("button", { name: "Stop project" }).click();
    rejection &&=
      (await page.getByRole("alert").isVisible()) &&
      (await page.locator("main").innerText()).includes(
        "Backend admission changed"
      );
    check(rejection, "backend rejection");
    layouts &&= await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    );
    if (evidence)
      await page.screenshot({
        path: join(evidence, `rejected-${width}.png`),
        fullPage: true,
      });
    f.setDisabled("Observation is stale. Wait for fresh verification.");
    await page.goto(f.origin + path);
    staleDisabled &&= await page
      .getByRole("button", { name: "Stop project" })
      .isDisabled();
    layouts &&= await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    );
    if (evidence)
      await page.screenshot({
        path: join(evidence, `stale-${width}.png`),
        fullPage: true,
      });
    f.setDisabled(undefined);
    f.setUnavailable(true);
    await page.goto(f.origin + `/commands/${f.records.accepted}`);
    failureAlert &&= await page.getByRole("alert").isVisible();
    layouts &&= await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    );
    if (evidence)
      await page.screenshot({
        path: join(evidence, `error-${width}.png`),
        fullPage: true,
      });
    f.setUnavailable(false);
  }
  check(layouts, "responsive layouts");
  check(assets, "local asset geometry");
  check(closureLayouts, "closure responsive layout");
  check(closureFocus, "closure focus return");
  check(reasonErrors, "inline reason validation");
  check(rejection, "backend rejection");
  check(staleDisabled, "browser stale disabled");
  check(failureAlert, "browser failure alert");
  console.log(
    `C17 browser passed on ${platform()} (native Chromium, fixture HTTPS; no OS process acceptance)`
  );
} finally {
  await browser.close();
  await f.close();
}
