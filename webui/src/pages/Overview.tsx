import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import Badge from "../components/ui/Badge";
import { formatUptime } from "../lib/utils";

type CheckResult = { ok: boolean; label: string; detail: string; link: string };

export default function Overview() {
  const { data: health, isLoading: healthLoading } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
  });
  const { data: bots } = useQuery({
    queryKey: ["bots"],
    queryFn: () => api.listBots(),
  });
  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.listAccounts(),
  });
  const { data: bindings } = useQuery({
    queryKey: ["bindings"],
    queryFn: () => api.listBindings(),
  });

  if (healthLoading) {
    return (
      <div className="animate-fade-up">
        <p className="t-body text-muted-fg py-12">Loading…</p>
      </div>
    );
  }

  // ── Closure checks ──────────────────────────────────────────
  const checks: CheckResult[] = [
    {
      ok: bots ? bots.some((b) => b.model_ref && b.model_ref.trim().length > 0) : false,
      label: "Provider + Model",
      detail: "At least one bot has a valid model reference",
      link: "/providers",
    },
    {
      ok: health ? health.bot_count > 0 : (bots ? bots.length > 0 : false),
      label: "Configs",
      detail: "Bot profiles exist and reference a model",
      link: "/config",
    },
    {
      ok: bots ? bots.some((b) => b.system_prompt && b.system_prompt.trim().length > 0) : false,
      label: "Personas",
      detail: "At least one bot has a non-empty system prompt",
      link: "/persona",
    },
    {
      ok: health ? health.account_count > 0 : (accounts ? accounts.length > 0 : false),
      label: "Platform Accounts",
      detail: "Account configured with valid credentials",
      link: "/platforms",
    },
    {
      ok: bindings ? bindings.length > 0 : false,
      label: "Attachments",
      detail: "At least one binding links account to bot profile",
      link: "/platforms",
    },
  ];

  const allPassed = checks.every((c) => c.ok);
  const passedCount = checks.filter((c) => c.ok).length;

  return (
    <div className="animate-fade-up space-y-6 md:space-y-8">
      {/* ── Hero header ────────────────────────────────────────── */}
      <div>
        <h1 className="t-display">Overview</h1>
        <p className="t-body text-muted-fg mt-3 max-w-xl">
          System health and readiness — a single-pane summary of service status
          and configuration completeness.
        </p>
      </div>
      <div className="rule-heavy" />

      {/* ── Status badge ───────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        <Badge variant={allPassed ? "success" : "warning"} className="px-3 py-1 text-xs">
          {allPassed ? "All Clear" : `${passedCount}/${checks.length} Ready`}
        </Badge>
        {!allPassed && (
          <span className="t-body text-muted-fg">
            {checks.length - passedCount} step{(checks.length - passedCount) !== 1 ? "s" : ""} need
            attention
          </span>
        )}
      </div>

      {/* ── Stats grid ─────────────────────────────────────────── */}
      {health && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
          <StatCard label="Uptime" value={formatUptime(health.uptime_secs)} />
          <StatCard label="Agent Host" value={health.agent_host} mono />
          <StatCard label="Adapters" value={String(health.adapter_count)} />
          <StatCard label="Sessions" value={String(health.session_count)} />
          <StatCard label="Accounts" value={String(health.account_count)} />
          <StatCard label="Bot Profiles" value={String(health.bot_count)} />
        </div>
      )}

      {/* ── Halftone divider ───────────────────────────────────── */}
      <div className="halftone h-8" />

      {/* ── Closure checklist ──────────────────────────────────── */}
      <div>
        <h2 className="t-headline mb-6">Closure Checklist</h2>
        <div className="space-y-4">
          {checks.map((check, i) => (
            <div
              key={check.label}
              className="bg-card border border-border px-4 py-4 flex items-center gap-6 group"
            >
              {/* Step number */}
              <span className="t-display text-[2rem] text-muted-fg/20 leading-none tabular-nums w-12 flex-shrink-0">
                {(i + 1).toString().padStart(2, "0")}
              </span>

              {/* Status icon */}
              <span
                className={`flex-shrink-0 w-7 h-7 flex items-center justify-center text-sm font-bold ${
                  check.ok
                    ? "bg-green-50 text-green-700 border border-green-200"
                    : "bg-red-50 text-red-700 border border-red-200"
                }`}
              >
                {check.ok ? "\u2713" : "\u2717"}
              </span>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <p className="t-title font-medium">{check.label}</p>
                <p className="t-body text-muted-fg mt-0.5">{check.detail}</p>
              </div>

              {/* Action link */}
              {!check.ok && (
                <Link
                  to={check.link}
                  className="t-label text-muted-fg hover:text-fg transition-colors flex-shrink-0"
                >
                  Configure &rarr;
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="bg-card border border-border px-4 py-4">
      <p
        className={`t-display text-[1.75rem] md:text-[2.25rem] leading-none ${
          mono ? "t-mono" : ""
        }`}
      >
        {value}
      </p>
      <p className="t-label text-muted-fg mt-2">{label}</p>
    </div>
  );
}
