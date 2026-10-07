import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-neutral-200 bg-white p-5 ${className}`}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "warn" | "muted";
}) {
  const tones = {
    neutral: "bg-neutral-100 text-neutral-700",
    accent: "bg-blue-50 text-blue-700",
    warn: "bg-amber-50 text-amber-700",
    muted: "bg-neutral-50 text-neutral-400",
  };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost";
  type?: "button" | "submit";
}) {
  const styles =
    variant === "primary"
      ? "bg-neutral-900 text-white hover:bg-neutral-700"
      : "border border-neutral-300 text-neutral-700 hover:bg-neutral-50";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

export function Spinner({ label }: { label: string }) {
  return <p className="py-8 text-center text-sm text-neutral-400">{label}</p>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-16 text-center">
      <p className="text-sm font-medium text-neutral-900">{title}</p>
      {hint ? <p className="mt-1 text-sm text-neutral-500">{hint}</p> : null}
    </div>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </div>
  );
}
