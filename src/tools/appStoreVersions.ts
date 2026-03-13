import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppStoreConnectClient } from '../client.js';
import { formatError } from '../errors.js';

export function registerAppStoreVersionTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    'list_app_store_versions',
    'List App Store versions for an app (shows version string, state, platform, and release type)',
    {
      appId: z.string().describe('App resource ID (from list_apps)'),
      limit: z.number().optional().describe('Max results (default 10)'),
    },
    async ({ appId, limit }) => {
      try {
        const data = await client.requestAll(
          `/v1/apps/${appId}/appStoreVersions`,
          {
            'fields[appStoreVersions]': 'versionString,appStoreState,platform,releaseType,createdDate',
            'limit': String(limit ?? 10),
          }
        );
        const versions = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(v => ({
          id: v.id,
          ...v.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(versions, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'create_app_store_version',
    'Create a new App Store version for an app. This is required before submitting to the App Store.',
    {
      appId: z.string().describe('App resource ID (from list_apps)'),
      versionString: z.string().describe('Version number (e.g. "1.0.0", "1.1.0")'),
      platform: z.enum(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS']).describe('Platform for this version'),
      buildId: z.string().optional().describe('Build resource ID to attach (from list_builds). Can also be set later.'),
      releaseType: z.enum(['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED']).optional().describe('Release type (default AFTER_APPROVAL)'),
      copyright: z.string().optional().describe('Copyright text (e.g. "2026 Doctor Durant LLC")'),
    },
    async ({ appId, versionString, platform, buildId, releaseType, copyright }) => {
      try {
        const attributes: Record<string, string> = {
          platform,
          versionString,
          releaseType: releaseType ?? 'AFTER_APPROVAL',
        };
        if (copyright) attributes.copyright = copyright;

        const relationships: Record<string, unknown> = {
          app: {
            data: { type: 'apps', id: appId },
          },
        };
        if (buildId) {
          relationships.build = {
            data: { type: 'builds', id: buildId },
          };
        }

        const body = {
          data: {
            type: 'appStoreVersions',
            attributes,
            relationships,
          },
        };

        const result = await client.request<{ data: { id: string; attributes: Record<string, unknown> } }>(
          '/v1/appStoreVersions',
          { method: 'POST', body }
        );

        const version = { id: result.data.id, ...result.data.attributes };
        return { content: [{ type: 'text' as const, text: JSON.stringify(version, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'select_build_for_version',
    'Attach a processed build to an App Store version',
    {
      versionId: z.string().describe('App Store version resource ID (from list_app_store_versions or create_app_store_version)'),
      buildId: z.string().describe('Build resource ID (from list_builds)'),
    },
    async ({ versionId, buildId }) => {
      try {
        const body = {
          data: {
            type: 'appStoreVersions',
            id: versionId,
            relationships: {
              build: {
                data: { type: 'builds', id: buildId },
              },
            },
          },
        };

        const result = await client.request(
          `/v1/appStoreVersions/${versionId}`,
          { method: 'PATCH', body }
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'get_version_localizations',
    'Get App Store listing localizations for a version (description, whatsNew, keywords, etc.)',
    {
      versionId: z.string().describe('App Store version resource ID'),
    },
    async ({ versionId }) => {
      try {
        const data = await client.requestAll(
          `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
          {
            'fields[appStoreVersionLocalizations]': 'locale,description,keywords,whatsNew,promotionalText,marketingUrl,supportUrl',
          }
        );
        const localizations = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(l => ({
          id: l.id,
          ...l.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(localizations, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'update_version_localization',
    'Update App Store listing text for a version localization (description, what\'s new, keywords, etc.)',
    {
      localizationId: z.string().describe('Localization resource ID (from get_version_localizations)'),
      description: z.string().optional().describe('App description for the App Store'),
      whatsNew: z.string().optional().describe('What\'s new in this version (release notes)'),
      keywords: z.string().optional().describe('Search keywords (comma-separated, max 100 chars)'),
      promotionalText: z.string().optional().describe('Promotional text (can be updated without a new version)'),
      marketingUrl: z.string().optional().describe('Marketing URL'),
      supportUrl: z.string().optional().describe('Support URL'),
    },
    async ({ localizationId, description, whatsNew, keywords, promotionalText, marketingUrl, supportUrl }) => {
      try {
        const attributes: Record<string, string> = {};
        if (description !== undefined) attributes.description = description;
        if (whatsNew !== undefined) attributes.whatsNew = whatsNew;
        if (keywords !== undefined) attributes.keywords = keywords;
        if (promotionalText !== undefined) attributes.promotionalText = promotionalText;
        if (marketingUrl !== undefined) attributes.marketingUrl = marketingUrl;
        if (supportUrl !== undefined) attributes.supportUrl = supportUrl;

        if (Object.keys(attributes).length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No fields provided to update. Provide at least one of: description, whatsNew, keywords, promotionalText, marketingUrl, supportUrl.' }],
            isError: true,
          };
        }

        const body = {
          data: {
            type: 'appStoreVersionLocalizations',
            id: localizationId,
            attributes,
          },
        };

        const result = await client.request<{ data: { id: string; attributes: Record<string, unknown> } }>(
          `/v1/appStoreVersionLocalizations/${localizationId}`,
          { method: 'PATCH', body }
        );

        const localization = { id: result.data.id, ...result.data.attributes };
        return { content: [{ type: 'text' as const, text: JSON.stringify(localization, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'submit_for_app_review',
    'Submit an App Store version for App Store review. The version must have a build attached and all required metadata filled in.',
    {
      versionId: z.string().describe('App Store version resource ID (from list_app_store_versions or create_app_store_version)'),
    },
    async ({ versionId }) => {
      try {
        const body = {
          data: {
            type: 'appStoreVersionSubmissions',
            relationships: {
              appStoreVersion: {
                data: { type: 'appStoreVersions', id: versionId },
              },
            },
          },
        };

        const result = await client.request(
          '/v1/appStoreVersionSubmissions',
          { method: 'POST', body }
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
