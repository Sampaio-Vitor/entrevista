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

Ajustes em `config.json > meeting` (nome, idioma padrão, gravação, refino, resumo automático, modelos).

## Modo Entrevista

Briefing, transcrição dos dois lados e respostas/soluções de código sob demanda por atalho.

Tudo fica em arquivos locais (`sessions/*.json`, `*.md`, `*.wav`).
