import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { SessionSummary } from "../api/types";
import { usePageEnter } from "../hooks/useAnimations";
import Table from "../components/ui/Table";
import Badge from "../components/ui/Badge";
import { formatDate, truncate } from "../lib/utils";

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

  const pageRef = usePageEnter<HTMLDivElement>();

  return (
    <div ref={pageRef} className="space-y-6 md:space-y-8">
      <div>
        <h1 className="t-display">Sessions</h1>
        <p className="t-body text-muted-fg mt-3 max-w-xl">
          Read-only view of active chat sessions — auto-refreshes every 5s.
        </p>
      </div>
      <div className="rule-heavy" />

      {isLoading && (
        <div className="halftone-light py-16 text-center">
          <p className="t-body text-muted-fg">Loading sessions…</p>
        </div>
      )}
      {error && (
        <div className="bg-card border border-destructive px-6 py-8 text-center">
          <p className="t-body text-destructive">{(error as Error).message}</p>
        </div>
      )}

      {!isLoading && !error && (
        <Table<SessionSummary & Record<string, unknown>>
          columns={[
            {
              key: "session_id",
              label: "Session",
              className: "t-mono py-3",
              render: (r) => (
                <Link to={`/sessions/${r.session_id}`} className="text-fg hover:underline">
                  {truncate(r.session_id, 16)}
                </Link>
              ),
            },
            {
              key: "bot_profile_id",
              label: "Config",
              className: "py-3",
              render: (r) => (
                <Link to={`/config/${r.bot_profile_id}`} className="t-mono text-fg hover:underline">
                  {truncate(r.bot_profile_id, 16)}
                </Link>
              ),
            },
            {
              key: "route_key",
              label: "Route",
              className: "t-mono py-3",
              render: (r) => truncate(r.route_key, 24),
            },
            {
              key: "active",
              label: "Status",
              className: "py-3",
              render: (r) => (
                <Badge variant={r.active ? "success" : "default"}>
                  {r.active ? "active" : "archived"}
                </Badge>
              ),
            },
            {
              key: "message_count",
              label: "Msgs",
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
