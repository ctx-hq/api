import { generateId } from "../utils/response";

export function generateDeviceCode(): { deviceCode: string; userCode: string } {
  return {
    deviceCode: generateId(),
    userCode: Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => b.toString(36)).join("").slice(0, 8).toUpperCase(),
  };
}

export async function generateAPIToken(): Promise<{ token: string; hash: string }> {
  const token = `ctx_${generateId()}${generateId()}`;
  const hash = await hashToken(token);
  return { token, hash };
}

// SHA-256 is appropriate here: tokens have ~244 bits of entropy (two UUIDs),
// making rainbow tables and brute-force infeasible. Salting only helps for
// low-entropy inputs (passwords). GitHub/npm/PyPI use the same approach.
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
