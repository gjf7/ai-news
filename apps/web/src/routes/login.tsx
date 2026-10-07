import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useLogin } from "../hooks/useSession.ts";
import { HttpError } from "../lib/http.ts";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const [password, setPassword] = useState("");
  const login = useLogin();
  const navigate = useNavigate();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await login.mutateAsync(password);
      await navigate({ to: "/" });
    } catch {
      // The message is rendered from login.error below.
    }
  };

  const message =
    login.error instanceof HttpError
      ? login.error.status === 429
        ? "尝试次数过多，请稍后再试"
        : "密码不正确"
      : null;

  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6"
      >
        <h1 className="text-base font-semibold">登录</h1>
        <p className="mt-1 text-sm text-neutral-500">AI 与半导体情报站</p>

        <label className="mt-6 block text-sm font-medium" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-2 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
        />

        {message ? <p className="mt-2 text-sm text-red-600">{message}</p> : null}

        <button
          type="submit"
          disabled={login.isPending || password.length === 0}
          className="mt-4 w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {login.isPending ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
