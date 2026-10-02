# Moda Interact API

Backend-only Node.js service for bounded HTTP health checks and PostgreSQL readiness.

## Requirements

- Node.js `24.19.0` and npm `11.17.0`.
- PostgreSQL reachable through `DATABASE_URL` for readiness to report healthy.
- The canonical database schema is provided by the `database/` Git submodule.

## Local Development

Initialize nested repositories and install locked dependencies:

```sh
git submodule update --init --recursive
npm ci
npm run prisma:generate
```

Set `DATABASE_URL` to a PostgreSQL connection string. `PORT` is optional and
defaults to `3000`; the server binds to `0.0.0.0`.

```sh
npm run dev
npm run build
npm run start
npm run typecheck
npm run lint
npm test
```

The service exposes `GET /health/live` independently of PostgreSQL and
`GET /health/ready` with a bounded Prisma connectivity probe. Other routes return
404. Startup and shutdown logs use the canonical Shared structured logger; health
responses do not include configuration or database error details.

The HTTP stack is Node.js's built-in `node:http`; the service does not own
database migrations or application/business routes.# moda-interact-api
Backend-only Node.js service for bounded HTTP health checks and PostgreSQL readiness.
