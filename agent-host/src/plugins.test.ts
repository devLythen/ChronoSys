import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolRegistry } from "./plugins/registry.ts";

const fixtureRoot = join(import.meta.dir, "plugins", "__fixtures__");

async function homeWith(...plugins: string[]) {
  const home = await mkdtemp(join("/tmp", "chronosys-plugin-"));
  for (const plugin of plugins) {
    await mkdir(join(home, "plugins", "installed"), { recursive: true });
    await cp(join(fixtureRoot, plugin), join(home, "plugins", "installed", plugin), { recursive: true });
  }
  return home;
}

describe("native plugin registry", () => {
  test("loads deterministic echo and selects it through allowlist", async () => {
    const home = await homeWith("echo");
    try {
      const registry = new ToolRegistry(home);
      await registry.reload();
      const tools = registry.createToolsForAllowlist(["example.echo"], "session-1", new Map());
      expect(tools.map((tool) => tool.name)).toEqual(["example.echo"]);
      const result = await tools[0]!.execute("call-1", { text: "hello" });
      expect(result.content).toEqual([{ type: "text", text: "echo:hello" }]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("loads enabled sender plugin tools alongside message_send", async () => {
    const home = await homeWith("sender");
    try {
      const registry = new ToolRegistry(home);
      await registry.reload();
      const names = registry.createToolsForAllowlist([], "session-1", new Map()).map((tool) => tool.name);
      expect(names).toContain("message_send");
      expect(names).toContain("example.send");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("warns through the injected host logger instead of stdout", async () => {
    const home = await homeWith("echo");
    try {
      const warnings: string[] = [];
      const registry = new ToolRegistry(home, (message) => warnings.push(message));
      await registry.reload();
      expect(registry.createToolsForAllowlist(["missing.tool"], "session-1", new Map())).toEqual([]);
      expect(warnings).toEqual(["unknown tool names: missing.tool"]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("preserves the last valid snapshot when the install root becomes unreadable", async () => {
    const home = await homeWith("echo");
    try {
      const registry = new ToolRegistry(home);
      await registry.reload();
      const installRoot = join(home, "plugins", "installed");
      await rm(installRoot, { recursive: true, force: true });
      await writeFile(installRoot, "not a directory");
      await expect(registry.reload()).rejects.toThrow("plugin install root is not a directory");
      expect(registry.createToolsForAllowlist(["example.echo"], "session-1", new Map()).map((tool) => tool.name)).toEqual(["example.echo"]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("filters a plugin tool for a blacklisted persona", async () => {
    const home = await homeWith("echo");
    try {
      await writeFile(join(home, "plugins", "installed", "echo", "chrono.policy.toml"), "enabled = true\n\n[tools.\"example.echo\"]\npersona_blacklist = [\"persona-blocked\"]\n");
      const registry = new ToolRegistry(home);
      await registry.reload();
      expect(registry.createToolsForAllowlist(["example.echo"], "session-1", new Map(), undefined, "persona-blocked")).toEqual([]);
      expect(registry.createToolsForAllowlist(["example.echo"], "session-1", new Map(), undefined, "persona-allowed").map((tool) => tool.name)).toEqual(["example.echo"]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("executes a registered user command through the platform IPC facade", async () => {
    const home = await homeWith("sender");
    try {
      const registry = new ToolRegistry(home);
      await registry.reload();
      const pending = new Map();
      const running = registry.executeCommand("/weather Shanghai", "session-1", pending);
      await Promise.resolve();
      const entry = [...pending.values()][0];
      expect(entry).toBeDefined();
      entry.resolve({ type: "tool.response", tool_call_id: "ignored", ok: true, result: {} });
      await expect(running).resolves.toBe(true);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
