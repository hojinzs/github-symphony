/** Build the JSON-RPC reply for a server request unsupported by this worker. */
export function createUnhandledServerRequestError(
  message: Record<string, unknown>
): Record<string, unknown> | null {
  if (
    !("id" in message) ||
    message.id == null ||
    typeof message.method !== "string" ||
    "result" in message ||
    "error" in message
  ) {
    return null;
  }

  return {
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `unhandled server request: ${message.method}`,
    },
  };
}
