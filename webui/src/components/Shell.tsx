import { NavLink, Outlet } from "react-router-dom";
import { useState } from "react";
import { PanelLeftClose, PanelLeft, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

interface NavItem {
  to?: string;
  label: string;
  children?: NavItem[];
}

const NAV_SECTIONS: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: "/overview", label: "Overview" },
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
}: {
  label?: string;
  items: NavItem[];
  collapsed: boolean;
}) {
  return (
    <div className={cn(label && "mt-4")}>
      {label && !collapsed && (
        <p className="px-3 mb-1 text-[10px] font-semibold text-muted-fg uppercase tracking-widest">
          {label}
        </p>
      )}
      {items.map((item) => {
        if (item.children) {
          return (
            <SidebarGroup
              key={item.label}
              item={item}
              collapsed={collapsed}
            />
          );
        }
        return (
          <NavLink
            key={item.to}
            to={item.to!}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 px-3 py-2 text-[13px] transition-colors duration-150",
                isActive
                  ? "bg-fg text-bg font-medium"
                  : "text-muted-fg hover:text-fg hover:bg-muted",
                collapsed && "justify-center px-2",
              )
            }
          >
            {collapsed ? (
              <span className="text-xs font-bold">{item.label[0]}</span>
            ) : (
              item.label
            )}
          </NavLink>
        );
      })}
    </div>
  );
}

function SidebarGroup({
  item,
  collapsed,
}: {
  item: NavItem;
  collapsed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (collapsed) {
    return (
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-center px-2 py-2 text-[13px] text-muted-fg hover:text-fg hover:bg-muted transition-colors"
        title={item.label}
      >
        <ChevronRight size={14} />
      </button>
    );
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-[13px] text-muted-fg hover:text-fg hover:bg-muted transition-colors"
      >
        <span>{item.label}</span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <div className="ml-3 border-l border-border">
          {item.children!.map((child) => (
            <NavLink
              key={child.to}
              to={child.to!}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 pl-6 pr-3 py-1.5 text-[12px] transition-colors duration-150",
                  isActive
                    ? "bg-fg text-bg font-medium"
                    : "text-muted-fg hover:text-fg hover:bg-muted",
                )
              }
            >
              {child.label}
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
          collapsed ? "w-12" : "w-48",
        )}
      >
        <div
          className={cn(
            "flex items-center h-12 border-b border-border shrink-0",
            collapsed ? "justify-center px-2" : "px-4",
          )}
        >
          {!collapsed && (
            <NavLink to="/overview" className="text-base font-bold tracking-tight select-none">
              ChronoSys
            </NavLink>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={cn(
              "p-1 text-muted-fg hover:text-fg transition-colors",
              collapsed ? "" : "ml-auto",
            )}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-2">
          {NAV_SECTIONS.map((section, i) => (
            <SidebarSection
              key={i}
              label={section.label}
              items={section.items}
              collapsed={collapsed}
            />
          ))}
        </nav>

        <div className="border-t border-border px-3 py-3">
          <p className={cn("text-[10px] text-muted-fg", collapsed && "text-center")}>
            {collapsed ? "v0.1" : "ChronoSys v0.1"}
          </p>
        </div>
      </aside>

      <div className="flex-1 min-w-0">
        <main className="max-w-6xl mx-auto px-4 md:px-6 py-6 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
