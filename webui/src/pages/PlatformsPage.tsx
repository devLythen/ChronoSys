import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Globe } from "lucide-react";
import { api } from "../api/client";
import type { AccountView } from "../api/types";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Modal from "../components/ui/Modal";
import Input from "../components/ui/Input";
import { cn } from "../lib/utils";
import { useToast } from "../components/ui/Toast";
import { usePageEnter, useStaggerList } from "../hooks/useAnimations";
import ConfirmDialog from "../components/ui/ConfirmDialog";

export default function PlatformsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const { data: accounts = [], isLoading, error } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.listAccounts(),
  });
  const pageRef = usePageEnter<HTMLDivElement>();
  const gridRef = useStaggerList<HTMLDivElement>([accounts]);

  const [newModalOpen, setNewModalOpen] = useState(false);
  const [newId, setNewId] = useState("");

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const toggleEnabled = useMutation({
    mutationFn: async (a: AccountView) => {
      await api.updateAccount(a.id, {
        id: a.id, platform: a.platform, adapter_id: a.adapter_id,
        enabled: !a.enabled,
        adapter_config_json: a.adapter_config_json, json_ext: a.json_ext,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
    onError: (e: Error) => toast.add("error", e.message),
  });

  const createMut = useMutation({
    mutationFn: (id: string) => api.createAccount({ id, platform: "telegram", adapter_id: "chrono.adapter.telegram" }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      setNewModalOpen(false);
      setNewId("");
      navigate(`/platforms/${id}`);
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  const deleteAcct = useMutation({
    mutationFn: (id: string) => api.deleteAccount(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      toast.add("success", "Bot deleted.");
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  const handleDelete = (a: AccountView) => {
    setDeleteConfirm(a.id);
  };

  const handleCreate = () => {
    const trimmed = newId.trim();
    if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) return;
    createMut.mutate(trimmed);
  };

  return (
    <div ref={pageRef} className="space-y-6 md:space-y-8">
      <div>
        <h1 className="t-display">Platforms</h1>
        <p className="t-body text-muted-fg mt-3 max-w-xl">
          Manage messaging accounts and platform connections.
        </p>
      </div>
      <div className="rule-heavy" />

      <div className="flex items-center justify-between">
        <p className="t-label text-muted-fg">
          {accounts.length} bot{accounts.length !== 1 ? "s" : ""}
        </p>
        <Button onClick={() => { setNewId(""); setNewModalOpen(true); }}>
          <Plus size={16} />
          New Bot
        </Button>
      </div>

      {isLoading && (
        <div className="py-16 text-center">
          <p className="t-body text-muted-fg">Loading&hellip;</p>
        </div>
      )}
      {error && (
        <div className="py-16 text-center">
          <p className="text-sm text-destructive font-medium">{(error as Error).message}</p>
        </div>
      )}
      {!isLoading && !error && accounts.length === 0 && (
        <div className="halftone-light py-24 text-center border border-border">
          <p className="t-headline text-muted-fg/60 mb-3">No bots yet</p>
          <p className="t-body text-muted-fg/70 mb-6">Add a platform account to get started.</p>
          <Button onClick={() => { setNewId(""); setNewModalOpen(true); }}>
            <Plus size={16} /> New Bot
          </Button>
        </div>
      )}

      {accounts.length > 0 && (
        <div ref={gridRef} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {accounts.map((a) => (
            <Card
              key={a.id}
              className="anim-item hover:border-fg/30 transition-colors group flex flex-col"
              padding="none"
            >
              <div
                onClick={() => navigate(`/platforms/${a.id}`)}
                className="p-4 flex-1 cursor-pointer"
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="t-headline !text-xl truncate">{a.id}</h3>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={a.enabled}
                    onClick={(e) => { e.stopPropagation(); toggleEnabled.mutate(a); }}
                    className={`relative w-8 h-5 rounded-full transition-colors duration-200 focus:outline-none focus:ring-1 focus:ring-fg shrink-0 ml-2 ${
                      a.enabled ? "bg-fg" : "bg-border"
                    }`}
                  >
                    <span
                      className={`absolute top-[3px] left-0 w-3.5 h-3.5 rounded-full bg-white transition-transform duration-200 shadow-sm ${
                        a.enabled ? "translate-x-[15px]" : "translate-x-[2px]"
                      }`}
                    />
                  </button>
                </div>
                <div className="space-y-1.5 text-xs text-muted-fg">
                  <div className="flex items-center gap-1.5">
                    <Globe size={11} className="shrink-0" />
                    <span className="t-mono truncate">{a.platform.charAt(0).toUpperCase() + a.platform.slice(1)}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 pl-2 pr-4 py-2 border-t border-border bg-muted/30">
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(a);
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

      <Modal open={newModalOpen} onClose={() => setNewModalOpen(false)} title="New Bot" size="sm">
        <div className="space-y-4">
          <Input
            label="ID"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="e.g. my-telegram-bot"
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          />
          <p className="text-[11px] text-muted-fg">After creation you&apos;ll be redirected to configure the bot.</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setNewModalOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newId.trim()}>Create</Button>
          </div>
        </div>
      </Modal>
      <ConfirmDialog
        open={deleteConfirm !== null}
        title="Delete Account"
        message={`Delete "${deleteConfirm}"? This cannot be undone.`}
        onConfirm={() => {
          deleteAcct.mutate(deleteConfirm!);
          setDeleteConfirm(null);
        }}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}
