/**
 * Standalone worker entrypoint — spawned by the orchestrator as a child process.
 * Importing the worker module triggers its top-level side effect (startAssignedRun).
 */
import "@gh-symphony/worker";
