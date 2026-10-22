import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePageEnter } from "../hooks/useAnimations";
import { useAuthStore } from "../store";
import { api } from "../api/client";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Card from "../components/ui/Card";
import Toggle from "../components/ui/Toggle";
import { useToast } from "../components/ui/Toast";

type SandboxForm = {
  enabled: boolean;
  image: string;
  network: boolean;
  timeout_ms: number;
  memory_mb: number;
  cpus: number;
  pids_limit: number;
  idle_secs: number;
};

const SANDBOX_DEFAULTS: SandboxForm = {
  enabled: false,
  image: "",
  network: false,
  timeout_ms: 30000,
  memory_mb: 512,
  cpus: 1,
  pids_limit: 256,
  idle_secs: 300,
};

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function ServerSettingsSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.listSettings(),
  });
  const [form, setForm] = useState<SandboxForm>(SANDBOX_DEFAULTS);

  useEffect(() => {
    if (!settings) return;
    const values: Record<string, unknown> = Object.fromEntries(
      settings.map((setting) => [setting.key, setting.value_json]),
    );
    setForm({
      enabled: values["sandbox.enabled"] === true,
      image: typeof values["sandbox.image"] === "string" ? String(values["sandbox.image"]) : "",
      network: values["sandbox.network"] === true,
      timeout_ms: numberValue(values["sandbox.timeout_ms"], SANDBOX_DEFAULTS.timeout_ms),
      memory_mb: numberValue(values["sandbox.memory_mb"], SANDBOX_DEFAULTS.memory_mb),
      cpus: numberValue(values["sandbox.cpus"], SANDBOX_DEFAULTS.cpus),
      pids_limit: numberValue(values["sandbox.pids_limit"], SANDBOX_DEFAULTS.pids_limit),
      idle_secs: numberValue(values["sandbox.idle_secs"], SANDBOX_DEFAULTS.idle_secs),
    });
  }, [settings]);

  const save = useMutation({
    mutationFn: async (value: SandboxForm) => {
      const entries: Array<[string, unknown]> = [
        ["sandbox.enabled", value.enabled],
        ["sandbox.image", value.image.trim()],
        ["sandbox.network", value.network],
        ["sandbox.timeout_ms", value.timeout_ms],
        ["sandbox.memory_mb", value.memory_mb],
        ["sandbox.cpus", value.cpus],
        ["sandbox.pids_limit", value.pids_limit],
        ["sandbox.idle_secs", value.idle_secs],
      ];
      for (const [key, entry] of entries) {
        await api.putSetting(key, entry);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.add("success", "Sandbox settings saved");
    },
    onError: (error: Error) => toast.add("error", error.message),
  });

  function update<K extends keyof SandboxForm>(key: K, value: SandboxForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="t-headline">Sandbox</h2>
        <p className="t-body text-muted-fg mt-1">
          Per-session Docker execution for the <code className="font-mono text-[11px]">sandbox_exec</code> tool.
          Disabled and image-less by default; network is off unless enabled.
        </p>
      </div>

      <Card>
        <div className="space-y-4">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm text-fg">Enable sandbox</span>
            <Toggle checked={form.enabled} onChange={(enabled) => update("enabled", enabled)} />
          </label>

          <Input
            label="Image"
            value={form.image}
            onChange={(e) => update("image", e.target.value)}
            placeholder="alpine:latest"
            hint="Container image with a POSIX shell. Pulled by Docker on first use."
          />

          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm text-fg">Allow outbound network</span>
            <Toggle checked={form.network} onChange={(network) => update("network", network)} />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Timeout (ms)" type="number" min={1} max={295000} value={form.timeout_ms}
              onChange={(e) => update("timeout_ms", numberValue(Number(e.target.value), 1))} />
            <Input label="Memory (MB)" type="number" value={form.memory_mb}
              onChange={(e) => update("memory_mb", numberValue(Number(e.target.value), 16))} />
            <Input label="CPUs" type="number" step="0.1" value={form.cpus}
              onChange={(e) => update("cpus", numberValue(Number(e.target.value), 0.1))} />
            <Input label="PID limit" type="number" value={form.pids_limit}
              onChange={(e) => update("pids_limit", numberValue(Number(e.target.value), 16))} />
            <Input label="Idle timeout (s)" type="number" value={form.idle_secs}
              onChange={(e) => update("idle_secs", numberValue(Number(e.target.value), 0))} />
          </div>

          <div className="rule-thin" />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-fg">
              {isLoading ? "Loading server settings…" : "Saved as explicit server settings rows."}
            </p>
            <Button onClick={() => save.mutate(form)} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save sandbox settings"}
            </Button>
          </div>
        </div>
      </Card>
    </section>
  );
}

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

      <ServerSettingsSection />

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
