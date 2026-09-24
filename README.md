# OrthoTrack

**Sistema Determinístico de Acompanhamento de Fraturas**

Aplicação web de suporte à decisão clínica em trauma ortopédico, baseada nas diretrizes da AO Foundation.

## Funcionalidades

- Cadastro de pacientes (fictícios), com edição e exclusão
- Histórico de avaliações por paciente, cada uma com data, observações e RX anexado
- Classificação automática da fase de consolidação (Fase 1, 2 ou 3) em cada avaliação
- Diretrizes clínicas por tipo de fratura e tratamento (conservador/cirúrgico)
- Contagem de dias desde o trauma (conservador) ou desde a cirurgia (cirúrgico)
- Validação de datas (ex.: avaliação anterior à cirurgia não é aceita)

## Fraturas Suportadas

- Rádio Distal (AO 23)
- Clavícula Diáfise (AO 15-B)
- Úmero Proximal (AO 11)
- Úmero Diáfise (AO 12) — Haste Intramedular
- Fêmur Diáfise (AO 32)
- Tíbia Diáfise (AO 42)
- Tornozelo / Maléolos (AO 44)

## Acesso

🌐 [Abrir OrthoTrack](https://patient-grace-production-7285.up.railway.app/)

## Rodando localmente

Requer Node.js 18 ou superior, sem dependências externas.

```bash
npm start
# abra http://localhost:8080
```

## Armazenamento

Os pacientes ficam em `pacientes.json` e as imagens de RX na pasta `rx/`, dentro do diretório de dados:

1. `DATA_DIR`, se definido;
2. senão, o volume do Railway (`RAILWAY_VOLUME_MOUNT_PATH`, definido automaticamente quando um volume está anexado ao serviço);
3. senão, a pasta `data/` do projeto (ignorada pelo git).

**No Railway é preciso anexar um volume ao serviço.** Sem ele, os dados são apagados a cada deploy.

## Senha de acesso

Defina a variável `APP_PASSWORD` para exigir senha ao abrir o app (o navegador pede usuário e senha; o usuário pode ser qualquer um). Sem essa variável, qualquer pessoa com o link acessa os dados.

## Aviso

Esta aplicação é um protótipo para fins educativos e de demonstração, e deve ser usada apenas com pacientes fictícios. Não substitui avaliação clínica especializada.
