import { useAuthStore } from "../store";

const BASE = "/api/v1";

class ApiClient {
  private get headers(): HeadersInit {
    const token = useAuthStore.getState().token;
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...this.headers, ...init?.headers },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = body?.detail || body?.error || res.statusText;
      throw new Error(`${res.status}: ${detail}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  // ── Health ──────────────────────────────────────────────────
  health() {
    return this.request<import("./types").HealthResponse>("/health");
  }

  // ── Providers ───────────────────────────────────────────────
  listProviders() {
    return this.request<import("./types").ProviderView[]>("/providers");
  }
  getProvider(id: string) {
    return this.request<import("./types").ProviderView>(`/providers/${encodeURIComponent(id)}`);
  }
  createProvider(body: import("./types").ProviderBody) {
    return this.request<import("./types").ProviderView>("/providers", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  updateProvider(id: string, body: import("./types").ProviderBody) {
    return this.request<import("./types").ProviderView>(`/providers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }
  deleteProvider(id: string) {
    return this.request<{ ok: boolean }>(`/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  getCredential(providerId: string) {
    return this.request<import("./types").CredentialView>(
      `/providers/${encodeURIComponent(providerId)}/credential`,
    );
  }
  upsertCredential(providerId: string, body: import("./types").CredentialBody) {
    return this.request<import("./types").CredentialView>(
      `/providers/${encodeURIComponent(providerId)}/credential`,
      { method: "PUT", body: JSON.stringify(body) },
    );
  }
  deleteCredential(providerId: string) {
    return this.request<{ ok: boolean }>(
      `/providers/${encodeURIComponent(providerId)}/credential`,
      { method: "DELETE" },
    );
  }
  listModels(providerId: string) {
    return this.request<import("./types").LlmModel[]>(
      `/providers/${encodeURIComponent(providerId)}/models`,
    );
  }
  upsertModel(providerId: string, body: import("./types").ModelBody) {
    return this.request<import("./types").LlmModel>(
      `/providers/${encodeURIComponent(providerId)}/models`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }
  deleteModel(providerId: string, modelId: string) {
    return this.request<{ ok: boolean }>(
      `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
      { method: "DELETE" },
    );
  }
  refreshModels(providerId: string) {
    return this.request<import("./types").RefreshedModel[]>(
      `/providers/${encodeURIComponent(providerId)}/refresh-models`,
    );
  }
  getModelInfo(providerId: string, modelId: string) {
    return this.request<import("./types").ModelInfo | null>(
      `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/info`,
    );
  }
  // ── Bots (Configs) ──────────────────────────────────────────
  listBots() {
    return this.request<import("./types").BotProfile[]>("/bots");
  }
  getBot(id: string) {
    return this.request<import("./types").BotProfile>(`/bots/${encodeURIComponent(id)}`);
  }
  createBot(body: import("./types").BotBody) {
    return this.request<import("./types").BotProfile>("/bots", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  updateBot(id: string, body: import("./types").BotBody) {
    return this.request<import("./types").BotProfile>(`/bots/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }
  deleteBot(id: string) {
    return this.request<{ ok: boolean }>(`/bots/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  // ── Personas ────────────────────────────────────────────────
  listPersonas() {
    return this.request<import("./types").Persona[]>("/personas");
  }
  getPersona(id: string) {
    return this.request<import("./types").Persona>(`/personas/${encodeURIComponent(id)}`);
  }
  createPersona(body: import("./types").PersonaBody) {
    return this.request<import("./types").Persona>("/personas", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  updatePersona(id: string, body: import("./types").PersonaBody) {
    return this.request<import("./types").Persona>(`/personas/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }
  deletePersona(id: string) {
    return this.request<{ ok: boolean }>(`/personas/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  // ── Accounts ────────────────────────────────────────────────
  listAccounts() {
    return this.request<import("./types").AccountView[]>("/accounts");
  }
  getAccount(id: string) {
    return this.request<import("./types").AccountView>(`/accounts/${encodeURIComponent(id)}`);
  }
  createAccount(body: import("./types").AccountBody) {
    return this.request<import("./types").AccountView>("/accounts", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  updateAccount(id: string, body: import("./types").AccountBody) {
    return this.request<import("./types").AccountView>(`/accounts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }
  deleteAccount(id: string) {
    return this.request<{ ok: boolean }>(`/accounts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  // ── Bindings (Attachments) ──────────────────────────────────
  listBindings() {
    return this.request<import("./types").Binding[]>("/bindings");
  }
  getBinding(id: string) {
    return this.request<import("./types").Binding>(`/bindings/${encodeURIComponent(id)}`);
  }
  createBinding(body: import("./types").BindingBody) {
    return this.request<import("./types").Binding>("/bindings", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  updateBinding(id: string, body: import("./types").BindingBody) {
    return this.request<import("./types").Binding>(`/bindings/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }
  deleteBinding(id: string) {
    return this.request<{ ok: boolean }>(`/bindings/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  // ── Sessions ────────────────────────────────────────────────
  listSessions() {
    return this.request<import("./types").SessionSummary[]>("/sessions");
  }
  getSession(id: string) {
    return this.request<import("./types").SessionDetail>(`/sessions/${encodeURIComponent(id)}`);
  }
  steerSession(sessionId: string, text: string) {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/steer`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }
  abortSession(sessionId: string) {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
    });
  }

  // ── Audit ───────────────────────────────────────────────────
  listAudit(params?: { limit?: number; account_id?: string; session_id?: string; event?: string }) {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.account_id) qs.set("account_id", params.account_id);
    if (params?.session_id) qs.set("session_id", params.session_id);
    if (params?.event) qs.set("event", params.event);
    const q = qs.toString();
    return this.request<import("./types").AuditEntry[]>(`/audit${q ? `?${q}` : ""}`);
  }

  // ── Settings ────────────────────────────────────────────────
  listSettings() {
    return this.request<import("./types").Setting[]>("/settings");
  }
  getSetting(key: string) {
    return this.request<import("./types").Setting>(`/settings/${encodeURIComponent(key)}`);
  }
  setSetting(body: import("./types").SettingBody) {
    return this.request<import("./types").Setting>("/settings", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  putSetting(key: string, value: unknown) {
    return this.request<import("./types").Setting>(`/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value_json: value }),
    });
  }
  deleteSetting(key: string) {
    return this.request<{ ok: boolean }>(`/settings/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
  }

  // ── Tools ───────────────────────────────────────────────────
  listTools() {
    return this.request<import("./types").ToolInfo[]>("/tools");
  }
}

export const api = new ApiClient();
