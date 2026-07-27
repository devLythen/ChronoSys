import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { AccountView } from "../api/types";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Modal from "../components/ui/Modal";
import Input from "../components/ui/Input";
import { cn } from "../lib/utils";
import { useToast } from "../components/ui/Toast";

export default function PlatformsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const { data: accounts = [], isLoading, error } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.listAccounts(),
  });

  const [newModalOpen, setNewModalOpen] = useState(false);
  const [newId, setNewId] = useState("");

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

  const deleteAcct = useMutation({
    mutationFn: (id: string) => api.deleteAccount(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      toast.add("success", "Bot deleted.");
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  const handleDelete = (a: AccountView) => {
    if (window.confirm(`Delete "${a.id}"? This cannot be undone.`)) {
      deleteAcct.mutate(a.id);
    }
  };

  const handleCreate = () => {
    const trimmed = newId.trim();
    if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) return;
    setNewModalOpen(false);
    setNewId("");
    navigate(`/platforms/${trimmed}`);
  };

  return (
    <div className="animate-fade-up space-y-6 md:space-y-8">
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {accounts.map((a) => (
            <Card
              key={a.id}
              className="cursor-pointer hover:border-fg/30 transition-colors group flex flex-col"
              padding="none"
            >
              <div
                onClick={() => navigate(`/platforms/${a.id}`)}
                className="p-4 flex-1"
              >
                <div className="flex items-start justify-between mb-3">
                  <h3 className="t-headline !text-xl truncate">
                    {a.id}
                  </h3>
                </div>
                <p className="t-mono text-muted-fg mb-3 truncate">
                  {a.id}
                </p>
                <div className="flex items-center gap-2 text-sm text-muted-fg mb-4">
                  <span className="t-mono text-[11px]">{a.platform}</span>
                  <span>·</span>
                  <span className="t-mono text-[11px]">{a.adapter_id}</span>
                </div>
              </div>

              <div className="flex items-center gap-1 px-4 py-2 border-t border-border bg-muted/30">
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
    </div>
  );
}
