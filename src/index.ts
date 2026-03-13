#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, getConfigErrors } from './config.js';

const config = loadConfig();
const errors = config ? [] : getConfigErrors();

const server = new McpServer(
  { name: 'asc-mcp-server', version: '1.0.0' },
  {
    capabilities: { logging: {} },
    ...(!config && {
      instructions: 'App Store Connect MCP Server — setup required. Run the "setup" tool for configuration instructions.',
    }),
  }
);

if (config) {
  // Config is valid — dynamically import and register all tools
  const { AppStoreConnectClient } = await import('./client.js');
  const { registerAppTools } = await import('./tools/apps.js');
  const { registerBundleIdTools } = await import('./tools/bundleIds.js');
  const { registerBuildTools } = await import('./tools/builds.js');
  const { registerTestingTools } = await import('./tools/testing.js');
  const { registerAgreementTools } = await import('./tools/agreements.js');
  const { registerDeviceTools } = await import('./tools/devices.js');
  const { registerProvisioningTools } = await import('./tools/provisioning.js');
  const { registerAppStoreVersionTools } = await import('./tools/appStoreVersions.js');
  const { registerScreenshotTools } = await import('./tools/screenshots.js');

  const client = new AppStoreConnectClient(config);

  registerAppTools(server, client);
  registerBundleIdTools(server, client);
  registerBuildTools(server, client, config);
  registerTestingTools(server, client);
  registerAgreementTools(server, client);
  registerDeviceTools(server, client);
  registerProvisioningTools(server, client);
  registerAppStoreVersionTools(server, client);
  registerScreenshotTools(server, client);
} else {
  // Config is missing or invalid — register only the setup tool
  server.tool(
    'setup',
    'Shows setup instructions for the App Store Connect MCP server',
    {},
    async () => {
      const errors = getConfigErrors();
      const missing = errors.filter(e => !!e.error);
      const set = errors.filter(e => !e.error);

      const envBlock = errors.map(e => `    "${e.variable}": "${e.description}"`).join(',\n');

      let statusLines = '';
      if (set.length > 0) {
        statusLines += '\nCurrently set:\n' + set.map(e => `  - ${e.variable}`).join('\n') + '\n';
      }
      if (missing.length > 0) {
        statusLines += '\nMissing:\n' + missing.map(e => `  - ${e.variable}: ${e.error}`).join('\n') + '\n';
      }

      const message = `App Store Connect MCP Server - Setup Required

This server needs the following environment variables configured in your Claude settings (~/.claude/settings.json):

"app-store-connect": {
  "command": "node",
  "args": ["/Users/jamesdurant/asc-mcp-server/dist/index.js"],
  "env": {
${envBlock}
  }
}

How to get these values:
1. Go to App Store Connect -> Users and Access -> Integrations -> App Store Connect API
2. Generate a new API key (or use existing)
3. Copy the Key ID and Issuer ID
4. Download the .p8 key file
${statusLines}
After updating settings, restart Claude Code for changes to take effect.`;

      return { content: [{ type: 'text' as const, text: message }] };
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
