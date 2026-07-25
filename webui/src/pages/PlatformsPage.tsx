import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, ChevronDown, ChevronRight, X, Trash2, Link2 } from "lucide-react";
import { api } from "../api/client";
import type { AccountView, Binding, BotProfile, AccountBody } from "../api/types";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Modal from "../components/ui/Modal";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import { cn } from "../lib/utils";
import { useToast } from "../components/ui/Toast";

type AccountForm = {
  id: string;
  platform: string;
  mode: string;
  enabled: boolean;
  secret_ref: string;
};

const emptyForm: AccountForm = {
  id: "",
  platform: "telegram",
  mode: "telegram",
  enabled: true,
  secret_ref: "",
};

function accountToForm(a: AccountView): AccountForm {
  return {
    id: a.id,
    platform: a.platform,
    mode: a.adapter_id,
    enabled: a.enabled,
    secret_ref: a.secret_ref,
  };
}

export default function PlatformsPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const { data: accounts = [], isLoading: acctsLoading, error: acctsError } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.listAccounts(),
  });
  const { data: bindings = [] } = useQuery({
    queryKey: ["bindings"],
    queryFn: () => api.listBindings(),
  });
  const { data: bots = [] } = useQuery({
    queryKey: ["bots"],
    queryFn: () => api.listBots(),
  });

  const botsById = new Map(bots.map((b: BotProfile) => [b.id, b]));

  // -- expand/collapse state --
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // -- account modal --
  const [acctModal, setAcctModal] = useState(false);
  const [editing, setEditing] = useState<AccountView | null>(null);
  const [acctForm, setAcctForm] = useState<AccountForm>(emptyForm);

  const openNew = () => {
    setEditing(null);
    setAcctForm(emptyForm);
    setAcctModal(true);
  };
  const openEdit = (a: AccountView) => {
    setEditing(a);
    setAcctForm(accountToForm(a));
    setAcctModal(true);
  };

  const acctMut = useMutation({
    mutationFn: async () => {
      const body: AccountBody = {
        id: acctForm.id,
        platform: acctForm.platform,
        adapter_id: acctForm.mode,
        enabled: acctForm.enabled,
        adapter_config_json: {},
        json_ext: {},
      };

      if (editing) {
        if (acctForm.secret_ref) {
          body.secret_ref = acctForm.secret_ref;
        }
        await api.updateAccount(editing.id, body);
      } else {
        body.secret_ref = acctForm.secret_ref || undefined;
        await api.createAccount(body);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["bindings"] });
      setAcctModal(false);
      toast.add("success", editing ? "Bot updated." : "Bot created.");
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  const deleteAcct = useMutation({
    mutationFn: (id: string) => api.deleteAccount(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["bindings"] });
      toast.add("success", "Bot deleted.");
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  const toggleEnabled = useMutation({
    mutationFn: async (a: AccountView) => {
      await api.updateAccount(a.id, {
        id: a.id,
        platform: a.platform,
        adapter_id: a.adapter_id,
        enabled: !a.enabled,
        adapter_config_json: a.adapter_config_json,
        json_ext: a.json_ext,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
    onError: (e: Error) => toast.add("error", e.message),
  });


  // -- attach modal --
  const [attachModalOpen, setAttachModalOpen] = useState(false);
  const [attachAcct, setAttachAcct] = useState<string>("");
  const [attachConfigId, setAttachConfigId] = useState("");

  const attachMut = useMutation({
    mutationFn: async (accountId: string) => {
      const bindingId = `${accountId}-${attachConfigId}-${Date.now().toString(36)}`;
      await api.createBinding({
        id: bindingId,
        account_id: accountId,
        bot_profile_id: attachConfigId,
        chat_pattern: "dm:*",
        session_mode: "dm",
        priority: 10,
        enabled: true,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bindings"] });
      setAttachModalOpen(false);
      setAttachConfigId("");
      toast.add("success", "Config attached.");
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  const detachMut = useMutation({
    mutationFn: (id: string) => api.deleteBinding(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bindings"] });
      toast.add("success", "Config detached.");
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  const confirmDetach = (bindingId: string) => {
    if (window.confirm("Detach this config?")) {
      detachMut.mutate(bindingId);
    }
  };

  const accountBinding = (accountId: string): Binding | undefined =>
    bindings.find((b) => b.account_id === accountId);

  return (
    <div className="animate-fade-up space-y-6">
      {/* ── Page header — typographic ── */}
      <div>
        <h1 className="t-display">Platforms</h1>
        <p className="t-body text-muted-fg mt-3 max-w-lg">
          Manage messaging accounts and attached configs
        </p>
      </div>

      <div className="rule-heavy" />

      {/* ── Action bar ── */}
      <div className="flex items-center justify-between">
        <span className="t-label text-muted-fg">
          {accounts.length} bot{accounts.length !== 1 ? "s" : ""}
        </span>
        <Button onClick={openNew} size="lg">
          <Plus size={15} />
          New Bot
        </Button>
      </div>

      {/* ── Loading / Error ── */}
      {acctsLoading && (
        <div className="py-16 text-center">
          <span className="t-body text-muted-fg">Loading accounts…</span>
        </div>
      )}
      {acctsError && (
        <div className="py-16 text-center">
          <span className="t-body text-destructive">{(acctsError as Error).message}</span>
        </div>
      )}

      {/* ── Empty state ── */}
      {!acctsLoading && !acctsError && accounts.length === 0 && (
        <div className="halftone-light py-20 px-8 text-center border border-border rounded-sm">
          <p className="t-body text-muted-fg">
            No bots yet. Create one to get started.
          </p>
        </div>
      )}

      {/* ── Decorative halftone block ── */}
      {accounts.length > 0 && (
        <div className="halftone h-20 rounded-none opacity-30" />
      )}

      {/* ── Account cards ── */}
      {accounts.length > 0 && (
        <div className="space-y-4">
          {accounts.map((a) => {
            const isOpen = expanded.has(a.id);
            const attached = accountBinding(a.id);

            return (
              <div key={a.id}>
                <Card padding="none">
                  {/* Card body — horizontal full-width */}
                  <div className="flex items-center justify-between px-4 py-3">
                    <button
                      className="flex items-center gap-3 text-left flex-1 min-w-0 cursor-pointer"
                      onClick={() => toggleExpanded(a.id)}
                    >
                      <span className="text-muted-fg shrink-0">
                        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </span>
                      <div className="min-w-0">
                        <h3 className="t-headline truncate">{a.id}</h3>
                        <div className="flex items-center flex-wrap gap-1.5 mt-1.5">
                          <code className="t-mono text-[11px] text-muted-fg">{a.id}</code>
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center gap-1 shrink-0 ml-4">
                      <button
                        onClick={() => toggleEnabled.mutate(a)}
                        className={cn(
                          "relative w-8 h-5 rounded-full transition-colors duration-200",
                          a.enabled ? "bg-fg" : "bg-border"
                        )}
                      >
                        <span
                          className={cn(
                            "absolute top-[3px] left-0 w-3.5 h-3.5 rounded-full bg-white transition-transform duration-200 shadow-sm",
                            a.enabled ? "translate-x-[15px]" : "translate-x-[2px]"
                          )}
                        />
                      </button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(a)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          if (window.confirm(`Delete bot "${a.id}"?`)) {
                            deleteAcct.mutate(a.id);
                          }
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>

                  {/* ── Expanded: Attached config ── */}
                  {isOpen && (
                    <div className="border-t border-border px-5 py-4 space-y-3 bg-muted/20">
                      <span className="t-label text-muted-fg">Attached Config</span>

                      {attached ? (
                        <div className="flex items-center justify-between py-2 px-3 border border-border rounded-sm bg-card text-xs">
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <Link
                              to={`/config/${attached.bot_profile_id}`}
                              className="t-headline !text-sm hover:underline truncate"
                            >
                              {attached.bot_profile_id}
                            </Link>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive shrink-0 ml-2"
                            onClick={() => confirmDetach(attached.id)}
                          >
                            <X size={14} />
                            Detach
                          </Button>
                        </div>
                      ) : (
                        <div className="py-3 text-center halftone-light rounded-sm">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { setAttachAcct(a.id); setAttachConfigId(""); setAttachModalOpen(true); }}
                          >
                            <Link2 size={14} />
                            Attach Config
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Account Modal ── */}
      <Modal
        open={acctModal}
        onClose={() => setAcctModal(false)}
        title={editing ? "Edit Bot" : "New Bot"}
        size="lg"
      >
        <div className="space-y-5">
          {/* Row 1: ID + Platform */}
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="ID"
              value={acctForm.id}
              onChange={(e) => setAcctForm({ ...acctForm, id: e.target.value })}
              placeholder="e.g. my-telegram-bot"
              disabled={!!editing}
            />
            <Select
              label="Platform"
              value={acctForm.platform}
              onChange={(e) => setAcctForm({ ...acctForm, platform: e.target.value })}
              options={[{ value: "telegram", label: "Telegram" }]}
            />
          </div>

          {/* Row 2: Mode + Secret Ref */}
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Connection Mode"
              value={acctForm.mode}
              onChange={(e) => setAcctForm({ ...acctForm, mode: e.target.value })}
              options={[
                { value: "telegram", label: "Long Polling (getUpdates)" },
              ]}
            />
            <Input
              label="Secret Ref"
              value={acctForm.secret_ref}
              onChange={(e) => setAcctForm({ ...acctForm, secret_ref: e.target.value })}
              placeholder="Bot token from @BotFather"
            />

          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button variant="secondary" onClick={() => setAcctModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => acctMut.mutate()}
              disabled={acctMut.isPending || !acctForm.id}
            >
              {acctMut.isPending ? "Saving…" : editing ? "Save Changes" : "Create Bot"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Attach Config Modal ── */}
      <Modal
        open={attachModalOpen}
        onClose={() => setAttachModalOpen(false)}
        title="Attach Config"
        size="sm"
      >
        <div className="space-y-4">
          <Select
            label="Config"
            value={attachConfigId}
            onChange={(e) => setAttachConfigId(e.target.value)}
            options={[
              { value: "", label: "Select a config…" },
              ...bots.map((b) => ({ value: b.id, label: b.id })),
            ]}
          />
          <div className="flex justify-end gap-2">
            <Button
              disabled={!attachConfigId || attachMut.isPending}
              onClick={() => attachMut.mutate(attachAcct)}
            >
              {attachMut.isPending ? "Attaching…" : "Attach"}
            </Button>
          </div>
        </div>
      </Modal>

    </div>
  );
}
