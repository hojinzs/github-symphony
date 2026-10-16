import {
  runSummarySchema,
  type LogStream,
} from "@gh-symphony/management-protocol";
import { RunLogModel } from "./run-log-model.js";
import { BoundedLogReader } from "./log-read-client.js";

const root = document.getElementById("run-page");
if (root) mountRunLogPage(root);

export function mountRunLogPage(root: HTMLElement) {
  const select = root.querySelector<HTMLSelectElement>("#log-selection")!;
  const follow = root.querySelector<HTMLButtonElement>("#log-follow")!;
  const read = root.querySelector<HTMLButtonElement>("#log-read")!;
  const reset = root.querySelector<HTMLButtonElement>("#log-reset")!;
  const reconnect = root.querySelector<HTMLButtonElement>("#log-reconnect")!;
  const output = root.querySelector<HTMLElement>("#log-content")!;
  const status = root.querySelector<HTMLElement>("#log-status")!;
  const badge = root.querySelector<HTMLElement>("#log-badge")!;
  const fetched = root.querySelector<HTMLElement>("#log-fetched")!;
  if (!select.options.length) return;
  const known = Array.from(
    select.options,
    (option) => JSON.parse(option.value)[0] as string
  );
  let model!: RunLogModel;
  let reader!: BoundedLogReader;
  let lastObservedAt = root.dataset.observed!;
  let checking = false;

  function render() {
    output.textContent = model.text;
    output.setAttribute("aria-busy", String(model.phase === "loading"));
    const historical = model.historical ? "Historical · " : "";
    badge.textContent =
      historical +
      (model.following
        ? "Following · bounded chunks"
        : model.phase === "reset-required"
          ? "Rotation detected · reset required"
          : "follow paused");
    const messages = {
      empty: "No content fetched. Request a bounded read.",
      loading: "Loading bounded log chunk…",
      ready: model.text
        ? "Fetched log output."
        : "Read completed. This stream is empty at the current cursor.",
      "reset-required":
        "Log rotated or truncated. Reset the cursor explicitly; previously fetched content remains historical.",
      unavailable:
        "Log unavailable or missing file. Request a fresh read when available.",
      expired: "Read expired after 30 seconds. Request a fresh read.",
      offline:
        "Follow paused while offline. Fetched content remains historical. Reconnect before requesting fresh detail.",
    };
    // Avoid announcing repeated polling ticks or every appended log line.
    if (status.textContent !== messages[model.phase])
      status.textContent = messages[model.phase];
    fetched.textContent =
      (model.fetchedAt
        ? "Fetched " + model.fetchedAt
        : "No log content fetched") +
      (model.historical ? " · historical content" : "") +
      " · Last observed " +
      lastObservedAt;
    follow.textContent = model.following
      ? "Pause follow"
      : model.online
        ? "Follow"
        : "Follow paused · offline";
    follow.disabled = !model.online || model.phase === "reset-required";
    read.disabled =
      !model.online ||
      model.phase === "loading" ||
      model.phase === "reset-required";
    reset.hidden = model.phase !== "reset-required";
    reset.disabled = !model.online;
    reconnect.hidden = model.online;
  }
  function selection() {
    reader?.disconnect();
    const [runId, stream] = JSON.parse(select.value) as [string, LogStream];
    model = new RunLogModel(
      {
        projectId: root.dataset.project!,
        environmentId: root.dataset.environment!,
        runId,
        stream,
      },
      known
    );
    reader = new BoundedLogReader(model, root.dataset.csrf!, fetch, render);
    if (root.dataset.online !== "true") model.disconnect();
    render();
  }
  async function checkConnection() {
    if (checking) return;
    checking = true;
    reconnect.disabled = true;
    try {
      const response = await fetch(
        "/projects/" +
          encodeURIComponent(model.identity.projectId) +
          "/runs/state",
        {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!response.ok) throw new Error("Unavailable");
      const state = await response.json();
      if (
        state.projectId !== model.identity.projectId ||
        state.environmentId !== model.identity.environmentId ||
        typeof state.online !== "boolean" ||
        typeof state.lastObservedAt !== "string" ||
        !Array.isArray(state.runs) ||
        state.runs.length > 100
      )
        throw new Error("Invalid observation");
      const runs = state.runs.map((run: unknown) =>
        runSummarySchema.parse(run)
      );
      lastObservedAt = state.lastObservedAt;
      root.dataset.online = String(state.online);
      if (
        !state.online ||
        !runs.some(
          (run: { runId: string }) => run.runId === model.identity.runId
        )
      )
        reader.disconnect();
      else model.reconnect();
    } catch {
      root.dataset.online = "false";
      reader.disconnect();
    } finally {
      checking = false;
      reconnect.disabled = false;
      render();
    }
  }
  selection();
  select.addEventListener("change", () => {
    selection();
    if (model.online) void reader.read();
  });
  follow.addEventListener("click", () => {
    if (model.following) model.pause();
    else {
      model.follow();
      void reader.read();
    }
    render();
  });
  read.addEventListener("click", () => {
    void reader.read();
  });
  reset.addEventListener("click", () => {
    model.reset();
    render();
    read.focus();
    void reader.read();
  });
  reconnect.addEventListener("click", () => {
    void checkConnection();
  });
  const offline = () => {
    root.dataset.online = "false";
    reader.disconnect();
  };
  window.addEventListener("offline", offline);
  window.addEventListener("online", checkConnection);
  // Sequential work and fixed pacing bound follow even for immediately completed EOF reads.
  const followTimer = setInterval(() => {
    if (model.following) void reader.read();
  }, 1000);
  const connectionTimer = setInterval(() => {
    void checkConnection();
  }, 5000);
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(followTimer);
      clearInterval(connectionTimer);
      reader.disconnect();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", checkConnection);
    },
    { once: true }
  );
  if (model.online) void reader.read();
}
