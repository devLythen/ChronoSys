import { useState, useEffect } from "react";
import { usePageEnter } from "../hooks/useAnimations";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Modal from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { ArrowLeft, Save, Loader2, Plus, X, Pencil } from "lucide-react";
import { cn } from "../lib/utils";


export default function PersonaEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const { data: persona, isLoading, error } = useQuery({
    queryKey: ["persona", id],
    queryFn: () => api.getPersona(id!),
    enabled: !!id,
  });
  const { data: tools } = useQuery({
    queryKey: ["tools"],
    queryFn: () => api.listTools(),
  });
  const { data: pluginsData, isLoading: pluginsLoading } = useQuery({ queryKey: ["plugins"], queryFn: () => api.listPlugins() });
  const pluginEntries = (pluginsData?.plugins ?? []).flatMap((plugin) => plugin.policy.enabled ? plugin.tools.map((tool) => ({ ...tool, plugin, disabledForPersona: plugin.policy.tools[tool.name]?.persona_blacklist.includes(id ?? "") ?? false })) : []);
  const toolCatalog = (tools ?? []).map((tool) => ({ ...tool, unavailable: false }));



  const [systemPrompt, setSystemPrompt] = useState("");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillInput, setSkillInput] = useState("");
  const [skillError, setSkillError] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);

  useEffect(() => {
    if (persona) {
      setSystemPrompt(persona.system_prompt || "");
      setSelectedTools(Array.isArray(persona.tools_allowlist_json) ? persona.tools_allowlist_json : []);
      setSkills(Array.isArray(persona.skills_allowlist_json) ? persona.skills_allowlist_json : []);
    }
  }, [persona]);

  const toggleTool = (tool: string) => {
    setSelectedTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]
    );
  };

  const updatePluginTool = useMutation({
    mutationFn: async ({ pluginId, toolName, disabled }: { pluginId: string; toolName: string; disabled: boolean }) => {
      const plugin = (pluginsData?.plugins ?? []).find((item) => item.id === pluginId);
      if (!plugin || !id) throw new Error("Plugin or persona unavailable");
      const blacklist = plugin.policy.tools[toolName]?.persona_blacklist ?? [];
      const tools = { ...plugin.policy.tools, [toolName]: { persona_blacklist: disabled ? [...new Set([...blacklist, id])] : blacklist.filter((persona) => persona !== id) } };
      return api.updatePluginPolicy(pluginId, { enabled: plugin.policy.enabled, config: plugin.policy.config, tools });
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["plugins"] }); },
    onError: (err: Error) => toast.add("error", err.message),
  });

  const handleAddSkill = () => {
    const trimmed = skillInput.trim();
    if (!trimmed) return;
    if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
      setSkillError("Only letters, digits, dots, hyphens, underscores");
      return;
    }
    if (skills.includes(trimmed)) {
      setSkillError("Skill already added");
      return;
    }
    setSkillError("");
    setSkills((prev) => [...prev, trimmed]);
    setSkillInput("");
  };

  const removeSkill = (skill: string) => {
    setSkills((prev) => prev.filter((s) => s !== skill));
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error("Missing persona id");
      return api.updatePersona(id, { system_prompt: systemPrompt, tools_allowlist_json: selectedTools, skills_allowlist_json: skills, json_ext: persona?.json_ext || {} });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["persona", id] });
      queryClient.invalidateQueries({ queryKey: ["personas"] });
      toast.add("success", "Persona saved");
      navigate("/persona");
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  const pageRef = usePageEnter<HTMLDivElement>();
  if (isLoading || pluginsLoading) {
    return <div className="animate-fade-in space-y-5 py-12"><div className="h-9 w-44 bg-muted animate-pulse" /><div className="h-52 bg-muted animate-pulse" /><div className="h-28 bg-muted animate-pulse" /></div>;
  }

  if (error || !persona) {
    return (
      <div className="animate-fade-up py-20 text-center">
        <p className="text-sm text-destructive font-medium mb-4">
          {error ? (error as Error).message : "Persona not found"}
        </p>
        <Button variant="secondary" onClick={() => navigate("/persona")}>
          <ArrowLeft size={14} />
          Back to Personas
        </Button>
      </div>
    );
  }

  return (
    <div ref={pageRef} className="space-y-6 md:space-y-8">
      {/* Back link */}
      <Link
        to="/persona"
        className="t-label text-muted-fg hover:text-fg transition-colors inline-flex items-center gap-1"
      >
        <ArrowLeft size={12} />
        Personas
      </Link>

      {/* Hero header */}
      <div>
        <h1 className="t-display">{id}</h1>
      </div>
      <div className="rule-heavy" />

      <div className="grid grid-cols-1 gap-6">
        {/* System Prompt */}
        <Card className="space-y-4">
          <div>
            <h2 className="t-headline !text-lg">System Prompt</h2>
            <p className="t-label text-muted-fg mt-1">Define how the assistant behaves</p>
          </div>
          <textarea
            className="w-full px-4 py-3 text-sm border border-border bg-card text-fg font-mono min-h-[200px] focus:outline-none focus:ring-1 focus:ring-fg transition-colors duration-150 resize-y placeholder:text-muted-fg/60"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are a helpful assistant…"
            spellCheck={false}
            rows={10}
          />
        </Card>
      </div>

      <Card className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="t-headline !text-lg">Tools</h2><p className="t-label text-muted-fg mt-1">{selectedTools.length + pluginEntries.filter((tool) => !tool.disabledForPersona).length} enabled</p></div>
          <Button variant="secondary" size="sm" onClick={() => setToolsOpen(true)}><Pencil size={14} /> Edit tools</Button>
        </div>
        <div className="flex flex-wrap gap-2">{[...selectedTools, ...pluginEntries.filter((tool) => !tool.disabledForPersona).map((tool) => tool.name)].slice(0, 6).map((name) => <span key={name} className="t-mono max-w-40 truncate border border-border px-2 py-1 text-xs">{name}</span>)}{selectedTools.length + pluginEntries.length > 6 && <span className="t-label px-2 py-1 text-muted-fg">…</span>}</div>
      </Card>
      <Modal open={toolsOpen} onClose={() => setToolsOpen(false)} title="Edit tools" size="lg">
        <div className="max-h-[65vh] overflow-y-auto space-y-6 pr-1">
          <section><p className="t-label text-muted-fg mb-3">Built-in tools</p><div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{toolCatalog.map((tool) => <button type="button" key={tool.name} onClick={() => toggleTool(tool.name)} className={cn("text-left border px-4 py-3 transition-colors", selectedTools.includes(tool.name) ? "bg-fg text-bg border-fg" : "border-border hover:bg-muted") }><span className="t-mono text-xs">{tool.name}</span><span className="block text-xs opacity-70 mt-1">{tool.label}</span></button>)}</div></section>
          <section><p className="t-label text-muted-fg mb-3">Plugin tools</p><div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{pluginEntries.map((tool) => <button type="button" key={`${tool.plugin.id}:${tool.name}`} onClick={() => updatePluginTool.mutate({ pluginId: tool.plugin.id, toolName: tool.name, disabled: !tool.disabledForPersona })} className={cn("text-left border px-4 py-3 transition-colors", !tool.disabledForPersona ? "bg-fg text-bg border-fg" : "border-border hover:bg-muted") }><span className="t-mono text-xs">{tool.name}</span><span className="block text-xs opacity-70 mt-1">{tool.plugin.name}</span></button>)}</div></section>
        </div>
      </Modal>

      {/* Skills */}
      <Card className="space-y-5">
        <div>
          <h2 className="t-headline !text-lg">Skills</h2>
          <p className="t-label text-muted-fg mt-1">
            {skills.length} {skills.length === 1 ? "skill" : "skills"} configured
          </p>
        </div>

        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Input
              label="Add Skill"
              placeholder="skill-id"
              value={skillInput}
              onChange={(e) => {
                setSkillInput(e.target.value);
                setSkillError("");
              }}
              error={skillError}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddSkill();
                }
              }}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleAddSkill}
            className="mb-0.5"
          >
            <Plus size={14} />
            Add
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          {skills.length > 0 ? (
            skills.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-muted border border-border text-sm t-mono"
              >
                {skill}
                <button
                  onClick={() => removeSkill(skill)}
                  className="ml-0.5 p-0.5 hover:bg-destructive/10 hover:text-destructive transition-colors"
                  title={`Remove ${skill}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))
          ) : (
            <p className="t-body text-muted-fg/60">No skills configured</p>
          )}
        </div>
      </Card>

      {/* Save button */}
      <div className="rule-thin" />
      <div className="flex justify-end">
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} size="lg">
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
