import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type {
  ProviderView,
  LlmModel,
  ProviderBody,
  CredentialBody,
  ModelBody,
} from "../api/types";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Modal from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { ChevronDown, ChevronRight } from "lucide-react";

// ── Constants ──────────────────────────────────────────────────

const PROVIDER_KINDS = [
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "anthropic", label: "Anthropic" },
  { value: "custom", label: "Custom" },
];

const AUTH_KINDS = [
  { value: "api_key", label: "API Key" },
  { value: "env_ref", label: "Environment Reference" },
];

const THINKING_LEVELS = [
  { value: "", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

// ── Empty form state ──────────────────────────────────────────

function emptyProviderBody(): ProviderBody {
  return { id: "", kind: "openai", display_name: "", enabled: true };
}

function emptyCredentialBody(): CredentialBody {
  return { auth_kind: "api_key", secret_ref: "" };
}

function emptyModelBody(): ModelBody {
  return { model_id: "", display_name: "", enabled: true };
}

// ── Page component ─────────────────────────────────────────────

export default function ProvidersPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const {
    data: providers,
    isLoading,
    error,
    refetch,
  } = useQuery<ProviderView[]>({
    queryKey: ["providers"],
    queryFn: () => api.listProviders(),
  });

  // ── Provider modal state ────────────────────────────────────
  const [provModalOpen, setProvModalOpen] = useState(false);
  const [editingProvId, setEditingProvId] = useState<string | null>(null);
  const [provForm, setProvForm] = useState<ProviderBody>(emptyProviderBody());

  const openCreateProv = () => {
    setEditingProvId(null);
    setProvForm(emptyProviderBody());
    setProvModalOpen(true);
  };

  const openEditProv = (pv: ProviderView) => {
    setEditingProvId(pv.id);
    setProvForm({
      id: pv.id,
      kind: pv.kind,
      base_url: pv.base_url,
      display_name: pv.display_name,
      enabled: pv.enabled,
    });
  };

  const closeProvModal = () => {
    setProvModalOpen(false);
    setEditingProvId(null);
  };

  const provMutation = useMutation({
    mutationFn: (body: ProviderBody) =>
      editingProvId ? api.updateProvider(editingProvId, body) : api.createProvider(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", editingProvId ? "Provider updated." : "Provider created.");
      closeProvModal();
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  const deleteProvMutation = useMutation({
    mutationFn: (id: string) => api.deleteProvider(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", "Provider deleted.");
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  // ── Credential modal state ──────────────────────────────────
  const [credModalOpen, setCredModalOpen] = useState(false);
  const [credProvId, setCredProvId] = useState<string>("");
  const [credForm, setCredForm] = useState<CredentialBody>(emptyCredentialBody());

  const openCredModal = (providerId: string, hasSecret: boolean) => {
    setCredProvId(providerId);
    setCredForm(
      hasSecret
        ? { auth_kind: "api_key", secret_ref: "" }
        : emptyCredentialBody(),
    );
    setCredModalOpen(true);
  };

  const credMutation = useMutation({
    mutationFn: () => api.upsertCredential(credProvId, credForm),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", "Credential saved.");
      setCredModalOpen(false);
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  const deleteCredMutation = useMutation({
    mutationFn: (providerId: string) => api.deleteCredential(providerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", "Credential removed.");
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  // ── Model modal state ───────────────────────────────────────
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [modelProvId, setModelProvId] = useState<string>("");
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [modelForm, setModelForm] = useState<ModelBody>(emptyModelBody());

  const openCreateModel = (providerId: string) => {
    setModelProvId(providerId);
    setEditingModelId(null);
    setModelForm(emptyModelBody());
    setModelModalOpen(true);
  };

  const openEditModel = (providerId: string, model: LlmModel) => {
    setModelProvId(providerId);
    setEditingModelId(model.model_id);
    setModelForm({
      model_id: model.model_id,
      display_name: model.display_name,
      enabled: model.enabled,
      temperature: model.temperature,
      max_tokens: model.max_tokens,
      top_p: model.top_p,
      thinking_level: model.thinking_level,
    });
    setModelModalOpen(true);
  };

  const modelMutation = useMutation({
    mutationFn: () => api.upsertModel(modelProvId, modelForm),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", editingModelId ? "Model updated." : "Model added.");
      setModelModalOpen(false);
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  const deleteModelMutation = useMutation({
    mutationFn: ({ providerId, modelId }: { providerId: string; modelId: string }) =>
      api.deleteModel(providerId, modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", "Model deleted.");
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  // ── Expand state ────────────────────────────────────────────
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Render helpers ──────────────────────────────────────────

  const kindLabel = (k: string) =>
    PROVIDER_KINDS.find((o) => o.value === k)?.label ?? k;

  // ── Render ──────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="animate-fade-up flex items-center justify-center h-64">
        <p className="t-body text-muted-fg">Loading providers...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="animate-fade-up flex flex-col items-center justify-center gap-4 h-64">
        <p className="t-body text-destructive">
          Failed to load providers: {(error as Error).message}
        </p>
        <Button variant="secondary" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const list = providers ?? [];

  return (
    <div className="animate-fade-up space-y-6">
      {/* ── Header ─────────────────────────────────────────── */}
      <div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="t-display !text-4xl md:!text-5xl">Providers</h1>
            <p className="t-body text-muted-fg mt-3 max-w-lg">
              Configure LLM providers and their models for the ChronoSys gateway.
            </p>
          </div>
          <Button size="lg" onClick={openCreateProv}>
            Add Provider
          </Button>
        </div>
      </div>

      <div className="rule-heavy" />

      {/* ── Empty state ────────────────────────────────────── */}
      {list.length === 0 && (
        <>
          <div className="halftone h-10 opacity-30" />
          <div className="py-20 text-center">
            <p className="t-body text-muted-fg">
              No providers configured. Add one to get started.
            </p>
          </div>
        </>
      )}

      {/* ── Provider cards ──────────────────────────────────── */}
      {list.length > 0 && (
        <>
          <div className="halftone h-10 opacity-30" />

          <section className="space-y-6">
            {list.map((pv) => (
              <div key={pv.id}>
                <Card padding="md">
                  {/* Top row: info + actions */}
                  <div className="flex items-start justify-between gap-6">
                    {/* Left: provider info */}
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h3 className="t-headline">{pv.display_name}</h3>
                        <span className="t-mono text-muted-fg">{pv.id}</span>
                        <Badge variant="default" className="font-mono text-[10px]">
                          {kindLabel(pv.kind)}
                        </Badge>
                        <Badge variant={pv.enabled ? "success" : "default"}>
                          {pv.enabled ? "enabled" : "disabled"}
                        </Badge>
                        <CreditStatus has_secret={pv.has_credential} />
                      </div>

                      {pv.base_url && (
                        <p className="t-mono text-muted-fg text-xs truncate">
                          {pv.base_url}
                        </p>
                      )}
                    </div>

                    {/* Right: actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openCredModal(pv.id, pv.has_credential)}
                      >
                        Credential
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditProv(pv)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          if (window.confirm(`Delete provider "${pv.display_name}"?`)) {
                            deleteProvMutation.mutate(pv.id);
                          }
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  {/* Models toggle */}
                  <button
                    onClick={() => toggleExpand(pv.id)}
                    className="mt-3 flex items-center gap-1.5 text-xs text-muted-fg hover:text-fg transition-colors"
                  >
                    {expandedIds.has(pv.id) ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                    {pv.models.length}{" "}
                    {pv.models.length === 1 ? "model" : "models"}
                  </button>
                </Card>

                {/* ── Expanded models table ────────────────── */}
                {expandedIds.has(pv.id) && (
                  <div className="mt-3 px-4">
                    <div className="rule-thin mb-4" />
                    <div className="flex items-center justify-between mb-4">
                      <span className="t-label text-muted-fg">Models</span>
                      <Button size="sm" variant="secondary" onClick={() => openCreateModel(pv.id)}>
                        Add Model
                      </Button>
                    </div>

                    {pv.models.length === 0 ? (
                      <p className="t-body text-muted-fg py-6 text-center">
                        No models configured.
                      </p>
                    ) : (
                      <div className="border border-border rounded-sm overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/50">
                              <th className="text-left px-4 py-3 t-label text-muted-fg font-medium">
                                Model ID
                              </th>
                              <th className="text-left px-4 py-3 t-label text-muted-fg font-medium">
                                Display Name
                              </th>
                              <th className="text-center px-4 py-3 t-label text-muted-fg font-medium">
                                Status
                              </th>
                              <th className="text-center px-4 py-3 t-label text-muted-fg font-medium">
                                Temp
                              </th>
                              <th className="text-center px-4 py-3 t-label text-muted-fg font-medium">
                                Max Tokens
                              </th>
                              <th className="text-center px-4 py-3 t-label text-muted-fg font-medium">
                                Thinking
                              </th>
                              <th className="text-right px-4 py-3 t-label text-muted-fg font-medium">
                                Actions
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {pv.models.map((m) => (
                              <tr
                                key={m.model_id}
                                className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                              >
                                <td className="px-4 py-3">
                                  <span className="t-mono">{m.model_id}</span>
                                </td>
                                <td className="px-4 py-3 text-muted-fg">
                                  {m.display_name || "—"}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  <Badge variant={m.enabled ? "success" : "default"}>
                                    {m.enabled ? "on" : "off"}
                                  </Badge>
                                </td>
                                <td className="px-4 py-3 text-center tabular-nums">
                                  {m.temperature != null ? m.temperature : "—"}
                                </td>
                                <td className="px-4 py-3 text-center tabular-nums">
                                  {m.max_tokens != null ? m.max_tokens : "—"}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  {m.thinking_level ? (
                                    <Badge variant="info">{m.thinking_level}</Badge>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => openEditModel(pv.id, m)}
                                    >
                                      Edit
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-destructive hover:text-destructive"
                                      onClick={() => {
                                        if (window.confirm(`Delete model "${m.model_id}"?`)) {
                                          deleteModelMutation.mutate({
                                            providerId: pv.id,
                                            modelId: m.model_id,
                                          });
                                        }
                                      }}
                                    >
                                      Del
                                    </Button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="rule-thin mt-4" />
                  </div>
                )}
              </div>
            ))}
          </section>
        </>
      )}

      {/* ── Provider modal ──────────────────────────────────── */}
      <Modal
        open={provModalOpen}
        onClose={closeProvModal}
        title={editingProvId ? "Edit Provider" : "Add Provider"}
        size="md"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            provMutation.mutate(provForm);
          }}
          className="flex flex-col gap-5"
        >
          <Input
            label="ID"
            value={provForm.id}
            onChange={(e) => setProvForm({ ...provForm, id: e.target.value })}
            required
            disabled={!!editingProvId}
            hint="Unique identifier, e.g. my-openai"
          />
          <Select
            label="Kind"
            options={PROVIDER_KINDS}
            value={provForm.kind}
            onChange={(e) => setProvForm({ ...provForm, kind: e.target.value })}
          />
          <Input
            label="Display Name"
            value={provForm.display_name}
            onChange={(e) => setProvForm({ ...provForm, display_name: e.target.value })}
            required
          />
          <Input
            label="Base URL"
            value={provForm.base_url ?? ""}
            onChange={(e) =>
              setProvForm({ ...provForm, base_url: e.target.value || null })
            }
            placeholder="https://api.openai.com/v1"
          />
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={provForm.enabled ?? true}
              onChange={(e) => setProvForm({ ...provForm, enabled: e.target.checked })}
              className="rounded-sm border-border"
            />
            Enabled
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" type="button" onClick={closeProvModal}>
              Cancel
            </Button>
            <Button type="submit" disabled={provMutation.isPending}>
              {provMutation.isPending ? "Saving..." : editingProvId ? "Update" : "Create"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ── Credential modal ────────────────────────────────── */}
      <Modal
        open={credModalOpen}
        onClose={() => setCredModalOpen(false)}
        title="Credential"
        size="sm"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            credMutation.mutate();
          }}
          className="flex flex-col gap-5"
        >
          <Select
            label="Auth Kind"
            options={AUTH_KINDS}
            value={credForm.auth_kind}
            onChange={(e) => setCredForm({ ...credForm, auth_kind: e.target.value })}
          />
          <Input
            label="Secret Reference"
            value={credForm.secret_ref}
            onChange={(e) => setCredForm({ ...credForm, secret_ref: e.target.value })}
            required={
              !providers?.find((p) => p.id === credProvId)?.has_credential
            }
            placeholder={
              providers?.find((p) => p.id === credProvId)?.has_credential
                ? "leave blank to keep existing"
                : "sk-..."
            }
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setCredModalOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={credMutation.isPending}>
              {credMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ── Model modal ─────────────────────────────────────── */}
      <Modal
        open={modelModalOpen}
        onClose={() => setModelModalOpen(false)}
        title={editingModelId ? "Edit Model" : "Add Model"}
        size="md"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            modelMutation.mutate();
          }}
          className="flex flex-col gap-5"
        >
          <Input
            label="Model ID"
            value={modelForm.model_id ?? ""}
            onChange={(e) => setModelForm({ ...modelForm, model_id: e.target.value })}
            required
            disabled={!!editingModelId}
            hint="Provider's model identifier, e.g. gpt-4o"
          />
          <Input
            label="Display Name"
            value={modelForm.display_name ?? ""}
            onChange={(e) =>
              setModelForm({ ...modelForm, display_name: e.target.value || null })
            }
            placeholder="Optional friendly name"
          />
          <Input
            label="Temperature"
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={modelForm.temperature ?? ""}
            onChange={(e) =>
              setModelForm({
                ...modelForm,
                temperature: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
          <Input
            label="Max Tokens"
            type="number"
            min={1}
            step={1}
            value={modelForm.max_tokens ?? ""}
            onChange={(e) =>
              setModelForm({
                ...modelForm,
                max_tokens: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
          <Input
            label="Top P"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={modelForm.top_p ?? ""}
            onChange={(e) =>
              setModelForm({
                ...modelForm,
                top_p: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
          <Select
            label="Thinking Level"
            options={THINKING_LEVELS}
            value={modelForm.thinking_level ?? ""}
            onChange={(e) =>
              setModelForm({
                ...modelForm,
                thinking_level: e.target.value || null,
              })
            }
          />
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={modelForm.enabled ?? true}
              onChange={(e) => setModelForm({ ...modelForm, enabled: e.target.checked })}
              className="rounded-sm border-border"
            />
            Enabled
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setModelModalOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={modelMutation.isPending}>
              {modelMutation.isPending ? "Saving..." : editingModelId ? "Update" : "Add"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────

function CreditStatus({ has_secret }: { has_secret: boolean }) {
  if (!has_secret) {
    return (
      <Badge variant="destructive" className="gap-1">
        no credential
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="gap-1 font-mono">
      configured
    </Badge>
  );
}
