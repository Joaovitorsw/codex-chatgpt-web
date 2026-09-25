function rawMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value ?? "");
}

function unwrapElectronError(value: string): string {
  let message = value.trim();
  message = message.replace(/^Error invoking remote method '[^']+':\s*/i, "");
  while (/^Error:\s*/i.test(message)) message = message.replace(/^Error:\s*/i, "");
  return message.trim();
}

function isPortuguese(language: string): boolean {
  return language.toLowerCase().startsWith("pt");
}

/** Converts internal launcher/runtime failures into actionable UI copy without
 * changing the original error kept in the activity log. */
export function friendlyErrorMessage(value: unknown, language = "en"): string {
  const message = unwrapElectronError(rawMessage(value));
  const pt = isPortuguese(language);

  const activeTurns = message.match(/daemon has (\d+) active HTTP turn\(s\) and (\d+) active browser turn\(s\)/i);
  if (/atomic idleness could not be proven|finish or cancel active ChatGPT turns/i.test(message)) {
    const total = activeTurns ? Number(activeTurns[1]) + Number(activeTurns[2]) : 1;
    if (pt) {
      return total > 1
        ? `Há ${total} tarefas em andamento. Aguarde a conclusão ou cancele os turnos ativos antes de alterar esta configuração. Nenhum trabalho foi interrompido.`
        : "Há uma tarefa em andamento. Aguarde a conclusão ou cancele o turno ativo antes de alterar esta configuração. Nenhum trabalho foi interrompido.";
    }
    return total > 1
      ? `${total} tasks are still running. Wait for them to finish or cancel the active turns before changing this setting. No work was interrupted.`
      : "A task is still running. Wait for it to finish or cancel the active turn before changing this setting. No work was interrupted.";
  }

  if (/another launcher operation is active/i.test(message)) {
    return pt
      ? "O launcher já está concluindo outra operação. Aguarde alguns instantes e tente novamente."
      : "The launcher is already completing another operation. Wait a moment and try again.";
  }
  if (/login is expired|session (?:has )?expired|sign in to the .*chatgpt profile/i.test(message)) {
    return pt
      ? "Sua sessão do ChatGPT expirou. Abra o navegador integrado, entre novamente e repita a ação."
      : "Your ChatGPT session expired. Open the integrated browser, sign in again, and retry.";
  }
  if (/model controls are unavailable/i.test(message)) {
    return pt
      ? "Os controles de modelo do ChatGPT não estão disponíveis nesta tela. Recarregue o navegador integrado e tente novamente."
      : "ChatGPT model controls are unavailable on this screen. Reload the integrated browser and try again.";
  }
  if (/unexpected idle surface/i.test(message)) {
    return pt
      ? "O navegador integrado ficou em uma tela inesperada. Volte à página inicial do ChatGPT e tente novamente."
      : "The integrated browser is on an unexpected screen. Return to the ChatGPT home page and try again.";
  }
  if (/config requires .*launcher is|needs-setup|runtime is not configured/i.test(message)) {
    return pt
      ? "A instalação local precisa ser reparada. Abra Configuração e use “Reinstalar”; seus dados serão preservados."
      : "The local installation needs repair. Open Setup and choose Reinstall; your data will be preserved.";
  }
  if (/tunnel runtime did not confirm a stopped state/i.test(message)) {
    return pt
      ? "O túnel ainda está sendo encerrado. Aguarde alguns segundos e tente novamente."
      : "The tunnel is still shutting down. Wait a few seconds and try again.";
  }
  if (/connector menu did not open/i.test(message)) {
    return pt
      ? "O menu do conector não abriu no ChatGPT. Recarregue o navegador integrado e confirme que o Codex Native2 está disponível."
      : "The connector menu did not open in ChatGPT. Reload the integrated browser and confirm Codex Native2 is available.";
  }
  if (/composer did not preserve the complete prompt|composer contained unexpected residual text/i.test(message)) {
    return pt
      ? "O envio foi bloqueado porque havia texto residual no ChatGPT, evitando duplicação. Abra uma conversa limpa e tente novamente."
      : "Sending was blocked because ChatGPT contained residual text, preventing a duplicate submission. Open a clean conversation and try again.";
  }

  if (/\b(?:launcher|daemon|runtime|ipc|atomic|webcontentsview)\b/i.test(message)) {
    return pt
      ? "Não foi possível concluir esta ação. Tente novamente. Se continuar, abra Atividade e exporte o log seguro."
      : "This action could not be completed. Try again. If it continues, open Activity and export the safe log.";
  }
  return message || (pt ? "Ocorreu um erro inesperado. Tente novamente." : "An unexpected error occurred. Try again.");
}
