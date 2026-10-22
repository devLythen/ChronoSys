import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";

export default function SetupPage() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  const setup = useMutation({
    mutationFn: () => api.setup({ username: username.trim(), password }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  function submit() {
    setError("");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setup.mutate();
  }

  return (
    <div className="min-h-screen bg-bg text-fg flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <p className="t-label text-muted-fg">ChronoSys · first run</p>
          <h1 className="t-headline">Create the admin account</h1>
          <p className="t-body text-muted-fg">
            This password protects the WebUI and API. It is stored as an Argon2 hash in the local config database.
          </p>
        </div>
        <Card>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Input
              label="Username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoFocus
            />
            <Input
              label="Password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint="At least 8 characters."
            />
            <Input
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={setup.isPending || !username.trim() || !password}>
              {setup.isPending ? "Creating…" : "Create account"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
