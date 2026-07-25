import { NavLink, Outlet } from "react-router-dom";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { cn } from "../lib/utils";

const NAV_ITEMS = [
  { to: "/overview", label: "Overview" },
  { to: "/platforms", label: "Platforms" },
  { to: "/config", label: "Config" },
  { to: "/providers", label: "Providers" },
  { to: "/persona", label: "Persona" },
  { to: "/sessions", label: "Sessions" },
  { to: "/audit", label: "Audit" },
  { to: "/settings", label: "Settings" },
];

export default function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-bg text-fg">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 bg-bg/95 backdrop-blur-sm border-b border-border">
        <div className="max-w-6xl mx-auto px-4 md:px-6">
          <div className="flex items-center justify-between h-12">
            <NavLink to="/overview" className="text-base font-bold tracking-tight select-none">
              ChronoSys
            </NavLink>

            <nav className="hidden md:flex items-center gap-0.5">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      "px-2.5 py-1 text-[13px] transition-colors duration-150",
                      isActive
                        ? "bg-fg text-bg font-medium"
                        : "text-muted-fg hover:text-fg hover:bg-muted",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>

            <button
              className="md:hidden p-1"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="Menu"
            >
              {menuOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>

        {menuOpen && (
          <nav className="md:hidden border-t border-border bg-bg">
            <div className="max-w-6xl mx-auto px-4 py-2 flex flex-col gap-0.5">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      "px-3 py-2 text-sm",
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
          </nav>
        )}
      </header>

      {/* Page Content — no overflow hidden to allow modals to escape */}
      <main className="max-w-6xl mx-auto px-4 md:px-6 py-6 md:py-8">
        <Outlet />
      </main>

      <footer className="border-t border-border mt-12">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-4 text-[11px] text-muted-fg">
          ChronoSys v0.1
        </div>
      </footer>
    </div>
  );
}
