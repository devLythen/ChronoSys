import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { PluginView } from "../api/types";
import { usePageEnter } from "../hooks/useAnimations";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Modal from "../components/ui/Modal";
import Toggle from "../components/ui/Toggle";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import { useToast } from "../components/ui/Toast";

function PluginCard({ plugin, onDelete }: { plugin: PluginView; onDelete: (plugin: PluginView) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const policy = useMutation({ mutationFn: (enabled: boolean) => api.updatePluginPolicy(plugin.id, { enabled, config: plugin.policy.config, tools: plugin.policy.tools }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["plugins"] }); }, onError: (error: Error) => toast.add("error", error.message) });
  return <Card className="group flex flex-col hover:border-fg/30 transition-colors" padding="none"><div onClick={() => navigate(`/plugins/extensions/${plugin.id}`)} className="p-4 flex-1 cursor-pointer"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="t-headline !text-xl truncate">{plugin.name}</h2><p className="t-mono text-xs text-muted-fg mt-1 truncate">{plugin.id} · v{plugin.version}</p></div><div onClick={(e) => e.stopPropagation()}><Toggle checked={plugin.policy.enabled} disabled={policy.isPending} onChange={(enabled) => policy.mutate(enabled)} /></div></div><p className="text-sm text-muted-fg mt-4 line-clamp-2">{plugin.description}</p><div className="mt-4 flex gap-2 text-xs text-muted-fg"><span>{plugin.tools.length} tool{plugin.tools.length !== 1 ? "s" : ""}</span><span>·</span><span>{plugin.commands.length} command{plugin.commands.length !== 1 ? "s" : ""}</span></div></div><div className="flex items-center border-t border-border bg-muted/30 py-2 pl-2 pr-4"><div className="flex-1" /><Button variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); onDelete(plugin); }} className="text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" title="Delete"><Trash2 size={14} /></Button></div></Card>;
}


export default function PluginsExtensions() {
  const pageRef = usePageEnter<HTMLDivElement>(); const queryClient = useQueryClient(); const toast = useToast();
  const [installOpen, setInstallOpen] = useState(false); const [deleteTarget, setDeleteTarget] = useState<PluginView | null>(null); const [source, setSource] = useState<"zip" | "github">("zip"); const [file, setFile] = useState<File | null>(null); const [url, setUrl] = useState(""); const [gitRef, setGitRef] = useState(""); const fileRef = useRef<HTMLInputElement>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ["plugins"], queryFn: () => api.listPlugins() });
  const reload = useMutation({ mutationFn: () => api.reloadPlugins(), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["plugins"] }); toast.add("success", "Local plugins refreshed"); }, onError: (err: Error) => toast.add("error", err.message) });
  const install = useMutation({ mutationFn: () => source === "zip" ? (file ? api.installPluginZip(file) : Promise.reject(new Error("Choose a ZIP archive"))) : api.installPluginGitHub({ url, ...(gitRef ? { git_ref: gitRef } : {}) }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["plugins"] }); setInstallOpen(false); setFile(null); setUrl(""); setGitRef(""); toast.add("success", "Plugin installed and refreshed"); }, onError: (err: Error) => toast.add("error", err.message) });
  const remove = useMutation({ mutationFn: (id: string) => api.deletePlugin(id), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["plugins"] }); setDeleteTarget(null); toast.add("success", "Plugin removed"); }, onError: (err: Error) => toast.add("error", err.message) });
  const plugins = data?.plugins ?? [];
  return (
    <div ref={pageRef} className="space-y-6 md:space-y-8">
      <div>
        <h1 className="t-display">Extensions</h1>
        <p className="t-body text-muted-fg mt-3 max-w-2xl">
          Install and manage native tools and user commands. Each plugin is installed at <span className="t-mono">$CHRONO_HOME/plugins/installed/&lt;plugin-id&gt;/</span>.
        </p>
      </div>
      <div className="rule-heavy" />
      <div className="flex items-center justify-between">
        <p className="t-label text-muted-fg">{plugins.length} plugin{plugins.length !== 1 ? "s" : ""}</p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" className="px-3" onClick={() => reload.mutate()} disabled={reload.isPending}>
            <RefreshCw size={15} className={reload.isPending ? "animate-spin" : ""} /> Refresh
          </Button>
          <Button className="px-3" onClick={() => setInstallOpen(true)}><Plus size={15} /> Install plugin</Button>
        </div>
      </div>
      {isLoading && <p className="text-sm text-muted-fg">Discovering local plugins…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {!isLoading && !error && plugins.length === 0 && <Card className="halftone-light text-center py-16"><p className="t-headline text-muted-fg/60">No local plugins discovered</p></Card>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} onDelete={setDeleteTarget} />)}</div>
      <Modal open={installOpen} onClose={() => setInstallOpen(false)} title="Install plugin">
        <div className="space-y-5">
          <div className="flex gap-2">
            <Button variant={source === "zip" ? "primary" : "secondary"} onClick={() => setSource("zip")}>ZIP upload</Button>
            <Button variant={source === "github" ? "primary" : "secondary"} onClick={() => setSource("github")}>GitHub</Button>
          </div>
          {source === "zip" ? <div className="space-y-3"><input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><Button variant="secondary" onClick={() => fileRef.current?.click()}><Upload size={15} /> {file ? file.name : "Choose ZIP"}</Button><p className="text-xs text-muted-fg">Maximum archive size: 20 MiB.</p></div> : <div className="space-y-3"><Input label="GitHub repository" placeholder="https://github.com/owner/repo" value={url} onChange={(event) => setUrl(event.target.value)} /><Input label="Tag or branch (optional)" value={gitRef} onChange={(event) => setGitRef(event.target.value)} /></div>}
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setInstallOpen(false)}>Cancel</Button><Button onClick={() => install.mutate()} disabled={install.isPending}>{install.isPending ? "Installing…" : "Install"}</Button></div>
        </div>
      </Modal>
      <ConfirmDialog open={!!deleteTarget} title="Remove plugin" message={`Remove ${deleteTarget?.name ?? "this plugin"}? Its local files will be deleted.`} confirmLabel="Remove" onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)} onCancel={() => setDeleteTarget(null)} />
    </div>
  );
}
