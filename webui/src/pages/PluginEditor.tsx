import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { api } from "../api/client";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";
import Toggle from "../components/ui/Toggle";
import { useToast } from "../components/ui/Toast";
import { usePageEnter } from "../hooks/useAnimations";

function EntryRow({ name, label, description, prefix }: { name: string; label: string; description: string; prefix?: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border pb-3">
      <div className="flex items-center gap-2">
        <span className="t-mono text-sm">{prefix ?? ""}{name}</span>
        <span className="t-label text-muted-fg">{label}</span>
      </div>
      {description && <p className="text-xs text-muted-fg leading-relaxed">{description}</p>}
    </div>
  );
}

export default function PluginEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ["plugins"], queryFn: () => api.listPlugins() });
  const plugin = data?.plugins.find((item) => item.id === id);
  const pageRef = usePageEnter<HTMLDivElement>();

  const [configValues, setConfigValues] = useState<Record<string, string | boolean>>({});
  const configRef = useRef(configValues);
  configRef.current = configValues;
  useEffect(() => {
    if (plugin) {
      const initial: Record<string, string | boolean> = {};
      for (const [key, value] of Object.entries(plugin.policy.config)) { if (typeof value === "string" || typeof value === "boolean") initial[key] = value; }
      setConfigValues(initial);
    }
  }, [plugin?.id]);

  const policyMutation = useMutation({
    mutationFn: () => api.updatePluginPolicy(id!, { enabled: plugin!.policy.enabled, config: configRef.current, tools: plugin!.policy.tools }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["plugins"] }); toast.add("success", "Plugin config saved"); navigate("/plugins/extensions"); },
    onError: (error: Error) => toast.add("error", error.message),
  });

  if (isLoading) return <div className="animate-fade-in space-y-5 py-12"><div className="h-7 w-40 bg-muted animate-pulse" /><div className="h-48 bg-muted animate-pulse" /></div>;
  if (!plugin) return <div className="py-20 text-center"><p className="text-sm text-destructive">Plugin not found</p><Button variant="secondary" className="mt-4" onClick={() => navigate("/plugins/extensions")}>Back</Button></div>;

  const fields = plugin.configSchema ?? [];

  return (
    <div ref={pageRef} className="space-y-6 md:space-y-8">
      <Link to="/plugins/extensions" className="t-label text-muted-fg hover:text-fg inline-flex items-center gap-1">
        <ArrowLeft size={13} /> Extensions
      </Link>
      <div>
        <p className="t-label text-muted-fg">{plugin.id} · v{plugin.version}</p>
        <h1 className="t-display mt-1">{plugin.name}</h1>
        <p className="t-body text-muted-fg mt-3 max-w-2xl">{plugin.description}</p>
      </div>
      <div className="rule-heavy" />

      {!plugin.policy.enabled && (
        <p className="bg-muted/60 text-muted-fg text-sm px-4 py-3 border border-border">This plugin is disabled.</p>
      )}

      <Card className="space-y-4">
        <h2 className="t-headline !text-lg">Config</h2>
        {fields.length === 0 ? <p className="text-sm text-muted-fg">No configurable fields.</p> : fields.map((field) => (
          <div key={field.key} className="space-y-1.5">
            <label className="t-label">{field.label}</label>
            {field.description && <p className="text-xs text-muted-fg">{field.description}</p>}
            {field.type === "boolean" ? (
              <div className="flex items-center gap-3 pt-1">
                <Toggle checked={configValues[field.key] === true} onChange={(v) => setConfigValues((prev) => ({ ...prev, [field.key]: v }))} />
                <span className="text-sm text-muted-fg">{configValues[field.key] === true ? "Yes" : "No"}</span>
              </div>
            ) : (
              <Input value={String(configValues[field.key] ?? field.default ?? "")} onChange={(e) => setConfigValues((prev) => ({ ...prev, [field.key]: e.target.value }))} />
            )}
          </div>
        ))}
        {fields.length > 0 && (
          <div className="flex justify-end">
            <Button onClick={() => policyMutation.mutate()} disabled={policyMutation.isPending}>
              <Save size={15} /> Save config
            </Button>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="t-headline !text-lg">AI tools</h2>
            <span className="t-label text-muted-fg">{plugin.tools.length}</span>
          </div>
          {plugin.tools.length === 0
            ? <p className="text-sm text-muted-fg">No AI tools registered.</p>
            : plugin.tools.map((tool) => <EntryRow key={tool.name} name={tool.name} label={tool.label} description={tool.description} />)}
        </Card>

        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="t-headline !text-lg">User commands</h2>
            <span className="t-label text-muted-fg">{plugin.commands.length}</span>
          </div>
          {plugin.commands.length === 0
            ? <p className="text-sm text-muted-fg">No user commands registered.</p>
            : plugin.commands.map((cmd) => <EntryRow key={cmd.name} name={cmd.name} label={cmd.label} description={cmd.description} prefix="/" />)}
        </Card>
      </div>
    </div>
  );
}
