import { useState } from "react";
import { usePageEnter } from "../hooks/useAnimations";
import { useAuthStore } from "../store";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Card from "../components/ui/Card";
import { useToast } from "../components/ui/Toast";

export default function SettingsPage() {
  const token = useAuthStore((s) => s.token);
  const setToken = useAuthStore((s) => s.setToken);
  const toast = useToast();

  const pageRef = usePageEnter<HTMLDivElement>();

  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);

  function handleSetToken() {
    const t = tokenInput.trim();
    if (!t) return;
    setToken(t);
    setTokenInput("");
    toast.add("success", "Auth token saved");
  }

  function handleClearToken() {
    setToken(null);
    toast.add("info", "Auth token removed");
  }

  return (
    <div ref={pageRef} className="space-y-6 md:space-y-8">
      {/* Page header — typographic */}
      <div>
        <h1 className="t-display">Settings</h1>
        <p className="t-body text-muted-fg mt-3 max-w-lg">
          Manage your ChronoSys instance configuration and authentication.
        </p>
      </div>

      <div className="rule-heavy" />

      {/* Auth Token */}
      <section className="space-y-6">
        <div>
          <h2 className="t-headline">Authentication</h2>
          <p className="t-body text-muted-fg mt-1">
            API token for accessing the ChronoSys gateway. Required when binding to non-localhost addresses.
          </p>
        </div>

        <Card>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="t-label text-muted-fg">Status</p>
                <p className="text-sm mt-0.5">
                  {token ? (
                    <span className="text-success font-medium">Token configured</span>
                  ) : (
                    <span className="text-muted-fg">No token set</span>
                  )}
                </p>
              </div>
              {token && (
                <Button variant="ghost" size="sm" onClick={handleClearToken}>
                  Clear
                </Button>
              )}
            </div>

            {token && (
              <div>
                <p className="t-label text-muted-fg mb-1">Current token</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono bg-muted px-2 py-1 select-all">
                    {showToken ? token : token.slice(0, 8) + "••••••••"}
                  </code>
                  <button
                    onClick={() => setShowToken(!showToken)}
                    className="text-xs text-muted-fg hover:text-fg transition-colors"
                  >
                    {showToken ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
            )}

            <div className="rule-thin" />

            <div>
              <p className="t-label text-muted-fg mb-2">
                {token ? "Update token" : "Set token"}
              </p>
              <form
                onSubmit={(e) => { e.preventDefault(); handleSetToken(); }}
                className="flex gap-2"
              >
                <Input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Enter auth token"
                  className="flex-1"
                />
                <Button type="submit" disabled={!tokenInput.trim()}>
                  {token ? "Update" : "Set"}
                </Button>
              </form>
              <p className="text-xs text-muted-fg mt-1.5">
                Tokens are stored in browser local storage. Set <code className="font-mono text-[11px]">CHRONO_AUTH_TOKEN</code> on the server.
              </p>
            </div>
          </div>
        </Card>
      </section>

      {/* Decorative halftone block */}
      <div className="halftone h-8" />

      {/* Instance Info */}
      <section className="space-y-6">
        <div>
          <h2 className="t-headline">About</h2>
        </div>
        <Card>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="t-label text-muted-fg">Version</p>
              <p>0.1.0</p>
            </div>
            <div>
              <p className="t-label text-muted-fg">Gateway</p>
              <p className="font-mono text-xs">127.0.0.1:8787</p>
            </div>
            <div>
              <p className="t-label text-muted-fg">Stack</p>
              <p>React 19 + Vite + Tailwind</p>
            </div>
            <div>
              <p className="t-label text-muted-fg">Design</p>
              <p>Swiss Modernism</p>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
