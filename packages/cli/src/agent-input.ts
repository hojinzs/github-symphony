import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

type TokenInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(raw: boolean): unknown;
};
/** Never echo token characters or include them in a diagnostic. */
export async function readEnrollmentToken(
  fromStdin: boolean,
  input: TokenInput = process.stdin,
  output: Writable = process.stderr
): Promise<string> {
  if (!fromStdin && (!input.isTTY || !input.setRawMode))
    throw new Error(
      "Token input needs a terminal; use --token-stdin for a pipe"
    );
  if (fromStdin && input.isTTY)
    throw new Error(
      "--token-stdin requires a pipe; omit it for the hidden prompt"
    );
  return new Promise((resolve, reject) => {
    let token = "";
    const decoder = new StringDecoder("utf8");
    const raw = Boolean(input.isRaw);
    const wasFlowing = input.readableFlowing === true;
    const cleanup = () => {
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("error", error);
      if (!fromStdin) {
        input.setRawMode!(raw);
        output.write("\n");
      }
      if (!wasFlowing) input.pause();
    };
    const finish = (message?: string) => {
      cleanup();
      if (message) reject(new Error(message));
      else if (
        !token.trim() ||
        [...token.trim()].some(
          (character) =>
            /\s/.test(character) ||
            character.charCodeAt(0) < 32 ||
            character.charCodeAt(0) === 127
        )
      )
        reject(new Error("Invalid token input"));
      else resolve(token.trim());
    };
    const error = () => finish("Token input failed");
    const end = () => finish();
    const data = (chunk: Buffer | string) => {
      const value = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (fromStdin) {
        token += value;
        if (Buffer.byteLength(token) > 4096)
          finish("Token input exceeds limit");
        return;
      }
      for (const character of value) {
        if (character === "\u0003" || character === "\u0004") {
          finish("Token input cancelled");
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b")
          token = [...token].slice(0, -1).join("");
        else if (character.charCodeAt(0) >= 32) token += character;
        if (Buffer.byteLength(token) > 4096) {
          finish("Token input exceeds limit");
          return;
        }
      }
    };
    input.on("data", data);
    input.once("end", end);
    input.once("error", error);
    if (!fromStdin) {
      input.setRawMode!(true);
      output.write("Enrollment token (hidden): ");
    }
    input.resume();
  });
}
