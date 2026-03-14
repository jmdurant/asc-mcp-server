import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppStoreConnectClient } from '../client.js';
import { formatError } from '../errors.js';

export function registerAnalyticsTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    'create_analytics_report_request',
    'Request an analytics report for an app. Reports take time to generate — use list_analytics_reports to check when ready.',
    {
      appId: z.string().describe('App resource ID (from list_apps)'),
      accessType: z.enum(['ONE_TIME_SNAPSHOT', 'ONGOING']).optional().describe('ONE_TIME_SNAPSHOT for a single report, ONGOING for continuous updates (default: ONE_TIME_SNAPSHOT)'),
    },
    async ({ appId, accessType }) => {
      try {
        const body = {
          data: {
            type: 'analyticsReportRequests',
            attributes: {
              accessType: accessType ?? 'ONE_TIME_SNAPSHOT',
            },
            relationships: {
              app: {
                data: { type: 'apps', id: appId },
              },
            },
          },
        };

        const result = await client.request<{ data: { id: string; attributes: Record<string, unknown> } }>(
          '/v1/analyticsReportRequests',
          { method: 'POST', body }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Analytics report requested.\nRequest ID: ${result.data.id}\n\nUse list_analytics_reports with this ID to check when reports are ready.\n\n${JSON.stringify({ id: result.data.id, ...result.data.attributes }, null, 2)}`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'list_analytics_report_requests',
    'List existing analytics report requests for an app',
    {
      appId: z.string().describe('App resource ID (from list_apps)'),
      limit: z.number().optional().describe('Max results (default 10)'),
    },
    async ({ appId, limit }) => {
      try {
        const data = await client.requestAll(
          `/v1/apps/${appId}/analyticsReportRequests`,
          {
            'fields[analyticsReportRequests]': 'accessType,stoppedDueToInactivity',
            'limit': String(limit ?? 10),
          }
        );
        const requests = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(r => ({
          id: r.id,
          ...r.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(requests, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'list_analytics_reports',
    'List available analytics reports for a report request. Filter by category to find specific report types.',
    {
      reportRequestId: z.string().describe('Report request ID (from create_analytics_report_request or list_analytics_report_requests)'),
      category: z.enum([
        'APP_USAGE', 'APP_STORE_ENGAGEMENT', 'COMMERCE', 'FRAMEWORK_USAGE', 'PERFORMANCE',
      ]).optional().describe('Filter by report category'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
    async ({ reportRequestId, category, limit }) => {
      try {
        const params: Record<string, string> = {
          'fields[analyticsReports]': 'name,category',
          'limit': String(limit ?? 20),
        };
        if (category) {
          params['filter[category]'] = category;
        }

        const data = await client.requestAll(
          `/v1/analyticsReportRequests/${reportRequestId}/reports`,
          params
        );
        const reports = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(r => ({
          id: r.id,
          ...r.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(reports, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'list_analytics_report_segments',
    'List downloadable segments for an analytics report. Each segment has a URL to download the data.',
    {
      reportId: z.string().describe('Report ID (from list_analytics_reports)'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
    async ({ reportId, limit }) => {
      try {
        const data = await client.requestAll(
          `/v1/analyticsReports/${reportId}/instances`,
          {
            'limit': String(limit ?? 20),
          }
        );

        // For each instance, get segments
        const instances = data as Array<{ id: string; attributes: Record<string, unknown> }>;
        const results = [];

        for (const instance of instances.slice(0, 5)) {
          const segments = await client.requestAll(
            `/v1/analyticsReportInstances/${instance.id}/segments`,
            {
              'fields[analyticsReportSegments]': 'checksum,sizeInBytes,url',
            }
          );

          results.push({
            instanceId: instance.id,
            ...instance.attributes,
            segments: (segments as Array<{ id: string; attributes: Record<string, unknown> }>).map(s => ({
              id: s.id,
              ...s.attributes,
            })),
          });
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'download_analytics_report',
    'Download an analytics report segment by URL. Returns the report data as text (typically TSV format).',
    {
      url: z.string().describe('Download URL (from list_analytics_report_segments)'),
    },
    async ({ url }) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          return formatError(new Error(`Download failed: HTTP ${response.status}`));
        }

        // Check if it's gzipped
        const contentEncoding = response.headers.get('content-encoding');
        let text: string;

        if (contentEncoding === 'gzip' || url.endsWith('.gz')) {
          const buffer = await response.arrayBuffer();
          const ds = new DecompressionStream('gzip');
          const decompressed = new Response(new Blob([buffer]).stream().pipeThrough(ds));
          text = await decompressed.text();
        } else {
          text = await response.text();
        }

        // Truncate if too large
        const maxLength = 50000;
        const truncated = text.length > maxLength;
        const output = truncated ? text.slice(0, maxLength) : text;

        return {
          content: [{
            type: 'text' as const,
            text: truncated
              ? `${output}\n\n... (truncated, ${text.length} total characters)`
              : output,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'download_sales_report',
    'Download sales and trends reports. Returns financial data about app sales, in-app purchases, and subscriptions.',
    {
      vendorNumber: z.string().describe('Vendor number (found in App Store Connect under Payments and Financial Reports)'),
      frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).describe('Report frequency'),
      reportDate: z.string().describe('Report date (format depends on frequency: DAILY="2026-03-14", WEEKLY="2026-03-14", MONTHLY="2026-03", YEARLY="2026")'),
      reportType: z.enum(['SALES', 'PRE_ORDER', 'NEWSSTAND', 'SUBSCRIPTION', 'SUBSCRIPTION_EVENT', 'SUBSCRIBER', 'SUBSCRIPTION_OFFER_CODE_REDEMPTION', 'INSTALLS', 'FIRST_ANNUAL']).optional().describe('Report sub type (default: SALES)'),
    },
    async ({ vendorNumber, frequency, reportDate, reportType }) => {
      try {
        const params: Record<string, string> = {
          'filter[vendorNumber]': vendorNumber,
          'filter[frequency]': frequency,
          'filter[reportDate]': reportDate,
          'filter[reportType]': reportType ?? 'SALES',
          'filter[reportSubType]': 'SUMMARY',
        };

        // Sales reports return gzipped TSV
        const result = await client.request<Response>(
          '/v1/salesReports',
          { params }
        );

        return {
          content: [{
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'download_finance_report',
    'Download financial reports with payment and proceeds data by region.',
    {
      vendorNumber: z.string().describe('Vendor number (found in App Store Connect under Payments and Financial Reports)'),
      regionCode: z.string().describe('Two-letter region code (e.g. "US", "EU", "JP")'),
      reportDate: z.string().describe('Report date in YYYY-MM format (e.g. "2026-03")'),
    },
    async ({ vendorNumber, regionCode, reportDate }) => {
      try {
        const params: Record<string, string> = {
          'filter[vendorNumber]': vendorNumber,
          'filter[regionCode]': regionCode,
          'filter[reportDate]': reportDate,
          'filter[reportType]': 'FINANCIAL',
        };

        const result = await client.request<Response>(
          '/v1/financeReports',
          { params }
        );

        return {
          content: [{
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
