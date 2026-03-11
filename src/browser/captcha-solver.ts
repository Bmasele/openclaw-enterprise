/**
 * CAPTCHA solver integration — detects and solves CAPTCHAs via external
 * solving services (2Captcha, CapSolver, etc.).
 *
 * Supports: reCAPTCHA v2, reCAPTCHA v3, hCaptcha, Turnstile, image CAPTCHAs.
 */

import type { Page } from "playwright-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaptchaSolverConfig = {
  provider: string;
  apiKey: string;
  settings?: Record<string, unknown>;
};

type DetectedCaptcha =
  | { type: "recaptcha-v2"; sitekey: string; pageUrl: string; isInvisible: boolean }
  | { type: "recaptcha-v3"; sitekey: string; pageUrl: string; action?: string }
  | { type: "hcaptcha"; sitekey: string; pageUrl: string }
  | { type: "turnstile"; sitekey: string; pageUrl: string }
  | { type: "image"; base64: string };

type SolveResult = {
  ok: boolean;
  type: string;
  token?: string;
  error?: string;
  injected?: boolean;
};

// ---------------------------------------------------------------------------
// Detection — runs in the browser page via evaluate
// ---------------------------------------------------------------------------

const DETECT_CAPTCHA_SCRIPT = `(() => {
  const result = [];
  const pageUrl = window.location.href;

  // reCAPTCHA v2 / v3
  const recaptchaEl = document.querySelector('.g-recaptcha, [data-sitekey]');
  if (recaptchaEl) {
    const sitekey = recaptchaEl.getAttribute('data-sitekey');
    const size = recaptchaEl.getAttribute('data-size');
    if (sitekey) {
      result.push({
        type: size === 'invisible' ? 'recaptcha-v2' : 'recaptcha-v2',
        sitekey,
        pageUrl,
        isInvisible: size === 'invisible',
      });
    }
  }

  // reCAPTCHA v3 via script tag
  if (!recaptchaEl) {
    const scripts = document.querySelectorAll('script[src*="recaptcha"]');
    for (const s of scripts) {
      const src = s.getAttribute('src') || '';
      const renderMatch = src.match(/render=([A-Za-z0-9_-]+)/);
      if (renderMatch && renderMatch[1] !== 'explicit') {
        result.push({
          type: 'recaptcha-v3',
          sitekey: renderMatch[1],
          pageUrl,
        });
      }
    }
  }

  // Recaptcha inside iframes
  if (result.length === 0) {
    const iframes = document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]');
    for (const iframe of iframes) {
      const src = iframe.getAttribute('src') || '';
      const kMatch = src.match(/[?&]k=([A-Za-z0-9_-]+)/);
      if (kMatch) {
        result.push({
          type: 'recaptcha-v2',
          sitekey: kMatch[1],
          pageUrl,
          isInvisible: false,
        });
      }
    }
  }

  // hCaptcha
  const hcaptchaEl = document.querySelector('.h-captcha, [data-hcaptcha-sitekey]');
  if (hcaptchaEl) {
    const sitekey = hcaptchaEl.getAttribute('data-sitekey') || hcaptchaEl.getAttribute('data-hcaptcha-sitekey');
    if (sitekey) {
      result.push({ type: 'hcaptcha', sitekey, pageUrl });
    }
  }

  // hCaptcha iframes
  if (!hcaptchaEl) {
    const hIframes = document.querySelectorAll('iframe[src*="hcaptcha.com"]');
    for (const iframe of hIframes) {
      const src = iframe.getAttribute('src') || '';
      const kMatch = src.match(/sitekey=([A-Za-z0-9_-]+)/);
      if (kMatch) {
        result.push({ type: 'hcaptcha', sitekey: kMatch[1], pageUrl });
      }
    }
  }

  // Cloudflare Turnstile
  const turnstileEl = document.querySelector('.cf-turnstile, [data-turnstile-sitekey]');
  if (turnstileEl) {
    const sitekey = turnstileEl.getAttribute('data-sitekey') || turnstileEl.getAttribute('data-turnstile-sitekey');
    if (sitekey) {
      result.push({ type: 'turnstile', sitekey, pageUrl });
    }
  }

  // Turnstile iframes
  if (!turnstileEl) {
    const tIframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
    for (const iframe of tIframes) {
      const src = iframe.getAttribute('src') || '';
      const kMatch = src.match(/sitekey=([A-Za-z0-9_-]+)/);
      if (kMatch) {
        result.push({ type: 'turnstile', sitekey: kMatch[1], pageUrl });
      }
    }
  }

  return result;
})()`;

// ---------------------------------------------------------------------------
// Injection — injects the solved token back into the page
// ---------------------------------------------------------------------------

function buildInjectScript(captchaType: string, token: string): string {
  const escaped = token.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  switch (captchaType) {
    case "recaptcha-v2":
    case "recaptcha-v3":
      return `(() => {
        // Set textarea value
        const textarea = document.getElementById('g-recaptcha-response');
        if (textarea) {
          textarea.value = '${escaped}';
          textarea.style.display = 'block';
        }
        // Also set any hidden textareas in iframes
        document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(el => {
          el.value = '${escaped}';
        });
        // Call the callback if registered
        if (typeof window.___grecaptcha_cfg !== 'undefined') {
          const clients = window.___grecaptcha_cfg?.clients;
          if (clients) {
            for (const key of Object.keys(clients)) {
              const client = clients[key];
              // Walk the client object to find the callback
              const walk = (obj, depth) => {
                if (depth > 5 || !obj || typeof obj !== 'object') return;
                for (const k of Object.keys(obj)) {
                  if (typeof obj[k] === 'function' && k.length < 5) {
                    try { obj[k]('${escaped}'); } catch {}
                  }
                  walk(obj[k], depth + 1);
                }
              };
              walk(client, 0);
            }
          }
        }
        // Try global callback
        const el = document.querySelector('.g-recaptcha, [data-sitekey]');
        const cbName = el?.getAttribute('data-callback');
        if (cbName && typeof window[cbName] === 'function') {
          window[cbName]('${escaped}');
        }
        return true;
      })()`;

    case "hcaptcha":
      return `(() => {
        const textarea = document.querySelector('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]');
        if (textarea) textarea.value = '${escaped}';
        // hCaptcha callback
        const el = document.querySelector('.h-captcha, [data-hcaptcha-sitekey]');
        const cbName = el?.getAttribute('data-callback');
        if (cbName && typeof window[cbName] === 'function') {
          window[cbName]('${escaped}');
        }
        // Also try hcaptcha object
        if (typeof window.hcaptcha !== 'undefined' && window.hcaptcha.getRespKey) {
          // Trigger internal submit
          document.querySelectorAll('iframe[src*="hcaptcha"]').forEach(f => {
            f.setAttribute('data-hcaptcha-response', '${escaped}');
          });
        }
        return true;
      })()`;

    case "turnstile":
      return `(() => {
        const input = document.querySelector('input[name="cf-turnstile-response"]');
        if (input) input.value = '${escaped}';
        const el = document.querySelector('.cf-turnstile, [data-turnstile-sitekey]');
        const cbName = el?.getAttribute('data-callback');
        if (cbName && typeof window[cbName] === 'function') {
          window[cbName]('${escaped}');
        }
        if (typeof window.turnstile !== 'undefined' && typeof window.turnstile.getResponse === 'function') {
          // Trigger callback
        }
        return true;
      })()`;

    default:
      return "false";
  }
}

// ---------------------------------------------------------------------------
// 2Captcha API
// ---------------------------------------------------------------------------

async function solve2Captcha(
  apiKey: string,
  captcha: DetectedCaptcha,
): Promise<{ token?: string; error?: string }> {
  const baseUrl = "https://2captcha.com";

  let createPayload: Record<string, string>;

  switch (captcha.type) {
    case "recaptcha-v2":
      createPayload = {
        key: apiKey,
        method: "userrecaptcha",
        googlekey: captcha.sitekey,
        pageurl: captcha.pageUrl,
        ...(captcha.isInvisible ? { invisible: "1" } : {}),
        json: "1",
      };
      break;
    case "recaptcha-v3":
      createPayload = {
        key: apiKey,
        method: "userrecaptcha",
        version: "v3",
        googlekey: captcha.sitekey,
        pageurl: captcha.pageUrl,
        ...(captcha.action ? { action: captcha.action } : {}),
        min_score: "0.3",
        json: "1",
      };
      break;
    case "hcaptcha":
      createPayload = {
        key: apiKey,
        method: "hcaptcha",
        sitekey: captcha.sitekey,
        pageurl: captcha.pageUrl,
        json: "1",
      };
      break;
    case "turnstile":
      createPayload = {
        key: apiKey,
        method: "turnstile",
        sitekey: captcha.sitekey,
        pageurl: captcha.pageUrl,
        json: "1",
      };
      break;
    case "image":
      createPayload = {
        key: apiKey,
        method: "base64",
        body: captcha.base64,
        json: "1",
      };
      break;
    default:
      return { error: `Unsupported CAPTCHA type: ${(captcha as { type: string }).type}` };
  }

  // Submit task
  const form = new URLSearchParams(createPayload);
  const createRes = await fetch(`${baseUrl}/in.php`, {
    method: "POST",
    body: form,
  });
  const createData = (await createRes.json()) as { status: number; request: string };
  if (createData.status !== 1) {
    return { error: `2Captcha submit failed: ${createData.request}` };
  }
  const taskId = createData.request;

  // Poll for result (max 120s)
  const maxAttempts = 24;
  const pollInterval = 5000;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, pollInterval));
    const resultRes = await fetch(
      `${baseUrl}/res.php?key=${encodeURIComponent(apiKey)}&action=get&id=${encodeURIComponent(taskId)}&json=1`,
    );
    const resultData = (await resultRes.json()) as { status: number; request: string };
    if (resultData.status === 1) {
      return { token: resultData.request };
    }
    if (resultData.request !== "CAPCHA_NOT_READY") {
      return { error: `2Captcha solve failed: ${resultData.request}` };
    }
  }
  return { error: "2Captcha timeout — CAPTCHA not solved within 120s" };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectCaptcha(page: Page): Promise<DetectedCaptcha[]> {
  const results = await page.evaluate(DETECT_CAPTCHA_SCRIPT);
  return (results as DetectedCaptcha[]) ?? [];
}

export async function solveCaptcha(
  page: Page,
  config: CaptchaSolverConfig,
): Promise<SolveResult> {
  // 1. Detect
  const detected = await detectCaptcha(page);
  if (detected.length === 0) {
    return { ok: false, type: "none", error: "No CAPTCHA detected on the page" };
  }

  const captcha = detected[0];

  // 2. Solve via provider
  let result: { token?: string; error?: string };
  switch (config.provider) {
    case "2captcha":
      result = await solve2Captcha(config.apiKey, captcha);
      break;
    default:
      return {
        ok: false,
        type: captcha.type,
        error: `Unsupported CAPTCHA solver provider: ${config.provider}. Supported: 2captcha`,
      };
  }

  if (result.error || !result.token) {
    return { ok: false, type: captcha.type, error: result.error ?? "No token returned" };
  }

  // 3. Inject solution
  if (captcha.type !== "image") {
    const injectScript = buildInjectScript(captcha.type, result.token);
    try {
      await page.evaluate(injectScript);
    } catch {
      // injection failed but we still have the token
      return { ok: true, type: captcha.type, token: result.token, injected: false };
    }
    return { ok: true, type: captcha.type, token: result.token, injected: true };
  }

  // For image CAPTCHAs, the token is the text answer — agent needs to type it
  return { ok: true, type: captcha.type, token: result.token, injected: false };
}
