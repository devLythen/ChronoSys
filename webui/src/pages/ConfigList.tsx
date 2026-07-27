import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BotProfile } from "../api/types";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Modal from "../components/ui/Modal";
import { Plus, Trash2, Cpu, ExternalLink } from "lucide-react";

interface CreateForm {
  id: string;
}

const emptyForm: CreateForm = {
  id: "",
};

export default function ConfigList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof CreateForm, string>>>({});

  const { data: bots, isLoading, error } = useQuery({
    queryKey: ["bots"],
    queryFn: () => api.listBots(),
  });

  const createMut = useMutation({
    mutationFn: () =>
      api.createBot({
        id: form.id,

        model_ref: "",
        persona_id: null,
        policy_json: {},
        json_ext: {},
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["bots"] });
      setModalOpen(false);
      setForm(emptyForm);
      setFormErrors({});
      navigate(`/config/${created.id}`);
    },
    onError: (err: Error) => {
      setFormErrors({ id: err.message });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteBot(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bots"] });
    },
  });

  const handleDelete = (bot: BotProfile) => {
    if (window.confirm(`Delete config "${bot.id}"? This cannot be undone.`)) {
      deleteMut.mutate(bot.id);
    }
  };

  const validateForm = (): boolean => {
    const errs: Partial<Record<keyof CreateForm, string>> = {};
    if (!form.id.trim()) errs.id = "ID is required";
    else if (!/^[a-zA-Z0-9_-]+$/.test(form.id)) errs.id = "Only letters, digits, hyphens, underscores";
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleCreate = () => {
    if (!validateForm()) return;
    createMut.mutate();
  };

  return (
    <div className="animate-fade-up space-y-6 md:space-y-8">
      {/* Hero header */}
      <div>
        <h1 className="t-display">Configs</h1>
        <p className="t-body text-muted-fg mt-3 max-w-xl">
          Manage bot configurations and model bindings. Each config pairs a model reference
          with runtime policy settings.
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="t-label text-muted-fg">
            {bots ? `${bots.length} config${bots.length !== 1 ? "s" : ""}` : "—"}
          </p>
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={16} />
            New Config
          </Button>
        </div>
        <div className="rule-heavy" />
      </div>

      {isLoading && (
        <div className="py-16 text-center">
          <p className="t-body text-muted-fg">Loading configs&hellip;</p>
        </div>
      )}

      {error && (
        <div className="py-16 text-center">
          <p className="text-sm text-destructive font-medium">
            Failed to load configs: {(error as Error).message}
          </p>
        </div>
      )}

      {bots && bots.length === 0 && (
        <div className="halftone-light py-24 text-center border border-border">
          <p className="t-headline text-muted-fg/60 mb-3">No configs yet</p>
          <p className="t-body text-muted-fg/70 mb-6">Create one to get started.</p>
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={16} />
            New Config
          </Button>
        </div>
      )}

      {bots && bots.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {bots.map((bot) => (
            <Card
              key={bot.id}
              className="cursor-pointer hover:border-fg/30 transition-colors group flex flex-col"
              padding="none"
            >
              <div
                onClick={() => navigate(`/config/${bot.id}`)}
                className="p-4 flex-1"
              >
                <div className="flex items-start justify-between mb-3">
                  <h3 className="t-headline !text-xl truncate">
                    {bot.id}
                  </h3>
                </div>

                <p className="t-mono text-muted-fg mb-3 truncate">
                  {bot.id}
                </p>

                <div className="flex items-center gap-2 text-sm text-muted-fg mb-4">
                  <Cpu size={14} />
                  <span className="t-mono truncate font-medium">{bot.model_ref || "—"}</span>
                </div>
              </div>

              <div className="flex items-center gap-1 px-4 py-2 border-t border-border bg-muted/30">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (bot.persona_id) navigate(`/persona/${bot.persona_id}`);
                  }}
                  title="Edit persona"
                >
                  <ExternalLink size={14} />
                  Persona
                </Button>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(bot);
                  }}
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

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setForm(emptyForm);
          setFormErrors({});
        }}
        title="New Config"
      >
        <div className="flex flex-col space-y-6">
          <Input
            label="ID"
            placeholder="e.g. my-assistant"
            value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
            error={formErrors.id}
            hint="Unique identifier — cannot be changed later"
          />
          <div className="rule-thin" />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setModalOpen(false);
                setForm(emptyForm);
                setFormErrors({});
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createMut.isPending}>
              {createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
