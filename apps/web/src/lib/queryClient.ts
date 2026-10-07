import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
    mutations: {
      // Refresh-style mutations must not be retried blindly; the caller checks
      // for an active run first when the network outcome is uncertain.
      retry: 0,
    },
  },
});
