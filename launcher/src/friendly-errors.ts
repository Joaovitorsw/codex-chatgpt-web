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

/** State copy for display only; logs and native tool outcomes keep their original details. */
export function failurePresentation(value: unknown, language = "en") {
  const message = unwrapElectronError(rawMessage(value));
  const pt = isPortuguese(language);
  if (/codex_tool_timeout|Tempo limite de transporte|Tool transport timeout|did not return a result within|MCP transport deadline/i.test(message)) {
    return {
      title: pt ? "Tempo limite de transporte" : "Tool transport timeout",
      message: pt
        ? "Tempo limite de transporte. A ferramenta não confirmou o resultado. Confira se o processo continua ativo ou aguarda aprovação antes de repetir a ação."
        : "Tool transport timeout. The tool did not confirm its result. Check whether the process is still running or awaiting approval before retrying.",
      tone: "error" as const,
    };
  }
  if (/chatgpt_tool_approval_required|Aprovação pendente|Permission required|waiting for plugin permission/i.test(message)) {
    return {
      title: pt ? "Aprovação pendente" : "Permission required",
      message: pt
        ? "Aprovação pendente. Revise a ação solicitada no ChatGPT para decidir se deseja autorizá-la."
        : "Permission required. Review the pending action in ChatGPT to decide whether to approve it.",
      tone: "busy" as const,
    };
  }
  if (/client_cancelled|Execução interrompida|Request interrupted|turn was cancelled|response was cancelled/i.test(message)) {
    return {
      title: pt ? "Execução interrompida" : "Request interrupted",
      message: pt
        ? "Execução interrompida. A solicitação foi cancelada; isso não confirma o término de um processo já iniciado."
        : "Request interrupted. The request was cancelled; this does not confirm that an already started process has exited.",
      tone: "idle" as const,
    };
  }
  const exit = message.match(/\b(?:exit(?:[_ ]?code)?|código de saída)\s*[:=]?\s*(-?\d+)\b/i);
  if (exit && Number(exit[1]) !== 0) {
    return {
      title: pt ? "Falha no comando" : "Command failed",
      message: pt ? `Falha no comando (código de saída ${exit[1]}). Confira a saída no card da execução.`
        : `Command failed (exit code ${exit[1]}). Check the output in the command card.`,
      tone: "error" as const,
    };
  }
  return null;
}

/** Converts internal launcher/runtime failures into actionable UI copy without
 * changing the original error kept in the activity log. */
export function friendlyErrorMessage(value: unknown, language = "en"): string {
  const message = unwrapElectronError(rawMessage(value));
  const pt = isPortuguese(language);
  const failure = failurePresentation(message, language);
  if (failure) return failure.message;

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
  if (/Não foi possível confirmar os controles de modelo/i.test(message)) {
    return pt
      ? "O ChatGPT não terminou de carregar o seletor de modelo mesmo após uma tentativa automática de recuperação. Nada foi enviado: mantenha o chat aberto, recarregue o navegador integrado e use Continuar."
      : "ChatGPT did not finish loading its model selector after one automatic recovery attempt. Nothing was sent: keep the chat open, reload the integrated browser, then continue.";
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
  if (/alterou ou duplicou o texto antes do envio|não pôde ser limpo com segurança/i.test(message)) {
    return pt
      ? "O ChatGPT duplicou ou reteve parte do texto antes do envio. A aplicação tentou limpar e reenviar uma vez sem trocar de conversa; como não foi seguro, nenhum envio adicional foi feito. Abra o chat integrado e use Continuar."
      : "ChatGPT duplicated or retained part of the text before sending. The app tried one clean same-conversation retry; because it was not safe, no extra submission was made. Open the integrated chat and continue.";
  }

  if (/\b(?:launcher|daemon|runtime|ipc|atomic|webcontentsview)\b/i.test(message)) {
    return pt
      ? "Não foi possível concluir esta ação. Tente novamente. Se continuar, abra Atividade e exporte o log seguro."
      : "This action could not be completed. Try again. If it continues, open Activity and export the safe log.";
  }
  return message || (pt ? "Ocorreu um erro inesperado. Tente novamente." : "An unexpected error occurred. Try again.");
}
