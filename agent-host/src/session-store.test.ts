import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { SessionStore, sessionsDbPath } from "./session-store.ts";

const HOME = "/tmp/chrono-session-store-test";

describe("SessionStore", () => {
  beforeAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(`${HOME}/state`, { recursive: true });
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  test("save load rotate across reopen", () => {
    const path = sessionsDbPath(HOME);
    const logical = "acct:chat:dm#bot1";

    {
      const s = new SessionStore(path);
      const messages = [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "hello" }],
          timestamp: 1,
        },
      ];
      s.save(logical, "acct:chat:dm", "bot1", 0, messages);
      s.close();
    }

    {
      const s = new SessionStore(path);
      const rec = s.load(logical);
      expect(rec.generation).toBe(0);
      expect(rec.messages).toHaveLength(1);
      expect((rec.messages[0] as any).role).toBe("user");

      const gen = s.rotate(logical, "acct:chat:dm", "bot1");
      expect(gen).toBe(1);
      const after = s.load(logical);
      expect(after.generation).toBe(1);
      expect(after.messages).toHaveLength(0);
      s.close();
    }
  });
});
