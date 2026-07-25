import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BotProfile, Persona, ProviderView } from "../api/types";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { ArrowLeft, Save, Loader2, ExternalLink } from "lucide-react";

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

  const { data: personas } = useQuery({
    queryKey: ["personas"],
    queryFn: () => api.listPersonas(),
  });


  const [modelRef, setModelRef] = useState("");
  const [personaId, setPersonaId] = useState("");
  const [policyJson, setPolicyJson] = useState("");
  const [policyError, setPolicyError] = useState("");

  useEffect(() => {
    if (bot) {

      setModelRef(bot.model_ref);
      setPersonaId(bot.persona_id || "");
      setPolicyJson(JSON.stringify(bot.policy_json ?? {}, null, 2));
    }
  }, [bot]);

  const modelOptions = (() => {
    const opts: { value: string; label: string }[] = [];
    if (!providers) return opts;
    for (const pv of providers) {
      for (const m of pv.models) {
        if (!m.model_id) continue;
        const ref = `${pv.id}/${m.model_id}`;
        opts.push({ value: ref, label: ref });
      }
    }
    return opts;
  })();

  const personaOptions = (() => {
    if (!personas) return [];
    return personas.map((p) => ({ value: p.id, label: p.id }));
  })();

  const selectedPersona = personaId ? personas?.find((p: Persona) => p.id === personaId) : null;

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error("Missing bot id");
      let parsedPolicy;
      try {
        parsedPolicy = JSON.parse(policyJson);
      } catch {
        throw new Error("Invalid policy JSON");
      }
      return api.updateBot(id, {
        model_ref: modelRef,
        persona_id: personaId || null,
        policy_json: parsedPolicy,
        json_ext: bot?.json_ext || {},
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bot", id] });
      toast.add("success", "Config saved");
      navigate("/config");
    },
    onError: (err: Error) => {
      toast.add("error", err.message);
    },
  });

  const handleSave = () => {
    try {
      JSON.parse(policyJson);
      saveMut.mutate();
    } catch (e) {
      setPolicyError((e as Error).message);
    }
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
        <h1 className="t-display">{bot.id}</h1>
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

          <Select
            label="Model"
            options={modelOptions}
            value={modelRef}
            onChange={(e) => setModelRef(e.target.value)}
            placeholder="Select a model…"
          />
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

        {/* Persona Section */}
        <Card className="space-y-5">
          <div>
            <h2 className="t-headline !text-lg">Persona</h2>
            <p className="t-label text-muted-fg mt-1">Select the persona for this config</p>
          </div>

          <Select
            label="Persona"
            options={personaOptions}
            value={personaId}
            onChange={(e) => setPersonaId(e.target.value)}
            placeholder="Select a persona…"
          />

          {selectedPersona && (
            <div className="bg-card border border-border rounded-lg p-4 space-y-3">
              <div>
                <p className="t-label text-muted-fg">System Prompt</p>
                <p className="text-sm text-fg/80 whitespace-pre-wrap line-clamp-3 font-mono mt-1">
                  {selectedPersona.system_prompt.slice(0, 200)}
                  {selectedPersona.system_prompt.length > 200 ? "\u2026" : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="info">
                  {(selectedPersona.tools_allowlist_json?.length ?? 0)} tool{(selectedPersona.tools_allowlist_json?.length ?? 0) !== 1 ? "s" : ""}
                </Badge>
                <Badge variant="info">
                  {(selectedPersona.skills_allowlist_json?.length ?? 0)} skill{(selectedPersona.skills_allowlist_json?.length ?? 0) !== 1 ? "s" : ""}
                </Badge>
              </div>
              <div className="rule-thin" />
              <Link
                to={`/persona/${selectedPersona.id}`}
                className="inline-flex items-center gap-1.5 t-label font-medium text-accent hover:underline transition-colors"
              >
                Edit Persona
                <ExternalLink size={13} />
              </Link>
            </div>
          )}

          {!selectedPersona && personaId && (
            <p className="text-sm text-muted-fg italic">Persona not found</p>
          )}
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
