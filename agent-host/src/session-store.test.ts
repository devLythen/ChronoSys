import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { SessionStore, sessionsDbPath, routeKey } from "./session-store.ts";

const HOME = "/tmp/chrono-uuid-session-test";

describe("SessionStore UUID model", () => {
  beforeAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(`${HOME}/state`, { recursive: true });
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  test("allocates UUID, persists, rotates to new UUID", () => {
    const path = sessionsDbPath(HOME);
    const route = routeKey("acct:chat:dm", "bot1");

    let id1: string;
    {
      const s = new SessionStore(path);
      const rec = s.getOrCreateActive(route, "acct:chat:dm", "bot1");
      expect(rec.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      id1 = rec.sessionId;
      s.save(id1, [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "hello" }],
          timestamp: 1,
        },
      ]);
      s.close();
    }

    {
      const s = new SessionStore(path);
      const rec = s.getOrCreateActive(route, "acct:chat:dm", "bot1");
      expect(rec.sessionId).toBe(id1);
      expect(rec.messages).toHaveLength(1);

      const rotated = s.rotate(route, "acct:chat:dm", "bot1");
      expect(rotated.sessionId).not.toBe(id1);
      expect(rotated.messages).toHaveLength(0);

      // Old session still archived
      const old = s.loadById(id1);
      expect(old).not.toBeNull();
      expect(old!.messages).toHaveLength(1);

      // Active points to new id
      const active = s.getOrCreateActive(route, "acct:chat:dm", "bot1");
      expect(active.sessionId).toBe(rotated.sessionId);
      s.close();
    }
  });
});
