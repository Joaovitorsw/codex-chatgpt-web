import { describe, expect, test } from "bun:test";
import { friendlyErrorMessage } from "./friendly-errors";

describe("friendlyErrorMessage", () => {
  test("turns the Electron active-turn failure into friendly pt-BR copy", () => {
    const result = friendlyErrorMessage(
      "Error invoking remote method 'launcher:fresh-conversation-per-turn': Error: Refusing to stop launcher-owned runtime because atomic idleness could not be proven: daemon has 1 active HTTP turn(s) and 0 active browser turn(s)",
      "pt-BR",
    );
    expect(result).toContain("Há uma tarefa em andamento");
    expect(result).toContain("Nenhum trabalho foi interrompido");
    expect(result).not.toMatch(/launcher|daemon|HTTP|atomic/i);
  });

  test("pluralizes active tasks", () => {
    expect(friendlyErrorMessage(
      "Refusing to stop launcher-owned runtime because atomic idleness could not be proven: daemon has 2 active HTTP turn(s) and 1 active browser turn(s)",
      "pt-BR",
    )).toContain("Há 3 tarefas em andamento");
  });

  test("provides an English fallback", () => {
    expect(friendlyErrorMessage(
      "Refusing to stop launcher-owned runtime because atomic idleness could not be proven: daemon has 1 active HTTP turn(s) and 0 active browser turn(s)",
      "en",
    )).toContain("A task is still running");
  });

  test("keeps useful unknown errors after removing Electron wrappers", () => {
    expect(friendlyErrorMessage(
      "Error invoking remote method 'launcher:test': Error: Network unavailable",
      "pt-BR",
    )).toBe("Network unavailable");
  });
});
