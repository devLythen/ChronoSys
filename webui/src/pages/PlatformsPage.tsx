import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, ChevronDown, ChevronRight, X, Trash2, Link2 } from "lucide-react";
import { api } from "../api/client";
import type { AccountView, Binding, BotProfile, AccountBody, BindingBody } from "../api/types";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Modal from "../components/ui/Modal";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";

type AccountForm = {
  id: string;
  platform: string;
  display_name: string;
  adapter_id: string;
  enabled: boolean;
  secret_ref: string;
  bot_username: string;
};

const emptyForm: AccountForm = {
  id: "",
  platform: "telegram",
  display_name: "",
  adapter_id: "",
  enabled: true,
  secret_ref: "",
  bot_username: "",
};

function accountToForm(a: AccountView): AccountForm {
  const cfg = a.adapter_config_json as Record<string, unknown> | undefined;
  return {
    id: a.id,
    platform: a.platform,
    display_name: a.display_name,
    adapter_id: a.adapter_id,
    enabled: a.enabled,
    secret_ref: "",
    bot_username: (cfg?.bot_username as string) ?? "",
  };
}

type AttachForm = {
  bot_profile_id: string;
  chat_pattern: string;
  session_mode: string;
  priority: number;
};

const emptyAttach: AttachForm = {
  bot_profile_id: "",
  chat_pattern: "dm:*",
  session_mode: "dm",
  priority: 10,
};

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
      next.has(id) ? next.delete(id) : next.add(id);
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
        display_name: acctForm.display_name,
        adapter_id: acctForm.adapter_id,
        enabled: acctForm.enabled,
        adapter_config_json: acctForm.bot_username
          ? { bot_username: acctForm.bot_username }
          : undefined,
        json_ext: undefined,
      };
      if (editing) {
        // Only send secret_ref if provided
        if (acctForm.secret_ref) {
          body.secret_ref = acctForm.secret_ref;
        }
        return api.updateAccount(editing.id, body);
      }
      body.secret_ref = acctForm.secret_ref || undefined;
      return api.createAccount(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      setAcctModal(false);
      toast.add("success", editing ? "Account updated." : "Account created.");
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  const deleteAcct = useMutation({
    mutationFn: (id: string) => api.deleteAccount(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      toast.add("success", "Account deleted.");
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  // -- attach modal --
  const [attachModal, setAttachModal] = useState(false);
  const [attachAccountId, setAttachAccountId] = useState("");
  const [attachForm, setAttachForm] = useState<AttachForm>(emptyAttach);

  const openAttach = (accountId: string) => {
    setAttachAccountId(accountId);
    setAttachForm(emptyAttach);
    setAttachModal(true);
  };

  const attachMut = useMutation({
    mutationFn: async () => {
      const id = `${attachAccountId}-${attachForm.bot_profile_id}-${Date.now().toString(36)}`;
      const body: BindingBody = {
        id,
        account_id: attachAccountId,
        bot_profile_id: attachForm.bot_profile_id,
        chat_pattern: attachForm.chat_pattern || undefined,
        session_mode: attachForm.session_mode || undefined,
        priority: attachForm.priority,
        enabled: true,
      };
      return api.createBinding(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bindings"] });
      setAttachModal(false);
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

  const accountBindings = (accountId: string): Binding[] =>
    bindings.filter((b) => b.account_id === accountId);

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
          {accounts.length} account{accounts.length !== 1 ? "s" : ""}
        </span>
        <Button onClick={openNew} size="lg">
          <Plus size={15} />
          New Account
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
            No accounts yet. Create one to get started.
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
            const attached = accountBindings(a.id);

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
                        <h3 className="t-headline truncate">{a.display_name}</h3>
                        <div className="flex items-center flex-wrap gap-1.5 mt-1.5">
                          <code className="t-mono text-[11px] text-muted-fg">{a.id}</code>
                          <Badge variant="default" className="text-[10px]">{a.platform}</Badge>
                          <Badge variant={a.enabled ? "success" : "default"} className="text-[10px]">
                            {a.enabled ? "enabled" : "disabled"}
                          </Badge>
                          {a.has_secret && (
                            <Badge variant="info" className="text-[10px]">has secret</Badge>
                          )}
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center gap-1 shrink-0 ml-4">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(a)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          if (window.confirm(`Delete account "${a.display_name}"?`)) {
                            deleteAcct.mutate(a.id);
                          }
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>

                  {/* ── Expanded: Attached configs ── */}
                  {isOpen && (
                    <div className="border-t border-border px-5 py-4 space-y-3 bg-muted/20">
                      <div className="flex items-center justify-between">
                        <span className="t-label text-muted-fg">Attached configs</span>
                        <Button variant="secondary" size="sm" onClick={() => openAttach(a.id)}>
                          <Link2 size={13} />
                          Attach Config
                        </Button>
                      </div>

                      {attached.length === 0 ? (
                        <p className="t-body text-muted-fg py-3 text-center halftone-light">
                          No configs attached
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {attached.map((b) => {
                            const bot = botsById.get(b.bot_profile_id);
                            return (
                              <div
                                key={b.id}
                                className="flex items-center justify-between py-2 px-3 border border-border rounded-sm bg-card text-xs"
                              >
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <Link
                                    to={`/config/${b.bot_profile_id}`}
                                    className="t-headline !text-sm hover:underline truncate"
                                  >
                                    {bot?.display_name ?? b.bot_profile_id}
                                  </Link>
                                  {bot && (
                                    <code className="t-mono text-[10px] text-muted-fg truncate max-w-[160px]">
                                      {bot.model_ref}
                                    </code>
                                  )}
                                  <Badge variant="default" className="text-[10px]">
                                    {b.chat_pattern}
                                  </Badge>
                                  <Badge variant="default" className="text-[10px]">
                                    {b.session_mode}
                                  </Badge>
                                  <span className="t-mono text-[10px] text-muted-fg">
                                    pri:{b.priority}
                                  </span>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive hover:text-destructive shrink-0 ml-2"
                                  onClick={() => confirmDetach(b.id)}
                                >
                                  <X size={14} />
                                  Detach
                                </Button>
                              </div>
                            );
                          })}
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
        title={editing ? "Edit Account" : "New Account"}
        size="lg"
      >
        <div className="space-y-5">
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
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Display Name"
              value={acctForm.display_name}
              onChange={(e) => setAcctForm({ ...acctForm, display_name: e.target.value })}
            />
            <Input
              label="Adapter ID"
              value={acctForm.adapter_id}
              onChange={(e) => setAcctForm({ ...acctForm, adapter_id: e.target.value })}
              placeholder="e.g. telegram-webhook"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Bot Username"
              value={acctForm.bot_username}
              onChange={(e) => setAcctForm({ ...acctForm, bot_username: e.target.value })}
              placeholder="@mybot"
              hint="Stored in adapter_config_json"
            />
            <Input
              label="Secret Ref"
              value={acctForm.secret_ref}
              onChange={(e) => setAcctForm({ ...acctForm, secret_ref: e.target.value })}
              placeholder="vault:tg-token"
              hint={editing ? "Leave blank to keep existing secret" : undefined}
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={acctForm.enabled}
              onChange={(e) => setAcctForm({ ...acctForm, enabled: e.target.checked })}
              className="rounded-sm border-border"
            />
            <span className="t-body text-muted-fg">Enabled</span>
          </label>
          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button variant="secondary" onClick={() => setAcctModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => acctMut.mutate()}
              disabled={acctMut.isPending || !acctForm.id || !acctForm.display_name}
            >
              {acctMut.isPending ? "Saving…" : editing ? "Save Changes" : "Create Account"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Attach Config Modal ── */}
      <Modal
        open={attachModal}
        onClose={() => setAttachModal(false)}
        title="Attach Config"
        size="sm"
      >
        <div className="space-y-5">
          <Select
            label="Config"
            value={attachForm.bot_profile_id}
            onChange={(e) => setAttachForm({ ...attachForm, bot_profile_id: e.target.value })}
            placeholder="Select a config…"
            options={bots.map((b) => ({ value: b.id, label: b.display_name || b.id }))}
          />
          <Input
            label="Chat Pattern"
            value={attachForm.chat_pattern}
            onChange={(e) => setAttachForm({ ...attachForm, chat_pattern: e.target.value })}
          />
          <Select
            label="Session Mode"
            value={attachForm.session_mode}
            onChange={(e) => setAttachForm({ ...attachForm, session_mode: e.target.value })}
            options={[
              { value: "dm", label: "dm" },
              { value: "group", label: "group" },
              { value: "shared", label: "shared" },
            ]}
          />
          <Input
            label="Priority"
            type="number"
            value={String(attachForm.priority)}
            onChange={(e) =>
              setAttachForm({ ...attachForm, priority: Number(e.target.value) || 0 })
            }
          />
          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button variant="secondary" onClick={() => setAttachModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => attachMut.mutate()}
              disabled={attachMut.isPending || !attachForm.bot_profile_id}
            >
              {attachMut.isPending ? "Attaching…" : "Attach"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
