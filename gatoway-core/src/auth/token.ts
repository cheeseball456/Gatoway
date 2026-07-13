import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

/** Generates a fresh, crypto-random shared-secret token (design.md D5: 32 bytes). */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Writes the current auth token to a local file restricted to the owning user, creating
 * parent directories as needed and overwriting any previous token (design.md D5,
 * tasks.md 4.2).
 *
 * On POSIX platforms this sets file mode 0600. Windows has no POSIX mode bits, so an
 * equivalent restriction is applied via `icacls`, granting access only to the current
 * user and stripping inherited permissions. The `icacls` step is best-effort: if it
 * fails (e.g. `icacls` unavailable in a minimal environment), the error is thrown so
 * the caller can log it, since silently accepting a world-readable token file would
 * undermine NFR 3.3.
 */
export async function writeTokenFile(filePath: string, token: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, token, { encoding: "utf8", mode: 0o600 });

  if (process.platform === "win32") {
    await restrictToOwnerOnWindows(filePath);
  } else {
    await chmod(filePath, 0o600);
  }
}

async function restrictToOwnerOnWindows(filePath: string): Promise<void> {
  const username = process.env.USERNAME ?? os.userInfo().username;
  await execFileAsync("icacls", [
    filePath,
    "/inheritance:r",
    "/grant:r",
    `${username}:F`,
  ]);
}

/**
 * Constant-time comparison between the current token and a value presented by a
 * connecting plugin, to avoid leaking timing information about the token's contents.
 */
export function tokensMatch(expectedToken: string, presentedToken: unknown): boolean {
  if (typeof presentedToken !== "string") {
    return false;
  }
  const expectedBuffer = Buffer.from(expectedToken, "utf8");
  const presentedBuffer = Buffer.from(presentedToken, "utf8");
  if (expectedBuffer.length !== presentedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, presentedBuffer);
}
