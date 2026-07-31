import { NavLink, Outlet } from "react-router-dom";
import { useState, useRef, useLayoutEffect, useEffect } from "react";
import {
  PanelLeftClose, PanelLeft, ChevronRight,
  LayoutDashboard, Globe, Sliders, Server, User,
  Puzzle, Plug, Wrench, MessageSquare, ScrollText, Cog,
} from "lucide-react";
import { loadGsap } from "../lib/motion";
import { cn } from "../lib/utils";
import { RealtimeSync } from "../hooks/useRealtimeSync";

interface NavItem {
  to?: string;
  label: string;
  icon: React.ReactNode;
  children?: NavItem[];
}

const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { to: "/overview", label: "Dashboard", icon: <LayoutDashboard size={16} /> },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/platforms", label: "Platforms", icon: <Globe size={16} /> },
      { to: "/config", label: "Config", icon: <Sliders size={16} /> },
      { to: "/providers", label: "Providers", icon: <Server size={16} /> },
      { to: "/persona", label: "Persona", icon: <User size={16} /> },
    ],
  },
  {
    label: "Plugins",
    items: [
      { to: "/plugins/extensions", label: "Extensions", icon: <Puzzle size={16} /> },
      { to: "/plugins/mcp", label: "MCP", icon: <Plug size={16} /> },
      { to: "/plugins/skills", label: "Skills", icon: <Wrench size={16} /> },
    ],
  },
  {
    label: "Observability",
    items: [
      { to: "/sessions", label: "Sessions", icon: <MessageSquare size={16} /> },
      { to: "/audit", label: "Audit", icon: <ScrollText size={16} /> },
      { to: "/settings", label: "Settings", icon: <Cog size={16} /> },
    ],
  },
];

function SidebarSection({
  label,
  items,
  collapsed,
  defaultExpanded,
}: {
  label: string;
  items: NavItem[];
  collapsed: boolean;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? true);
  const contentRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let disposed = false;
    let revert: (() => void) | undefined;

    void loadGsap().then((gsap) => {
      if (disposed) return;
      const mm = gsap.matchMedia();
      const targetHeight = content.scrollHeight;
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        if (expanded) {
          gsap.fromTo(content, { height: 0, opacity: 0 }, { height: targetHeight, opacity: 1, duration: 0.2, ease: "power2.out", clearProps: "height" });
        } else {
          gsap.fromTo(content, { height: targetHeight, opacity: 1 }, { height: 0, opacity: 0, duration: 0.15, ease: "power2.in" });
        }
      });
      mm.add("(prefers-reduced-motion: reduce)", () => {
        gsap.set(content, { height: expanded ? "auto" : 0, opacity: expanded ? 1 : 0, clearProps: expanded ? "height" : undefined as unknown as string });
      });
      revert = () => mm.revert();
    });

    return () => {
      disposed = true;
      revert?.();
    };
  }, [expanded]);

  const labelEl = collapsed ? (
    <span className="text-[10px] font-bold uppercase">{label[0]}</span>
  ) : (
    <>
      {label}
      <ChevronRight size={12} className={cn("transition-transform", expanded && "rotate-90")} />
    </>
  );

  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "w-full flex items-center transition-colors",
          collapsed
            ? "justify-center py-2 text-muted-fg hover:text-fg hover:bg-muted"
            : "justify-between px-4 py-1.5 text-[11px] font-semibold text-muted-fg uppercase tracking-wider hover:text-fg",
        )}
        title={label}
      >
        {labelEl}
      </button>
      <div ref={contentRef} className="overflow-hidden" style={{ height: 0, opacity: 0 }}>
        <div className={cn("mt-0.5", collapsed && "flex flex-col items-center")}>
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to!}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 transition-colors duration-150",
                  collapsed
                    ? "justify-center w-8 h-8 my-0.5 text-[13px]"
                    : "pl-6 pr-4 py-1.5 text-[13px]",
                  isActive
                    ? collapsed
                      ? "bg-fg text-bg font-medium rounded-sm"
                      : "bg-fg text-bg font-medium"
                    : collapsed
                      ? "text-muted-fg hover:text-fg hover:bg-muted rounded-sm"
                      : "text-muted-fg hover:text-fg hover:bg-muted",
                )
              }
              title={collapsed ? item.label : undefined}
            >
              {item.icon}
              {!collapsed && item.label}
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  );
}
export default function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  const [manualOverride, setManualOverride] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const sync = () => {
      if (!manualOverride) setCollapsed(mq.matches);
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [manualOverride]);

  const toggleCollapsed = () => {
    setManualOverride(true);
    setCollapsed(!collapsed);
  };
  return (
    <div className="min-h-screen bg-bg text-fg flex">
      <aside
        className={cn(
          "sticky top-0 h-screen flex flex-col border-r border-border bg-bg/95 backdrop-blur-sm transition-all duration-200 z-30",
          collapsed ? "w-12" : "w-56",
        )}
      >
        {/* Branding */}
        <div
          className={cn(
            "flex items-center h-12 border-b border-border shrink-0 gap-2",
            collapsed ? "justify-center px-2" : "px-5",
          )}
        >
          {!collapsed && (
            <NavLink to="/overview" className="text-[15px] font-bold tracking-tight select-none shrink-0">
              ChronoSys
            </NavLink>
          )}
          {!collapsed && (
            <span className="text-[10px] text-muted-fg mt-0.5">v0.1</span>
          )}
          <button
            onClick={toggleCollapsed}
            className={cn(
              "p-1 text-muted-fg hover:text-fg transition-colors shrink-0",
              collapsed ? "" : "ml-auto",
            )}
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-3">
          {NAV_SECTIONS.map((section, i) => (
            <SidebarSection
              key={i}
              label={section.label}
              items={section.items}
              collapsed={collapsed}
            />
          ))}
        </nav>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0">
        <main className="max-w-6xl mx-auto px-4 md:px-6 py-6 md:py-8">
          <RealtimeSync />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
