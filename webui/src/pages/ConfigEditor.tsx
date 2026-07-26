import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BotProfile, Persona } from "../api/types";
import Card from "../components/ui/Card";
import Toggle from "../components/ui/Toggle";
import Modal from "../components/ui/Modal";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Select from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { ArrowLeft, Save, Loader2, ExternalLink, Pencil } from "lucide-react";
import { cn } from "../lib/utils";

const KNOWN_COMMANDS = [
  { name: "new", desc: "Start a new conversation session" },
  { name: "compact", desc: "Compress conversation context" },
];

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
  const [maxContext, setMaxContext] = useState<number | null>(null);
  const [selectedCommands, setSelectedCommands] = useState<string[]>(["new"]);
  const [mentionRequired, setMentionRequired] = useState(false);
  const [commandModalOpen, setCommandModalOpen] = useState(false);

  useEffect(() => {
    if (bot) {
      setModelRef(bot.model_ref);
      setPersonaId(bot.persona_id || "");
      const p = bot.policy_json ?? {} as Record<string,unknown>;
      setMaxContext(p.max_context_messages as number ?? null);
      const cmds: unknown = p.commands;
      setSelectedCommands(Array.isArray(cmds) ? cmds as string[] : ["new"]);
      setMentionRequired(Boolean(p.mention_required));
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
      const policy: Record<string, unknown> = {};
      if (maxContext != null) policy.max_context_messages = maxContext;
      if (selectedCommands.length > 0) policy.commands = selectedCommands;
      if (mentionRequired) policy.mention_required = true;
      return api.updateBot(id, {
        model_ref: modelRef,
        persona_id: personaId || null,
        policy_json: policy,
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

  const handleSave = () => saveMut.mutate();

  const toggleCommand = (cmd: string) => {
    setSelectedCommands((prev) =>
      prev.includes(cmd) ? prev.filter((c) => c !== cmd) : [...prev, cmd]
    );
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
      <Link
        to="/config"
        className="t-label text-muted-fg hover:text-fg transition-colors inline-flex items-center gap-1"
      >
        <ArrowLeft size={12} />
        Configs
      </Link>

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

          <div className="space-y-4">
            <p className="t-label text-muted-fg">Runtime Policy</p>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-fg uppercase tracking-wide">
                Max Context Messages
              </label>
              <input
                type="number"
                min={0}
                step={1}
                value={maxContext ?? ""}
                onChange={(e) => setMaxContext(e.target.value ? Number(e.target.value) : null)}
                placeholder="Unlimited"
                className="px-3 py-1.5 text-sm border rounded-sm bg-card text-fg placeholder:text-muted-fg/60 focus:outline-none focus:ring-1 focus:ring-fg transition-colors duration-150 border-border"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-fg uppercase tracking-wide">
                Commands
              </label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-fg tabular-nums">
                  {selectedCommands.length} selected
                </span>
                <Button variant="secondary" size="sm" onClick={() => setCommandModalOpen(true)}>
                  <Pencil size={12} />
                  Edit
                </Button>
              </div>
            </div>

            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm text-fg">Require @mention in groups</span>
              <Toggle checked={mentionRequired} onChange={setMentionRequired} />
            </label>
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

      {/* ── Commands Modal ── */}
      <Modal
        open={commandModalOpen}
        onClose={() => setCommandModalOpen(false)}
        title="Commands"
        size="sm"
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-2 max-h-[280px] overflow-y-auto">
            {KNOWN_COMMANDS.map((cmd) => (
              <label
                key={cmd.name}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 border cursor-pointer transition-colors select-none",
                  selectedCommands.includes(cmd.name)
                    ? "border-fg/30 bg-fg/[0.03]"
                    : "border-border hover:bg-muted/50"
                )}
              >
                <input
                  type="checkbox"
                  checked={selectedCommands.includes(cmd.name)}
                  onChange={() => toggleCommand(cmd.name)}
                  className="w-4 h-4 border-border accent-fg"
                />
                <div>
                  <span className="t-mono !text-xs">/{cmd.name}</span>
                  <p className="text-[11px] text-muted-fg mt-0.5 leading-tight">{cmd.desc}</p>
                </div>
              </label>
            ))}
          </div>

        </div>
      </Modal>
    </div>
  );
}
