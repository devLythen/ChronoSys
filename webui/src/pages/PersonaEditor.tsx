import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import { ArrowLeft, Save, Loader2, Plus, X } from "lucide-react";
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


  const [systemPrompt, setSystemPrompt] = useState("");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillInput, setSkillInput] = useState("");
  const [skillError, setSkillError] = useState("");

  useEffect(() => {
    if (persona) {
      setSystemPrompt(persona.system_prompt || "");
      setSelectedTools(persona.tools_allowlist_json || []);
      setSkills(persona.skills_allowlist_json || []);
    }
  }, [persona]);

  const toggleTool = (tool: string) => {
    setSelectedTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]
    );
  };

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
      return api.updatePersona(id, {
        system_prompt: systemPrompt,
        tools_allowlist_json: selectedTools,
        skills_allowlist_json: skills,
        json_ext: persona?.json_ext || {},
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["persona", id] });
      queryClient.invalidateQueries({ queryKey: ["personas"] });
      toast.add("success", "Persona saved");
      navigate("/persona");
    },
    onError: (err: Error) => {
      toast.add("error", err.message);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-muted-fg" />
      </div>
    );
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
    <div className="animate-fade-up space-y-6 md:space-y-8">
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
        <h1 className="t-display">Persona: {persona.id}</h1>
        <p className="t-mono text-muted-fg mt-2">{persona.id}</p>
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

      {/* Tools */}
      <Card className="space-y-4">
        <div>
          <h2 className="t-headline !text-lg">Tools</h2>
          <p className="t-label text-muted-fg mt-1">
            {selectedTools.length} selected
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {(tools || []).map((tool) => (
            <label
              key={tool.name}
              className={cn(
                "flex items-center gap-2.5 px-4 py-3 border cursor-pointer transition-colors select-none",
                selectedTools.includes(tool.name)
                  ? "border-fg/30 bg-fg/[0.03]"
                  : "border-border hover:bg-muted/50"
              )}
            >
              <input
                type="checkbox"
                checked={selectedTools.includes(tool.name)}
                onChange={() => toggleTool(tool.name)}
                className="w-4 h-4 border-border accent-fg"
              />
              <div>
                <span className="t-mono !text-xs">{tool.name}</span>
                <p className="text-[11px] text-muted-fg mt-0.5 leading-tight">{tool.label}</p>
              </div>
            </label>
          ))}
        </div>
      </Card>

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
