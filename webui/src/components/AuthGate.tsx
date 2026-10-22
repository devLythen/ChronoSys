import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet } from "react-router-dom";
import { api } from "../api/client";
import LoginPage from "../pages/LoginPage";
import SetupPage from "../pages/SetupPage";

export default function AuthGate() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api.authStatus(),
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    // Remove the old bearer-token copy from pre-session WebUI versions.
    window.localStorage.removeItem("chronosys-auth");
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    };
    window.addEventListener("chrono:unauthorized", invalidate);
    return () => window.removeEventListener("chrono:unauthorized", invalidate);
  }, [queryClient]);

  if (status.isLoading) {
    return (
      <div className="min-h-screen bg-bg text-fg flex items-center justify-center">
        <p className="t-body text-muted-fg">Connecting…</p>
      </div>
    );
  }

  if (status.isError) {
    return (
      <div className="min-h-screen bg-bg text-fg flex items-center justify-center px-4">
        <div className="max-w-md text-center space-y-3">
          <h1 className="t-headline">Gateway unavailable</h1>
          <p className="t-body text-muted-fg">{status.error instanceof Error ? status.error.message : "Cannot reach the gateway."}</p>
          <button className="text-sm underline underline-offset-4" onClick={() => void status.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!status.data?.configured) return <SetupPage />;
  if (!status.data.authenticated) return <LoginPage username={status.data.username} />;
  return <Outlet />;
}
