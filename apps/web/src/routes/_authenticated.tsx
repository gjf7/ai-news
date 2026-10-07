import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppLayout } from "../components/layout/AppLayout.tsx";
import { sessionQueryOptions } from "../api/session.ts";

/**
 * Authenticated shell. The session check runs before the children render, so
 * an unauthenticated visitor is redirected to /login without a flash of
 * protected content.
 */
export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions);
    if (!session.authenticated) {
      throw redirect({ to: "/login" });
    }
  },
  component: () => (
    <AppLayout>
      <Outlet />
    </AppLayout>
  ),
});
