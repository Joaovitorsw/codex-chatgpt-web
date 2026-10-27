import { expect, test } from "bun:test";
import { hasNativeConnectorInternalFailure } from "../src/adapters/chatgpt-web/native-connector-failure";

const recurringReport = "Nesta execução, consegui localizar a ferramenta de comandos do Codex, mas as tentativas de executar comandos e consultar o navegador retornaram erros internos. Não foi possível confirmar o estado atualizado do projeto nem realizar novos testes.";

test.each([
  recurringReport,
  recurringReport.toUpperCase(),
  "The Codex native tool failed internally. I could not run commands or tests.",
  "The tool failed internally in the local connector.",
  "The plugin tool failed internally in this execution context.",
  "The native tool failed internally.",
  "A ferramenta do Codex falhou internamente. Não consegui ler os arquivos.",
  "O executor local retornou um erro interno. Não foi possível executar comandos.",
  "As ferramentas retornaram erros internos. Não consegui consultar o navegador nem realizar testes.",
  "Erro interno do executor local: não pude executar os testes.",
])("recognizes an actual connector failure: %s", answer => {
  expect(hasNativeConnectorInternalFailure(answer)).toBe(true);
});

test.each([
  "",
  "The tool failed internally.",
  "Codex ran npm test; the command failed with exit code 1.",
  "O comando do Codex saiu com código 1. Não consegui realizar testes.",
  "O servidor da aplicação retornou erro interno. Não consegui consultar o navegador.",
  "A ferramenta do Codex falhou internamente.",
  "As ferramentas retornaram erros internos, mas consegui executar os testes.",
  "The Codex native tool failed internally, but I fixed it and all tests passed.",
  `${recurringReport} Depois corrigi o problema e os testes passaram.`,
  "Did the Codex native tool fail internally?",
  "Why did the Codex native tool failed internally error occur?",
  "A ferramenta do Codex falhou internamente? Não foi possível executar testes?",
  'The error "the Codex native tool failed internally" means the connector crashed.',
  '> The Codex native tool failed internally.\nThis is a quoted error explanation.',
  '```text\nThe Codex native tool failed internally.\n```',
  'O erro “a ferramenta do Codex falhou internamente” explica por que não consegui executar testes.',
  "If the Codex native tool failed internally, I could not run tests.",
  "Se a ferramenta do Codex falhou internamente, não foi possível executar testes.",
  "The Codex native tool failed internally because approval was denied.",
  "The Codex native tool failed internally after cancellation.",
  "The Codex native tool failed internally due to a timeout.",
  `${recurringReport} A aprovação foi negada.`,
  `${recurringReport} A execução foi cancelada.`,
  `${recurringReport} O tempo limite foi excedido.`,
  "The Codex native tool never failed internally. Tests passed.",
  "A ferramenta do Codex não falhou internamente. Não consegui executar testes por outro motivo.",
])("rejects non-failure or ambiguous prose: %s", answer => {
  expect(hasNativeConnectorInternalFailure(answer)).toBe(false);
});
