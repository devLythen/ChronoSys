import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";

export default function LoginPage({ username }: { username?: string | null }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(username ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const login = useMutation({
    mutationFn: () => api.login({ username: name.trim(), password }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="min-h-screen bg-bg text-fg flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <p className="t-label text-muted-fg">ChronoSys</p>
          <h1 className="t-headline">Sign in</h1>
          <p className="t-body text-muted-fg">Use the admin credentials configured for this instance.</p>
        </div>
        <Card>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError("");
              login.mutate();
            }}
          >
            <Input
              label="Username"
              autoComplete="username"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={login.isPending || !name.trim() || !password}>
              {login.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
