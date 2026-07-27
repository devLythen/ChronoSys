import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import Modal from "../components/ui/Modal";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import type { Persona } from "../api/types";
import { truncate } from "../lib/utils";
import { Wrench, Puzzle, Plus, Trash2 } from "lucide-react";

export default function PersonaList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [modalOpen, setModalOpen] = useState(false);
  const [newId, setNewId] = useState("");
  const [idError, setIdError] = useState("");

  const { data: personas, isLoading, error } = useQuery({
    queryKey: ["personas"],
    queryFn: () => api.listPersonas(),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deletePersona(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["personas"] });
      toast.add("success", "Persona deleted");
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  const handleDelete = (p: Persona) => {
    if (window.confirm(`Delete persona "${p.id}"? This cannot be undone.`)) {
      deleteMut.mutate(p.id);
    }
  };

  const handleCreate = () => {
    const trimmed = newId.trim();
    if (!trimmed) { setIdError("ID is required"); return; }
    if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
      setIdError("Only letters, digits, dots, hyphens, underscores");
      return;
    }
    setIdError("");
    setModalOpen(false);
    setNewId("");
    navigate(`/persona/${trimmed}`);
  };

  return (
    <div className="animate-fade-up space-y-6 md:space-y-8">
      <div>
        <h1 className="t-display">Personas</h1>
        <p className="t-body text-muted-fg mt-3 max-w-xl">
          Edit system prompts, tools, and skills. Personas define how
          the assistant behaves and what it can do.
        </p>
      </div>
      <div className="rule-heavy" />

      <div className="flex items-center justify-between">
        <p className="t-label text-muted-fg">
          {personas ? `${personas.length} persona${personas.length !== 1 ? "s" : ""}` : "—"}
        </p>
        <Button onClick={() => { setNewId(""); setModalOpen(true); }}>
          <Plus size={16} /> New Persona
        </Button>
      </div>

      {isLoading && (
        <div className="py-16 text-center">
          <p className="t-body text-muted-fg">Loading personas&hellip;</p>
        </div>
      )}
      {error && (
        <div className="py-16 text-center">
          <p className="text-sm text-destructive font-medium">{(error as Error).message}</p>
        </div>
      )}
      {personas && personas.length === 0 && (
        <div className="halftone-light py-24 text-center border border-border">
          <p className="t-headline text-muted-fg/60 mb-3">No personas yet</p>
          <p className="t-body text-muted-fg/70 mb-6">Create one to get started.</p>
          <Button onClick={() => { setNewId(""); setModalOpen(true); }}>
            <Plus size={16} /> New Persona
          </Button>
        </div>
      )}

      {personas && personas.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {personas.map((persona) => (
            <Card
              key={persona.id}
              className="cursor-pointer hover:border-fg/30 transition-colors group flex flex-col"
              padding="none"
            >
              <div
                onClick={() => navigate(`/persona/${persona.id}`)}
                className="p-4 flex-1"
              >
                <div className="flex items-start justify-between mb-3">
                  <h3 className="t-headline !text-xl truncate">{persona.id}</h3>
                </div>
                <div className="mb-3 min-h-[2.5em]">
                  {persona.system_prompt ? (
                    <p className="t-body text-muted-fg line-clamp-2">
                      {truncate(persona.system_prompt, 120)}
                    </p>
                  ) : (
                    <p className="t-body text-muted-fg/50 italic">No system prompt</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="info">
                    <Wrench size={11} className="mr-1" />
                    {persona.tools_allowlist_json?.length ?? 0} tools
                  </Badge>
                  <Badge variant="info">
                    <Puzzle size={11} className="mr-1" />
                    {persona.skills_allowlist_json?.length ?? 0} skills
                  </Badge>
                </div>
              </div>
              <div className="flex items-center gap-1 px-4 py-2 border-t border-border bg-muted/30">
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); handleDelete(persona); }}
                  className="text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => { setModalOpen(false); setNewId(""); setIdError(""); }} title="New Persona" size="sm">
        <div className="space-y-4">
          <Input
            label="ID"
            placeholder="my-persona-id"
            value={newId}
            onChange={(e) => { setNewId(e.target.value); setIdError(""); }}
            error={idError}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          />
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="secondary" onClick={() => { setModalOpen(false); setNewId(""); setIdError(""); }}>
              Cancel
            </Button>
            <Button onClick={handleCreate}>Create</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
