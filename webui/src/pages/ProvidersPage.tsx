import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type {
  ProviderView,
  ProviderBody,
} from "../api/types";
import Button from "../components/ui/Button";
import { Plus } from "lucide-react";
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

// ── Page component ─────────────────────────────────────────────

export default function ProvidersPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const {
    data: providers,
    isLoading,
    error,
  } = useQuery<ProviderView[]>({
    queryKey: ["providers"],
    queryFn: () => api.listProviders(),
  });

  // ── Add Provider modal ───────────────────────────────────────
  const [provModalOpen, setProvModalOpen] = useState(false);
  const [provForm, setProvForm] = useState<ProviderBody>({ id: "", kind: "openai", base_url: DEFAULT_BASE_URLS["openai"] });
  const [apiKey, setApiKey] = useState("");

  // ── Derived ──────────────────────────────────────────────────
  const list = providers ?? [];

  const openCreateProv = () => {
    setProvForm({ id: "", kind: "openai", base_url: DEFAULT_BASE_URLS["openai"] });
    setApiKey("");
    setProvModalOpen(true);
  };

  // ── Provider mutations ───────────────────────────────────────

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

  const deleteProvMutation = useMutation({
    mutationFn: (id: string) => api.deleteProvider(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.add("success", "Provider deleted.");
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="animate-fade-up space-y-6 md:space-y-8">
      {/* ── Header ──────────────────────────────────────────── */}
      <div>
        <h1 className="t-display">Providers</h1>
        <p className="t-body text-muted-fg mt-3 max-w-xl">
          Configure LLM providers and their models for the ChronoSys gateway.
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="t-label text-muted-fg">
            {list ? `${list.length} provider${list.length !== 1 ? "s" : ""}` : "—"}
          </p>
          <Button onClick={openCreateProv}>
            <Plus size={16} />
            New Provider
          </Button>
        </div>
        <div className="rule-heavy" />
      </div>

      {isLoading && (
        <div className="py-16 text-center">
          <p className="t-body text-muted-fg">Loading providers&hellip;</p>
        </div>
      )}

      {error && (
        <div className="py-16 text-center">
          <p className="text-sm text-destructive font-medium">
            Failed to load providers: {(error as Error).message}
          </p>
        </div>
      )}

      {!isLoading && !error && list.length === 0 && (
        <div className="halftone-light py-24 text-center border border-border">
          <p className="t-headline text-muted-fg/60 mb-3">No providers yet</p>
          <p className="t-body text-muted-fg/70 mb-6">Add one to get started.</p>
          <Button onClick={openCreateProv}>
            <Plus size={16} />
            New Provider
          </Button>
        </div>
      )}

      {/* ── Provider cards ──────────────────────────────────── */}
      {list.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {list.map((pv) => (
            <Card
              key={pv.id}
              className="cursor-pointer hover:border-fg/30 transition-colors flex flex-col"
              padding="none"
              onClick={() => navigate(`/providers/${pv.id}`)}
            >
              <div className="p-4 flex-1">
                <div className="flex items-start justify-between mb-3">
                  <h3 className="t-headline !text-xl truncate">{pv.id}</h3>
                  <span className="t-mono text-[11px] text-muted-fg">{pv.kind}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-fg">
                  <span>{pv.models.length} model{pv.models.length !== 1 ? "s" : ""}</span>
                  {pv.secret_ref && <span className="text-success">● credential set</span>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── Add Provider modal ──────────────────────────────── */}
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
    </div>
  );
}
