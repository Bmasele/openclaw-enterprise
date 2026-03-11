/**
 * Vision-based CAPTCHA solver — uses the AI model's own vision to solve CAPTCHAs.
 *
 * Key design: screenshots the CAPTCHA challenge iframe directly (not full page)
 * so the model sees tiles at full resolution for accurate identification.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page, Locator, FrameLocator } from "playwright-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaptchaSolveResult = {
  ok: boolean;
  captchaType: string;
  status: "solved" | "challenge_visible" | "clicked_checkbox" | "no_captcha" | "error";
  screenshotPath?: string;
  /** Challenge instruction text (e.g. "Select all images with buses") */
  challengeText?: string;
  /** Grid dimensions if image challenge (e.g. "3x3" or "4x4") */
  gridSize?: string;
  /** Instructions for the model on what to do next */
  nextStep?: string;
  error?: string;
  details?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Detection script
// ---------------------------------------------------------------------------

const DETECT_CAPTCHA_SCRIPT = `(() => {
  const found = [];
  const pageUrl = window.location.href;

  // reCAPTCHA checkbox iframe
  const recapAnchors = document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]');
  // reCAPTCHA challenge iframe
  const recapChallenges = document.querySelectorAll('iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]');

  if (recapAnchors.length > 0 || recapChallenges.length > 0) {
    const src = (recapAnchors[0] || recapChallenges[0])?.getAttribute('src') || '';
    const kMatch = src.match(/[?&]k=([A-Za-z0-9_-]+)/);
    found.push({
      type: 'recaptcha-v2',
      sitekey: kMatch ? kMatch[1] : 'unknown',
      pageUrl,
      hasCheckbox: recapAnchors.length > 0,
      hasChallenge: recapChallenges.length > 0,
      challengeVisible: false,
    });
    // Check if challenge iframe is visible (has dimensions)
    if (recapChallenges.length > 0) {
      const rect = recapChallenges[0].getBoundingClientRect();
      if (rect.width > 50 && rect.height > 50) {
        found[found.length - 1].challengeVisible = true;
      }
    }
  }

  // Data-sitekey elements (fallback)
  if (found.length === 0) {
    const sitekeyEl = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey]');
    if (sitekeyEl) {
      found.push({
        type: 'recaptcha-v2',
        sitekey: sitekeyEl.getAttribute('data-sitekey') || 'unknown',
        pageUrl,
        hasCheckbox: false,
        hasChallenge: false,
      });
    }
  }

  // reCAPTCHA v3
  const v3Scripts = document.querySelectorAll('script[src*="recaptcha"][src*="render="]');
  for (const s of v3Scripts) {
    const src = s.getAttribute('src') || '';
    const m = src.match(/render=([A-Za-z0-9_-]+)/);
    if (m && m[1] !== 'explicit') {
      found.push({ type: 'recaptcha-v3', sitekey: m[1], pageUrl });
    }
  }

  // hCaptcha
  const hcapIframes = document.querySelectorAll('iframe[src*="hcaptcha.com"]');
  const hcapEl = document.querySelector('.h-captcha[data-sitekey]');
  if (hcapIframes.length > 0 || hcapEl) {
    found.push({
      type: 'hcaptcha',
      sitekey: hcapEl?.getAttribute('data-sitekey') || 'unknown',
      pageUrl,
    });
  }

  // Turnstile
  const turnstileIframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
  const turnstileEl = document.querySelector('.cf-turnstile[data-sitekey]');
  if (turnstileIframes.length > 0 || turnstileEl) {
    found.push({
      type: 'turnstile',
      sitekey: turnstileEl?.getAttribute('data-sitekey') || 'unknown',
      pageUrl,
    });
  }

  // Generic image CAPTCHA
  const captchaImgs = document.querySelectorAll(
    'img[alt*="captcha" i], img[src*="captcha" i], .captcha img, #captcha img'
  );
  if (captchaImgs.length > 0 && found.length === 0) {
    found.push({ type: 'image-captcha', pageUrl, imageCount: captchaImgs.length });
  }

  return found;
})()`;

// ---------------------------------------------------------------------------
// Challenge iframe helpers
// ---------------------------------------------------------------------------

/**
 * Get the reCAPTCHA challenge FrameLocator (the bframe iframe that shows image tiles).
 */
function getChallengeFrameLocator(page: Page): FrameLocator {
  return page.frameLocator(
    'iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]',
  );
}

/**
 * Get the reCAPTCHA challenge iframe element (for screenshots).
 */
function getChallengeIframeLocator(page: Page): Locator {
  return page.locator(
    'iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]',
  );
}

/**
 * Check if the challenge iframe is visible with reasonable dimensions.
 */
async function isChallengeVisible(page: Page): Promise<boolean> {
  try {
    const iframe = getChallengeIframeLocator(page);
    const count = await iframe.count();
    if (count === 0) return false;
    const box = await iframe.first().boundingBox();
    return box !== null && box.width > 100 && box.height > 100;
  } catch {
    return false;
  }
}

/**
 * Wait for the challenge content to load inside the iframe.
 * The iframe element can be visible before its inner content renders.
 */
async function waitForChallengeContent(page: Page, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const frame = getChallengeFrameLocator(page);
      // Check if the instruction text element exists
      const instructionEl = frame.locator(
        '.rc-imageselect-desc-wrapper, .rc-imageselect-desc, .rc-imageselect-instructions',
      );
      const count = await instructionEl.count();
      if (count > 0) {
        const text = await instructionEl.first().innerText({ timeout: 1000 });
        if (text && text.trim().length > 5) return true;
      }
    } catch {
      // content not ready yet
    }
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Extract the challenge instruction text from inside the challenge iframe.
 * e.g. "Select all images with buses" or "Select all squares with crosswalks"
 */
async function extractChallengeText(page: Page): Promise<string | undefined> {
  try {
    const frame = getChallengeFrameLocator(page);
    // Try multiple selectors — Google varies the DOM structure
    const selectors = [
      '.rc-imageselect-desc-wrapper',
      '.rc-imageselect-desc',
      '.rc-imageselect-instructions',
      '.rc-imageselect-desc-no-canonical',
    ];
    for (const sel of selectors) {
      const el = frame.locator(sel);
      const count = await el.count();
      if (count > 0) {
        const text = await el.first().innerText({ timeout: 2000 });
        if (text && text.trim().length > 3) return text.trim();
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Detect grid size from challenge iframe (3x3 or 4x4).
 */
async function detectGridSize(page: Page): Promise<string | undefined> {
  try {
    const frame = getChallengeFrameLocator(page);
    // Check for table with grid class
    const table = frame.locator('table.rc-imageselect-table-44, table.rc-imageselect-table-33');
    const count = await table.count();
    if (count > 0) {
      const cls = await table.first().getAttribute("class");
      if (cls?.includes("44")) return "4x4";
      if (cls?.includes("33")) return "3x3";
    }
    // Fallback: count tiles by td elements
    const tiles = frame.locator('td.rc-imageselect-tile');
    const tileCount = await tiles.count();
    if (tileCount === 16) return "4x4";
    if (tileCount === 9) return "3x3";
    // Fallback: count by image divs
    const imgDivs = frame.locator('.rc-image-tile-wrapper');
    const imgDivCount = await imgDivs.count();
    if (imgDivCount === 16) return "4x4";
    if (imgDivCount === 9) return "3x3";
  } catch {
    // ignore
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Screenshot helpers
// ---------------------------------------------------------------------------

function getScreenshotDir(): string {
  const dir = join(tmpdir(), "openclaw-captcha");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Screenshot JUST the challenge iframe element at high quality.
 * Falls back to full page if the iframe can't be screenshotted.
 */
async function screenshotChallenge(page: Page, label: string): Promise<string> {
  const dir = getScreenshotDir();
  const filename = `captcha-${label}-${Date.now()}.png`;
  const filepath = join(dir, filename);

  try {
    const iframe = getChallengeIframeLocator(page);
    const count = await iframe.count();
    if (count > 0) {
      const box = await iframe.first().boundingBox();
      if (box && box.width > 100 && box.height > 100) {
        // Screenshot just the challenge iframe element for maximum tile resolution
        await iframe.first().screenshot({ path: filepath });
        return filepath;
      }
    }
  } catch {
    // fallback to full page
  }

  // Fallback: full page screenshot
  await page.screenshot({ path: filepath, fullPage: false });
  return filepath;
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
    const frame = page.frameLocator(
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]',
    );
    const checkbox = frame.locator('#recaptcha-anchor, .recaptcha-checkbox');
    const count = await checkbox.count();
    if (count > 0) {
      await checkbox.first().click({ timeout: 5000 });
      await page.waitForTimeout(3000); // Wait for challenge or solve
      return true;
    }
  } catch {
    // ignore
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
      await page.waitForTimeout(3000);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

async function clickTurnstileCheckbox(page: Page): Promise<boolean> {
  try {
    const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
    const el = frame.locator('input[type="checkbox"], .cb-i');
    const count = await el.count();
    if (count > 0) {
      await el.first().click({ timeout: 5000 });
      await page.waitForTimeout(3000);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

// ---------------------------------------------------------------------------
// Check if solved
// ---------------------------------------------------------------------------

const CHECK_SOLVED_SCRIPT = `(() => {
  const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
  if (textarea && textarea.value && textarea.value.length > 20) {
    return { solved: true };
  }
  return { solved: false };
})()`;

async function checkIfSolved(page: Page): Promise<boolean> {
  try {
    const result = (await page.evaluate(CHECK_SOLVED_SCRIPT)) as { solved: boolean };
    return result.solved;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
      error: `Detection failed: ${String(err)}`,
    };
  }

  if (!detected || detected.length === 0) {
    return {
      ok: true,
      captchaType: "none",
      status: "no_captcha",
      nextStep: "No CAPTCHA detected. Continue with your task.",
    };
  }

  const captcha = detected[0];
  const captchaType = String(captcha.type || "unknown");

  // reCAPTCHA v3 — invisible, nothing to do
  if (captchaType === "recaptcha-v3") {
    return {
      ok: true,
      captchaType,
      status: "solved",
      nextStep: "reCAPTCHA v3 is invisible/score-based. Just submit the form normally.",
    };
  }

  // 2. If challenge is already visible (e.g. called again after first solveCaptcha),
  //    skip clicking checkbox and go straight to screenshot
  const alreadyHasChallenge = captcha.challengeVisible === true || (await isChallengeVisible(page));

  if (!alreadyHasChallenge) {
    // Click the checkbox
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
    }

    if (!clicked) {
      const screenshotPath = await screenshotPage(page, "no-click");
      return {
        ok: false,
        captchaType,
        status: "error",
        screenshotPath,
        error: "Could not find/click the CAPTCHA checkbox.",
        nextStep: "Take a screenshot to see the page state and try clicking the CAPTCHA manually.",
      };
    }

    // Check if it was solved just by clicking
    if (await checkIfSolved(page)) {
      return {
        ok: true,
        captchaType,
        status: "solved",
        nextStep: "CAPTCHA solved! The checkbox was accepted without image challenge. Continue with the form.",
      };
    }
  }

  // 3. Check if image challenge appeared
  const challengeVisible = await isChallengeVisible(page);
  if (!challengeVisible) {
    // Might be solved or might need more time
    const solved = await checkIfSolved(page);
    if (solved) {
      return {
        ok: true,
        captchaType,
        status: "solved",
        nextStep: "CAPTCHA solved! Continue with the form.",
      };
    }
    const screenshotPath = await screenshotPage(page, "after-click");
    return {
      ok: true,
      captchaType,
      status: "clicked_checkbox",
      screenshotPath,
      nextStep:
        "Clicked checkbox but no clear result yet. Take a screenshot to check the state. " +
        "If you see a green checkmark, it's solved. If you see an image grid, call solveCaptcha again.",
    };
  }

  // 4. Image challenge is visible — wait for content to load, then screenshot
  await waitForChallengeContent(page, 5000);
  const challengeText = await extractChallengeText(page);
  const gridSize = await detectGridSize(page);
  const screenshotPath = await screenshotChallenge(page, "challenge");

  const BFRAME_SELECTOR = 'iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]';

  return {
    ok: true,
    captchaType,
    status: "challenge_visible",
    screenshotPath,
    challengeText: challengeText ?? undefined,
    gridSize: gridSize ?? undefined,
    nextStep:
      `Image challenge: "${challengeText ?? "unknown"}". Grid: ${gridSize ?? "unknown"}. ` +
      "This screenshot shows ONLY the challenge popup at full resolution. " +
      "CAREFULLY examine each tile in the grid. " +
      "The tiles are numbered left-to-right, top-to-bottom (tile 1 = top-left, tile 9 = bottom-right for 3x3). " +
      "DO NOT GIVE UP. You MUST solve this CAPTCHA. Follow these steps:\n" +
      `1. Use action='snapshot' with frame='${BFRAME_SELECTOR}' to get clickable element refs for the tiles inside the challenge iframe.\n` +
      "2. Look at the screenshot to identify which tiles match the challenge instruction.\n" +
      "3. Click each matching tile using action='act' with kind='click' and the tile's ref.\n" +
      "4. BEFORE clicking Verify/Next: take another screenshot to double-check your selections. " +
      "Look carefully — did you miss any tiles? Are there tiles you selected that DON'T actually match? " +
      "If you missed any, click them. If you wrongly selected one, click it again to deselect.\n" +
      "5. Once you're confident ALL matching tiles are selected and ONLY matching tiles, click 'Verify' or 'Next'.\n" +
      "6. Call solveCaptcha again to check if solved or if a new challenge appeared.\n" +
      "7. If new tiles fade in to replace clicked ones, identify and click the new matching tiles too before verifying.\n" +
      "CRITICAL: Google reCAPTCHA typically shows 3-6 rounds of challenges. This is NORMAL — it DOES end. " +
      "You MUST keep solving every round until the CAPTCHA is fully resolved. " +
      "NEVER give up, NEVER say it will 'go on forever', NEVER close the browser to avoid solving. " +
      "Keep going round after round until it's done.",
    details: {
      ...captcha,
      challengeText,
      gridSize,
    },
  };
}
