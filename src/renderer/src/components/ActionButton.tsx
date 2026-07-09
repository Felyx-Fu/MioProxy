import type { ButtonHTMLAttributes, ReactNode } from "react";

export function ActionButton({
  children,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: "primary" | "secondary";
}) {
  return (
    <button type="button" className={`action-button ${variant}`} {...props}>
      {children}
    </button>
  );
}
