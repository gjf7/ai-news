import { expect, test } from "vite-plus/test";
import { createSourceRegistry, registryKeys } from "../src/sources/registry.ts";

const registry = createSourceRegistry({ fetch: globalThis.fetch });

test("every source from the reference project is registered", () => {
  // The reference dashboard covers these; all must be present here too.
  const expected = [
    "google-news",
    "reddit",
    "hacker-news",
    "arxiv",
    "techcrunch",
    "the-verge",
    "mit-tech-review",
    "huggingface",
    "lobsters",
    "product-hunt",
    "semi-engineering",
    "ee-times",
    "semiwiki",
    "ieee-spectrum",
    "ft",
    "wsj",
    "economist",
    "bloomberg",
  ];
  expect(registryKeys({ fetch: globalThis.fetch }).sort()).toEqual(expected.sort());
});

test("source keys are unique", () => {
  const keys = registry.map((source) => source.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("adapter keys match their registry key", () => {
  for (const source of registry) {
    expect(source.adapter.key, source.key).toBe(source.key);
  }
});

test("only arXiv opts out of insight generation", () => {
  const noInsights = registry.filter((source) => !source.analyze).map((source) => source.key);
  expect(noInsights).toEqual(["arxiv"]);
});

test("Product Hunt is the only source requiring a credential", () => {
  const requiring = registry.filter((source) => source.requires).map((source) => source.key);
  expect(requiring).toEqual(["product-hunt"]);
});

test("Product Hunt is registered even without a token, so it can be explained", () => {
  const withoutToken = createSourceRegistry({
    fetch: globalThis.fetch,
    productHuntToken: undefined,
  });
  expect(withoutToken.some((source) => source.key === "product-hunt")).toBe(true);
});
