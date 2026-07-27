import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { AccountView } from "../api/types";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { ArrowLeft, Save, Loader2, Trash2 } from "lucide-react";

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
            onClick={() => {
              if (window.confirm(`Delete account "${account.id}"? This cannot be undone.`)) {
                deleteMut.mutate();
              }
            }}
            disabled={deleteMut.isPending}
          >
            <Trash2 size={14} />
            {deleteMut.isPending ? "Deleting…" : "Delete Account"}
          </Button>
        </Card>
      </div>

      <div className="rule-thin" />
      <div className="flex justify-end">
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} size="lg">
          {saveMut.isPending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          Save
        </Button>
      </div>
    </div>
  );
}
