import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BotProfile, ProviderView } from "../api/types";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { ArrowLeft, UserCircle, Save, Loader2 } from "lucide-react";

export default function ConfigEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const { data: bot, isLoading, error } = useQuery({
    queryKey: ["bot", id],
    queryFn: () => api.getBot(id!),
    enabled: !!id,
  });

  const { data: providers } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.listProviders(),
  });

  const [displayName, setDisplayName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [modelRef, setModelRef] = useState("");
  const [policyJson, setPolicyJson] = useState("");
  const [policyError, setPolicyError] = useState("");

  useEffect(() => {
    if (bot) {
      setDisplayName(bot.display_name);
      setEnabled(bot.enabled);
      setModelRef(bot.model_ref);
      setPolicyJson(JSON.stringify(bot.policy_json ?? {}, null, 2));
    }
  }, [bot]);

  const modelOptions = (() => {
    if (!providers) return [];
    const opts: { value: string; label: string }[] = [];
    for (const pv of providers) {
      if (!pv.enabled) continue;
      for (const m of pv.models) {
        if (!m.enabled) continue;
        const ref = `${pv.id}/${m.model_id}`;
        opts.push({
          value: ref,
          label: m.display_name ? `${m.display_name} (${ref})` : ref,
        });
      }
    }
    return opts;
  })();

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error("Missing bot id");
      // Validate policy JSON
      let parsedPolicy;
      try {
        parsedPolicy = JSON.parse(policyJson);
      } catch {
        throw new Error("Invalid policy JSON");
      }
      // Re-fetch current bot to get full state
      const current = await api.getBot(id);
      // Merge: overwrite only config-owned fields
      const body = {
        ...current,
        display_name: displayName,
        enabled,
        model_ref: modelRef,
        policy_json: parsedPolicy,
        // Preserve persona fields from current fetch
        system_prompt: current.system_prompt,
        tools_allowlist_json: current.tools_allowlist_json,
        skills_allowlist_json: current.skills_allowlist_json,
        json_ext: current.json_ext,
      };
      return api.updateBot(id, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bot", id] });
      queryClient.invalidateQueries({ queryKey: ["bots"] });
      toast.add("success", "Config saved");
    },
    onError: (err: Error) => {
      toast.add("error", err.message);
    },
  });

  const handleSave = () => {
    // Validate policy JSON before save
    try {
      JSON.parse(policyJson);
      setPolicyError("");
    } catch (e) {
      setPolicyError((e as Error).message);
      return;
    }
    saveMut.mutate();
  };

  const validatePolicyJson = (val: string) => {
    setPolicyJson(val);
    if (!val.trim()) {
      setPolicyError("");
      return;
    }
    try {
      JSON.parse(val);
      setPolicyError("");
    } catch (e) {
      setPolicyError((e as Error).message);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-muted-fg" />
      </div>
    );
  }

  if (error || !bot) {
    return (
      <div className="animate-fade-up py-20 text-center">
        <p className="text-sm text-destructive font-medium mb-4">
          {error ? (error as Error).message : "Config not found"}
        </p>
        <Button variant="secondary" onClick={() => navigate("/config")}>
          <ArrowLeft size={14} />
          Back to Configs
        </Button>
      </div>
    );
  }

  return (
    <div className="animate-fade-up space-y-6 md:space-y-8">
      {/* Back link */}
      <Link
        to="/config"
        className="t-label text-muted-fg hover:text-fg transition-colors inline-flex items-center gap-1"
      >
        <ArrowLeft size={12} />
        Configs
      </Link>

      {/* Hero header */}
      <div>
        <h1 className="t-display">{bot.display_name || bot.id}</h1>
        <p className="t-mono text-muted-fg mt-2">{bot.id}</p>
      </div>
      <div className="rule-heavy" />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Config Section */}
        <Card className="space-y-6">
          <div>
            <h2 className="t-headline !text-lg">Configuration</h2>
            <p className="t-label text-muted-fg mt-1">Model binding and runtime policy</p>
          </div>

          <Input
            label="Display Name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <Select
            label="Model"
            options={modelOptions}
            value={modelRef}
            onChange={(e) => setModelRef(e.target.value)}
            placeholder="Select a model…"
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 border-border accent-fg"
            />
            <span className="text-sm">Enabled</span>
          </label>

          <div className="flex flex-col gap-1.5">
            <p className="t-label text-muted-fg">Policy JSON</p>
            <textarea
              className={`px-4 py-3 text-sm border bg-card text-fg placeholder:text-muted-fg/60 font-mono min-h-[200px] focus:outline-none focus:ring-1 focus:ring-fg transition-colors duration-150 resize-y ${
                policyError ? "border-destructive" : "border-border"
              }`}
              value={policyJson}
              onChange={(e) => validatePolicyJson(e.target.value)}
              placeholder='{ "max_context_messages": 50 }'
              spellCheck={false}
            />
            {policyError && (
              <p className="text-xs text-destructive">Invalid JSON: {policyError}</p>
            )}
          </div>
        </Card>

        {/* Read-only Persona Preview */}
        <Card className="space-y-6">
          <div>
            <h2 className="t-headline !text-lg">Persona</h2>
            <p className="t-label text-muted-fg mt-1">Read-only preview</p>
          </div>

          <div>
            <p className="t-label text-muted-fg mb-1.5">System Prompt</p>
            <div className="px-4 py-3 text-sm border border-border bg-muted/30 max-h-40 overflow-y-auto whitespace-pre-wrap text-muted-fg font-mono">
              {bot.system_prompt || "—"}
            </div>
          </div>

          <div>
            <p className="t-label text-muted-fg mb-1.5">Tools</p>
            <div className="flex flex-wrap gap-1.5">
              {bot.tools_allowlist_json?.length > 0 ? (
                bot.tools_allowlist_json.map((t) => (
                  <Badge key={t} variant="info">
                    {t}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-fg">—</span>
              )}
            </div>
          </div>

          <div>
            <p className="t-label text-muted-fg mb-1.5">Skills</p>
            <div className="flex flex-wrap gap-1.5">
              {bot.skills_allowlist_json?.length > 0 ? (
                bot.skills_allowlist_json.map((s) => (
                  <Badge key={s} variant="info">
                    {s}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-fg">—</span>
              )}
            </div>
          </div>

          <Link
            to={`/persona/${bot.id}`}
            className="inline-flex items-center gap-1.5 t-label text-fg hover:text-muted-fg transition-colors"
          >
            <UserCircle size={13} />
            Edit Persona
          </Link>
        </Card>
      </div>

      {/* Save button */}
      <div className="rule-thin" />
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saveMut.isPending} size="lg">
          {saveMut.isPending ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Save size={16} />
          )}
          Save
        </Button>
      </div>
    </div>
  );
}
