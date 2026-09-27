<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Switch to web models. Stay in Codex. Your ChatGPT plan. Your workflow. Maximum capabilities.">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.2/codex-web-gpt-6.1.2-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.2/codex-web-gpt-6.1.2-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.2/codex-web-gpt-6.1.2-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.2/codex-web-gpt-6.1.2-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">All releases</a>
</p>

<p align="center">
  <a href="README.md">Português (Brasil)</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="A live ChatGPT Web turn using the native Codex harness">
</p>

<p align="center">
  <a href="#get-started">Primeiros passos</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">Novidades</a> · <a href="docs/architecture.md">Arquitetura</a> · <a href="TROUBLESHOOTING.md">Solução de problemas</a>
</p>

Use no seletor nativo do Codex os modelos Web disponíveis na sua conta do ChatGPT, inclusive Pro, com os limites separados do ChatGPT Web e sem consumir a cota do Work ou do Codex. A interface, as tarefas, as imagens e o streaming continuam no Codex.

O modo Full harness conecta o ChatGPT aos arquivos, terminal, ferramentas e aprovações da tarefa atual por MCP. As conversas permanecem vinculadas à tarefa do Codex conforme o contexto cresce.

<div id="get-started"><a id="quick-start"></a></div>

## Primeiros passos

**Modelos disponíveis:** Free/Go → **Luna / Think**. Contas com controles de raciocínio → **Instant–High**, além de **Extra High** e **GPT-6 Pro** quando disponíveis. O launcher detecta automaticamente o que a conta pode usar.

1. **Instale o launcher** usando o download do seu sistema acima.
2. **Entre no ChatGPT** pelo navegador integrado e execute o smoke test.
3. **Instale os modelos** e reinicie o Codex uma vez. No modo automático, escolha um modelo terminado em **(Web)**. GPT-6 Pro tem uma entrada própria; o raciocínio do Sol é selecionado por Effort. Zero Risk mantém sua entrada dedicada.
4. **Para programar com ferramentas**, abra **MCP** no launcher e conclua a configuração Full harness abaixo.

O aplicativo já inclui navegador e runtime. Não é necessário instalar Chrome, Node ou Bun separadamente.

<details>
<summary><strong>Instalação, atualização e reparo pelo terminal</strong></summary>

Feche o launcher antes de atualizar. Os instaladores detectam plataforma e arquitetura, verificam os checksums publicados e preservam o perfil do ChatGPT e as configurações.

**macOS / Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

</details>

<details>
<summary><strong>Modelos, modos e configuração MCP</strong></summary>

<a id="modes"></a>

Os modos automáticos oferecem Luna/Think quando a conta não possui seletor de raciocínio; caso contrário, oferecem Instant–High, com Extra High e GPT-6 Pro quando expostos pela conta.

| Modo | Envio de mensagens | Ferramentas locais do Codex |
| --- | --- | --- |
| **Somente navegador** | Automático | Não |
| **Full harness (com automação)** | Automático | Sim, por MCP |
| **Zero Risk** | Colar e enviar manualmente | Sim, por um conector MCP separado |

Zero Risk não lê nem opera a página do ChatGPT. Selecione manualmente o modelo e o conector `Codex Zero Risk`, cole e envie o prompt preparado e confirme **Enviado** no launcher. Modelos automáticos terminados em **(Web)** expõem no Codex os níveis de Effort compatíveis. Instant e GPT-6 Pro têm entradas próprias para preservar seus orçamentos de contexto; tarefas antigas mantêm a rota original apenas por compatibilidade.

<a id="full-harness"></a>

### Modo completo (Full harness)

O modo Full conecta as chamadas de ferramentas do ChatGPT à tarefa atual do Codex pelo
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). O túnel é de saída: não expõe IP
público, não abre porta de entrada e não exige redirecionamento no roteador.

A página **MCP** do launcher orienta toda a configuração. Para ver os cliques exatos, consulte os
[guias em vídeo](TROUBLESHOOTING.md).

> **Limites**
>
> Consulte [Limites](https://github.com/miuuyy/codex-chatgpt-web/discussions/309) para ver as
> franquias atuais de mensagens do ChatGPT. Os limites de contexto dependem do tipo de conta e do
> esforço selecionado. Plus Medium/High usa uma janela medida de 90.000 tokens, ou até 270.000
> tokens com o **contexto 3×** experimental, sempre com compactação nativa do Codex.

1. Conclua a configuração exigida, abra **MCP**, crie o túnel e a chave de API comum e pressione **Conectar harness**.
2. Ative o **Modo de desenvolvedor** do ChatGPT e crie um conector Tunnel chamado exatamente **Codex Native2**, com **Autenticação: nenhuma** e **Permitir todas as ações**.
3. Execute **Verificar runtime** para confirmar que **Codex Native2** está conectado e disponível.

Ações de escrita e modificação também dependem da permissão do workspace do ChatGPT e da política
do administrador. Consulte [modo de desenvolvedor e aplicativos MCP](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Pedidos inesperados de aprovação falham de forma segura, salvo quando `--auto-approve-tool-calls`
está explicitamente ativado; essa opção clica apenas em **Permitir uma vez**, nunca em permissão permanente.

</details>

<details>
<summary><strong>Diagnóstico e subagentes</strong></summary>

<a id="operations"></a>

Use **Atividade** para diagnósticos locais seguros e **Configurações → Executar doctor** para verificar
o fluxo completo. Nas configurações também é possível cancelar um turno retido ou remover a integração
do Codex antes da desinstalação. **Salvar chats no ChatGPT** mantém as conversas no histórico e vem
desativado por padrão, independentemente de **Novo chat do navegador a cada turno**. Defina
`CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` apenas quando cada checkpoint precisar de captura de tela.

Novas instalações usam **Compatibilidade V1** para subagentes entre backends. **Nativo** preserva as
configurações do próprio Codex e habilita delegação Web-to-Web V2 em texto simples. Reinicie o Codex
e abra uma nova tarefa após trocar o protocolo:

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>Requisitos e segurança</strong></summary>

<a id="limitations-and-security"></a>

- Esta é uma automação não oficial do navegador, não uma API da OpenAI. Mudanças na interface do
  ChatGPT podem quebrar seletores; desvios geram erro explícito em vez de trocar modelo ou transporte silenciosamente.
- O estado do navegador é um artefato sensível de login, e processos do mesmo usuário local podem
  alcançar o listener de loopback. Nunca compartilhe o perfil do launcher; use uma máquina confiável.
- Os pacotes atuais atendem macOS 13+ (arm64/x64), Windows x64 e Linux x64. Runtime, testes e empacotamento
  são validados nos três sistemas pelo CI; fluxos vinculados à conta usam a [validação de release](docs/release-validation.md).
- Os builds ainda não possuem assinatura de plataforma, então Gatekeeper ou SmartScreen podem alertar.
  Os instaladores verificam o manifesto SHA-256 publicado antes da instalação.

Leia a [arquitetura](docs/architecture.md) e o [modelo de segurança](docs/security-model.md) completos
antes de habilitar o modo Full. Informe vulnerabilidades por [SECURITY.md](SECURITY.md).

O Chat temporário é um [modo de privacidade do ChatGPT](https://help.openai.com/en/articles/8914046-temporary-chat-faq); os prompts ainda são processados pela OpenAI.

Cobertura de validação: [validação de release](docs/release-validation.md).

Este é um software independente, sem afiliação ou endosso da OpenAI. Use-o somente com sua própria
conta e de acordo com os [Termos de Uso](https://openai.com/policies/terms-of-use/) e as políticas do
workspace; ele não contorna autenticação nem controles de acesso.

</details>

<details>
<summary><strong>Executar pelo código-fonte e desenvolver</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/Joaovitorsw/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

Esta execução pelo código-fonte requer Bun 1.4.0. O comando instala as dependências travadas e abre o aplicativo.

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` usa perfil e conta separados em `~/.codex-chatgpt-web-dev`. `dev:chat` exercita o navegador real e os fluxos de compactação com resultados simulados explícitos, sem alterar a rota normal do Codex. Consulte o [harness DEV do chat](docs/dev-chat.md) para configuração e comandos.

</details>

## Histórico de estrelas

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

---

[Solução de problemas](TROUBLESHOOTING.md) · [Segurança](SECURITY.md) · [Como contribuir](CONTRIBUTING.md) · [Licença MIT](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

Também do autor original: <img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — vozes personalizadas locais, quase em tempo real, para ChatGPT e Codex.
