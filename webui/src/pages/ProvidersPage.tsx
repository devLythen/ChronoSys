import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ProviderView } from "../api/types";
import Button from "../components/ui/Button";
import { Plus } from "lucide-react";
import Input from "../components/ui/Input";
import Card from "../components/ui/Card";
import Modal from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";


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
  const [newProvId, setNewProvId] = useState("");

  // ── Derived ──────────────────────────────────────────────────
  const list = providers ?? [];

  const openCreateProv = () => {
    setNewProvId("");
    setProvModalOpen(true);
  };


  // ── Provider mutations ───────────────────────────────────────

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

      <div className="rule-heavy" />
      <div className="flex items-center justify-between">
        <p className="t-label text-muted-fg">
          {list ? `${list.length} provider${list.length !== 1 ? "s" : ""}` : "—"}
        </p>
        <Button onClick={openCreateProv}>
          <Plus size={16} />
          New Provider
        </Button>
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
            if (newProvId.trim()) {
              navigate(`/providers/${newProvId.trim()}`);
            }
          }}
          className="flex flex-col gap-5"
        >
          <Input
            label="ID"
            value={newProvId}
            onChange={(e) => setNewProvId(e.target.value)}
            required
            hint="Unique identifier, e.g. my-openai"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setProvModalOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!newProvId.trim()}>
              Create
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
