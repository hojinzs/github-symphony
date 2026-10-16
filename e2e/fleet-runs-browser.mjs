// Run against the actual C18/C10/C09 HTTPS fixture in a real Chromium browser.
// PLAYWRIGHT_MODULE_PATH permits an external scratch install; no repo dependency.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunFixture } from "./fleet-runs-fixture.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright"
);
const evidence =
  process.env.EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), "c18-browser-"));
mkdirSync(evidence, { recursive: true });
const fixture = await createRunFixture({ runCount: 2 });
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  headless: true,
});
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
let count = 0;
async function check(value, label) {
  console.log("reached: " + label);
  count++;
  assert.ok(await value, label);
}
async function textIncludes(value) {
  await page.waitForFunction(
    (value) =>
      document.querySelector("#log-content")?.textContent.includes(value),
    value
  );
}
try {
  await page.goto(fixture.origin + fixture.path + "?run=run-001");
  await textIncludes("session started");
  await check(
    page.evaluate(
      () =>
        !globalThis.logExecuted &&
        document.querySelector("#log-content").textContent.includes("<script>")
    ),
    "log text is inert"
  );
  await check(
    page
      .locator("#log-selection")
      .inputValue()
      .then((value) => value === JSON.stringify(["run-001", "worker"])),
    "known initial selection"
  );
  await page.locator("#log-selection").focus();
  // macOS headless Chromium does not drive its native select popup with
  // synthetic arrow keys; selectOption exercises the native change boundary.
  await page
    .locator("#log-selection")
    .selectOption(JSON.stringify(["run-001", "events"]));
  await textIncludes('"event"');
  await check(
    page
      .locator("#log-content")
      .textContent()
      .then((text) => !text.includes("session started")),
    "stream change clears prior content"
  );
  await page
    .locator("#log-selection")
    .selectOption(JSON.stringify(["run-001", "worker"]));
  await textIncludes("session started");
  await page.locator("#log-follow").focus();
  await page.keyboard.press("Enter");
  fixture.append("follow-marker\n");
  await textIncludes("follow-marker");
  await page.keyboard.press("Space");
  const requests = fixture.selections.length;
  await page.waitForTimeout(1200);
  await check(
    fixture.selections.length === requests &&
      (await page.locator("#log-follow").textContent()) === "Follow",
    "keyboard follow and pause"
  );
  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true })
    );
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true })
    );
  });
  await page
    .waitForFunction(
      () => !document.querySelector("#log-follow").disabled,
      undefined,
      { timeout: 1000 }
    )
    .catch(() => undefined);
  await check(
    page.locator("#log-follow").isEnabled(),
    "cached page reconnects paused"
  );
  const summaryTime = await page
    .locator("#history-observed")
    .getAttribute("datetime");
  const currentTime = await fixture.observeNow();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(
    (time) => document.querySelector("#log-fetched").textContent.includes(time),
    currentTime
  );
  await check(
    (await page.locator("#history-observed").getAttribute("datetime")) ===
      summaryTime,
    "summary timestamp stays with snapshot"
  );
  const historicalText = await page.locator("#log-content").textContent();
  fixture.rotate();
  await page.locator("#log-read").click();
  await page.locator("#log-reset").waitFor({ state: "visible" });
  await check(
    (await page.locator("#log-content").textContent()) === historicalText &&
      (await page.locator("#log-read").isDisabled()),
    "rotation preserves text until reset"
  );
  await page.locator("#log-reset").focus();
  await page.keyboard.press("Enter");
  await textIncludes("new generation");
  await check(
    page
      .locator("#log-read")
      .evaluate((element) => document.activeElement === element),
    "reset returns focus"
  );
  const fresh = await page.locator("#log-content").textContent();
  const fetched = await page.locator("#log-fetched").textContent();
  await fixture.offline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.waitForFunction(() =>
    document.querySelector("#log-status").textContent.includes("offline")
  );
  await check(
    (await page.locator("#history-status").count()) === 1 &&
      (await page.locator("#history-status").textContent()).includes(
        "Historical"
      ),
    "offline history label"
  );
  await check(
    (await page.locator("#log-content").textContent()) === fresh &&
      (await page.locator("#log-fetched").textContent()).includes(
        fetched.split(" · ")[0]
      ) &&
      (await page.locator("#log-follow").isDisabled()),
    "offline retains timestamp and text"
  );
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await check(
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      ),
      "layout no overflow " + width
    );
    const geometry = await page.locator(".run-page").evaluate((root) =>
      [...document.images]
        .filter((img) => img.getBoundingClientRect().width > 0)
        .map((img) => ({
          src: new URL(img.src).pathname,
          width: img.getBoundingClientRect().width,
          height: img.getBoundingClientRect().height,
          loaded: img.complete && img.naturalWidth > 0,
        }))
    );
    await check(
      geometry.length === { 1440: 6, 1024: 1, 390: 1 }[width] &&
        geometry.every(
          (img) =>
            img.loaded &&
            (img.src.includes("OhMySymphony")
              ? img.width === 24 && img.height === 24
              : img.width === (img.src.includes("ChevronRight") ? 12 : 16) &&
                img.height === (img.src.includes("ChevronRight") ? 12 : 16))
        ),
      "local asset geometry " + width
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
    await page.screenshot({
      path: join(evidence, "offline-" + width + ".png"),
      fullPage: true,
    });
  }
  await fixture.offline(false);
  await page.locator("#log-reconnect").click();
  await page.waitForFunction(
    () => !document.querySelector("#log-follow").disabled
  );
  await check(
    (await page.locator("#log-follow").textContent()) === "Follow" &&
      (await page.locator("#log-badge").textContent()).includes("Historical"),
    "reconnect does not follow"
  );
  await page
    .locator("#log-selection")
    .selectOption(JSON.stringify(["run-002", "worker"]));
  await page.waitForFunction(() =>
    document.querySelector("#log-status").textContent.includes("missing file")
  );
  await check(
    (await page.locator("#log-content").textContent()) === "" &&
      !(await page.locator("#log-read").isDisabled()),
    "missing file fresh read recovery"
  );
  await page
    .locator("#log-selection")
    .selectOption(JSON.stringify(["run-001", "worker"]));
  await textIncludes("new generation");
  fixture.hold(true);
  await page.clock.install();
  await page.locator("#log-read").click();
  await page.waitForFunction(() =>
    document.querySelector("#log-status").textContent.includes("Loading")
  );
  await page.clock.fastForward(30001);
  await page.waitForFunction(() =>
    document.querySelector("#log-status").textContent.includes("expired")
  );
  await check(
    (await page.locator("#log-content").textContent()).includes(
      "new generation"
    ) && !(await page.locator("#log-read").isDisabled()),
    "expired read retains content"
  );
  await check(errors.length === 0, "no browser runtime errors");
  const empty = await createRunFixture({ runCount: 0 });
  try {
    await page.goto(empty.origin + empty.path);
    await check(
      (await page.locator("#history-heading").textContent()) ===
        "Recent runs" &&
        (await page.locator("#log-selection").isDisabled()) &&
        (await page.locator("#log-follow").isDisabled()) &&
        (await page.locator(".history-panel").textContent()).includes(
          "No recorded runs"
        ),
      "empty history disables reads"
    );
  } finally {
    await empty.close();
  }
  writeFileSync(
    join(evidence, "result.json"),
    JSON.stringify(
      { os: process.platform, assertions: count, errors, evidence },
      null,
      2
    )
  );
  console.log(
    "C18 browser passed (" +
      count +
      " reached assertions; actual " +
      process.platform +
      "); evidence: " +
      evidence
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
