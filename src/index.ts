#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { AppStoreConnectClient } from './client.js';
import { registerAppTools } from './tools/apps.js';
import { registerBundleIdTools } from './tools/bundleIds.js';
import { registerBuildTools } from './tools/builds.js';
import { registerTestingTools } from './tools/testing.js';
import { registerAgreementTools } from './tools/agreements.js';
import { registerDeviceTools } from './tools/devices.js';
import { registerProvisioningTools } from './tools/provisioning.js';

const config = loadConfig();
const client = new AppStoreConnectClient(config);

const server = new McpServer(
  { name: 'asc-mcp-server', version: '1.0.0' },
  { capabilities: { logging: {} } }
);

registerAppTools(server, client);
registerBundleIdTools(server, client);
registerBuildTools(server, client, config);
registerTestingTools(server, client);
registerAgreementTools(server, client);
registerDeviceTools(server, client);
registerProvisioningTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
