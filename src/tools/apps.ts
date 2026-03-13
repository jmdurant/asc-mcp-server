import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppStoreConnectClient } from '../client.js';
import { formatError } from '../errors.js';

export function registerAppTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    'list_apps',
    'List all apps in App Store Connect',
    { limit: z.number().optional().describe('Max number of apps to return (default 50)') },
    async ({ limit }) => {
      try {
        const data = await client.requestAll('/v1/apps', {
          'fields[apps]': 'name,bundleId,sku,primaryLocale',
          'limit': String(limit ?? 50),
        });
        const apps = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(app => ({
          id: app.id,
          ...app.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(apps, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'create_app',
    'Create a new app in App Store Connect. The bundle ID must be registered first (use register_bundle_id).',
    {
      name: z.string().describe('App name as it will appear on the App Store'),
      bundleIdResourceId: z.string().describe('The resource ID of the registered bundle ID (from list_bundle_ids)'),
      platform: z.enum(['IOS', 'MAC_OS']).describe('Platform (IOS includes tvOS/watchOS/visionOS)'),
      sku: z.string().describe('Unique SKU for the app (e.g. "slingshot-ios")'),
      primaryLocale: z.string().optional().describe('Primary locale (default en-US)'),
    },
    async ({ name, bundleIdResourceId, platform, sku, primaryLocale }) => {
      try {
        const body = {
          data: {
            type: 'apps',
            attributes: {
              name,
              primaryLocale: primaryLocale ?? 'en-US',
              sku,
            },
            relationships: {
              bundleId: {
                data: { type: 'bundleIds', id: bundleIdResourceId },
              },
            },
          },
        };
        const result = await client.request('/v1/apps', { method: 'POST', body });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
