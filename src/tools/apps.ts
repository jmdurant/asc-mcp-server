import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppStoreConnectClient } from '../client.js';
import { AppStoreConnectError, formatError } from '../errors.js';

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
    'Create a new app in App Store Connect. Attempts the API first; if Apple blocks it (currently not supported), returns manual steps instead.',
    {
      name: z.string().describe('App name as it will appear on the App Store'),
      bundleIdResourceId: z.string().describe('The resource ID of the registered bundle ID (from list_bundle_ids)'),
      platform: z.enum(['IOS', 'MAC_OS']).describe('Platform (IOS includes tvOS/watchOS/visionOS)'),
      sku: z.string().describe('Unique SKU for the app (e.g. "slingshot-ios")'),
      primaryLocale: z.string().optional().describe('Primary locale (default en-US)'),
    },
    async ({ name, bundleIdResourceId, platform, sku, primaryLocale }) => {
      // First check if app already exists for this bundle ID
      try {
        const bundleIdData = await client.request<{ data: { attributes: { identifier: string } } }>(
          `/v1/bundleIds/${bundleIdResourceId}`,
          { params: { 'fields[bundleIds]': 'identifier' } }
        );
        const identifier = bundleIdData.data.attributes.identifier;

        const apps = await client.requestAll('/v1/apps', {
          'filter[bundleId]': identifier,
          'fields[apps]': 'name,bundleId,sku',
        }) as Array<{ id: string; attributes: Record<string, unknown> }>;

        if (apps.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `App already exists for bundle ID '${identifier}'!\n` +
                `ID: ${apps[0].id}\n` +
                `Details: ${JSON.stringify(apps[0].attributes, null, 2)}`,
            }],
          };
        }
      } catch { /* continue to creation attempt */ }

      // Attempt API creation
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
        // If Apple doesn't support CREATE, provide manual instructions
        if (error instanceof AppStoreConnectError && (error.status === 403 || error.status === 405)) {
          return {
            content: [{
              type: 'text' as const,
              text: `Apple's API currently does not support creating apps (returned ${error.status}).\n\n` +
                `Please create the app manually in App Store Connect:\n` +
                `  1. Go to appstoreconnect.apple.com → Apps → "+" → New App\n` +
                `  2. Platform: ${platform === 'IOS' ? 'iOS (covers tvOS/watchOS/visionOS)' : 'macOS'}\n` +
                `  3. Name: ${name}\n` +
                `  4. Bundle ID: select from dropdown (resource: ${bundleIdResourceId})\n` +
                `  5. SKU: ${sku}\n` +
                `  6. User Access: Full Access\n\n` +
                `Once created, run list_apps to confirm it's visible via the API.\n` +
                `Then you can use upload_build, create_beta_group, add_tester, etc.`,
            }],
            isError: true,
          };
        }
        return formatError(error);
      }
    }
  );
}
