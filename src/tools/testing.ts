import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppStoreConnectClient } from '../client.js';
import { formatError } from '../errors.js';

export function registerTestingTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    'list_testers',
    'List TestFlight beta testers',
    {
      limit: z.number().optional().describe('Max results (default 50)'),
      filterEmail: z.string().optional().describe('Filter by email address'),
    },
    async ({ limit, filterEmail }) => {
      try {
        const params: Record<string, string> = {
          'fields[betaTesters]': 'firstName,lastName,email,inviteType',
          'limit': String(limit ?? 50),
        };
        if (filterEmail) params['filter[email]'] = filterEmail;

        const data = await client.requestAll('/v1/betaTesters', params);
        const testers = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(t => ({
          id: t.id,
          ...t.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(testers, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'add_tester',
    'Add a beta tester to a TestFlight group',
    {
      email: z.string().describe('Tester email address'),
      firstName: z.string().describe('Tester first name'),
      lastName: z.string().describe('Tester last name'),
      betaGroupId: z.string().describe('Beta group resource ID (from create_beta_group)'),
    },
    async ({ email, firstName, lastName, betaGroupId }) => {
      try {
        const body = {
          data: {
            type: 'betaTesters',
            attributes: { email, firstName, lastName },
            relationships: {
              betaGroups: {
                data: [{ type: 'betaGroups', id: betaGroupId }],
              },
            },
          },
        };
        const result = await client.request('/v1/betaTesters', { method: 'POST', body });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'create_beta_group',
    'Create a TestFlight beta testing group for an app',
    {
      name: z.string().describe('Group name (e.g. "Internal Testers")'),
      appId: z.string().describe('App resource ID (from list_apps)'),
      isInternalGroup: z.boolean().optional().describe('Whether this is an internal group (default false)'),
      publicLinkEnabled: z.boolean().optional().describe('Enable public TestFlight link (default false)'),
    },
    async ({ name, appId, isInternalGroup, publicLinkEnabled }) => {
      try {
        const body = {
          data: {
            type: 'betaGroups',
            attributes: {
              name,
              isInternalGroup: isInternalGroup ?? false,
              publicLinkEnabled: publicLinkEnabled ?? false,
            },
            relationships: {
              app: {
                data: { type: 'apps', id: appId },
              },
            },
          },
        };
        const result = await client.request('/v1/betaGroups', { method: 'POST', body });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'submit_for_review',
    'Submit a build for TestFlight external testing review. Internal testers do not require review.',
    {
      buildId: z.string().describe('Build resource ID (from list_builds)'),
    },
    async ({ buildId }) => {
      try {
        const body = {
          data: {
            type: 'betaAppReviewSubmissions',
            relationships: {
              build: {
                data: { type: 'builds', id: buildId },
              },
            },
          },
        };
        const result = await client.request('/v1/betaAppReviewSubmissions', { method: 'POST', body });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
