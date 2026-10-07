import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useLogout } from "../../hooks/useSession.ts";

export function AppLayout({ children }: { children: ReactNode }) {
  const logout = useLogout();
  const navigate = useNavigate();

  const signOut = async () => {
    await logout.mutateAsync();
    await navigate({ to: "/login" });
  };

  return (
    <div className="min-h-full">
      <header className="border-b border-neutral-200 bg-white">
        <nav className="mx-auto flex h-14 max-w-4xl items-center gap-6 px-4">
          <Link to="/" className="text-sm font-semibold tracking-tight">
            AI 与半导体情报站
          </Link>
          <Link
            to="/sources"
            className="text-sm text-neutral-500 hover:text-neutral-900"
            activeProps={{ className: "text-neutral-900" }}
          >
            来源
          </Link>
          <Link
            to="/activity"
            className="text-sm text-neutral-500 hover:text-neutral-900"
            activeProps={{ className: "text-neutral-900" }}
          >
            活动
          </Link>
          <button
            type="button"
            onClick={() => void signOut()}
            className="ml-auto text-sm text-neutral-400 hover:text-neutral-900"
          >
            退出
          </button>
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
    </div>
  );
}
