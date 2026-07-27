import { useEffect, useState, useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import Button from "./Button";
import { cn } from "../../lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: "destructive" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  variant = "destructive",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [visible, setVisible] = useState(false);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (open) {
      setVisible(true);
      requestAnimationFrame(() => setAnimating(true));
    } else {
      setAnimating(false);
      const timer = setTimeout(() => setVisible(false), 200);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    },
    [onCancel],
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [open, handleKeyDown]);

  if (!visible) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[200] flex items-center justify-center transition-colors duration-200",
        animating ? "bg-black/40" : "bg-transparent",
      )}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "bg-card border border-border px-6 py-5 w-[380px] max-w-[90vw] shadow-lg transition-all duration-200",
          animating ? "opacity-100 scale-100" : "opacity-0 scale-95",
        )}
      >
        <div className="flex items-start gap-3 mb-4">
          {variant === "destructive" && (
            <AlertTriangle size={18} className="text-destructive shrink-0 mt-0.5" />
          )}
          <div>
            <h3 className="t-title font-medium">{title}</h3>
            <p className="text-sm text-muted-fg mt-1">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            size="sm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
