import { cn } from "../../lib/utils";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export default function Toggle({ checked, onChange, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative w-8 h-5 rounded-full transition-colors duration-200",
        "focus:outline-none focus:ring-1 focus:ring-fg focus:ring-offset-1",
        checked ? "bg-fg" : "bg-border",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] left-0 w-3.5 h-3.5 rounded-full bg-white transition-transform duration-200 shadow-sm",
          checked ? "translate-x-[15px]" : "translate-x-[2px]"
        )}
      />
    </button>
  );
}
