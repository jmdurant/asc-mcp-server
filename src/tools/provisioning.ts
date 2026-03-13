import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppStoreConnectClient } from '../client.js';
import { formatError } from '../errors.js';

export function registerProvisioningTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    'list_certificates',
    'List signing certificates in the developer portal',
    {
      limit: z.number().optional().describe('Max results (default 50)'),
      filterType: z.string().optional().describe('Filter by type (e.g. "DISTRIBUTION", "DEVELOPMENT")'),
    },
    async ({ limit, filterType }) => {
      try {
        const params: Record<string, string> = {
          'fields[certificates]': 'name,certificateType,expirationDate,serialNumber',
          'limit': String(limit ?? 50),
        };
        if (filterType) params['filter[certificateType]'] = filterType;

        const data = await client.requestAll('/v1/certificates', params);
        const certs = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(c => ({
          id: c.id,
          ...c.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(certs, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'create_provisioning_profile',
    'Create a provisioning profile in the developer portal',
    {
      name: z.string().describe('Profile name'),
      profileType: z.enum([
        'IOS_APP_DEVELOPMENT', 'IOS_APP_STORE', 'IOS_APP_ADHOC',
        'MAC_APP_DEVELOPMENT', 'MAC_APP_STORE', 'MAC_APP_DIRECT',
      ]).describe('Provisioning profile type'),
      bundleIdId: z.string().describe('Bundle ID resource ID (from list_bundle_ids)'),
      certificateIds: z.array(z.string()).describe('Certificate resource IDs (from list_certificates)'),
      deviceIds: z.array(z.string()).optional().describe('Device resource IDs (from list_devices). Required for development/adhoc profiles.'),
    },
    async ({ name, profileType, bundleIdId, certificateIds, deviceIds }) => {
      try {
        const relationships: Record<string, unknown> = {
          bundleId: {
            data: { type: 'bundleIds', id: bundleIdId },
          },
          certificates: {
            data: certificateIds.map(id => ({ type: 'certificates', id })),
          },
        };
        if (deviceIds?.length) {
          relationships.devices = {
            data: deviceIds.map(id => ({ type: 'devices', id })),
          };
        }

        const body = {
          data: {
            type: 'profiles',
            attributes: { name, profileType },
            relationships,
          },
        };
        const result = await client.request('/v1/profiles', { method: 'POST', body });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
