# Melhorias de exibição — DevSpace / Codex Web

Lista canônica: `devspace-display-improvements` no work_state. Preservar os 16 itens já validados do checklist anterior. Validar funcionamento real e não repetir efeitos para fabricar cards.

- [x] 1. Conclusão única: removidas duas rotas que promoviam resposta provisória a comentário. V2 falhou e foi preservada; V3 real passou com 1 final, nenhum fragmento/conclusão em comentários e progresso mantido.
- [x] 2. Progresso curto: rótulos limitados a 200 caracteres; ação/shell/arquivo e contagem de leituras preservados. Comando e argumentos completos continuam no card nativo.
- [x] 3. Nomes MCP legíveis: V2 real exibiu Lendo/Salvando estado do trabalho; identidade técnica mantida nos eventos MCP.
- [x] 4. Estados separados: timeout, interrupção e aprovação mantêm seus códigos; avisos usam títulos, marcadores e roles distintos. Fixture React renderizada verificou timeout/exit7 como alert, aprovação como status/busy e interrupção como status/idle. Não foram alteradas permissões nem cancelados processos reais para produzir esses estados.
- [x] 5. Leitura de skill real aparece como Lendo skill; aplicação só é anunciada após leitura/uso. V2/V3 comprovaram a leitura nativa e a verificação; catálogo não é tratado como execução.
- [x] 6. Todos os 12 callers de Switch fornecem rótulo real obrigatório. Fixture renderizada confirmou 11 switches nas Configurações, nenhum sem nome, e o rótulo do switch de recomendação.
- [x] 7. Abas com tablist nomeado, foco roving, setas circulares, Home/End e ativação manual por Enter/Espaço. Eventos de teclado no React real comprovaram foco separado da seleção e recibos de IPC apenas na ativação.
- [x] 8. Validação concluída: typechecks, revisão independente, fixture renderizada e rodadas nativas V3/V4 após reinício seguro15:24. V4 confirmou múltiplas fronteiras MCP, uma falha intencional7, progresso preservado e conclusão única. Evidência: `outputs/devspace-display-20261025/native-v4-audit.json`.

Referências: [protocolo oficial do Codex](https://learn.chatgpt.com/docs/app-server), [padrão de abas W3C](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/). Códigos/estados nativos e resultados de ferramentas permanecem autoritativos; rótulos de apresentação não criam eventos de execução.

## Evidências e limites

- `outputs/devspace-display-20261025/failed-v2-dedup-audit.json`: falha original preservada; corrigida a corrida adicional no despachante.
- `outputs/devspace-display-20261025/native-v3-audit.json`: aceitação nativa real após reinício15:24, runtime23200.
- `outputs/devspace-display-20261025/renderer-audit.json` e `transport-timeout.png`: componentes reais renderizados em fixture de IPC isolada via Browser Bridge. A fixture usa Motion skipAnimations para permitir renderização em aba de fundo, sem tomar o foco do usuário.
- Os eventos de teclado foram enviados ao DOM pelo Bridge. Isso valida handlers, foco, seleção e ARIA; não constitui certificação com teclado físico ou leitor de tela.
- Typecheck do bridge e launcher e diff--check aprovados. Revisão independente não encontrou falhas acionáveis. Sem bateria de unitários, commits ou pushes.

Checklist concluído: 8/8 itens. A fixture foi encerrada, a aba temporária fechada e a reserva do Browser Bridge liberada. Os serviços compartilhados e os chats do usuário foram preservados.

## Conferência adicional na interface de produção — 25/10

Lista canônica adicional: `devspace-real-ui-acceptance`. Esta etapa amplia a evidência anterior; não confundir a fixture com o aplicativo em produção.

- [x] Codex nativo: V3 expandida mostra “Lendo skill verification-before-completion e 1 outro arquivo no PowerShell”, comando completo, conteúdo real e sucesso. Evidências `real-codex-v3.txt` e `real-codex-v3.png` em `outputs/devspace-display-20261025/`.
- [x] Codex nativo: V4 mostra quatro cards MCP com ícone claude-mem, progresso legível, card Shell com comando/saída/Exit code 7 e conclusão única. Evidências `real-codex-v4.txt` e `real-codex-v4.png`.
- [x] Launcher de produção v6.1.13: 11 switches de Configurações com nomes acessíveis, sem alterar preferências. Evidência `real-launcher-settings.txt`.
- [x] Teclado no Electron: corrigida a transferência indevida de foco em `selectTab` e preservado o foco do launcher na troca automática. Reinício seguro concluído15:42:53, runtime5376. Com duas abas reais, seta focou a segunda sem selecioná-la; Enter ativou a segunda; seta circulou para a primeira mantendo a segunda selecionada; Espaço ativou a primeira. O foco visual continuou na barra após encerramento do agente. Evidências `real-keyboard-after-enter.png` e `real-keyboard-after-space-and-agent-close.png`. O campo focused_element da automação nativa continuava apontando um documento filho inativo; a sequência de teclado e o contorno visível comprovaram o comportamento real.
- [x] V5: nova leitura nativa de package.json acompanhada até exit0. V6: exatamente um subagente herdando modelo, leitura/espera30 no mesmo comando, exit0 e encerramento confirmado. O coordenador não repetiu o comando delegado.
- [x] Interrupção V7: botão Stop no chat nativo de teste encerrou o turno como interrupted/errornull. O bridge chegou a HTTP0/browser0; nenhum comando, edição ou trabalho de outro chat foi cancelado.
- [ ] Timeout de transporte e aprovação: apresentação verificada na fixture anterior; ainda sem ocorrência controlada observada nesta conferência de produção. Permanecem pendências de validação real, não defeitos demonstrados. Não alterar permissões nem provocar indisponibilidade compartilhada para fabricar esses estados.

Referência da correção de foco: [Electron webContents.focus](https://www.electronjs.org/docs/latest/api/web-contents#contentsfocus). O foco do documento React e o foco do WebContents são camadas distintas; a seleção da aba deve preservar a navegação no shell nativo.

### Falha `/goal` reportada durante a conferência

Reproduzido “Failed to set goal” no mesmo chat Web aberto em duas janelas. O log da janela1 identifica `previousStreamRole=follower`; a tentativa não chega a `thread/goal/set`. O cliente nativo instalado exige ownership e sua captura genérica esconde a causa. Na janela4, que mantém `streamRole=owner`, o mesmo objetivo foi aceito: `thread/goal/set`, errorCode=null, e card real “Pursuing goal”. Evidências `goal-ownership-audit.json` e `real-goal-owner-accepted.png`.

Isso distingue o bloqueio de janela de uma incompatibilidade com modelo Web. Usar a janela que controla o chat resolve a reprodução. A mensagem genérica pertence ao aplicativo Codex instalado, fora do código deste bridge; nenhum arquivo do aplicativo instalado foi modificado. Contrato consultado: [Goals no App Server](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal).

O teste Web concluiu com leitura nativa exit0 e “Goal achieved in43s”, registrado em `real-goal-achieved.png`. O histórico de navegação da segunda janela foi restaurado após a conferência.

### GIF e geração pela skill no modelo Web — V9

O usuário confirmou que as imagens já aparecem e encerrou a investigação genérica de cards de imagem. Não houve alteração de código nesse fluxo. A V8 anterior reportou erro MIME ao inspecionar um PNG; a V9 posterior conseguiu gerar, inspecionar e entregar PNG/GIF, portanto não tratar uma falha anterior como indisponibilidade universal.

- [x] Modelo Web leu integralmente `chatgpt-image-handoff/SKILL.md` pela ferramenta nativa, aplicou a skill e chamou `codex_generate_image_asset`; returned generated=true, PNG novo em `web-skill-image-v9.png`, 1254x1254, 1.631.757 bytes. Coordenador inspecionou o robô azul com flor amarela e validou formato/dimensões.
- [x] GIF existente `outputs/gif-display-preview/scenario-depth-v5-preview.gif`: 800x450, 60 frames distintos, 4 segundos, loop infinito, 4.517.638 bytes. O original não foi convertido.
- [x] Evento final nativo da V9 contém image/gif e image/png com hashes SHA256 iguais aos arquivos originais. Evidências `media-v9-file-audit.json` e `media-v9-native-payload-audit.json`: exact_original_bytes_preserved=true. Turno `01a17476-76dd-74f3-8318-8efabec1ee81` concluído sem erro.
- [x] Conferência visual temporal do GIF: usuário confirmou “eu validei e ta tudo certo”. Miniaturas de GIF e PNG já haviam sido observadas no aplicativo; aceitação da animação fornecida pelo usuário.

### Nomes nas leituras agrupadas

O formatador agora identifica skills e arquivos em vez de apresentar apenas contagens: “Lendo skills impeccable, frontend-visual-qa e arquivo README.md no PowerShell” e “Lendo 2 arquivos: package.json, server.ts no PowerShell”. Listas grandes mostram até três nomes por grupo, nomes longos são abreviados e itens adicionais aparecem como (+N), respeitando200 caracteres. Typecheck e execução direta do formatador aprovados. Reinício seguro enfileirado para carregar a alteração após os chats ativos, sem interrompê-los.
