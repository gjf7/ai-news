import { hashPassword } from "../src/api/auth/password.ts";

const password = process.argv[2];
if (!password) {
  console.error("Usage: vp run server#hash-password -- <password>");
  process.exit(1);
}

const hash = await hashPassword(password);
console.log(`LOGIN_PASSWORD_HASH=${hash}`);
