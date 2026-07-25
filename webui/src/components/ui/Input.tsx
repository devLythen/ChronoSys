import { cn } from "../../lib/utils";
import { type InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, className, id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-xs font-medium text-muted-fg uppercase tracking-wide">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            "px-3 py-1.5 text-sm border rounded-sm bg-card text-fg placeholder:text-muted-fg/60 transition-colors duration-150",
            "focus:outline-none focus:ring-1 focus:ring-fg",
            error ? "border-destructive" : "border-border",
            className,
          )}
          {...props}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        {hint && !error && <p className="text-xs text-muted-fg">{hint}</p>}
      </div>
    );
  },
);

Input.displayName = "Input";
export default Input;
