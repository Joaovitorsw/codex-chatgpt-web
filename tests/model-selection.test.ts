import { expect, test } from "bun:test";
import { selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

test("recognizes a selected 5.6 row retained in the simple picker panel", async () => {
  const option = {
    count: async () => 1,
    getAttribute: async (name: string) => name === "aria-checked" ? "true" : null,
  };
  const menu = {
    menu: {
      locator: (selector: string) => {
        expect(selector).toBe('[role="menuitemradio"]');
        return { filter: () => option };
      },
    },
  } as never;

  await expect(selectChatGptModelFamily(menu, "5.6", async () => menu)).resolves.toBe(menu);
});

test("opens the simple picker toggle when it has no aria-hidden attribute", async () => {
  let checked = false;
  let toggleClick: { force?: boolean; timeout?: number } | undefined;
  const option = {
    count: async () => 1,
    getAttribute: async (name: string) => name === "aria-checked" ? String(checked) : null,
    waitFor: async () => {},
    click: async () => { checked = true; },
  };
  const toggle = {
    count: async () => 1,
    click: async (options: { force?: boolean; timeout?: number }) => { toggleClick = options; },
  };
  const powerView = {
    count: async () => 1,
    getAttribute: async () => "simple",
    locator: (selector: string) => {
      expect(selector).toBe('[data-model-picker-view-toggle="true"]');
      return toggle;
    },
  };
  const menu = {
    menu: {
      locator: (selector: string) => {
        if (selector === '[role="menuitemradio"]') return { filter: () => option };
        expect(selector).toBe('[data-model-picker-view]');
        return powerView;
      },
    },
  } as never;

  await expect(selectChatGptModelFamily(menu, "5.6", async () => menu)).resolves.toBe(menu);
  expect(toggleClick).toEqual({ force: true, timeout: 5_000 });
});

test("uses the keyboard model-picker activation when the hidden window has no clickable viewport", async () => {
  let checked = false;
  let entered = false;
  const option = {
    count: async () => 1,
    getAttribute: async (name: string) => name === "aria-checked" ? String(checked) : null,
    waitFor: async () => {},
    click: async () => { checked = true; },
  };
  const toggle = {
    count: async () => 1,
    click: async () => { throw new Error("Element is outside of the viewport"); },
    press: async (key: string) => {
      expect(key).toBe("Enter");
      entered = true;
    },
  };
  const powerView = {
    count: async () => 1,
    getAttribute: async () => "simple",
    locator: () => toggle,
  };
  const menu = {
    menu: {
      locator: (selector: string) => selector === '[role="menuitemradio"]'
        ? { filter: () => option }
        : powerView,
    },
  } as never;

  await expect(selectChatGptModelFamily(menu, "5.6", async () => menu)).resolves.toBe(menu);
  expect(entered).toBe(true);
});

test("uses keyboard family selection when the selected model row is outside the hidden viewport", async () => {
  let checked = false;
  let entered = false;
  const option = {
    count: async () => 1,
    getAttribute: async (name: string) => name === "aria-checked" ? String(checked) : null,
    waitFor: async () => {},
    click: async () => { throw new Error("Element is outside of the viewport"); },
    press: async (key: string) => {
      expect(key).toBe("Enter");
      entered = true;
      checked = true;
    },
  };
  const powerView = {
    count: async () => 1,
    getAttribute: async () => "advanced",
  };
  const menu = {
    menu: {
      locator: (selector: string) => selector === '[role="menuitemradio"]'
        ? { filter: () => option }
        : powerView,
    },
  } as never;

  await expect(selectChatGptModelFamily(menu, "5.6", async () => menu)).resolves.toBe(menu);
  expect(entered).toBe(true);
});
