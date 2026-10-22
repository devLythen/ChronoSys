import { test, expect } from "bun:test";
import { cleanOutboundText } from "./tools.ts";

test("strips a leaked closing text tag", () => {
  expect(cleanOutboundText("三层山就是正弦波</text>\n")).toBe("三层山就是正弦波");
  expect(cleanOutboundText("（这条带括号）</text>")).toBe("（这条带括号）");
});

test("preserves complete or unrelated text", () => {
  expect(cleanOutboundText("plain message")).toBe("plain message");
  expect(cleanOutboundText("<text>hello</text>")).toBe("<text>hello</text>");
  expect(cleanOutboundText("code: </div>")).toBe("code: </div>");
});
