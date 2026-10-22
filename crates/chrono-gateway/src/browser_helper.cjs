#!/usr/bin/env node
"use strict";

/**
 * Fixed helper executed inside the session sandbox. The gateway writes the
 * job as JSON; this file never interpolates user input into shell or code.
 *
 * Image contract: `node` plus a resolvable `playwright` package. The operator
 * may provide an explicit module path in the job (`playwright_path`).
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_TEXT = 100_000;
const MAX_ACTIONS = 50;
const DEFAULT_DIR = "/workspace/.chrono/browser";
const DEFAULT_TIMEOUT = 30_000;

function fail(code, message) {
  const text = String(message ?? code).slice(0, 4000);
  process.stdout.write(JSON.stringify({ ok: false, code, message: text }) + "\n");
  process.exitCode = 1;
}

function loadPlaywright(configuredPath) {
  const candidates = [
    configuredPath,
    "playwright",
    "/opt/chrono/node_modules/playwright",
    "/usr/local/lib/node_modules/playwright",
    "/usr/lib/node_modules/playwright",
  ].filter(Boolean);
  let last;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      last = error;
    }
  }
  const error = new Error(`Playwright not found; tried ${candidates.join(", ")}`);
  error.code = "browser_unavailable";
  error.cause = last;
  throw error;
}

function isPrivateIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1"
  ) {
    return true;
  }
  if (host.includes(":")) {
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    // IPv4-mapped IPv6 (dotted or normalized hex) is easiest to reject whole.
    if (host.startsWith("::ffff:")) return true;
    return false;
  }
  return isPrivateIpv4(host);
}

function checkedUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    const error = new Error(`invalid URL: ${raw}`);
    error.code = "invalid_url";
    throw error;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    const error = new Error("only http(s) URLs are allowed");
    error.code = "invalid_url";
    throw error;
  }
  if (isBlockedHost(url.hostname)) {
    const error = new Error(`blocked private or local host: ${url.hostname}`);
    error.code = "blocked_url";
    throw error;
  }
  return url;
}

function blockedRequest(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === "data:" || url.protocol === "blob:") return false;
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
      return true;
    }
    return isBlockedHost(url.hostname);
  } catch {
    return true;
  }
}

function screenshotPath(raw, index) {
  const target = raw || path.posix.join(DEFAULT_DIR, `shot-${Date.now()}-${index}.png`);
  const normalized = path.posix.normalize(target);
  if (!normalized.startsWith("/workspace/") || normalized.includes("/../") || normalized.endsWith("/..")) {
    const error = new Error(`screenshot path must stay under /workspace/: ${target}`);
    error.code = "invalid_args";
    throw error;
  }
  return normalized;
}

async function runAction(page, action, timeout, index) {
  switch (action.action) {
    case "goto": {
      const url = checkedUrl(action.url);
      const response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout });
      return {
        action: "goto",
        url: page.url(),
        title: await page.title(),
        status: response ? response.status() : null,
      };
    }
    case "click": {
      await page.locator(action.selector).first().click({ timeout });
      return { action: "click", selector: action.selector };
    }
    case "fill": {
      await page.locator(action.selector).first().fill(action.value, { timeout });
      return { action: "fill", selector: action.selector };
    }
    case "wait_for": {
      await page.locator(action.selector).first().waitFor({ state: "visible", timeout });
      return { action: "wait_for", selector: action.selector };
    }
    case "extract": {
      const locator = action.selector ? page.locator(action.selector).first() : page.locator("body");
      const text = await locator.innerText({ timeout });
      return {
        action: "extract",
        selector: action.selector ?? null,
        text: text.slice(0, MAX_TEXT),
        truncated: text.length > MAX_TEXT,
      };
    }
    case "screenshot": {
      const target = screenshotPath(action.path, index);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await page.screenshot({ path: target, fullPage: action.full_page === true });
      return { action: "screenshot", path: target };
    }
    case "wait": {
      const ms = Number.isFinite(action.ms) ? Math.max(1, Math.min(30_000, Math.floor(action.ms))) : 1000;
      await page.waitForTimeout(ms);
      return { action: "wait", ms };
    }
    default: {
      const error = new Error(`unsupported action: ${action.action}`);
      error.code = "invalid_args";
      throw error;
    }
  }
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) {
    fail("invalid_args", "usage: browser-run.cjs <job.json>");
    return;
  }
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  } catch (error) {
    fail("invalid_args", `cannot read job: ${error.message}`);
    return;
  }
  const actions = Array.isArray(job.actions) ? job.actions : [];
  if (actions.length === 0 || actions.length > MAX_ACTIONS) {
    fail("invalid_args", `actions must contain 1..${MAX_ACTIONS} entries`);
    return;
  }
  const timeout = Number.isFinite(job.timeout_ms)
    ? Math.max(1_000, Math.min(295_000, Math.floor(job.timeout_ms)))
    : DEFAULT_TIMEOUT;

  if (job.browsers_path) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = String(job.browsers_path);
  }

  let playwright;
  try {
    playwright = loadPlaywright(job.playwright_path);
  } catch (error) {
    fail(error.code || "browser_unavailable", error.message);
    return;
  }

  let browser;
  try {
    if (!playwright || !playwright.chromium) {
      fail("browser_unavailable", "Playwright package has no chromium export");
      return;
    }
    const executable = playwright.chromium.executablePath();
    if (!fs.existsSync(executable)) {
      fail("browser_unavailable", `Chromium executable not found at ${executable}`);
      return;
    }
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const context = await browser.newContext({
      acceptDownloads: false,
      viewport: { width: 1280, height: 800 },
    });
    await context.route("**/*", (route) => {
      if (blockedRequest(route.request().url())) {
        return route.abort().catch(() => undefined);
      }
      return route.continue().catch(() => undefined);
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    page.on("dialog", (dialog) => {
      dialog.dismiss().catch(() => undefined);
    });

    const results = [];
    const screenshots = [];
    for (let index = 0; index < actions.length; index += 1) {
      try {
        const result = await runAction(page, actions[index], timeout, index);
        results.push(result);
        if (result.action === "screenshot") screenshots.push(result.path);
      } catch (error) {
        const wrapped = new Error(`action ${index} (${actions[index].action}) failed: ${error.message}`);
        wrapped.code = error.code || "browser_action_failed";
        throw wrapped;
      }
    }

    let title = "";
    let url = page.url();
    try {
      title = await page.title();
      url = page.url();
    } catch {
      /* page may be closed by a failed action */
    }
    process.stdout.write(
      JSON.stringify({ ok: true, results, screenshots, url, title }) + "\n",
    );
  } catch (error) {
    fail(error.code || "browser_failed", error.message);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

main().catch((error) => fail(error.code || "browser_failed", error.message));
