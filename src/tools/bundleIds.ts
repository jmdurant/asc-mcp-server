import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppStoreConnectClient } from '../client.js';
import { AppStoreConnectError, formatError } from '../errors.js';

export function registerBundleIdTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    'list_bundle_ids',
    'List registered bundle IDs in the developer portal',
    {
      limit: z.number().optional().describe('Max results (default 50)'),
      filterIdentifier: z.string().optional().describe('Filter by bundle ID string (e.g. "com.example.app")'),
    },
    async ({ limit, filterIdentifier }) => {
      try {
        const params: Record<string, string> = {
          'fields[bundleIds]': 'identifier,name,platform',
          'limit': String(limit ?? 50),
        };
        if (filterIdentifier) params['filter[identifier]'] = filterIdentifier;

        const data = await client.requestAll('/v1/bundleIds', params);
        const ids = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(b => ({
          id: b.id,
          ...b.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(ids, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'register_bundle_id',
    'Register a new bundle ID in the Apple Developer portal',
    {
      identifier: z.string().describe('Bundle identifier (e.g. "com.example.myapp")'),
      name: z.string().describe('Display name for this bundle ID'),
      platform: z.enum(['IOS', 'MAC_OS', 'UNIVERSAL']).describe('Platform'),
    },
    async ({ identifier, name, platform }) => {
      try {
        const body = {
          data: {
            type: 'bundleIds',
            attributes: { identifier, name, platform },
          },
        };
        const result = await client.request('/v1/bundleIds', { method: 'POST', body });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        // If "not available", check whether it already exists on this team
        if (error instanceof AppStoreConnectError && error.status === 409) {
          try {
            const existing = await client.requestAll('/v1/bundleIds', {
              'filter[identifier]': identifier,
              'fields[bundleIds]': 'identifier,name,platform,seedId',
            }) as Array<{ id: string; attributes: Record<string, unknown> }>;

            const match = existing.find(
              (b) => (b.attributes as { identifier: string }).identifier === identifier
            );

            if (match) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Bundle ID '${identifier}' already exists on this team.\n` +
                    `Resource ID: ${match.id}\n` +
                    `Details: ${JSON.stringify(match.attributes, null, 2)}\n\n` +
                    `You can use resource ID '${match.id}' directly with create_app.`,
                }],
                isError: false as const,
              };
            } else {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Bundle ID '${identifier}' is not available.\n\n` +
                    `It is NOT registered on this team — it's claimed by another Apple Developer account.\n` +
                    `This commonly happens when:\n` +
                    `  - Xcode auto-registered it on a previous/free team\n` +
                    `  - Another developer owns this identifier globally\n\n` +
                    `Options:\n` +
                    `  1. Delete it from the other account (if you have access)\n` +
                    `  2. Contact Apple Developer Support to release it\n` +
                    `  3. Choose a different bundle identifier`,
                }],
                isError: true,
              };
            }
          } catch {
            // If the check itself fails, return the original error
            return formatError(error);
          }
        }
        return formatError(error);
      }
    }
  );
}
