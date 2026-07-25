import { cn } from "../../lib/utils";
import { X, CheckCircle, AlertTriangle, XCircle, Info } from "lucide-react";
import { useEffect, useState, useCallback, createContext, useContext } from "react";
import { createPortal } from "react-dom";

type ToastType = "success" | "warning" | "error" | "info";

interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastCtx {
  add: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastCtx>({ add: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const iconMap: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  warning: AlertTriangle,
  error: XCircle,
  info: Info,
};

const colorMap: Record<ToastType, string> = {
  success: "border-green-200 bg-green-50 text-green-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  error: "border-red-200 bg-red-50 text-red-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const add = useCallback((type: ToastType, message: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ add }}>
      {children}
      {createPortal(
        <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 max-w-sm">
          {toasts.map((t) => {
            const Icon = iconMap[t.type];
            return (
              <div
                key={t.id}
                className={cn(
                  "flex items-start gap-2 px-3 py-2 border text-sm",
                  colorMap[t.type],
                  "animate-slide-up",
                )}
              >
                <Icon size={16} className="shrink-0 mt-0.5" />
                <span className="flex-1">{t.message}</span>
                <button onClick={() => remove(t.id)} className="shrink-0 p-0.5 hover:opacity-70">
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
