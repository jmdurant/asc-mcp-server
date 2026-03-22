# App Store Connect MCP Server — Setup

## Prerequisites

1. An Apple Developer account with App Store Connect API access
2. An API key generated from [App Store Connect → Users and Access → Keys](https://appstoreconnect.apple.com/access/api)
3. Node.js 18+

## Generate API Key

1. Go to App Store Connect → Users and Access → Integrations → App Store Connect API
2. Click "Generate API Key"
3. Note the **Key ID** and **Issuer ID**
4. Download the `.p8` private key file (you can only download this once)
5. Save it to a secure location

## Install & Build

```bash
npm install
npm run build
```

## Configure Credentials

### Option 1: Shared `.env` file (Recommended)

Create `~/.env` with your credentials. The `.mcp.json` shell wrapper sources this automatically before launching the server.

```bash
# ~/.env
ASC_KEY_ID="YOUR_KEY_ID"
ASC_ISSUER_ID="YOUR_ISSUER_ID"
ASC_KEY_PATH="/path/to/AuthKey_YOURKEYID.p8"
ASC_CONTACT_PHONE="+1XXXXXXXXXX"
```

Secure it:
```bash
chmod 600 ~/.env
```

You can also create a project-level `.env` to override per-project. The server sources `$HOME/.env` first, then `./.env`.

### Option 2: Shell profile environment variables

#### macOS / Linux (`~/.zshrc` or `~/.bashrc`)

```bash
export ASC_KEY_ID="YOUR_KEY_ID"
export ASC_ISSUER_ID="YOUR_ISSUER_ID"
export ASC_KEY_PATH="/path/to/AuthKey_YOURKEYID.p8"
export ASC_CONTACT_PHONE="+1XXXXXXXXXX"
```

Then reload: `source ~/.zshrc`

#### Windows (PowerShell profile)

```powershell
$env:ASC_KEY_ID = "YOUR_KEY_ID"
$env:ASC_ISSUER_ID = "YOUR_ISSUER_ID"
$env:ASC_KEY_PATH = "C:\Users\YOU\.appstoreconnect\AuthKey_YOURKEYID.p8"
$env:ASC_CONTACT_PHONE = "+1XXXXXXXXXX"
```

#### Windows (CMD — persistent)

```cmd
setx ASC_KEY_ID "YOUR_KEY_ID"
setx ASC_ISSUER_ID "YOUR_ISSUER_ID"
setx ASC_KEY_PATH "C:\Users\YOU\.appstoreconnect\AuthKey_YOURKEYID.p8"
setx ASC_CONTACT_PHONE "+1XXXXXXXXXX"
```

## Add to Claude Code

Copy `.mcp.json.example` to your project's `.mcp.json` (or merge into existing):

```json
{
  "mcpServers": {
    "app-store-connect": {
      "command": "bash",
      "args": ["-c", "set -a && source $HOME/.env && source ./.env 2>/dev/null && exec node $HOME/asc-mcp-server/dist/index.js"]
    }
  }
}
```

How it works:
- `set -a` — auto-exports all sourced variables
- `source $HOME/.env` — loads shared credentials
- `source ./.env 2>/dev/null` — loads project overrides (silent if missing)
- `exec node ...` — launches the server

Restart Claude Code after adding.

## Security

- **Never commit your `.p8` private key** to any repository
- **Never hardcode credentials** in `.mcp.json` — use the `.env` sourcing pattern
- Secure your `.env`: `chmod 600 ~/.env`
- Secure your key: `chmod 600 AuthKey_*.p8`
- Add `.env` to your global gitignore: `echo ".env" >> ~/.gitignore_global`
- Rotate keys periodically via App Store Connect
