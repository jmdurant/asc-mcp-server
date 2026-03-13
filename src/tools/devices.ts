import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppStoreConnectClient } from '../client.js';
import { formatError } from '../errors.js';

export function registerDeviceTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    'list_devices',
    'List registered devices in the developer portal',
    {
      limit: z.number().optional().describe('Max results (default 50)'),
      filterPlatform: z.enum(['IOS', 'MAC_OS']).optional().describe('Filter by platform'),
    },
    async ({ limit, filterPlatform }) => {
      try {
        const params: Record<string, string> = {
          'fields[devices]': 'name,udid,platform,status,deviceClass',
          'limit': String(limit ?? 50),
        };
        if (filterPlatform) params['filter[platform]'] = filterPlatform;

        const data = await client.requestAll('/v1/devices', params);
        const devices = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(d => ({
          id: d.id,
          ...d.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(devices, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'register_device',
    'Register a new device in the Apple Developer portal',
    {
      name: z.string().describe('Device name (e.g. "James iPhone 15 Pro")'),
      udid: z.string().describe('Device UDID'),
      platform: z.enum(['IOS', 'MAC_OS']).describe('Device platform'),
    },
    async ({ name, udid, platform }) => {
      try {
        const body = {
          data: {
            type: 'devices',
            attributes: { name, udid, platform },
          },
        };
        const result = await client.request('/v1/devices', { method: 'POST', body });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
