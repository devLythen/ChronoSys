import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";

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
  const [cached, setCached] = useState<{ title: string; message: string } | null>(null);
  if (open && (!cached || cached.title !== title || cached.message !== message)) {
    setCached({ title, message });
  }
  const display = cached ?? { title, message };

  return (
    <Modal open={open} onClose={onCancel} size="sm">
      <div className="flex items-start gap-3 mb-4">
        {variant === "destructive" && (
          <AlertTriangle size={18} className="text-destructive shrink-0 mt-0.5" />
        )}
        <div>
          <h3 className="t-title font-medium">{display.title}</h3>
          <p className="text-sm text-muted-fg mt-1">{display.message}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          variant={variant === "destructive" ? "destructive" : "primary"}
          size="sm"
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
