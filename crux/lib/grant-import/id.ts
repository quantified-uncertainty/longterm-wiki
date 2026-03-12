import { createHash } from "crypto";

/** Generate a deterministic 10-char ID from input string */
export function generateId(input: string): string {
  const hash = createHash("sha256").update(input).digest("base64url");
  return hash.substring(0, 10);
}
