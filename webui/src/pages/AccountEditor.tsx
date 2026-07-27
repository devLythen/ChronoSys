import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { AccountView } from "../api/types";
import { ArrowLeft, Save, Loader2, Trash2, Link2, X } from "lucide-react";
import Button from "../components/ui/Button";
import Select from "../components/ui/Select";
import Modal from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import ConfirmDialog from "../components/ui/ConfirmDialog";

const ADAPTERS = [
  { value: "chrono.adapter.telegram", label: "Telegram" },
];

const PLATFORMS = [
  { value: "telegram", label: "Telegram" },
];

export default function AccountEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const { data: account, isLoading, error } = useQuery({
    queryKey: ["account", id],
    queryFn: () => api.getAccount(id!),
    enabled: !!id,
  });

  const { data: bindings = [] } = useQuery({
    queryKey: ["bindings"],
    queryFn: () => api.listBindings(),
  });

  const { data: bots = [] } = useQuery({
    queryKey: ["bots"],
    queryFn: () => api.listBots(),
  });

  const accountBindings = bindings.filter((b: { account_id: string }) => b.account_id === id);
  const botsById = new Map(bots.map((b: { id: string }) => [b.id, b]));

  const [attachModalOpen, setAttachModalOpen] = useState(false);
  const [attachConfigId, setAttachConfigId] = useState("");
  const [deleteAccountConfirm, setDeleteAccountConfirm] = useState(false);
  const [detachConfirm, setDetachConfirm] = useState<{ id: string; name: string } | null>(null);

  const [platform, setPlatform] = useState("telegram");
  const [adapterId, setAdapterId] = useState("chrono.adapter.telegram");
  const [enabled, setEnabled] = useState(true);
  const [secretRef, setSecretRef] = useState("");

  useEffect(() => {
    if (account) {
      setPlatform(account.platform);
      setAdapterId(account.adapter_id);
      setEnabled(account.enabled);
      setSecretRef(account.secret_ref);
    }
  }, [account]);

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error("Missing account id");
      return api.updateAccount(id, {
        id,
        platform,
        adapter_id: adapterId,
        enabled,
        secret_ref: secretRef || undefined,
        adapter_config_json: account?.adapter_config_json ?? {},
        json_ext: account?.json_ext ?? {},
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["bindings"] });
      toast.add("success", "Account saved");
      navigate("/platforms");
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.deleteAccount(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      toast.add("success", "Account deleted");
      navigate("/platforms");
    },
    onError: (err: Error) => toast.add("error", err.message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-muted-fg" />
      </div>
    );
  }

  if (error || !account) {
    return (
      <div className="animate-fade-up py-20 text-center">
        <p className="text-sm text-destructive font-medium mb-4">
          {(error as Error)?.message ?? "Account not found"}
        </p>
        <Button variant="secondary" onClick={() => navigate("/platforms")}>
          <ArrowLeft size={14} />
          Back to Platforms
        </Button>
      </div>
    );
  }

  return (
    <div className="animate-fade-up space-y-6 md:space-y-8">
      <Link to="/platforms" className="t-label text-muted-fg hover:text-fg transition-colors inline-flex items-center gap-1">
        <ArrowLeft size={12} />
        Platforms
      </Link>

      <div>
        <h1 className="t-display">{account.id}</h1>
        <p className="t-mono text-muted-fg mt-2">{account.id}</p>
      </div>
      <div className="rule-heavy" />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="space-y-5">
          <div>
            <h2 className="t-headline !text-lg">Configuration</h2>
            <p className="t-label text-muted-fg mt-1">Platform connection settings</p>
          </div>

          <Select
            label="Platform"
            options={PLATFORMS}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          />
          <Select
            label="Adapter"
            options={ADAPTERS}
            value={adapterId}
            onChange={(e) => setAdapterId(e.target.value)}
          />
          <Input
            label="Bot Token"
            type="text"
            value={secretRef}
            onChange={(e) => setSecretRef(e.target.value)}
            placeholder={account.secret_ref ? "(unchanged if blank)" : "Bot token"}
          />

          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm text-fg">Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              className={`relative w-8 h-5 rounded-full transition-colors duration-200 focus:outline-none focus:ring-1 focus:ring-fg ${
                enabled ? "bg-fg" : "bg-border"
              }`}
            >
              <span
                className={`absolute top-[3px] left-0 w-3.5 h-3.5 rounded-full bg-white transition-transform duration-200 shadow-sm ${
                  enabled ? "translate-x-[15px]" : "translate-x-[2px]"
                }`}
              />
            </button>
          </label>
        </Card>

        <Card className="space-y-5">
          <div>
            <h2 className="t-headline !text-lg">Danger Zone</h2>
            <p className="t-label text-muted-fg mt-1">Irreversible actions</p>
          </div>
          <Button
            variant="destructive"
            className="w-full"
            onClick={() => setDeleteAccountConfirm(true)}
            disabled={deleteMut.isPending}
          >
            <Trash2 size={14} />
            {deleteMut.isPending ? "Deleting…" : "Delete Account"}
          </Button>
        </Card>
      </div>

      {/* ── Bindings ──────────────────────────────────────────── */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="t-headline !text-lg">Attached Configs</h2>
            <p className="t-label text-muted-fg mt-1">
              {accountBindings.length} config{accountBindings.length !== 1 ? "s" : ""} attached
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => { setAttachConfigId(""); setAttachModalOpen(true); }}>
            <Link2 size={14} />
            Attach
          </Button>
        </div>

        {accountBindings.length > 0 ? (
          <div className="border border-border rounded-sm overflow-hidden">
            {accountBindings.map((b: { id: string; bot_profile_id: string }) => (
              <div key={b.id} className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0">
                <span className="t-mono text-sm">{b.bot_profile_id}</span>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive"
                  onClick={() => setDetachConfirm({ id: b.id, name: b.bot_profile_id })}>
                  <X size={14} />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="t-body text-muted-fg py-4">No configs attached. Attach one to route messages.</p>
        )}
      </Card>

      <div className="rule-thin" />
      <div className="flex justify-end">
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} size="lg">
          {saveMut.isPending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          Save
        </Button>
      </div>

      {/* ── Attach Modal ── */}
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
              ...bots.map((b: { id: string }) => ({ value: b.id, label: b.id })),
            ]}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAttachModalOpen(false)}>Cancel</Button>
            <Button disabled={!attachConfigId} onClick={async () => {
              const bindingId = `${id}-${attachConfigId}-${Date.now().toString(36)}`;
              await api.createBinding({
                id: bindingId, account_id: id!, bot_profile_id: attachConfigId,
                chat_pattern: "dm:*", session_mode: "dm", priority: 10, enabled: true,
              });
              qc.invalidateQueries({ queryKey: ["bindings"] });
              setAttachModalOpen(false);
              setAttachConfigId("");
            }}>Attach</Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteAccountConfirm}
        title="Delete Account"
        message={`Delete "${account.id}"? This cannot be undone.`}
        onConfirm={() => {
          deleteMut.mutate();
          setDeleteAccountConfirm(false);
        }}
        onCancel={() => setDeleteAccountConfirm(false)}
      />

      <ConfirmDialog
        open={detachConfirm !== null}
        title="Detach Config"
        message={`Detach config "${detachConfirm?.name}"?`}
        onConfirm={() => {
          api.deleteBinding(detachConfirm!.id).then(() =>
            qc.invalidateQueries({ queryKey: ["bindings"] })
          );
          setDetachConfirm(null);
        }}
        onCancel={() => setDetachConfirm(null)}
      />
    </div>
  );
}
