import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AuditEntry } from "../api/types";
import Table from "../components/ui/Table";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import { formatDate } from "../lib/utils";

export default function AuditPage() {
  const [limit, setLimit] = useState(50);
  const [accountId, setAccountId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [event, setEvent] = useState("");
  const [applied, setApplied] = useState(false);

  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["audit", { limit, account_id: accountId, session_id: sessionId, event }],
    queryFn: () =>
      api.listAudit({
        limit: limit || undefined,
        account_id: accountId || undefined,
        session_id: sessionId || undefined,
        event: event || undefined,
      }),
    enabled: applied,
  });

  const columns: {
    key: string;
    label: string;
    className?: string;
    render?: (row: AuditEntry) => React.ReactNode;
  }[] = [
    {
      key: "time",
      label: "Time",
      className: "whitespace-nowrap py-3",
      render: (r) => (r.time ? formatDate(r.time) : "\u2014"),
    },
    {
      key: "event",
      label: "Event",
      className: "py-3",
      render: (r) => (
        <span className="t-label">{r.event ?? "\u2014"}</span>
      ),
    },
    {
      key: "tool",
      label: "Tool",
      className: "py-3",
      render: (r) =>
        r.tool ? (
          <code className="t-mono bg-muted px-1.5 py-0.5 border border-border">{r.tool}</code>
        ) : (
          "\u2014"
        ),
    },
    {
      key: "session_id",
      label: "Session",
      className: "t-mono py-3",
      render: (r) =>
        r.session_id ? (
          <Link
            to={`/sessions/${r.session_id}`}
            className="text-fg hover:underline"
          >
            {r.session_id.slice(0, 12)}…
          </Link>
        ) : (
          "\u2014"
        ),
    },
    {
      key: "account_id",
      label: "Account",
      className: "t-mono py-3",
      render: (r) =>
        r.account_id ? (
          <span>{r.account_id.slice(0, 10)}…</span>
        ) : (
          "\u2014"
        ),
    },
    {
      key: "allowed",
      label: "Allowed",
      className: "py-3",
      render: (r) =>
        r.allowed !== undefined ? (
          <Badge variant={r.allowed ? "success" : "destructive"}>
            {r.allowed ? "Yes" : "No"}
          </Badge>
        ) : (
          "\u2014"
        ),
    },
    {
      key: "latency_ms",
      label: "Latency",
      className: "tabular-nums text-right py-3",
      render: (r) =>
        r.latency_ms !== undefined ? `${r.latency_ms}ms` : "\u2014",
    },
    {
      key: "error",
      label: "Error",
      className: "py-3",
      render: (r) =>
        r.error ? (
          <span className="text-destructive text-xs">{r.error.slice(0, 60)}{r.error.length > 60 ? "…" : ""}</span>
        ) : (
          "\u2014"
        ),
    },
  ];

  return (
    <div className="animate-fade-up space-y-6 md:space-y-8">
      {/* ── Hero header ────────────────────────────────────────── */}
      <div>
        <h1 className="t-display">Audit Log</h1>
        <p className="t-body text-muted-fg mt-3 max-w-xl">
          Filter and inspect tool-call audit entries across all sessions
          and accounts.
        </p>
      </div>
      <div className="rule-heavy" />

      {/* ── Filter bar ─────────────────────────────────────────── */}
      <div className="bg-card border border-border px-4 py-4">
        <h2 className="t-title font-medium mb-4">Filters</h2>
        <div className="flex flex-wrap items-end gap-4">
          <Select
            label="Limit"
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value))}
            options={[
              { value: "25", label: "25" },
              { value: "50", label: "50" },
              { value: "100", label: "100" },
              { value: "250", label: "250" },
              { value: "500", label: "500" },
            ]}
          />
          <Input
            label="Account ID"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="Filter by account"
          />
          <Input
            label="Session ID"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="Filter by session"
          />
          <Input
            label="Event"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            placeholder="e.g. tool_call"
          />
          <Button
            variant="secondary"
            size="md"
            onClick={() => setApplied(true)}
            className="self-end"
          >
            Apply
          </Button>
        </div>
      </div>

      {/* ── Results ────────────────────────────────────────────── */}
      <div>
        <div className="rule-thin mb-6" />
        {!applied ? (
          <div className="halftone-light py-16 text-center">
            <p className="t-body text-muted-fg">
              Press &ldquo;Apply&rdquo; to load audit entries
            </p>
          </div>
        ) : isLoading ? (
          <p className="t-body text-muted-fg py-8">Loading audit log…</p>
        ) : error ? (
          <div className="bg-card border border-destructive px-6 py-8 text-center">
            <p className="t-body text-destructive">
              {(error as Error).message}
            </p>
          </div>
        ) : (
          <Table<AuditEntry>
            columns={columns}
            data={data}
            rowKey={(r) =>
              `${r.time ?? ""}-${r.session_id ?? ""}-${r.event ?? ""}-${r.tool ?? ""}`
            }
            emptyText="No audit entries found"
          />
        )}
      </div>
    </div>
  );
}
