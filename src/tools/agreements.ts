import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppStoreConnectClient } from '../client.js';
import { formatError, AppStoreConnectError } from '../errors.js';

export function registerAgreementTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    'check_agreement_status',
    'Check if all App Store Connect agreements are accepted. This is the #1 reason API calls fail for new accounts.',
    {},
    async () => {
      try {
        await client.request('/v1/apps', { params: { 'limit': '1' } });
        return {
          content: [{
            type: 'text' as const,
            text: 'All agreements are accepted. App Store Connect API is fully functional.',
          }],
        };
      } catch (error) {
        if (error instanceof AppStoreConnectError) {
          if (error.status === 403) {
            return {
              content: [{
                type: 'text' as const,
                text: `Agreements need attention!\n\nError: ${error.detail}\n\nPlease visit https://appstoreconnect.apple.com and accept any pending agreements under Business > Agreements, Tax, and Banking.`,
              }],
              isError: true as const,
            };
          }
        }
        return formatError(error);
      }
    }
  );
}
