# Campelo Smart

Aplicativo PWA de compras, ofertas por validade, fidelidade e operação local.

## Executar localmente

Requisitos: Docker Compose e Node.js 20+.

```bash
cp .env.example .env
docker compose up -d --build
```

Aplicação: `http://localhost:4174/download.html`

API: `http://localhost:4174/api/health`

A porta 4174 permite testar sem conflito com outros servidores locais. PostgreSQL é persistido no volume `campelo_data`.

## Configuração

Antes de publicar, defina no ambiente:

- `DATABASE_URL`: URL completa do PostgreSQL gerenciado
- `ADMIN_TOKEN`: segredo forte para endpoints administrativos
- `ALLOWED_ORIGIN`: domínio HTTPS da aplicação
- `PGSSL=true`: para provedores que exigem TLS no banco

Nunca use o valor de `.env.example` em produção.

## Infraestrutura em produção

1. Publique em VM ou Kubernetes com PostgreSQL 16 gerenciado.
2. Faça backup diário criptografado do banco e teste restauração.
3. Use domínio próprio com HTTPS válido; câmera e instalação PWA exigem contexto seguro.
4. Configure firewall para que PostgreSQL não seja acessível pela internet.
5. Use segredo gerenciado pelo provedor para `ADMIN_TOKEN` e `DATABASE_URL`.
6. Configure monitoramento, logs centralizados e alertas de API/banco.
7. Coloque CDN/reverso proxy na frente da API para cache, TLS e rate limit global.

O Compose atual é adequado para desenvolvimento e validação. Para alta disponibilidade, use réplicas da API, PostgreSQL gerenciado e objeto storage para backups.

## API

- `GET /api/health`
- `GET /api/products`
- `POST /api/sales`
- `GET /api/admin/summary` com `x-admin-token`
- `PUT /api/admin/products/:code` com `x-admin-token`

Vendas são persistidas em transação. O mesmo `id` não pode registrar uma compra duas vezes.

## PWA

A página [`download.html`](download.html) orienta a instalação no navegador. Android permite instalação direta quando o navegador oferece o prompt. iOS usa Compartilhar → Adicionar à Tela de Início.

A leitura real usa `BarcodeDetector` em navegadores compatíveis e entrada manual em navegadores sem suporte.

## Integrações pendentes

Pix, cartão e antifraude precisam ser conectados a um gateway homologado por meio de credenciais reais. Este projeto não simula cobrança nem promete uma transação financeira sem o provedor.