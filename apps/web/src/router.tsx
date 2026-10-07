import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import { queryClient } from "./lib/queryClient.ts";

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
