# ai-memory

ai-memory stores agent memories in a PostgreSQL database on the same machine as the agent. This repository is a standalone release candidate; it does not provide a hosted service or native ChatGPT memory integration.

The tested stack is Node.js 24.21.0 with npm 11.19.0, PostgreSQL 18.6, and pgvector 0.8.6. The package declares Node 24 support (`>=24 <25`), and recovery requires PostgreSQL major version 18 plus the exact extension versions recorded in the backup. PostgreSQL client tools `pg_dump` and `pg_restore` must also be version 18.

```sh
npm ci
npm run checks
```

For a personal database and MCP client, follow [installation](docs/installation.md). [API and architecture](docs/api-architecture.md) explains package ownership; [operations](docs/operations.md) covers health, encrypted backup, and recovery. [Contributing](CONTRIBUTING.md) describes checks and isolated database tests.

The source and package archives are licensed under the [MIT License](LICENSE). The plugin archive also includes notices for its bundled dependencies.

GitHub Actions runs the same `npm run checks` on eligible pull requests and main pushes, followed by synthetic integration tests against a disposable PostgreSQL 18 service. Fork pull requests receive read-only repository access and no provider or production credentials. The workflow also runs the repository's secret scanner against reachable history and the proposed tree. To run those checks locally, install [Betterleaks 1.8.1](https://github.com/betterleaks/betterleaks/releases/tag/v1.8.1), then run `npm run scan:secrets` and `npm run scan:secrets:probe`. Repository-host secret scanning and push protection add a separate layer where available; confirm their settings before publication.

Memory stays on the local machine unless you configure an external embedding or classification provider or optional S3 backups. Local availability depends on that machine and its PostgreSQL service. Public source code alone does not run a service for you.
