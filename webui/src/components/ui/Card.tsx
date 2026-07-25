import { cn } from "../../lib/utils";
import { type ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: "none" | "sm" | "md";
  onClick?: () => void;
}

export default function Card({ children, className, padding = "md", onClick }: CardProps) {
  const pad = { none: "", sm: "p-3", md: "p-4" }[padding];
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      className={cn("bg-card border border-border rounded-sm text-left w-full", pad, className)}
      onClick={onClick}
      type={onClick ? "button" : undefined}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between pb-3 mb-3 border-b border-border", className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold tracking-tight">{children}</h3>;
}
