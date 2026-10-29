# Entrevista

Gravador de reuniões e copiloto de entrevista para macOS. Captura o microfone e o áudio do sistema em canais separados (sem bot na chamada), transcreve em tempo real com Deepgram e usa `claude -p` para resumos, chat e respostas.

```bash
npm install
cp .env.example .env   # preencha DEEPGRAM_API_KEY
npm start
```

## Modo Reunião

- Separa quem falou do outro lado (diarização) e deixa você nomear cada voz.
- Grava um WAV por canal em `sessions/`; ao parar, retranscreve o áudio com separação de falantes precisa e gera um resumo com decisões e ações por pessoa.
- Chat sobre a reunião, ao vivo ou depois; biblioteca com busca por texto e por pessoa.
- Use um idioma fixo (`pt-BR`, `en`): `multi` desliga a separação de vozes no Deepgram.

Modelos, atalhos e as opções de gravação, refino e resumo se ajustam no ⚙ da tela inicial, que grava em `config.json`. Nome e idioma padrão ficam em `config.json > meeting`.

## Modo Entrevista

Transcrição dos dois lados e respostas/soluções de código sob demanda por atalho. O copiloto recebe duas coisas:

- **Seu perfil** (`profile.md`): currículo, experiências e histórias. Salvo uma vez, vale para todas as entrevistas.
- **Esta entrevista**: empresa, vaga e foco. Escrito a cada entrevista; "Preparar com Claude" transforma essas notas num briefing.

Tudo fica em arquivos locais (`sessions/*.json`, `*.md`, `*.wav`).
