# App Store Connect MCP Server

An MCP (Model Context Protocol) server that provides Claude Code with direct access to the App Store Connect API. Handles app creation, build uploads, TestFlight management, device registration, provisioning profiles, and more.

## Setup

### 1. Get an App Store Connect API Key

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
2. **Users and Access** > **Integrations** > **App Store Connect API** > **Team Keys**
3. Click **+** to generate a new key with **Admin** access
4. Download the `.p8` file (you can only download it once)
5. Note the **Key ID** and **Issuer ID**

### 2. Install

```bash
cd asc-mcp-server
npm install
npm run build
```

### 3. Configure Claude Code

Add to your project's `.mcp.json` (or copy the one included in this repo):

```json
{
  "mcpServers": {
    "app-store-connect": {
      "command": "node",
      "args": ["/path/to/asc-mcp-server/dist/index.js"],
      "env": {
        "ASC_KEY_ID": "YOUR_KEY_ID",
        "ASC_ISSUER_ID": "YOUR_ISSUER_ID",
        "ASC_KEY_PATH": "/path/to/AuthKey_XXXXXXXX.p8",
        "ASC_CONTACT_PHONE": "+18005551234"
      }
    }
  }
}
```

The server will guide you through setup if credentials are missing or invalid.

Restart Claude Code to pick up the new MCP server.

## Available Tools

### App Management
| Tool | Description |
|---|---|
| `list_apps` | List all apps in App Store Connect |
| `create_app` | Create a new app (requires bundle ID to be registered first) |

### Bundle IDs
| Tool | Description |
|---|---|
| `list_bundle_ids` | List registered bundle IDs |
| `register_bundle_id` | Register a new bundle ID in the developer portal |

### Builds
| Tool | Description |
|---|---|
| `list_builds` | List builds for an app with processing status |
| `upload_build` | Full pipeline: xcodebuild archive → export → altool upload |

### TestFlight
| Tool | Description |
|---|---|
| `list_testers` | List beta testers |
| `add_tester` | Add a tester to a TestFlight group |
| `create_beta_group` | Create a TestFlight testing group |
| `submit_for_review` | Submit a build for external testing review |

### Devices & Provisioning
| Tool | Description |
|---|---|
| `list_devices` | List registered devices |
| `register_device` | Register a device UDID |
| `list_certificates` | List signing certificates |
| `create_provisioning_profile` | Create a provisioning profile |

### Account
| Tool | Description |
|---|---|
| `check_agreement_status` | Check if all ASC agreements are accepted |

## Usage Examples

Once configured, just ask Claude Code naturally:

- "Check if my App Store Connect agreements are accepted"
- "Register bundle ID com.example.myapp for iOS"
- "Create a new app called MyApp with bundle ID com.example.myapp"
- "Upload my Xcode project to TestFlight"
- "List my TestFlight builds and their processing status"
- "Add jane@example.com as a TestFlight tester"
- "Register my device with UDID 00008030-..."

## Typical Workflow

1. **Check account**: `check_agreement_status`
2. **Register bundle ID**: `register_bundle_id`
3. **Create app in ASC**: `create_app`
4. **Upload build**: `upload_build` (archives, exports, and uploads)
5. **Create test group**: `create_beta_group`
6. **Add testers**: `add_tester`
7. **Submit for review** (external only): `submit_for_review`

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ASC_KEY_ID` | Yes | App Store Connect API Key ID |
| `ASC_ISSUER_ID` | Yes | App Store Connect API Issuer ID |
| `ASC_KEY_PATH` | Yes | Absolute path to the `.p8` private key file |
| `ASC_CONTACT_PHONE` | No | Contact phone for TestFlight beta review |

## Requirements

- Node.js 18+
- Xcode (for `upload_build` tool)
- Apple Developer Program membership
