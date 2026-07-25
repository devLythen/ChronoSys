import { useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, XCircle, SendHorizontal } from "lucide-react";
import { api } from "../api/client";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import { formatDate, cn } from "../lib/utils";

const STATUS_VARIANT: Record<string, "success" | "default" | "destructive" | "info"> = {
  active: "success",
  idle: "default",
  error: "destructive",
  completed: "info",
};

interface ParsedMessage {
  role: string;
  content?: string;
  tool_calls?: { name: string; arguments: unknown }[];
  tool_call_id?: string;
  name?: string;
}

function renderMessageContent(msg: ParsedMessage | undefined) {
  if (!msg) return <code className="t-mono text-muted-fg">—</code>;
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    return (
      <div className="space-y-1.5">
        {msg.content && (
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        )}
        {msg.tool_calls?.map((tc, i) => (
          <code
            key={i}
            className="block t-mono bg-muted px-2 py-1 border border-border whitespace-pre-wrap break-all"
          >
            {tc.name}({JSON.stringify(tc.arguments, null, 0)})
          </code>
        ))}
      </div>
    );
  }
  if (msg.content) {
    return <p className="whitespace-pre-wrap break-words">{msg.content}</p>;
  }
  return (
    <code className="t-mono text-muted-fg">
      {JSON.stringify(msg)}
    </code>
  );
}

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [steerText, setSteerText] = useState("");

  const {
    data: session,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["session", id],
    queryFn: () => api.getSession(id!),
    enabled: !!id,
    refetchInterval: 3000,
  });

  const messages: ParsedMessage[] = useMemo(() => {
    if (!session?.messages_json) return [];
    try {
      const parsed = JSON.parse(session.messages_json);
      if (Array.isArray(parsed)) return parsed as ParsedMessage[];
      if (parsed.messages && Array.isArray(parsed.messages))
        return parsed.messages as ParsedMessage[];
      return [];
    } catch {
      return [];
    }
  }, [session?.messages_json]);

  const steerMut = useMutation({
    mutationFn: (text: string) => api.steerSession(id!, text),
    onSuccess: () => {
      setSteerText("");
      qc.invalidateQueries({ queryKey: ["session", id] });
      toast.add("success", "Steer message sent.");
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  const abortMut = useMutation({
    mutationFn: () => api.abortSession(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["session", id] });
      toast.add("success", "Session aborted.");
    },
    onError: (e: Error) => toast.add("error", e.message),
  });

  const handleSteer = () => {
    const text = steerText.trim();
    if (!text) return;
    steerMut.mutate(text);
  };

  if (isLoading) {
    return (
      <div className="animate-fade-up">
        <div className="halftone-light py-16 text-center">
          <p className="t-body text-muted-fg">Loading session…</p>
        </div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="animate-fade-up">
        <div className="bg-card border border-destructive px-6 py-8 text-center">
          <p className="t-body text-destructive">
            {(error as Error)?.message ?? "Session not found"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-up space-y-6 md:space-y-8">
      {/* ── Back link ──────────────────────────────────────────── */}
      <Link
        to="/sessions"
        className="t-label text-muted-fg hover:text-fg transition-colors inline-flex items-center gap-1.5"
      >
        <ArrowLeft size={14} />
        Sessions
      </Link>

      {/* ── Session header ─────────────────────────────────────── */}
      <div>
        <h1 className="t-headline">
          Session{" "}
          <code className="t-mono text-muted-fg">{session.session_id}</code>
        </h1>
        <div className="flex items-center gap-3 mt-3">
          <Badge variant={STATUS_VARIANT[session.status] ?? "default"}>
            {session.status}
          </Badge>
          <span className="t-body text-muted-fg">
            Created {formatDate(session.created_at)}
          </span>
        </div>
      </div>
      <div className="rule-heavy" />

      {/* ── Two-column layout ──────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left: Transcript */}
        <div className="lg:col-span-2 space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="t-title font-medium">Transcript</h2>
            <span className="t-label text-muted-fg">
              {messages.length} message{messages.length !== 1 ? "s" : ""}
            </span>
          </div>

          {messages.length === 0 ? (
            <div className="halftone-light py-16 text-center">
              <p className="t-body text-muted-fg">No messages yet</p>
            </div>
          ) : (
            <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-2">
              {messages.map((msg, i) => {
                const isUser = msg.role === "user";
                const isTool = msg.role === "tool";
                return (
                  <div
                    key={i}
                    className={cn(
                      "px-4 py-3 border text-sm",
                      isUser
                        ? "bg-muted border-border mr-8"
                        : isTool
                          ? "bg-muted/50 border-border t-mono text-muted-fg ml-8"
                          : "bg-card border-border ml-8",
                    )}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="t-label text-muted-fg">
                        {msg.role}
                      </span>
                      {msg.name && (
                        <span className="t-mono text-muted-fg">{msg.name}</span>
                      )}
                    </div>
                    <div className={isUser ? "t-body" : "t-mono text-[0.8125rem]"}>
                      {renderMessageContent(msg)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Metadata + Actions */}
        <div className="space-y-6">
          {/* Details card */}
          <div className="bg-card border border-border px-4 py-4">
            <h3 className="t-title font-medium mb-4">Details</h3>
            <dl className="space-y-3">
              <div className="flex justify-between gap-2">
                <dt className="t-label text-muted-fg">Session ID</dt>
                <dd className="t-mono max-w-[180px] truncate">
                  {session.session_id}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="t-label text-muted-fg">Config</dt>
                <dd>
                  <Link
                    to={`/config/${session.bot_profile_id}`}
                    className="t-mono hover:underline"
                  >
                    {session.bot_profile_id}
                  </Link>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="t-label text-muted-fg">Account</dt>
                <dd className="t-mono max-w-[180px] truncate">
                  {session.account_id}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="t-label text-muted-fg">Chat ID</dt>
                <dd className="t-mono max-w-[180px] truncate">
                  {session.chat_id}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="t-label text-muted-fg">Route Key</dt>
                <dd className="t-mono max-w-[180px] truncate">
                  {session.route_key}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="t-label text-muted-fg">Status</dt>
                <dd>
                  <Badge
                    variant={STATUS_VARIANT[session.status] ?? "default"}
                  >
                    {session.status}
                  </Badge>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="t-label text-muted-fg">Created</dt>
                <dd className="t-mono">{formatDate(session.created_at)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="t-label text-muted-fg">Updated</dt>
                <dd className="t-mono">{formatDate(session.updated_at)}</dd>
              </div>
            </dl>
          </div>

          {/* Actions card */}
          <div className="bg-card border border-border px-4 py-4">
            <h3 className="t-title font-medium mb-4">Actions</h3>
            <div className="space-y-4">
              <Button
                variant="destructive"
                size="md"
                className="w-full"
                onClick={() => {
                  if (window.confirm("Abort this session?")) {
                    abortMut.mutate();
                  }
                }}
                disabled={abortMut.isPending}
              >
                <XCircle size={15} />
                {abortMut.isPending ? "Aborting…" : "Abort Session"}
              </Button>

              <div className="rule-thin" />

              <div>
                <p className="t-label text-muted-fg mb-2">
                  Send a steer message
                </p>
                <div className="flex gap-2">
                  <Input
                    value={steerText}
                    onChange={(e) => setSteerText(e.target.value)}
                    placeholder="Type a message…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSteer();
                      }
                    }}
                  />
                  <Button
                    size="md"
                    onClick={handleSteer}
                    disabled={steerMut.isPending || !steerText.trim()}
                  >
                    {steerMut.isPending ? "…" : <SendHorizontal size={15} />}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
