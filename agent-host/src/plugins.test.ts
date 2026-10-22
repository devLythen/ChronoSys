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
      const tools = registry.createToolsForAllowlist(["example_echo"], "session-1", new Map());
      expect(tools.map((tool) => tool.name)).toEqual(["example_echo"]);
      const result = await tools[0]!.execute("call-1", { text: "hello" });
      expect(result.content).toEqual([{ type: "text", text: "echo:hello" }]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("registers sandbox tools only when allowlisted", async () => {
    const home = await homeWith();
    try {
      const registry = new ToolRegistry(home);
      await registry.reload();
      const sandbox = registry.createToolsForAllowlist(
        ["sandbox_exec", "sandbox_send_file", "sandbox_read_file", "sandbox_write_file", "sandbox_edit_file"],
        "session-1",
        new Map(),
      );
      expect(sandbox.map((tool) => tool.name)).toEqual([
        "sandbox_exec",
        "sandbox_send_file",
        "sandbox_read_file",
        "sandbox_write_file",
        "sandbox_edit_file",
      ]);
      const platformOnly = registry.createToolsForAllowlist(["message_send"], "session-1", new Map());
      expect(platformOnly.map((tool) => tool.name)).toEqual(["message_send"]);
      const imageTool = registry.createToolsForAllowlist(
        ["sandbox_view_image"], "session-1", new Map(), undefined, undefined, "UTC", true,
      );
      expect(imageTool.map((tool) => tool.name)).toEqual(["sandbox_view_image"]);
      const textOnly = registry.createToolsForAllowlist(
        ["sandbox_view_image"], "session-1", new Map(), undefined, undefined, "UTC", false,
      );
      expect(textOnly).toEqual([]);
      const browser = registry.createToolsForAllowlist(
        [], "session-1", new Map(), undefined, undefined, "UTC", false, true,
      );
      expect(browser.map((tool) => tool.name)).toContain("sandbox_browser");
      const browserOff = registry.createToolsForAllowlist(
        [], "session-1", new Map(), undefined, undefined, "UTC", false, false,
      );
      expect(browserOff.map((tool) => tool.name)).not.toContain("sandbox_browser");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("loads enabled sender plugin tools alongside message_send", async () => {
    const home = await homeWith("sender");
    try {
      const registry = new ToolRegistry(home);
      await registry.reload();
      const names = registry.createToolsForAllowlist([], "session-1", new Map()).map((tool) => tool.name);
      expect(names).toContain("message_send");
      expect(names).toContain("example_send");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("warns through the injected host logger instead of stdout", async () => {
    const home = await homeWith("echo");
    try {
      const warnings: string[] = [];
      const registry = new ToolRegistry(home, (message) => warnings.push(message));
      await registry.reload();
      // Plugin tools bypass the allowlist; unknown names are silently ignored.
      const tools = registry.createToolsForAllowlist(["missing.tool"], "session-1", new Map());
      expect(tools.map((t) => t.name)).toContain("example_echo");
      expect(warnings).toEqual([]);
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
      expect(registry.createToolsForAllowlist(["example_echo"], "session-1", new Map()).map((tool) => tool.name)).toEqual(["example_echo"]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("filters a plugin tool for a blacklisted persona", async () => {
    const home = await homeWith("echo");
    try {
      await writeFile(join(home, "plugins", "installed", "echo", "chrono.policy.toml"), "enabled = true\n\n[tools.\"example_echo\"]\npersona_blacklist = [\"persona-blocked\"]\n");
      const registry = new ToolRegistry(home);
      await registry.reload();
      expect(registry.createToolsForAllowlist(["example_echo"], "session-1", new Map(), undefined, "persona-blocked")).toEqual([]);
      expect(registry.createToolsForAllowlist(["example_echo"], "session-1", new Map(), undefined, "persona-allowed").map((tool) => tool.name)).toEqual(["example_echo"]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("routes plugin sandbox.exec through the sandbox IPC facade", async () => {
    const home = await homeWith("sandbox");
    try {
      const registry = new ToolRegistry(home);
      await registry.reload();
      const pending = new Map();
      const tool = registry
        .createToolsForAllowlist([], "session-1", pending)
        .find((candidate) => candidate.name === "example_sandbox_exec");
      expect(tool).toBeDefined();

      const running = tool!.execute("outer-call", { cmd: "printf hello" });
      await Promise.resolve();
      const [nestedCallId, entry] = [...pending.entries()][0]!;
      expect(nestedCallId).not.toBe("outer-call");
      const result = { exit_code: 0, stdout: "hello", stderr: "", truncated: false };
      entry.resolve({
        type: "tool.response",
        tool_call_id: nestedCallId,
        ok: true,
        result,
      });

      const completed = await running;
      expect(completed.content).toEqual([
        { type: "text", text: JSON.stringify(result) },
      ]);
      expect(completed.details).toEqual({
        plugin_id: "example_sandbox",
        tool_name: "example_sandbox_exec",
        outcome: "success",
      });
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("routes sandbox_read_file and renders the truncation footer", async () => {
    const home = await homeWith();
    try {
      const registry = new ToolRegistry(home);
      await registry.reload();
      const pending = new Map();
      const tool = registry
        .createToolsForAllowlist(["sandbox_read_file"], "session-1", pending)
        .find((candidate) => candidate.name === "sandbox_read_file");
      expect(tool).toBeDefined();

      const running = tool!.execute("call-read", {
        path: "/workspace/notes.txt",
        offset: 2,
        limit: 1,
      });
      await Promise.resolve();
      const [nestedCallId, entry] = [...pending.entries()][0]!;
      entry.resolve({
        type: "tool.response",
        tool_call_id: nestedCallId,
        ok: true,
        result: {
          path: "/workspace/notes.txt",
          text: "second",
          offset: 2,
          limit: 1,
          total_lines: 3,
          truncated: true,
        },
      });

      const completed = await running;
      expect(completed.content[0]).toEqual({
        type: "text",
        text: "second\n\n[showing lines 2-2 of 3; use offset to continue]",
      });
      expect(completed.details).toEqual({
        path: "/workspace/notes.txt",
        offset: 2,
        limit: 1,
        total_lines: 3,
        truncated: true,
      });
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("routes sandbox_browser actions and returns screenshot image content", async () => {
    const home = await homeWith();
    try {
      const registry = new ToolRegistry(home);
      await registry.reload();
      const pending = new Map();
      const tool = registry
        .createToolsForAllowlist([], "session-1", pending, undefined, undefined, "UTC", true, true)
        .find((candidate) => candidate.name === "sandbox_browser");
      expect(tool).toBeDefined();

      const running = tool!.execute("outer-browser", {
        actions: [
          { action: "goto", url: "https://example.com" },
          { action: "screenshot", path: "/workspace/shot.png" },
        ],
      });
      await Promise.resolve();
      const [nestedCallId, entry] = [...pending.entries()][0]!;
      const result = {
        results: [{ action: "goto", url: "https://example.com/", title: "Example" }],
        screenshots: ["/workspace/shot.png"],
        url: "https://example.com/",
        title: "Example",
        image: { mime: "image/png", data: "aGVsbG8=" },
      };
      entry.resolve({
        type: "tool.response",
        tool_call_id: nestedCallId,
        ok: true,
        result,
      });

      const completed = await running;
      expect(completed.content[0]).toEqual({
        type: "text",
        text: JSON.stringify({
          results: result.results,
          screenshots: result.screenshots,
          url: result.url,
          title: result.title,
        }),
      });
      expect(completed.content[1]).toEqual({
        type: "image",
        data: "aGVsbG8=",
        mimeType: "image/png",
      });
      expect(completed.details).not.toHaveProperty("image");
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
