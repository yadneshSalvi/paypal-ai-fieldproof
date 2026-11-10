# Fieldproof

Connect community funding to reviewed work packages, purchases, and completion evidence.

A planned entry for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

## Current status

This repository contains the initial project setup and development context. The application is not implemented or deployed yet. Target integrations: PayPal + AI; AG Studio; APIMatic.

The local planning pack is at `plans/README.md`. It covers product scope, architecture, data and agent contracts, design, WOW moments, parallel implementation, validation, and judging evidence. `plans/` is intentionally excluded from Git, so those documents are available only in the original local workspace.

## Configuration

- `.env.example` is a credential-free configuration template.
- `.env` and all local planning documents are ignored by Git.
- Keep provider API keys, PayPal client secrets, and sandbox account passwords on the server.
- This project uses PayPal's sandbox. Per-project PayPal apps, webhooks, data stores, and deployment settings must be verified during implementation.
- Existing OpenAI and Gemini credentials can be used directly; an AI Gateway purchase is not a prerequisite.

## Development context

The repository includes the official APIMatic PayPal context skill content and its original license/provenance under `.agents/`. See [APIMATIC_SETUP.md](APIMATIC_SETUP.md). Installation is setup only; actual use and integration evidence will be recorded during implementation.

## Release requirements

Before submission: implement and verify a functional product, publish full setup instructions and the demo, make this repository public, retain the open-source license, and document the exact PayPal, AI, and sponsor integrations used. Hosting is planned for Vercel. Render is outside this project's scope.

## License

Application code is intended to be MIT licensed. Bundled third-party context content retains its upstream license and attribution. Commercial UI dependencies will be installed through their documented packages and licenses; proprietary distributions or license keys must not be committed.
