import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
let ready = false;
for (let i = 0; i < 30; i++) {
  try {
    const rejected = await fetch("http://collector:4319/v1/logs", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(
      rejected.status,
      401,
      "authenticated receiver must reject absent credentials"
    );
    ready = true;
    break;
  } catch (error) {
    if (error.code === "ERR_ASSERTION") throw error;
    await delay(1000);
  }
}
assert.ok(ready, "Collector did not become ready");
console.log("reached: Collector rejects missing authentication");
