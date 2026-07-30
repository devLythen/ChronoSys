import { useState, useMemo } from "react";
import { usePageEnter } from "../hooks/useAnimations";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import Badge from "../components/ui/Badge";
import { formatDate, cn } from "../lib/utils";
import Button from "../components/ui/Button";
import { ArrowLeft, Brain, Wrench, ChevronDown, ChevronRight } from "lucide-react";

const STATUS_VARIANT: Record<string, "success" | "default" | "destructive" | "info"> = {
  active: "success",
  archived: "default",
  error: "destructive",
};

// ── Content block types from pi-agent-core ──────────────────────

interface TextBlock {
  type: "text";
  text: string;
}

interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

interface AgentMessage {
  role: "user" | "assistant" | "toolResult";
  content: string | ContentBlock[];
  toolCallId?: string;
  toolName?: string;
  timestamp?: number;
  stopReason?: string;
  usage?: { totalTokens: number };
}

// ── Render helpers ──────────────────────────────────────────────

function RenderContent({ content, toolResults }: { content: AgentMessage["content"]; toolResults: Map<string, string> }) {
  if (typeof content === "string") {
    return <p className="whitespace-pre-wrap break-words">{content}</p>;
  }
  if (!Array.isArray(content)) return null;

  return (
    <div className="space-y-2">
      {content.map((block, i) => {
        if (block.type === "text") {
          return (
            <p key={i} className="whitespace-pre-wrap break-words">
              {block.text || "(empty)"}
            </p>
          );
        }
        if (block.type === "thinking") {
          return <ThinkingBubble key={i} block={block} />;
        }
        if (block.type === "toolCall") {
          const result = toolResults.get(block.id);
          return <ToolCallBubble key={i} block={block} result={result} />;
        }
        return null;
      })}
    </div>
  );
}

function ThinkingBubble({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  if (block.redacted) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-fg italic py-1">
        <Brain size={12} />
        Reasoning redacted
      </div>
    );
  }
  return (
    <div className="border border-border rounded-sm overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-xs text-muted-fg hover:bg-muted/50 transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} />
        Reasoning
      </button>
      {open && (
        <div className="px-3 py-2 text-xs text-muted-fg whitespace-pre-wrap border-t border-border bg-muted/30 font-mono leading-relaxed max-h-[200px] overflow-y-auto">
          {block.thinking}
        </div>
      )}
    </div>
  );
}

function ToolCallBubble({ block, result }: { block: ToolCallBlock; result?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-sm overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-xs text-muted-fg hover:bg-muted/50 transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} />
        <span className="t-mono font-medium">{block.name}</span>
      </button>
      {open && (
        <div className="px-3 py-2 text-xs border-t border-border bg-muted/30 space-y-2">
          <div>
            <span className="block t-label text-[10px] opacity-60 mb-0.5">Arguments</span>
            <span className="text-muted-fg font-mono break-all">{JSON.stringify(block.arguments)}</span>
          </div>
          <div>
            <span className="block t-label text-[10px] opacity-60 mb-0.5">Result</span>
            <span className="text-muted-fg font-mono break-all">{result ?? "(None)"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();

  const { data: session, isLoading, error } = useQuery({
    queryKey: ["session", id],
    queryFn: () => api.getSession(id!),
    enabled: !!id,
    refetchInterval: 3000,
  });

  const messages: AgentMessage[] = useMemo(() => {
    const raw = session?.messages;
    return Array.isArray(raw) ? raw as AgentMessage[] : [];
  }, [session?.messages]);

  const toolResults = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) {
      if (m.role === "toolResult" && m.toolCallId) {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        map.set(m.toolCallId, text);
      }
    }
    return map;
  }, [messages]);


  const pageRef = usePageEnter<HTMLDivElement>();
  if (isLoading) {
    return (
      <div className="animate-fade-up py-24 text-center">
        <p className="t-body text-muted-fg">Loading session…</p>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="animate-fade-up py-20 text-center">
        <p className="text-sm text-destructive font-medium mb-4">
          {(error as Error)?.message ?? "Session not found"}
        </p>
        <Button variant="secondary" onClick={() => window.history.back()}>
          <ArrowLeft size={14} />
          Back
        </Button>
      </div>
    );
  }

  return (
    <div ref={pageRef} className="space-y-6 md:space-y-8">
      <Link
        to="/sessions"
        className="t-label text-muted-fg hover:text-fg transition-colors inline-flex items-center gap-1.5"
      >
        <ArrowLeft size={14} />
        Sessions
      </Link>

      <div>
        <h1 className="t-headline">
          Session{" "}
          <code className="t-mono text-muted-fg">{session.session_id.slice(0, 12)}…</code>
        </h1>
        <div className="flex items-center gap-3 mt-3">
          <Badge variant={STATUS_VARIANT[session.active ? "active" : "archived"] ?? "default"}>
            {session.active ? "active" : "archived"}
          </Badge>
          <span className="t-body text-muted-fg">
            {formatDate(session.created_at)}
          </span>
          <span className="t-label text-muted-fg">
            {messages.length} messages
          </span>
        </div>
      </div>
      <div className="rule-heavy" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Transcript */}
        <div className="lg:col-span-2 space-y-4 max-h-[70vh] overflow-y-auto pr-2">
          {messages.length === 0 ? (
            <div className="halftone-light py-16 text-center rounded-sm">
              <p className="t-body text-muted-fg">No messages yet</p>
            </div>
          ) : (
            messages.filter(m => m.role !== "toolResult").map((msg, i) => {
              const isUser = msg.role === "user";

              return (
                <div
                  key={i}
                  className={cn("flex", isUser ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[85%] px-4 py-3 border text-sm",
                      isUser
                        ? "bg-fg text-bg border-fg"
                        : "bg-card border-border mr-8",
                    )}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="t-label text-[10px] opacity-60">
                        {isUser ? "User" : "Assistant"}
                      </span>
                      {msg.usage && (
                        <span className="t-mono text-[10px] opacity-40">
                          {msg.usage.totalTokens} tok
                        </span>
                      )}
                      {msg.stopReason && (
                        <span className="t-mono text-[10px] opacity-40">
                          {msg.stopReason}
                        </span>
                      )}
                    </div>
                    <RenderContent content={msg.content} toolResults={toolResults} />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          <div className="bg-card border border-border px-4 py-4">
            <h3 className="t-title font-medium mb-4">Details</h3>
            <dl className="space-y-3">
              {[
                ["Session ID", session.session_id],
                ["Config", session.bot_profile_id],
                ["Account", "—"],
                ["Chat ID", "—"],
                ["Route", session.route_key ?? "—"],
                ["Created", formatDate(session.created_at)],
                ["Updated", formatDate(session.updated_at)],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-2">
                  <dt className="t-label text-muted-fg">{label}</dt>
                  <dd className="t-mono text-xs max-w-[160px] truncate text-right">
                    {label === "Config" ? (
                      <Link to={`/config/${value}`} className="hover:underline">
                        {value}
                      </Link>
                    ) : (
                      value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

      </div>
    </div>
    </div>
  );
}
