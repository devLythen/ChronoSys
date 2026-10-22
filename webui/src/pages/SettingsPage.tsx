import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePageEnter } from "../hooks/useAnimations";
import { api } from "../api/client";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import Card from "../components/ui/Card";
import Toggle from "../components/ui/Toggle";
import { useToast } from "../components/ui/Toast";

type SandboxForm = {
  enabled: boolean;
  image: string;
  network: boolean;
  browser: "none" | "playwright";
  browser_node: string;
  browser_playwright_path: string;
  browser_browsers_path: string;
  timeout_ms: number;
  memory_mb: number;
  cpus: number;
  pids_limit: number;
  idle_secs: number;
  max_lifetime_secs: number;
  destroy_on_new: boolean;
};

const SANDBOX_DEFAULTS: SandboxForm = {
  enabled: false,
  image: "",
  network: false,
  browser: "none",
  browser_node: "node",
  browser_playwright_path: "/opt/chrono/node_modules/playwright",
  browser_browsers_path: "/ms-playwright",
  timeout_ms: 30000,
  memory_mb: 512,
  cpus: 1,
  pids_limit: 256,
  idle_secs: 300,
  max_lifetime_secs: 0,
  destroy_on_new: true,
};

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function ServerAccessSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.listSettings(),
  });
  const [publicUrl, setPublicUrl] = useState("");

  useEffect(() => {
    if (!settings) return;
    const value = settings.find((setting) => setting.key === "server.public_url")?.value_json;
    setPublicUrl(typeof value === "string" ? value : "");
  }, [settings]);

  const save = useMutation({
    mutationFn: () => api.putSetting("server.public_url", publicUrl.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.add("success", "Server public URL saved; restart gateway to apply");
    },
    onError: (error: Error) => toast.add("error", error.message),
  });

  return (
    <section className="space-y-6">
      <div>
        <h2 className="t-headline">Server access</h2>
        <p className="t-body text-muted-fg mt-1">
          Bind address is set at startup with <code className="font-mono text-[11px]">--host</code>.
          The public URL controls the startup banner and the browser CORS allow-list.
        </p>
      </div>
      <Card>
        <div className="space-y-4">
          <Input
            label="Public URL"
            value={publicUrl}
            onChange={(event) => setPublicUrl(event.target.value)}
            placeholder="https://chrono.example.com"
            hint="Use the URL users open in a browser, without /api. Applies after gateway restart."
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-fg">
              {isLoading
                ? "Loading server settings…"
                : "Empty keeps permissive CORS and shows the local bind address."}
            </p>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save public URL"}
            </Button>
          </div>
        </div>
      </Card>
    </section>
  );
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
      browser: values["sandbox.browser"] === "playwright" ? "playwright" : "none",
      browser_node:
        typeof values["sandbox.browser_node"] === "string"
          ? String(values["sandbox.browser_node"])
          : SANDBOX_DEFAULTS.browser_node,
      browser_playwright_path:
        typeof values["sandbox.browser_playwright_path"] === "string" &&
        String(values["sandbox.browser_playwright_path"]).trim()
          ? String(values["sandbox.browser_playwright_path"])
          : SANDBOX_DEFAULTS.browser_playwright_path,
      browser_browsers_path:
        typeof values["sandbox.browser_browsers_path"] === "string" &&
        String(values["sandbox.browser_browsers_path"]).trim()
          ? String(values["sandbox.browser_browsers_path"])
          : SANDBOX_DEFAULTS.browser_browsers_path,
      timeout_ms: numberValue(values["sandbox.timeout_ms"], SANDBOX_DEFAULTS.timeout_ms),
      memory_mb: numberValue(values["sandbox.memory_mb"], SANDBOX_DEFAULTS.memory_mb),
      cpus: numberValue(values["sandbox.cpus"], SANDBOX_DEFAULTS.cpus),
      pids_limit: numberValue(values["sandbox.pids_limit"], SANDBOX_DEFAULTS.pids_limit),
      idle_secs: numberValue(values["sandbox.idle_secs"], SANDBOX_DEFAULTS.idle_secs),
      max_lifetime_secs: numberValue(
        values["sandbox.max_lifetime_secs"],
        SANDBOX_DEFAULTS.max_lifetime_secs,
      ),
      destroy_on_new:
        values["sandbox.destroy_on_new"] === undefined
          ? SANDBOX_DEFAULTS.destroy_on_new
          : values["sandbox.destroy_on_new"] === true,
    });
  }, [settings]);

  const save = useMutation({
    mutationFn: async (value: SandboxForm) => {
      const entries: Array<[string, unknown]> = [
        ["sandbox.enabled", value.enabled],
        ["sandbox.image", value.image.trim()],
        ["sandbox.network", value.network],
        ["sandbox.browser", value.browser],
        ["sandbox.browser_node", value.browser_node.trim() || "node"],
        [
          "sandbox.browser_playwright_path",
          value.browser_playwright_path.trim() || SANDBOX_DEFAULTS.browser_playwright_path,
        ],
        [
          "sandbox.browser_browsers_path",
          value.browser_browsers_path.trim() || SANDBOX_DEFAULTS.browser_browsers_path,
        ],
        ["sandbox.timeout_ms", value.timeout_ms],
        ["sandbox.memory_mb", value.memory_mb],
        ["sandbox.cpus", value.cpus],
        ["sandbox.pids_limit", value.pids_limit],
        ["sandbox.idle_secs", value.idle_secs],
        ["sandbox.max_lifetime_secs", value.max_lifetime_secs],
        ["sandbox.destroy_on_new", value.destroy_on_new],
      ];
      for (const [key, entry] of entries) {
        await api.putSetting(key, entry);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
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
          Per-session Docker execution for <code className="font-mono text-[11px]">sandbox_*</code> tools.
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

          <div className="space-y-1">
            <Select
              label="Browser capability"
              value={form.browser}
              onChange={(event) =>
                update("browser", event.target.value === "playwright" ? "playwright" : "none")
              }
              options={[
                { value: "none", label: "None" },
                { value: "playwright", label: "Playwright" },
              ]}
            />
            <p className="text-xs text-muted-fg">
              Playwright exposes <code className="font-mono text-[11px]">sandbox_browser</code>.
              The image must provide <code className="font-mono text-[11px]">node</code>, a
              resolvable Playwright package, and Chromium browser binaries; outbound
              network must also be enabled.
              Playwright usually needs a larger memory limit (e.g. 1–2 GB).
            </p>
            {form.browser === "playwright" ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                <Input
                  label="Node binary"
                  value={form.browser_node}
                  onChange={(event) => update("browser_node", event.target.value)}
                  placeholder="node"
                  hint="Absolute path or command inside the container."
                />
                <Input
                  label="Playwright module path"
                  value={form.browser_playwright_path}
                  onChange={(event) => update("browser_playwright_path", event.target.value)}
                  placeholder="/opt/chrono/node_modules/playwright"
                  hint="Prefilled for the recommended image; adjust if yours differs."
                />
                <Input
                  label="Browser binaries path"
                  value={form.browser_browsers_path}
                  onChange={(event) => update("browser_browsers_path", event.target.value)}
                  placeholder="/ms-playwright"
                  hint="Prefilled for the recommended image; sets PLAYWRIGHT_BROWSERS_PATH."
                />
              </div>
            ) : (
              <p className="text-xs text-muted-fg pt-1">
                Select Playwright to configure the Node binary and Playwright paths.
              </p>
            )}
          </div>

          <details className="border-t border-border pt-4">
            <summary className="cursor-pointer text-sm text-fg">Advanced limits</summary>
            <p className="text-xs text-muted-fg mt-2">
              Defaults are fine for most setups. Timeout limits one sandbox call.
              Idle timer destroys an unused container and its workspace; max lifetime
              is an absolute cap from container creation. 0 disables a timer.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
              <Input label="Timeout (ms)" type="number" min={1} max={295000} value={form.timeout_ms}
                onChange={(e) => update("timeout_ms", numberValue(Number(e.target.value), 1))}
                hint="Per sandbox call; hard cap 295000." />
              <Input label="Memory (MB)" type="number" value={form.memory_mb}
                onChange={(e) => update("memory_mb", numberValue(Number(e.target.value), 16))}
                hint="Docker memory cap. Playwright needs about 2 GB." />
              <Input label="CPUs" type="number" step="0.1" value={form.cpus}
                onChange={(e) => update("cpus", numberValue(Number(e.target.value), 0.1))}
                hint="Docker CPU quota." />
              <Input label="PID limit" type="number" value={form.pids_limit}
                onChange={(e) => update("pids_limit", numberValue(Number(e.target.value), 16))}
                hint="Process cap; protects against fork bombs." />
              <Input label="Idle timeout (s)" type="number" value={form.idle_secs}
                onChange={(e) => update("idle_secs", numberValue(Number(e.target.value), 0))}
                hint="Destroy after this long without sandbox use; 0 disables." />
              <Input label="Max lifetime (s, 0 = off)" type="number" value={form.max_lifetime_secs}
                onChange={(e) => update("max_lifetime_secs", numberValue(Number(e.target.value), 0))}
                hint="Absolute TTL from creation; 0 disables." />
            </div>
            <label className="mt-4 flex items-center justify-between cursor-pointer">
              <span className="text-sm text-fg">Destroy sandbox on /new</span>
              <Toggle checked={form.destroy_on_new} onChange={(value) => update("destroy_on_new", value)} />
            </label>
          </details>

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

function ChangePasswordSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: auth } = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api.authStatus(),
  });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const change = useMutation({
    mutationFn: () =>
      api.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setError("");
      queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      toast.add("success", "Password updated");
    },
    onError: (err: Error) => setError(err.message),
  });

  function submit() {
    setError("");
    if (newPassword.length < 8) return setError("New password must be at least 8 characters.");
    if (newPassword !== confirmPassword) return setError("Passwords do not match.");
    change.mutate();
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="t-headline">Authentication</h2>
        <p className="t-body text-muted-fg mt-1">
          Signed in as <span className="font-mono text-fg">{auth?.username ?? "unknown"}</span>.
          The admin password is stored as an Argon2 hash in the local config database.
        </p>
      </div>
      <Card>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="New password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              hint="At least 8 characters."
            />
            <Input
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={change.isPending || !currentPassword || !newPassword}
            >
              {change.isPending ? "Updating…" : "Change password"}
            </Button>
          </div>
        </form>
      </Card>
    </section>
  );
}

export default function SettingsPage() {
  const pageRef = usePageEnter<HTMLDivElement>();

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

      <ChangePasswordSection />

      <ServerAccessSection />
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
