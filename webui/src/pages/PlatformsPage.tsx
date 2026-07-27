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
            <Card key={a.id} padding="none" className="hover:border-fg/30 transition-colors flex flex-col">
              <div className="p-4 flex-1">
                <div className="flex items-start justify-between mb-3">
                  <h3
                    className="t-headline !text-xl truncate cursor-pointer hover:underline"
                    onClick={() => navigate(`/platforms/${a.id}`)}
                  >
                    {a.id}
                  </h3>
                  <button
                    onClick={() => toggleEnabled.mutate(a)}
                    className={cn(
                      "relative w-8 h-5 rounded-full transition-colors duration-200 shrink-0 ml-2",
                      a.enabled ? "bg-fg" : "bg-border"
                    )}
                  >
                    <span className={cn(
                      "absolute top-[3px] left-0 w-3.5 h-3.5 rounded-full bg-white transition-transform duration-200 shadow-sm",
                      a.enabled ? "translate-x-[15px]" : "translate-x-[2px]"
                    )} />
                  </button>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-fg">
                  <span className="t-mono">{a.platform}</span>
                  <span>{a.enabled ? "● enabled" : "○ disabled"}</span>
                </div>
              </div>
              <div className="flex border-t border-border">
                <button
                  onClick={() => navigate(`/platforms/${a.id}`)}
                  className="flex-1 py-2 text-xs text-muted-fg hover:text-fg hover:bg-muted/50 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Delete "${a.id}"?`)) deleteAcct.mutate(a.id);
                  }}
                  className="px-3 py-2 text-xs text-destructive hover:bg-destructive/5 transition-colors border-l border-border"
                >
                  <Trash2 size={13} />
                </button>
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
