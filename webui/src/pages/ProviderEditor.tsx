import { useState, useEffect } from "react";
import { usePageEnter } from "../hooks/useAnimations";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type {
  ProviderView,
  LlmModel,
  RefreshedModel,
  ModelInfo,
  ProviderBody,
  ModelBody,
} from "../api/types";
import Card from "../components/ui/Card";
import Modal from "../components/ui/Modal";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import { ArrowLeft, Save, Loader2 } from "lucide-react";

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

function emptyModelBody(): ModelBody {
  return { model_id: "" };
}

// ── Page component ─────────────────────────────────────────────

export default function ProviderEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  // ── Provider query ─────────────────────────────────────────
  const {
    data: provider,
    isLoading,
    error,
  } = useQuery<ProviderView>({
    queryKey: ["provider", id],
    queryFn: () => api.getProvider(id!),
    enabled: !!id,
  });

  // ── Provider editing state ──────────────────────────────────
  const [apiKey, setApiKey] = useState("");
  const [editKind, setEditKind] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");

  // ── Model fetch state ───────────────────────────────────────
  const [availableModels, setAvailableModels] = useState<RefreshedModel[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  // ── Model settings modal state ──────────────────────────────
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [settingsForm, setSettingsForm] = useState<ModelBody>(emptyModelBody());
  const [extraBodyJsonText, setExtraBodyJsonText] = useState("");
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [modelInfoLoading, setModelInfoLoading] = useState(false);
  const [deleteModelConfirm, setDeleteModelConfirm] = useState<string | null>(null);

  // Sync edit form when provider data arrives or changes
  useEffect(() => {
    if (provider) {
      setEditKind(provider.kind);
      setEditBaseUrl(provider.base_url || DEFAULT_BASE_URLS[provider.kind] || "");
      setApiKey(provider.secret_ref ?? "");
    }
  }, [provider]);

  // ── Derived ──────────────────────────────────────────────────
  const configuredModelIds = new Set(provider?.models.map((m) => m.model_id) ?? []);
  const unconfiguredModels = availableModels.filter((m) => !configuredModelIds.has(m.id));

  // ── Provider mutation ───────────────────────────────────────

  const saveProvMutation = useMutation({
    mutationFn: async () => {
      if (!provider) return;
      const body: ProviderBody = {
        id: provider.id,
        kind: editKind,
        base_url: editBaseUrl || null,
      };
      await api.updateProvider(provider.id, body);
      if (apiKey) {
        await api.upsertCredential(provider.id, {
          auth_kind: "api_key",
          secret_ref: apiKey,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["provider", id] });
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", "Provider updated.");
      navigate("/providers");
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  // ── Model mutations ──────────────────────────────────────────

  const modelMutation = useMutation({
    mutationFn: (body: ModelBody) => {
      if (!provider) throw new Error("No provider loaded");
      return api.upsertModel(provider.id, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["provider", id] });
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
      queryClient.invalidateQueries({ queryKey: ["provider", id] });
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
    if (provider) {
      setModelInfoLoading(true);
      setModelInfo(null);
      try {
        const info = await api.getModelInfo(provider.id, model.model_id);
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
    if (!provider) return;
    setFetchingModels(true);
    try {
      // Auto-save provider config + credential before fetching models
      if (editKind !== provider.kind || editBaseUrl !== (provider.base_url ?? "") || apiKey) {
        await api.updateProvider(provider.id, {
          id: provider.id,
          kind: editKind,
          base_url: editBaseUrl || null,
        });
        if (apiKey) {
          await api.upsertCredential(provider.id, {
            auth_kind: "api_key",
            secret_ref: apiKey,
          });
        }
      }
      const models = await api.refreshModels(provider.id);
      setAvailableModels(models);
    } catch (err) {
      toast.add("error", (err as Error).message);
    } finally {
      setFetchingModels(false);
    }
  };

  const addAvailableModel = async (model: RefreshedModel) => {
    if (!provider) return;
    try {
      await api.upsertModel(provider.id, { model_id: model.id });
      queryClient.invalidateQueries({ queryKey: ["provider", id] });
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", `Model "${model.id}" added.`);
      setAvailableModels((prev) => prev.filter((m) => m.id !== model.id));
    } catch (err) {
      toast.add("error", (err as Error).message);
    }
  };

  // ── Loading / Error states ───────────────────────────────────


  const pageRef = usePageEnter<HTMLDivElement>();
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-muted-fg" />
      </div>
    );
  }

  if (error || !provider) {
    return (
      <div className="animate-fade-up py-20 text-center">
        <p className="text-sm text-destructive font-medium mb-4">
          {error ? (error as Error).message : "Provider not found"}
        </p>
        <Button variant="secondary" onClick={() => navigate("/providers")}>
          <ArrowLeft size={14} />
          Back to Providers
        </Button>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────

  return (
    <div ref={pageRef} className="space-y-6 md:space-y-8">
      <Link
        to="/providers"
        className="t-label text-muted-fg hover:text-fg transition-colors inline-flex items-center gap-1"
      >
        <ArrowLeft size={12} />
        Providers
      </Link>

      <div>
        <h1 className="t-display">{provider.id}</h1>
        <p className="t-mono text-muted-fg mt-2">{provider.kind}</p>
      </div>
      <div className="rule-heavy" />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Config Card ──────────────────────────── */}
        <Card className="space-y-4">
          <div>
            <h2 className="t-headline !text-lg">Configuration</h2>
            <p className="t-label text-muted-fg mt-1">Provider connection and credentials</p>
          </div>

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
        </Card>

        {/* ── Models Card ──────────────────────────── */}
        <Card className="space-y-4">
          <div>
            <h2 className="t-headline !text-lg">Models</h2>
            <p className="t-label text-muted-fg mt-1">Configured and available models</p>
          </div>

          <div className="flex items-center justify-between">
            <span className="t-label text-muted-fg">
              {provider.models.length} configured
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleFetchModels}
              disabled={fetchingModels}
            >
              {fetchingModels ? "Fetching..." : "Fetch"}
            </Button>
          </div>

          {provider.models.length === 0 && unconfiguredModels.length === 0 && (
            <p className="t-body text-muted-fg py-4">No models configured.</p>
          )}

          {provider.models.length > 0 && (
            <div className="border border-border rounded-sm overflow-hidden">
              {provider.models.map((m) => (
                <div
                  key={m.model_id}
                  className="flex items-center gap-3 px-3 py-2 border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                >
                  <span className="t-mono text-sm flex-1 min-w-0 truncate">{m.model_id}</span>
                  <Button variant="ghost" size="sm" onClick={() => openModelSettings(m)} title="Settings">⚙</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteModelConfirm(m.model_id)}
                    title="Delete model"
                  >✕</Button>
                </div>
              ))}
            </div>
          )}

          {unconfiguredModels.length > 0 && (
            <div className="space-y-2">
              <h4 className="t-label text-muted-fg">Available</h4>
              <div className="border border-border rounded-sm overflow-hidden">
                {unconfiguredModels.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => addAvailableModel(m)}
                    className="w-full text-left px-3 py-2 text-sm border-b border-border last:border-0 hover:bg-muted/30 transition-colors flex items-center gap-2"
                  >
                    <span className="text-accent">+</span>
                    <span className="t-mono">{m.id}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* ── Save button ─────────────────────────────────────── */}
      <div className="rule-thin" />
      <div className="flex justify-end">
        <Button onClick={() => saveProvMutation.mutate()} disabled={saveProvMutation.isPending} size="lg">
          {saveProvMutation.isPending ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Save size={16} />
          )}
          Save
        </Button>
      </div>

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
          {!modelInfoLoading && !modelInfo && (
            <p className="t-body text-muted-fg text-sm">
              Model not recognized by Pi — no capability data available. Parameters
              use the OpenAI standard format; thinking level is not offered.
            </p>
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
                <span className="t-mono">{modelInfo.contextWindow?.toLocaleString() ?? "—"}</span>
                <span className="text-muted-fg">Input Types</span>
                <span className="t-mono">{(modelInfo.input ?? []).join(", ") || "none"}</span>
              </div>
            </div>
          )}

          {/* ── Thinking Level ────────────────────────────────── */}
          {modelInfo && (modelInfo.thinkingLevels?.length ?? 0) > 0 && (
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

          {/* ── Temperature (OpenAI standard; shown for unknown models too) ── */}
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

          {/* ── Max Tokens ────────────────────────────────────── */}
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
            placeholder={
              modelInfo ? `Up to ${modelInfo.maxTokens?.toLocaleString() ?? "—"}` : "e.g. 4096"
            }
          />

          {/* ── Top P ─────────────────────────────────────────── */}
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

          {/* ── Extra Body JSON ───────────────────────────────── */}
          <div>
            <label className="block t-label mb-1">Extra Body JSON</label>
            <textarea
              value={extraBodyJsonText}
              onChange={(e) => setExtraBodyJsonText(e.target.value)}
              rows={6}
              className="w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-y"
              placeholder={'{"key": "value"}'}
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

      <ConfirmDialog
        open={deleteModelConfirm !== null}
        title="Delete Model"
        message={`Delete "${deleteModelConfirm}"? This cannot be undone.`}
        onConfirm={() => {
          deleteModelMutation.mutate({ providerId: provider.id, modelId: deleteModelConfirm! });
          setDeleteModelConfirm(null);
        }}
        onCancel={() => setDeleteModelConfirm(null)}
      />
    </div>
  );
}
