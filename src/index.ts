#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, getConfigErrors } from './config.js';

const config = loadConfig();

if (!config) {
  const errors = getConfigErrors();
  const missing = errors.filter(e => !!e.error).map(e => e.variable).join(', ');
  const setupMessage = `Setup required — missing: ${missing}

Set the following in your .mcp.json env block:

  "env": {
    "ASC_KEY_ID": "your_key_id",
    "ASC_ISSUER_ID": "your_issuer_id",
    "ASC_KEY_PATH": "/path/to/AuthKey_XXXXXXXX.p8"
  }

How to get these values:
1. Go to App Store Connect > Users and Access > Integrations > App Store Connect API
2. Generate a new API key (or use existing)
3. Copy the Key ID and Issuer ID
4. Download the .p8 key file

After updating .mcp.json, restart Claude Code for changes to take effect.`;

  const server = new McpServer(
    { name: 'app-store-connect (needs setup)', version: '1.0.0' },
    { capabilities: { logging: {} } }
  );

  server.tool('asc_setup', `App Store Connect MCP server is not configured. Call this tool for setup instructions.`, {}, async () => ({
    content: [{ type: 'text', text: setupMessage }],
    isError: true,
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
} else {
  try {
    const server = new McpServer(
      { name: 'asc-mcp-server', version: '1.0.0' },
      { capabilities: { logging: {} } }
    );

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
    const { registerReviewTools } = await import('./tools/reviews.js');
    const { registerDeployTools } = await import('./tools/deploy.js');
    const { registerAnalyticsTools } = await import('./tools/analytics.js');

    const client = new AppStoreConnectClient(config);

    registerAppTools(server, client);
    registerBundleIdTools(server, client);
    registerBuildTools(server, client, config);
    registerTestingTools(server, client, config);
    registerAgreementTools(server, client);
    registerDeviceTools(server, client);
    registerProvisioningTools(server, client);
    registerAppStoreVersionTools(server, client);
    registerScreenshotTools(server, client);
    registerReviewTools(server, client);
    registerDeployTools(server, client, config);
    registerAnalyticsTools(server, client);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const setupMessage = `App Store Connect MCP server failed to start: ${detail}

This usually means your credentials are missing or invalid.

Set the following in your .mcp.json env block:

  "env": {
    "ASC_KEY_ID": "your_key_id",
    "ASC_ISSUER_ID": "your_issuer_id",
    "ASC_KEY_PATH": "/path/to/AuthKey_XXXXXXXX.p8"
  }

How to get these values:
1. Go to App Store Connect > Users and Access > Integrations > App Store Connect API
2. Generate a new API key (or use existing)
3. Copy the Key ID and Issuer ID
4. Download the .p8 key file

After updating .mcp.json, restart Claude Code for changes to take effect.`;

    const fallback = new McpServer(
      { name: 'app-store-connect (needs setup)', version: '1.0.0' },
      { capabilities: { logging: {} } }
    );
    fallback.tool('asc_setup', `App Store Connect MCP server is not configured. Call this tool for setup instructions.`, {}, async () => ({
      content: [{ type: 'text', text: setupMessage }],
      isError: true,
    }));
    const transport = new StdioServerTransport();
    await fallback.connect(transport);
  }
}
