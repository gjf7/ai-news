import { expect, test } from "vite-plus/test";
import { hashPassword, hashSessionToken, verifyPassword } from "../src/api/auth/password.ts";

test("password hash verifies the original password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  expect(hash.startsWith("scrypt$")).toBe(true);
  expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
});

test("password hash rejects a wrong password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  expect(await verifyPassword("wrong password", hash)).toBe(false);
});

test("a malformed stored hash never verifies", async () => {
  expect(await verifyPassword("anything", "not-a-valid-hash")).toBe(false);
});

test("session tokens hash deterministically and do not leak the token", () => {
  const token = "opaque-token";
  const digest = hashSessionToken(token);
  expect(digest).toBe(hashSessionToken(token));
  expect(digest).not.toContain(token);
});
