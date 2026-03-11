/**
 * Vision-based CAPTCHA solver — uses the AI model's own vision to solve CAPTCHAs.
 *
 * Flow:
 * 1. Detect CAPTCHA type on the page (reCAPTCHA, hCaptcha, Turnstile, etc.)
 * 2. Auto-click the checkbox if present
 * 3. Screenshot the page so the model can see the result
 * 4. Return detection info + screenshot path for the model to continue solving
 *
 * No external API keys needed — the model IS the solver.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "playwright-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaptchaSolveResult = {
  ok: boolean;
  /** What type of CAPTCHA was detected */
  captchaType: string;
  /** Current status after auto-actions */
  status: "solved" | "challenge_visible" | "clicked_checkbox" | "no_captcha" | "error";
  /** Path to screenshot showing current state */
  screenshotPath?: string;
  /** Instructions for the model on what to do next */
  nextStep?: string;
  /** Error message if something went wrong */
  error?: string;
  /** Details about what was found/done */
  details?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Detection script — runs inside the browser page
// ---------------------------------------------------------------------------

const DETECT_CAPTCHA_SCRIPT = `(() => {
  const found = [];
  const pageUrl = window.location.href;

  // --- reCAPTCHA v2 ---
  // Check for the checkbox iframe
  const recapIframes = document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]');
  for (const iframe of recapIframes) {
    const src = iframe.getAttribute('src') || '';
    const kMatch = src.match(/[?&]k=([A-Za-z0-9_-]+)/);
    found.push({
      type: 'recaptcha-v2',
      sitekey: kMatch ? kMatch[1] : 'unknown',
      pageUrl,
      hasCheckboxIframe: true,
      iframeSrc: src,
    });
  }

  // Check for challenge iframe (image grid)
  const challengeIframes = document.querySelectorAll('iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]');
  if (challengeIframes.length > 0) {
    const existing = found.find(f => f.type === 'recaptcha-v2');
    if (existing) {
      existing.hasChallengeIframe = true;
    } else {
      found.push({
        type: 'recaptcha-v2',
        sitekey: 'unknown',
        pageUrl,
        hasCheckboxIframe: false,
        hasChallengeIframe: true,
      });
    }
  }

  // Data-sitekey elements
  const sitekeyEl = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey]');
  if (sitekeyEl && found.length === 0) {
    found.push({
      type: 'recaptcha-v2',
      sitekey: sitekeyEl.getAttribute('data-sitekey') || 'unknown',
      pageUrl,
      hasCheckboxIframe: false,
    });
  }

  // --- reCAPTCHA v3 (invisible, score-based) ---
  const v3Scripts = document.querySelectorAll('script[src*="recaptcha"][src*="render="]');
  for (const s of v3Scripts) {
    const src = s.getAttribute('src') || '';
    const renderMatch = src.match(/render=([A-Za-z0-9_-]+)/);
    if (renderMatch && renderMatch[1] !== 'explicit') {
      found.push({
        type: 'recaptcha-v3',
        sitekey: renderMatch[1],
        pageUrl,
        note: 'Invisible/score-based — no visual challenge to solve',
      });
    }
  }

  // --- hCaptcha ---
  const hcapIframes = document.querySelectorAll('iframe[src*="hcaptcha.com/captcha"]');
  for (const iframe of hcapIframes) {
    const src = iframe.getAttribute('src') || '';
    const kMatch = src.match(/sitekey=([A-Za-z0-9_-]+)/);
    found.push({
      type: 'hcaptcha',
      sitekey: kMatch ? kMatch[1] : 'unknown',
      pageUrl,
    });
  }
  const hcapEl = document.querySelector('.h-captcha[data-sitekey]');
  if (hcapEl && !found.some(f => f.type === 'hcaptcha')) {
    found.push({
      type: 'hcaptcha',
      sitekey: hcapEl.getAttribute('data-sitekey') || 'unknown',
      pageUrl,
    });
  }

  // --- Cloudflare Turnstile ---
  const turnstileIframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
  for (const iframe of turnstileIframes) {
    found.push({ type: 'turnstile', pageUrl });
  }
  const turnstileEl = document.querySelector('.cf-turnstile[data-sitekey]');
  if (turnstileEl && !found.some(f => f.type === 'turnstile')) {
    found.push({
      type: 'turnstile',
      sitekey: turnstileEl.getAttribute('data-sitekey') || 'unknown',
      pageUrl,
    });
  }

  // --- Generic image CAPTCHA (common patterns) ---
  const captchaImages = document.querySelectorAll(
    'img[alt*="captcha" i], img[src*="captcha" i], img[class*="captcha" i], ' +
    'img[id*="captcha" i], .captcha img, #captcha img'
  );
  if (captchaImages.length > 0 && found.length === 0) {
    found.push({
      type: 'image-captcha',
      pageUrl,
      imageCount: captchaImages.length,
    });
  }

  return found;
})()`;

// ---------------------------------------------------------------------------
// Check if reCAPTCHA was already solved
// ---------------------------------------------------------------------------

const CHECK_RECAPTCHA_SOLVED_SCRIPT = `(() => {
  // Check if the g-recaptcha-response textarea has a value
  const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
  if (textarea && textarea.value && textarea.value.length > 20) {
    return { solved: true, method: 'response-token' };
  }
  // Check for recaptcha badge showing "verified"
  return { solved: false };
})()`;

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

function getScreenshotDir(): string {
  const dir = join(tmpdir(), "openclaw-captcha");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function screenshotPage(page: Page, label: string): Promise<string> {
  const dir = getScreenshotDir();
  const filename = `captcha-${label}-${Date.now()}.png`;
  const filepath = join(dir, filename);
  await page.screenshot({ path: filepath, fullPage: false });
  return filepath;
}

// ---------------------------------------------------------------------------
// Auto-click helpers
// ---------------------------------------------------------------------------

async function clickRecaptchaCheckbox(page: Page): Promise<boolean> {
  try {
    // The reCAPTCHA checkbox lives inside an iframe
    const frame = page.frameLocator(
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]',
    );
    const checkbox = frame.locator('#recaptcha-anchor, .recaptcha-checkbox');
    const count = await checkbox.count();
    if (count > 0) {
      await checkbox.first().click({ timeout: 5000 });
      // Wait for potential challenge or solve
      await page.waitForTimeout(2000);
      return true;
    }
  } catch {
    // iframe may not be accessible
  }
  return false;
}

async function clickHcaptchaCheckbox(page: Page): Promise<boolean> {
  try {
    const frame = page.frameLocator('iframe[src*="hcaptcha.com"]');
    const checkbox = frame.locator('#checkbox, .check');
    const count = await checkbox.count();
    if (count > 0) {
      await checkbox.first().click({ timeout: 5000 });
      await page.waitForTimeout(2000);
      return true;
    }
  } catch {
    // iframe may not be accessible
  }
  return false;
}

async function clickTurnstileCheckbox(page: Page): Promise<boolean> {
  try {
    const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
    // Turnstile has a checkbox-like element
    const checkbox = frame.locator('input[type="checkbox"], .cb-i');
    const count = await checkbox.count();
    if (count > 0) {
      await checkbox.first().click({ timeout: 5000 });
      await page.waitForTimeout(2000);
      return true;
    }
  } catch {
    // iframe may not be accessible
  }
  return false;
}

// ---------------------------------------------------------------------------
// Check if challenge appeared after clicking checkbox
// ---------------------------------------------------------------------------

async function hasImageChallenge(page: Page): Promise<boolean> {
  try {
    // reCAPTCHA image challenge iframe becomes visible
    const challengeFrame = page.locator(
      'iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]',
    );
    const count = await challengeFrame.count();
    if (count > 0) {
      const box = await challengeFrame.first().boundingBox();
      // Challenge iframe is visible if it has non-zero dimensions
      if (box && box.width > 50 && box.height > 50) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect and attempt to solve CAPTCHA on the current page.
 *
 * Strategy:
 * 1. Detect CAPTCHA type
 * 2. Auto-click checkbox (reCAPTCHA/hCaptcha/Turnstile)
 * 3. Check if solved or if image challenge appeared
 * 4. Screenshot the page for the model to see
 * 5. Return status + instructions for next steps
 */
export async function solveCaptcha(page: Page): Promise<CaptchaSolveResult> {
  // 1. Detect
  let detected: Array<Record<string, unknown>>;
  try {
    detected = (await page.evaluate(DETECT_CAPTCHA_SCRIPT)) as Array<Record<string, unknown>>;
  } catch (err) {
    return {
      ok: false,
      captchaType: "unknown",
      status: "error",
      error: `Failed to detect CAPTCHA: ${String(err)}`,
    };
  }

  if (!detected || detected.length === 0) {
    return {
      ok: true,
      captchaType: "none",
      status: "no_captcha",
      nextStep: "No CAPTCHA detected on this page. Continue with your task.",
    };
  }

  const captcha = detected[0];
  const captchaType = String(captcha.type || "unknown");

  // 2. Auto-click checkbox
  let clicked = false;
  switch (captchaType) {
    case "recaptcha-v2":
      clicked = await clickRecaptchaCheckbox(page);
      break;
    case "hcaptcha":
      clicked = await clickHcaptchaCheckbox(page);
      break;
    case "turnstile":
      clicked = await clickTurnstileCheckbox(page);
      break;
    case "recaptcha-v3":
      // v3 is invisible/score-based — nothing to click
      return {
        ok: true,
        captchaType: "recaptcha-v3",
        status: "solved",
        nextStep:
          "reCAPTCHA v3 is invisible and score-based. It runs automatically. " +
          "If the form still fails, the site may be blocking automated browsers. " +
          "Try submitting the form normally.",
        details: captcha,
      };
    case "image-captcha":
      // Screenshot for the model to solve visually
      break;
  }

  // 3. Check result
  if (clicked && (captchaType === "recaptcha-v2" || captchaType === "hcaptcha")) {
    // Check if it was solved just by clicking (sometimes reCAPTCHA auto-passes)
    const solvedCheck = (await page.evaluate(CHECK_RECAPTCHA_SOLVED_SCRIPT).catch(() => ({
      solved: false,
    }))) as { solved: boolean };

    if (solvedCheck.solved) {
      const screenshotPath = await screenshotPage(page, "solved");
      return {
        ok: true,
        captchaType,
        status: "solved",
        screenshotPath,
        nextStep: "CAPTCHA solved! The checkbox was accepted. Continue with the form.",
        details: captcha,
      };
    }

    // Check if an image challenge appeared
    const hasChallenge = await hasImageChallenge(page);
    if (hasChallenge) {
      const screenshotPath = await screenshotPage(page, "challenge");
      return {
        ok: true,
        captchaType,
        status: "challenge_visible",
        screenshotPath,
        nextStep:
          "An image challenge appeared after clicking the checkbox. " +
          "Look at the screenshot to see the challenge. " +
          "Use action='screenshot' to see it clearly, then: " +
          "1. Read the challenge instruction (e.g. 'Select all images with traffic lights') " +
          "2. Use action='act' with kind='click' to click each matching image tile " +
          "3. The image tiles are usually in a 3x3 or 4x4 grid inside the challenge iframe " +
          "4. After selecting all matching images, click the 'Verify' button " +
          "5. Use action='screenshot' again to check if it was solved " +
          "6. If a new challenge appears, repeat the process",
        details: { ...captcha, challengeVisible: true },
      };
    }

    // Clicked but unclear result — screenshot for model to assess
    const screenshotPath = await screenshotPage(page, "after-click");
    return {
      ok: true,
      captchaType,
      status: "clicked_checkbox",
      screenshotPath,
      nextStep:
        "Clicked the CAPTCHA checkbox. Take a screenshot to see the current state. " +
        "If you see a green checkmark, the CAPTCHA is solved. " +
        "If you see an image challenge, solve it visually by clicking the correct images.",
      details: captcha,
    };
  }

  // 4. For unchecked CAPTCHAs or image CAPTCHAs — just screenshot
  const screenshotPath = await screenshotPage(page, "detected");
  return {
    ok: true,
    captchaType,
    status: "challenge_visible",
    screenshotPath,
    nextStep:
      captchaType === "image-captcha"
        ? "Image CAPTCHA detected. Take a screenshot to see it, read the text/image, " +
          "and type the answer into the input field."
        : captchaType === "turnstile"
          ? "Cloudflare Turnstile detected. It usually auto-solves. " +
            "If it shows a challenge, take a screenshot and follow the instructions."
          : "CAPTCHA detected. Take a screenshot to see it and solve it visually.",
    details: captcha,
  };
}
