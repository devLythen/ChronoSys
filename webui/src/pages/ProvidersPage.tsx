import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type {
  ProviderView,
  LlmModel,
  RefreshedModel,
  ProviderBody,
  ModelBody,
  ModelInfo,
} from "../api/types";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import Card from "../components/ui/Card";
import Modal from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";

// ── Constants ──────────────────────────────────────────────────

const PROVIDER_KINDS = [
  { value: "openai", label: "OpenAI / OpenAI-Compatible" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "anthropic", label: "Anthropic" },
];

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};


// ── Empty form state ──────────────────────────────────────────

function emptyProviderBody(): ProviderBody {
  return { id: "", kind: "openai", base_url: DEFAULT_BASE_URLS["openai"] };
}

function emptyModelBody(): ModelBody {
  return { model_id: "" };
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

  // ── Selection ────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── Inline provider editing ──────────────────────────────────
  const [apiKey, setApiKey] = useState("");
  const [editKind, setEditKind] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");

  // ── Add Provider modal ───────────────────────────────────────
  const [provModalOpen, setProvModalOpen] = useState(false);
  const [provForm, setProvForm] = useState<ProviderBody>(emptyProviderBody());

  const [availableModels, setAvailableModels] = useState<RefreshedModel[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  // ── Model settings modal ─────────────────────────────────────
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [settingsForm, setSettingsForm] = useState<ModelBody>(emptyModelBody());
  const [extraBodyJsonText, setExtraBodyJsonText] = useState("");
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [modelInfoLoading, setModelInfoLoading] = useState(false);
  // ── Derived ──────────────────────────────────────────────────
  const list = providers ?? [];
  const selected = selectedId ? list.find((p) => p.id === selectedId) ?? null : null;

  // Sync edit form when selected changes
  useEffect(() => {
    if (selected) {
      setEditKind(selected.kind);
      setEditBaseUrl(selected.base_url ?? "");
      setApiKey(selected.secret_ref ?? "");
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select first provider
  useEffect(() => {
    if (list.length > 0) {
      if (!selectedId || !list.find((p) => p.id === selectedId)) {
        setSelectedId(list[0].id);
      }
    } else {
      setSelectedId(null);
    }
  }, [list, selectedId]);

  const configuredModelIds = new Set(selected?.models.map((m) => m.model_id) ?? []);
  const unconfiguredModels = availableModels.filter((m) => !configuredModelIds.has(m.id));

  // ── Provider mutations ───────────────────────────────────────

  const openCreateProv = () => {
    setProvForm(emptyProviderBody());
    setProvModalOpen(true);
  };

  const provCreateMutation = useMutation({
    mutationFn: async (body: ProviderBody) => {
      const prov = await api.createProvider(body);
      if (apiKey) {
        await api.upsertCredential(prov.id, {
          auth_kind: "api_key",
          secret_ref: apiKey,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", "Provider created.");
      setProvModalOpen(false);
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  const saveProvMutation = useMutation({
    mutationFn: async () => {
      if (!selected) return;
      const body: ProviderBody = {
        id: selected.id,
        kind: editKind,
        base_url: editBaseUrl || null,
      };
      await api.updateProvider(selected.id, body);
      if (apiKey) {
        await api.upsertCredential(selected.id, {
          auth_kind: "api_key",
          secret_ref: apiKey,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", "Provider updated.");
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  const deleteProvMutation = useMutation({
    mutationFn: (id: string) => api.deleteProvider(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", "Provider deleted.");
      if (selectedId === id) {
        setSelectedId(null);
      }
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  // ── Model mutations ──────────────────────────────────────────

  const modelMutation = useMutation({
    mutationFn: (body: ModelBody) => {
      if (!selected) throw new Error("No provider selected");
      return api.upsertModel(selected.id, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", editingModelId ? "Model updated." : "Model added.");
      setModelSettingsOpen(false);
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


  // ── Model settings helpers ───────────────────────────────────

  const openModelSettings = async (model: LlmModel) => {
    setEditingModelId(model.model_id);
    setSettingsForm({
      model_id: model.model_id,
      temperature: model.temperature,
      max_tokens: model.max_tokens,
      top_p: model.top_p,
      thinking_level: model.thinking_level,
      extra_body_json: model.extra_body_json,
    });
    setExtraBodyJsonText(model.extra_body_json ? JSON.stringify(model.extra_body_json, null, 2) : "");
    setModelSettingsOpen(true);
    // Fetch model info on open
    if (selected) {
      setModelInfoLoading(true);
      setModelInfo(null);
      try {
        const info = await api.getModelInfo(selected.id, model.model_id);
        setModelInfo(info);
      } catch {
        setModelInfo(null);
      } finally {
        setModelInfoLoading(false);
      }
    }
  };
  // ── Fetch models ─────────────────────────────────────────────

  const handleFetchModels = async () => {
    if (!selected) return;
    setFetchingModels(true);
    try {
      const models = await api.refreshModels(selected.id);
      setAvailableModels(models);
    } catch (err) {
      toast.add("error", (err as Error).message);
    } finally {
      setFetchingModels(false);
    }
  };
  const addAvailableModel = async (model: RefreshedModel) => {
    if (!selected) return;
    try {
      await api.upsertModel(selected.id, { model_id: model.id });
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", `Model "${model.id}" added.`);
      setAvailableModels((prev) => prev.filter((m) => m.id !== model.id));
    } catch (err) {
      toast.add("error", (err as Error).message);
    }
  };

  // ── Render ───────────────────────────────────────────────────

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

  return (
    <div className="animate-fade-up space-y-6">
      {/* ── Header ──────────────────────────────────────────── */}
      <div>
        <h1 className="t-display !text-4xl md:!text-5xl">Providers</h1>
        <p className="t-body text-muted-fg mt-3 max-w-lg">
          Configure LLM providers and their models for the ChronoSys gateway.
        </p>
      </div>

      <div className="rule-heavy" />

      {/* ── Empty state ─────────────────────────────────────── */}
      {list.length === 0 && (
        <>
          <div className="halftone h-10 opacity-30" />
          <div className="py-20 text-center">
            <p className="t-body text-muted-fg">
              No providers configured. Add one to get started.
            </p>
            <Button className="mt-4" onClick={openCreateProv}>
              Add Provider
            </Button>
          </div>
        </>
      )}

      {/* ── Two-column layout ────────────────────────────────── */}
      {list.length > 0 && (
        <div className="flex gap-0 min-h-[600px]">
          {/* ── Left sidebar ────────────────────────────────── */}
          <aside className="w-56 shrink-0 border-r border-border bg-card">
            <div className="space-y-0.5 py-2">
              {list.map((pv) => (
                <div key={pv.id} className="group relative">
                  <button
                    onClick={() => setSelectedId(pv.id)}
                    className={
                      "w-full text-left px-4 py-2.5 text-sm flex items-center justify-between transition-colors " +
                      (selectedId === pv.id
                        ? "bg-fg text-bg"
                        : "hover:bg-muted text-fg")
                    }
                  >
                    <span className="truncate">{pv.id}</span>
                  </button>
                  <button
                    onClick={() => {
                        deleteProvMutation.mutate(pv.id);
                      if (window.confirm(`Delete provider "${pv.id}"?`)) {
                      }
                    }}
                    className={
                      "absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity " +
                      "text-xs px-1.5 py-0.5 rounded hover:bg-destructive hover:text-destructive-fg " +
                      (selectedId === pv.id ? "text-bg/60 hover:text-destructive-fg" : "text-muted-fg")
                    }
                    title="Delete provider"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="border-t border-border px-3 py-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-fg hover:text-fg"
                onClick={openCreateProv}
              >
                + Add Provider
              </Button>
            </div>
          </aside>

          {/* ── Main area ──────────────────────────────────── */}
          <main className="flex-1 min-w-0">
            {selected ? (
              <div className="px-8 py-6 space-y-6">
                {/* ── Top bar: name + save ─────────────────── */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h2 className="t-headline">
                      Provider: {selected.id}
                    </h2>
                    <span className="t-mono text-sm text-muted-fg">{selected.id}</span>
                  </div>
                  <Button
                    onClick={() => saveProvMutation.mutate()}
                    disabled={saveProvMutation.isPending}
                  >
                    {saveProvMutation.isPending ? "Saving..." : "Save"}
                  </Button>
                </div>

                {/* ── Config card ──────────────────────────── */}
                <Card padding="md">
                  <div className="space-y-4">
                    <Select
                      label="Kind"
                      options={PROVIDER_KINDS}
                      value={editKind}
                      onChange={(e) => {
                        const k = e.target.value;
                        setEditKind(k);
                        setEditBaseUrl(DEFAULT_BASE_URLS[k] ?? editBaseUrl);
                      }}
                    />
                    <Input
                      label="Base URL"
                      value={editBaseUrl}
                      onChange={(e) => setEditBaseUrl(e.target.value)}
                      placeholder="https://api.openai.com/v1"
                    />
                    <Input
                      label="API Key"
                      type="text"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-..."
                    />
                  </div>
                </Card>

                <div className="halftone h-6 opacity-30" />

                {/* ── Model management ──────────────────────── */}
                <div className="flex items-center justify-between">
                  <h3 className="t-headline">Configured Models</h3>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleFetchModels}
                    disabled={fetchingModels}
                  >
                    {fetchingModels ? "Fetching..." : "Fetch Models"}
                  </Button>
                </div>

                {/* Configured models list */}
                {selected.models.length === 0 ? (
                  <p className="t-body text-muted-fg py-4">
                    No models configured for this provider.
                  </p>
                ) : (
                  <div className="border border-border rounded-sm overflow-hidden">
                    {selected.models.map((m) => (
                      <div
                        key={m.model_id}
                        className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                      >
                        <span className="t-mono text-sm flex-1 min-w-0 truncate">
                          {m.model_id}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openModelSettings(m)}
                          title="Settings"
                        >
                          ⚙
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            if (window.confirm(`Delete model "${m.model_id}"?`)) {
                              deleteModelMutation.mutate({
                                providerId: selected.id,
                                modelId: m.model_id,
                              });
                            }
                          }}
                          title="Delete model"
                        >
                          ✕
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Available models */}
                {unconfiguredModels.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="t-label text-muted-fg">Available Models</h4>
                    <div className="border border-border rounded-sm overflow-hidden">
                      {unconfiguredModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => addAvailableModel(m)}
                          className="w-full text-left px-4 py-2.5 text-sm border-b border-border last:border-0 hover:bg-muted/30 transition-colors flex items-center gap-2"
                        >
                          <span className="text-accent">+</span>
                          <span className="t-mono">{m.id}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full py-20">
                <p className="t-body text-muted-fg">Select a provider from the sidebar.</p>
              </div>
            )}
          </main>
        </div>
      )}

      {/* ── Add Provider modal ──────────────────────────────────── */}
      <Modal
        open={provModalOpen}
        onClose={() => setProvModalOpen(false)}
        title="Add Provider"
        size="md"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            provCreateMutation.mutate({
              ...provForm,
              
            });
          }}
          className="flex flex-col gap-5"
        >
          <Input
            label="ID"
            value={provForm.id ?? ""}
            onChange={(e) => setProvForm({ ...provForm, id: e.target.value })}
            required
            hint="Unique identifier, e.g. my-openai"
          />
          <Select
            label="Kind"
            options={PROVIDER_KINDS}
            value={provForm.kind}
            onChange={(e) => {
              const kind = e.target.value;
              setProvForm({
                ...provForm,
                kind,
                base_url: DEFAULT_BASE_URLS[kind] ?? provForm.base_url,
              });
            }}
          />
          <Input
            label="Base URL"
            value={provForm.base_url ?? ""}
            onChange={(e) =>
              setProvForm({ ...provForm, base_url: e.target.value || null })
            }
            placeholder="https://api.openai.com/v1"
          />
          <Input
            label="API Key"
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setProvModalOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={provCreateMutation.isPending}>
              {provCreateMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ── Model settings modal ─────────────────────────────────── */}
      <Modal
        open={modelSettingsOpen}
        onClose={() => setModelSettingsOpen(false)}
        title={editingModelId ? "Edit Model" : "Add Model"}
        size="md"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            let extraBody: Record<string, unknown> | null = null;
            if (extraBodyJsonText.trim()) {
              try {
                extraBody = JSON.parse(extraBodyJsonText);
              } catch {
                toast.add("error", "Invalid JSON in Extra Body field.");
                return;
              }
            }
            const body: ModelBody = {
              model_id: settingsForm.model_id,
              temperature: settingsForm.temperature,
              max_tokens: settingsForm.max_tokens,
              top_p: settingsForm.top_p,
              thinking_level: settingsForm.thinking_level,
              extra_body_json: extraBody,
            };
            modelMutation.mutate(body);
          }}
          className="flex flex-col gap-5"
        >
          <Input
            label="Model ID"
            value={settingsForm.model_id ?? ""}
            disabled
            hint="Provider's model identifier, e.g. gpt-4o"
          />

          {/* ── Capabilities (read-only, fetched on open) ─────── */}
          {modelInfoLoading && (
            <p className="t-body text-muted-fg text-sm">Loading capabilities...</p>
          )}
          {!modelInfoLoading && modelInfo && (
            <div className="space-y-2 rounded-sm border border-border p-3">
              <h4 className="t-label">Capabilities</h4>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <span className="text-muted-fg">Name</span>
                <span className="t-mono">{modelInfo.name}</span>
                <span className="text-muted-fg">Reasoning</span>
                <span>{modelInfo.reasoning ? "Yes" : "No"}</span>
                <span className="text-muted-fg">Context Window</span>
                <span className="t-mono">{modelInfo.contextWindow.toLocaleString()}</span>
                <span className="text-muted-fg">Input Types</span>
                <span className="t-mono">{modelInfo.input.join(", ") || "none"}</span>
              </div>
            </div>
          )}

          {/* ── Thinking Level ────────────────────────────────── */}
          {modelInfo && modelInfo.thinkingLevels.length > 0 && (
            <Select
              label="Thinking Level"
              options={[
                { value: "", label: "(none)" },
                ...modelInfo.thinkingLevels.map((lvl) => ({ value: lvl, label: lvl })),
              ]}
              value={settingsForm.thinking_level ?? ""}
              onChange={(e) =>
                setSettingsForm({ ...settingsForm, thinking_level: e.target.value || null })
              }
            />
          )}

          {/* ── Temperature ───────────────────────────────────── */}
          {modelInfo && (
            <Input
              label="Temperature"
              type="number"
              min="0"
              step="0.1"
              value={settingsForm.temperature != null ? String(settingsForm.temperature) : ""}
              onChange={(e) =>
                setSettingsForm({
                  ...settingsForm,
                  temperature: e.target.value ? Number(e.target.value) : null,
                })
              }
              placeholder="e.g. 0.7"
            />
          )}

          {/* ── Max Tokens ────────────────────────────────────── */}
          {modelInfo && (
            <Input
              label="Max Tokens"
              type="number"
              min="1"
              step="1"
              value={settingsForm.max_tokens != null ? String(settingsForm.max_tokens) : ""}
              onChange={(e) =>
                setSettingsForm({
                  ...settingsForm,
                  max_tokens: e.target.value ? Number(e.target.value) : null,
                })
              }
              placeholder={`Up to ${modelInfo.maxTokens.toLocaleString()}`}
            />
          )}

          {/* ── Top P ─────────────────────────────────────────── */}
          {modelInfo && (
            <Input
              label="Top P"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={settingsForm.top_p != null ? String(settingsForm.top_p) : ""}
              onChange={(e) =>
                setSettingsForm({
                  ...settingsForm,
                  top_p: e.target.value ? Number(e.target.value) : null,
                })
              }
              placeholder="e.g. 0.9"
            />
          )}

          {/* ── Extra Body JSON ───────────────────────────────── */}
          <div>
            <label className="block t-label mb-1">Extra Body JSON</label>
            <textarea
              value={extraBodyJsonText}
              onChange={(e) => setExtraBodyJsonText(e.target.value)}
              rows={6}
              className="w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-y"
              placeholder='{"key": "value"}'
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setModelSettingsOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={modelMutation.isPending}>
              {modelMutation.isPending
                ? "Saving..."
                : editingModelId
                  ? "Update"
                  : "Save"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
