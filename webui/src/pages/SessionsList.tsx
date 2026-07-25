import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { SessionSummary } from "../api/types";
import Table from "../components/ui/Table";
import Badge from "../components/ui/Badge";
import { formatDate, truncate } from "../lib/utils";

const STATUS_VARIANT: Record<string, "success" | "default" | "destructive" | "info"> = {
  active: "success",
  idle: "default",
  error: "destructive",
  completed: "info",
};

export default function SessionsList() {
  const {
    data: sessions = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.listSessions(),
    refetchInterval: 5000,
  });

  return (
    <div className="animate-fade-up space-y-6 md:space-y-8">
      {/* ── Hero header ────────────────────────────────────────── */}
      <div>
        <h1 className="t-display">Sessions</h1>
        <p className="t-body text-muted-fg mt-3 max-w-xl">
          Active chat sessions across all platforms — auto-refreshes
          every 5 seconds.
        </p>
      </div>
      <div className="rule-heavy" />

      {/* ── Loading / Error ────────────────────────────────────── */}
      {isLoading && (
        <div className="halftone-light py-16 text-center">
          <p className="t-body text-muted-fg">Loading sessions…</p>
        </div>
      )}
      {error && (
        <div className="bg-card border border-destructive px-6 py-8 text-center">
          <p className="t-body text-destructive">
            {(error as Error).message}
          </p>
        </div>
      )}

      {/* ── Table ──────────────────────────────────────────────── */}
      {!isLoading && !error && (
        <Table<SessionSummary & Record<string, unknown>>
          columns={[
            {
              key: "session_id",
              label: "Session",
              className: "t-mono py-3",
              render: (r) => (
                <Link
                  to={`/sessions/${r.session_id}`}
                  className="text-fg hover:underline"
                >
                  {truncate(r.session_id, 16)}
                </Link>
              ),
            },
            {
              key: "bot_profile_id",
              label: "Config",
              className: "py-3",
              render: (r) => (
                <Link
                  to={`/config/${r.bot_profile_id}`}
                  className="t-mono text-fg hover:underline"
                >
                  {truncate(r.bot_profile_id, 16)}
                </Link>
              ),
            },
            {
              key: "account_id",
              label: "Account",
              className: "t-mono py-3",
              render: (r) => truncate(r.account_id, 14),
            },
            {
              key: "chat_id",
              label: "Chat",
              className: "t-mono py-3",
              render: (r) => truncate(r.chat_id, 14),
            },
            {
              key: "route_key",
              label: "Route Key",
              className: "t-mono py-3",
              render: (r) => truncate(r.route_key, 12),
            },
            {
              key: "status",
              label: "Status",
              className: "py-3",
              render: (r) => (
                <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>
                  {r.status}
                </Badge>
              ),
            },
            {
              key: "message_count",
              label: "Messages",
              className: "text-right tabular-nums py-3",
              render: (r) => r.message_count,
            },
            {
              key: "updated_at",
              label: "Updated",
              className: "text-muted-fg py-3",
              render: (r) => formatDate(r.updated_at),
            },
          ]}
          data={sessions as (SessionSummary & Record<string, unknown>)[]}
          rowKey={(r) => r.session_id}
          emptyText="No sessions found"
        />
      )}
    </div>
  );
}
