import { NavLink, Outlet } from "react-router-dom";
import { useState } from "react";
import { PanelLeftClose, PanelLeft, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

interface NavItem {
  to?: string;
  label: string;
  children?: NavItem[];
}

const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { to: "/overview", label: "Dashboard" },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/platforms", label: "Platforms" },
      { to: "/config", label: "Config" },
      { to: "/providers", label: "Providers" },
      { to: "/persona", label: "Persona" },
    ],
  },
  {
    label: "Plugins",
    items: [
      { to: "/plugins/extensions", label: "Extensions" },
      { to: "/plugins/mcp", label: "MCP" },
      { to: "/plugins/skills", label: "Skills" },
    ],
  },
  {
    label: "Observability",
    items: [
      { to: "/sessions", label: "Sessions" },
      { to: "/audit", label: "Audit" },
      { to: "/settings", label: "Settings" },
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

  if (collapsed) {
    return (
      <div className="mt-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-center py-2 text-muted-fg hover:text-fg hover:bg-muted transition-colors"
          title={label}
        >
          <span className="text-[10px] font-bold uppercase">{label[0]}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-1.5 text-[11px] font-semibold text-muted-fg uppercase tracking-wider hover:text-fg transition-colors"
      >
        {label}
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded && (
        <div className="mt-0.5">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to!}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 pl-6 pr-4 py-1.5 text-[13px] transition-colors duration-150",
                  isActive
                    ? "bg-fg text-bg font-medium"
                    : "text-muted-fg hover:text-fg hover:bg-muted",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Shell() {
  const [collapsed, setCollapsed] = useState(false);

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
            "flex items-center h-12 border-b border-border shrink-0",
            collapsed ? "justify-center px-2" : "px-5",
          )}
        >
          {!collapsed && (
            <NavLink to="/overview" className="text-[15px] font-bold tracking-tight select-none">
              ChronoSys
            </NavLink>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
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

        {/* Footer */}
        <div className="border-t border-border px-4 py-3">
          <p className={cn("text-[10px] text-muted-fg", collapsed && "text-center")}>
            {collapsed ? "v0.1" : "ChronoSys v0.1"}
          </p>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0">
        <main className="max-w-6xl mx-auto px-4 md:px-6 py-6 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
