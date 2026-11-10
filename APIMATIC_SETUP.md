# APIMatic PayPal context setup

Installed on November 10, 2026: the official **PayPal Context Plugin v0.4.1** skill content, scoped to this repository for Codex. No APIMatic account or API key is needed for this plugin.

- Source: [APIMatic PayPal plugin](https://context.apimatic.io/plugins/paypal/)
- Pinned repository commit: `context-plugins/plugin-marketplace@7cbdf85dc95f09d9ede8c5d349506686684fa0d4`
- Installed context: **29 skills, 32 files** in `.agents/skills/` — 9 TypeScript, 11 Python, and 9 .NET skills.
- Original manifest, README, MIT license, and file hashes: `.agents/apimatic-paypal/`.
- Verification: every installed skill file matched the official commit's Git blob hash; SHA-256 hashes are recorded in `.agents/apimatic-paypal/provenance.json`.

## Scope and installation

Preflight checked `npx --yes context-plugins@0.12.0 --help`, the package README, and `codex plugin add --help`. APIMatic's installer registers plugins for the whole user account and offers no project-scope flag. To keep this setup local, Codex's bundled Skill Installer installed all skill directories from the official plugin into the repository's `.agents/skills/` discovery directory. No global Codex configuration or other assistant settings were changed.

This is a repository-local installation of the plugin's complete skill content, not a user-wide marketplace registration. The upstream plugin contains skills only; no MCP connection, account, runtime service, or API credential is omitted by this method. Codex documents this local discovery location in [Build skills](https://developers.openai.com/codex/skills/).

Reproducible installation command (run from this repository on a fresh checkout; the helper refuses to overwrite installed skill directories):

```bash
python3 - <<'PY'
import json, subprocess, urllib.request
from pathlib import Path

ref = '7cbdf85dc95f09d9ede8c5d349506686684fa0d4'
url = f'https://api.github.com/repos/context-plugins/plugin-marketplace/git/trees/{ref}?recursive=1'
with urllib.request.urlopen(url) as response:
    tree = json.load(response)['tree']
paths = [str(Path(item['path']).parent) for item in tree
         if item['path'].startswith('plugins/paypal/skills/')
         and item['path'].endswith('/SKILL.md')]
helper = Path.home() / '.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py'
subprocess.run([
    'python3', str(helper), '--repo', 'context-plugins/plugin-marketplace',
    '--ref', ref, '--dest', str(Path.cwd() / '.agents/skills'),
    '--path', *paths
], check=True)
PY
```

## Use in this project

The skills will be available on the next Codex turn. If they do not appear, start a new Codex session in this directory. Begin a TypeScript integration with `$typescript-integrate-paypal` and `$typescript-getting-started`; corresponding Python and .NET skills are also installed.

The installed TypeScript entry point currently references APIMatic's generated SDK at `context-plugins/paypal-typescript-sdk`, whose package name is `paypal` and which is built from source. Read that skill before adding a runtime SDK; no application package or runtime SDK has been installed yet.

For the **Best Use of APIMatic** award, actually use the context while building the PayPal integration and document the usage in the submission. Installation alone does not demonstrate use. The optional [one-month Basic subscription claim](https://docs.google.com/forms/d/e/1FAIpQLScc2oCgAFACm7d6H3R4mgzv-O34DdyVnLIBNiwmUNggr_-hhA/viewform) requires a project/repository URL and evidence of plugin usage, so no claim has been submitted during setup.
