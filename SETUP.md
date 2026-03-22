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

## Environment Variables

Set these in your shell profile:

### macOS / Linux (`~/.zshrc` or `~/.bashrc`)

```bash
export ASC_KEY_ID="YOUR_KEY_ID"
export ASC_ISSUER_ID="YOUR_ISSUER_ID"
export ASC_KEY_PATH="/path/to/AuthKey_YOURKEYID.p8"
export ASC_CONTACT_PHONE="+1XXXXXXXXXX"  # Required for some ASC operations
```

Then reload: `source ~/.zshrc`

### Windows (PowerShell profile or System Environment Variables)

```powershell
# PowerShell profile (~\Documents\PowerShell\Microsoft.PowerShell_profile.ps1)
$env:ASC_KEY_ID = "YOUR_KEY_ID"
$env:ASC_ISSUER_ID = "YOUR_ISSUER_ID"
$env:ASC_KEY_PATH = "C:\Users\YOU\.appstoreconnect\AuthKey_YOURKEYID.p8"
$env:ASC_CONTACT_PHONE = "+1XXXXXXXXXX"
```

Or set via System → Advanced → Environment Variables.

### Windows (CMD)

```cmd
setx ASC_KEY_ID "YOUR_KEY_ID"
setx ASC_ISSUER_ID "YOUR_ISSUER_ID"
setx ASC_KEY_PATH "C:\Users\YOU\.appstoreconnect\AuthKey_YOURKEYID.p8"
setx ASC_CONTACT_PHONE "+1XXXXXXXXXX"
```

## Install & Build

```bash
npm install
npm run build
```

## Add to Claude Code

Copy `.mcp.json.example` to your project's `.mcp.json` (or merge into existing):

```bash
cp .mcp.json.example /path/to/your/project/.mcp.json
```

Update the `args` path to point to this server's `dist/index.js`:

```json
"args": ["/full/path/to/asc-mcp-server/dist/index.js"]
```

Restart Claude Code. The App Store Connect tools will be available.

## Verify

After restarting Claude Code, the server should connect automatically. You can test by asking Claude to list your apps or check app status.

## Security

- **Never commit your `.p8` private key** to any repository
- **Never hardcode credentials** in `.mcp.json` — always use `${ENV_VAR}` references
- The `.p8` key file should have restricted permissions: `chmod 600 AuthKey_*.p8`
- Rotate keys periodically via App Store Connect
