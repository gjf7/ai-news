import { expect, test } from "vite-plus/test";
import { chatCompletionsUrl } from "../src/insights/model.ts";

test("appends /v1 when the base has no version segment", () => {
  expect(chatCompletionsUrl("https://api.deepseek.com")).toBe(
    "https://api.deepseek.com/v1/chat/completions",
  );
});

test("does not double the version when the base already ends in /v1", () => {
  // A base URL that already carries the version is common in the wild; adding
  // another /v1 produced a 404 against the real endpoint.
  expect(chatCompletionsUrl("https://api.example.com/v1")).toBe(
    "https://api.example.com/v1/chat/completions",
  );
});

test("tolerates trailing slashes", () => {
  expect(chatCompletionsUrl("https://api.example.com/")).toBe(
    "https://api.example.com/v1/chat/completions",
  );
  expect(chatCompletionsUrl("https://api.example.com/v1/")).toBe(
    "https://api.example.com/v1/chat/completions",
  );
});
