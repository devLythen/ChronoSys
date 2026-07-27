import { cn } from "../../lib/utils";
import { type ReactNode, useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import gsap from "gsap";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}

const sizeClasses = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" };

export default function Modal({ open, onClose, title, children, className, size = "md" }: ModalProps) {
  const [visible, setVisible] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setVisible(true);
    } else if (panelRef.current && overlayRef.current) {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.to(panelRef.current, { opacity: 0, scale: 0.97, duration: 0.15, ease: "power2.in" });
        gsap.to(overlayRef.current, { backgroundColor: "rgba(0,0,0,0)", duration: 0.15, ease: "power2.in", onComplete: () => setVisible(false) });
      });
      mm.add("(prefers-reduced-motion: reduce)", () => {
        setVisible(false);
      });
      return () => mm.revert();
    }
  }, [open]);

  useEffect(() => {
    if (!visible || !panelRef.current || !overlayRef.current) return;

    const panel = panelRef.current;
    const overlay = overlayRef.current;

    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(panel, { opacity: 0, scale: 0.97 }, { opacity: 1, scale: 1, duration: 0.2, ease: "power2.out" });
      gsap.fromTo(overlay, { backgroundColor: "rgba(0,0,0,0)" }, { backgroundColor: "rgba(0,0,0,0.4)", duration: 0.2, ease: "power2.out" });
    });
    mm.add("(prefers-reduced-motion: reduce)", () => {
      gsap.set(panel, { opacity: 1, scale: 1 });
      gsap.set(overlay, { backgroundColor: "rgba(0,0,0,0.4)" });
    });

    return () => mm.revert();
  }, [visible]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); },
    [onClose],
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
      return () => {
        document.removeEventListener("keydown", handleKeyDown);
        document.body.style.overflow = "";
      };
    }
  }, [open, handleKeyDown]);

  if (!visible) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={cn(
          "w-full bg-card border border-border shadow-lg",
          sizeClasses[size],
          className,
        )}
      >
        {title && (
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
            <button onClick={onClose} className="p-1 hover:bg-muted transition-colors" aria-label="Close">
              <X size={16} />
            </button>
          </div>
        )}
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
