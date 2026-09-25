import type { Locator, Page } from "playwright-core";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_SAVED_CHAT_URL = "https://chatgpt.com/";

export function chatGptNewChatUrl(useSavedChats = false): string {
  return useSavedChats ? CHATGPT_SAVED_CHAT_URL : CHATGPT_TEMPORARY_CHAT_URL;
}
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
  'form [contenteditable="true"][role="textbox"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  // Structural identity used by the current composer, independent of locale.
  'button[data-codex-intelligence-trigger="true"][aria-haspopup="menu"]',
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  // Current ChatGPT exposes a compact picker with no test id or data-tone.  It owns
  // the same menu/effort slider but identifies itself through its accessible label.
  'button[aria-label="Select ChatGPT model"][aria-haspopup="menu"]',
  'button[aria-label="Selecionar modelo do ChatGPT"][aria-haspopup="menu"]',
].join(", ");

export const CHATGPT_APP_MENU_CONTROL_SELECTOR = [
  'button[data-testid="composer-plus-btn"]',
  'button[data-testid="composer-attachment-button"]',
  'button[aria-label="Add files and more"]',
  'button[aria-label="Adicionar arquivos e mais"]',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([data-model-picker-power-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = [
  '[data-model-reasoning-effort-slider]',
  '[data-reasoning-slider="true"]',
  '[data-model-picker-power-slider]',
  // Current Pro picker variants keep the semantic ARIA slider but no longer mark
  // its owner with either historical data attribute. Scope the fallback to an
  // actual menu/group so unrelated page sliders cannot become account evidence.
  '[data-testid="composer-intelligence-picker-content"]:has([role="slider"])',
  '[role="menu"]:has([role="slider"])',
  '[role="group"]:has([role="slider"])',
].join(", ");
export const CHATGPT_EFFORT_SLIDER_SELECTOR = [
  '[data-model-reasoning-effort-slider] [role="slider"]',
  '[data-reasoning-slider="true"] [role="slider"]',
  '[data-model-picker-power-slider] [role="slider"]',
  '[data-testid="composer-intelligence-picker-content"] [role="slider"]',
  '[role="menu"] [role="slider"]',
  '[role="group"] [role="slider"]',
].join(", ");
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;
export const CHATGPT_STOP_BUTTON_SELECTOR = '[data-testid="stop-button"], form[data-chatgpt-composer] button[type="button"][aria-label="Stop"]';
export const CHATGPT_SEND_BUTTON_SELECTOR = [
  '[data-testid="send-button"]',
  '[data-testid="composer-submit-button"]',
  'button[type="submit"]:not([data-testid="stop-button"])',
  'button[aria-label="Send"]',
  'button[aria-label="Send message"]',
  'button[aria-label="Enviar"]',
  'button[aria-label="Enviar mensagem"]',
].join(", ");
export const CHATGPT_COMPLETION_ACTION_SELECTOR = [
  'button[data-testid="copy-turn-action-button"]',
  'button[data-testid="good-response-turn-action-button"]',
  'button[data-testid="bad-response-turn-action-button"]',
  'button[data-testid="regenerate-turn-action-button"]',
  'button[aria-label="Regenerate response"]',
  'button[aria-label="Gerar resposta novamente"]',
  'button[aria-label="Copy message"]',
  'button[aria-label="Copiar mensagem"]',
  'button[aria-label="Good response"]',
  'button[aria-label="Bad response"]',
  'button[aria-label="Boa resposta"]',
  'button[aria-label="Resposta ruim"]',
  '[data-turn-key] .turn-action-controls button',
].join(", ");
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-conversation-role="assistant"])',
  '[data-turn-key]:has(button[aria-label="Regenerate response"])',
  '[data-turn-key]:not(:has([data-user-message-bubble]))',
  '[data-chatgpt-search-unit-key]:has(> [data-conversation-role="assistant"])',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-user-message-bubble])',
  '[data-chatgpt-search-unit-key]:has([data-user-message-bubble]):not([data-turn-key] [data-chatgpt-search-unit-key])',
].join(", ");

export interface ChatGptEffortSliderState {
  min: number;
  max: number;
  value: number;
}

export interface ChatGptEffortActivation {
  method: "already-open" | "click" | "pointerdown";
  menu: Locator;
  sliderContainer: Locator;
  slider: Locator;
}

export function chatGptEffortSlider(page: Page): { sliderContainer: Locator; slider: Locator } {
  const sliderContainer = page.locator(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR).filter({ visible: true }).last();
  // The current picker keeps ARIA values on a zero-width, aria-hidden semantic input.
  // Its visible container proves the active surface; the input proves the effort range.
  return { sliderContainer, slider: sliderContainer.locator('[role="slider"]') };
}

function effortMenuSelectorForId(menuId: string): string {
  return `[id=${JSON.stringify(menuId)}]`;
}

export async function chatGptEffortMenuForControl(page: Page, control: Locator): Promise<Locator> {
  const menuId = await control.getAttribute("aria-controls").catch(() => null);
  if (menuId) return page.locator(effortMenuSelectorForId(menuId));
  return page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last();
}

async function visibleEffortSurface(
  page: Page,
  control: Locator,
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  // The exit animation keeps a closed menu's slider visible after Escape. Read the
  // owner state first: selecting that outgoing range races its removal from the DOM.
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "false" || state === "closed") return undefined;
  const menu = await chatGptEffortMenuForControl(page, control);
  const surface = chatGptEffortSlider(page);
  if (await menu.isVisible().catch(() => false) || await surface.sliderContainer.isVisible().catch(() => false)) {
    return { menu, ...surface };
  }
  return undefined;
}

async function waitForEffortSurface(
  page: Page,
  control: Locator,
  timeoutMs: number,
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const surface = await visibleEffortSurface(page, control);
    if (surface) return surface;
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
  } while (true);
}

async function clearGhostEffortState(page: Page, control: Locator): Promise<void> {
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "true" || state === "open") {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

export async function activateChatGptEffortMenu(
  page: Page,
  control: Locator,
  options: { settleMs?: number } = {},
): Promise<ChatGptEffortActivation> {
  const openSurface = await visibleEffortSurface(page, control);
  if (openSurface) return { method: "already-open", ...openSurface };

  const settleMs = options.settleMs ?? 3_000;
  await clearGhostEffortState(page, control);
  await control.click({ force: true, timeout: Math.max(1, settleMs) });
  const clickedSurface = await waitForEffortSurface(page, control, settleMs);
  if (clickedSurface) return { method: "click", ...clickedSurface };

  await clearGhostEffortState(page, control);
  await control.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
  const pointerSurface = await waitForEffortSurface(page, control, settleMs);
  if (pointerSurface) return { method: "pointerdown", ...pointerSurface };
  throw new Error(
    "ChatGPT effort control did not expose its owned menu or structural slider after click and primary pointerdown",
  );
}

function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseChatGptEffortSliderState(
  rawMin: string | null,
  rawMax: string | null,
  rawValue: string | null,
): ChatGptEffortSliderState | undefined {
  const min = safeIntegerAttribute(rawMin);
  const max = safeIntegerAttribute(rawMax);
  const value = safeIntegerAttribute(rawValue);
  if (min === undefined || max === undefined || value === undefined) return undefined;
  const optionCount = max - min + 1;
  if (optionCount < 1 || optionCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) return undefined;
  if (value < min || value > max) return undefined;
  return { min, max, value };
}

export async function selectChatGptEffortTick(
  sliderContainer: Locator,
  state: ChatGptEffortSliderState,
  targetValue: number,
): Promise<void> {
  const targetIndex = targetValue - state.min;
  if (targetIndex < 0 || targetValue > state.max) {
    throw new Error(`ChatGPT effort target ${targetValue} is outside its slider range`);
  }
  const ticks = sliderContainer.locator([
    "[data-locked][data-selected]",
    "[data-model-picker-power-slider] [data-selected]",
  ].join(", "));
  if (await ticks.count() !== state.max - state.min + 1) {
    throw new Error("ChatGPT effort ticks do not match its semantic slider range");
  }
  const target = ticks.nth(targetIndex);
  const locked = await target.getAttribute("data-locked");
  if (locked !== null && locked !== "false") {
    throw new Error(`ChatGPT effort target ${targetValue} is locked`);
  }
  await target.click({ force: true, timeout: 5_000 });
}

export async function readChatGptEffortAvailability(
  sliderContainer: Locator,
  state: ChatGptEffortSliderState,
): Promise<boolean[]> {
  // Plus exposes a fourth ARIA position for a locked Pro upsell. Only the ticks
  // carry both attributes; the slider root also has data-locked and is not a choice.
  const locks = await sliderContainer.evaluate(container => {
    const power = container.hasAttribute("data-model-picker-power-slider")
      && Boolean(container.querySelector('[data-orientation="horizontal"][aria-disabled="false"]'));
    return Array.from(container.querySelectorAll("[data-selected]"), tick =>
      tick.getAttribute("data-locked") ?? (power ? "false" : null));
  });
  if (locks.length !== state.max - state.min + 1
    || locks.some(lock => lock !== "true" && lock !== "false")) {
    throw new Error("ChatGPT effort availability could not be verified from its slider ticks");
  }
  return locks.map(lock => lock === "false");
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const composer = page.locator(
    CHATGPT_COMPOSER_SELECTOR,
  );
  if (!await anyVisible(composer)) {
    throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  await assertNewChatPage(page);
}

export async function assertNewChatPage(page: Page, useSavedChats = false): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(chatGptNewChatUrl(useSavedChats));
  if (url.origin !== expected.origin || url.pathname !== expected.pathname
    || (url.searchParams.get("temporary-chat") === "true") === useSavedChats) {
    throw new Error(`ChatGPT left the requested new ${useSavedChats ? "saved" : "Temporary"} Chat surface (${page.url()})`);
  }
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: { selectorTimeoutMs?: number; stableAbsenceMs?: number } = {},
): Promise<ChatGptWebAccountCapabilities & { extraHighAvailable: boolean }> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const composer = composers.last();
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    const effortVisible = await effortButton.isVisible().catch(() => false);
    if (effortVisible) {
      presenceObservations += 1;
      absenceSince = undefined;
      if (presenceObservations >= 2) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
      continue;
    }
    presenceObservations = 0;
    const composerReady = await composers.count().then(count => count === 1).catch(() => false);
    const formReady = await composerForm.count().then(count => count === 1).catch(() => false);
    const documentReady = await page.evaluate(() => document.readyState === "complete").catch(() => false);
    if (composerReady && formReady && documentReady) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, extraHighAvailable: false, proAvailable: false };
      }
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
  const menuVisible = await menu.isVisible().catch(() => false);
  const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
  if (!menuVisible && menuExpanded !== "true") await effortButton.press("Enter");
  try {
    const { sliderContainer, slider } = chatGptEffortSlider(page);
    const timeout = options.selectorTimeoutMs ?? 70_000;
    try {
      // Hydration can expose model rows before the authoritative effort slider. Wait for the
      // slider first so a slow pt-BR/Pro surface is not cached as an Instant-only account.
      await sliderContainer.waitFor({ state: "visible", timeout });
      await slider.waitFor({ state: "attached", timeout });
    } catch (error) {
      const label = await effortButton.getAttribute("aria-label").catch(() => null);
      const structuralPicker = await effortButton.getAttribute("data-codex-intelligence-trigger").catch(() => null);
      if (structuralPicker !== "true"
        && label !== "Select ChatGPT model"
        && label !== "Selecionar modelo do ChatGPT") throw error;
      const compactSolOption = page.getByRole("menuitemradio")
        .filter({ hasText: "GPT-5.6 Sol" })
        .filter({ visible: true })
        .last();
      if (!await compactSolOption.isVisible().catch(() => false)) throw error;
      return { solAvailable: true, extraHighAvailable: false, proAvailable: false };
    }
    const state = parseChatGptEffortSliderState(
      await slider.getAttribute("aria-valuemin"),
      await slider.getAttribute("aria-valuemax"),
      await slider.getAttribute("aria-valuenow"),
    );
    if (!state) {
      throw new Error(
        "ChatGPT model controls are unavailable. Reload ChatGPT and run Repair again.",
        { cause: new Error("ChatGPT effort slider exposed an invalid ARIA range") },
      );
    }
    const available = await readChatGptEffortAvailability(sliderContainer, state);
    return { solAvailable: true, extraHighAvailable: available[3] === true, proAvailable: available[4] === true };
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
