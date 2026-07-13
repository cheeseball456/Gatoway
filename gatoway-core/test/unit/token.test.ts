import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateToken, tokensMatch, writeTokenFile } from "../../src/auth/token.js";

describe("token", () => {
  it("generates a 64-character hex token (32 random bytes)", () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a different token on each call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });

  it("matches a token presented back exactly", () => {
    const token = generateToken();
    expect(tokensMatch(token, token)).toBe(true);
  });

  it("rejects a mismatched, missing, or non-string token", () => {
    const token = generateToken();
    expect(tokensMatch(token, `${token}x`)).toBe(false);
    expect(tokensMatch(token, "wrong")).toBe(false);
    expect(tokensMatch(token, undefined)).toBe(false);
    expect(tokensMatch(token, 12345)).toBe(false);
  });

  describe("writeTokenFile", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "gatoway-token-test-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("creates parent directories and writes the token", async () => {
      const filePath = join(dir, "nested", "auth-token");
      const token = generateToken();
      await writeTokenFile(filePath, token);
      const contents = await readFile(filePath, "utf8");
      expect(contents).toBe(token);
    });

    it("restricts the file to owner-only access on POSIX platforms", async () => {
      if (process.platform === "win32") {
        return;
      }
      const filePath = join(dir, "auth-token");
      await writeTokenFile(filePath, generateToken());
      const info = await stat(filePath);
      expect(info.mode & 0o777).toBe(0o600);
    });

    it("overwrites a previous token", async () => {
      const filePath = join(dir, "auth-token");
      await writeTokenFile(filePath, "first-token");
      await writeTokenFile(filePath, "second-token");
      const contents = await readFile(filePath, "utf8");
      expect(contents).toBe("second-token");
    });
  });
});
