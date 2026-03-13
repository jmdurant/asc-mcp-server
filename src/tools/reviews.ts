import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppStoreConnectClient } from '../client.js';
import { formatError } from '../errors.js';

export function registerReviewTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    'list_reviews',
    'List customer reviews for an app. Returns ratings, titles, bodies, reviewer nicknames, and dates. Supports filtering by rating and sorting.',
    {
      appId: z.string().describe('App resource ID (from list_apps)'),
      limit: z.number().optional().describe('Max results per page (default 20, max 200)'),
      sort: z.enum([
        'createdDate', '-createdDate',
        'rating', '-rating',
      ]).optional().describe('Sort order (default: -createdDate for newest first)'),
      filterRating: z.string().optional().describe('Filter by rating value, e.g. "1" or "1,2" for multiple'),
      filterTerritory: z.string().optional().describe('Filter by territory code, e.g. "USA" or "GBR"'),
    },
    async ({ appId, limit, sort, filterRating, filterTerritory }) => {
      try {
        const params: Record<string, string> = {
          'fields[customerReviews]': 'rating,title,body,reviewerNickname,createdDate,territory',
          'limit': String(limit ?? 20),
        };
        if (sort) params['sort'] = sort;
        else params['sort'] = '-createdDate';
        if (filterRating) params['filter[rating]'] = filterRating;
        if (filterTerritory) params['filter[territory]'] = filterTerritory;

        const data = await client.requestAll(
          `/v1/apps/${appId}/customerReviews`,
          params
        );
        const reviews = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(r => ({
          id: r.id,
          ...r.attributes,
        }));

        if (reviews.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No customer reviews found.' }] };
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(reviews, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'reply_to_review',
    'Create or replace your developer response to a customer review. Only one response per review is allowed — calling this again replaces the previous response.',
    {
      reviewId: z.string().describe('Customer review resource ID (from list_reviews)'),
      responseBody: z.string().describe('The text of your response to the customer review'),
    },
    async ({ reviewId, responseBody }) => {
      try {
        const body = {
          data: {
            type: 'customerReviewResponses',
            attributes: {
              responseBody,
            },
            relationships: {
              review: {
                data: { type: 'customerReviews', id: reviewId },
              },
            },
          },
        };
        const result = await client.request('/v1/customerReviewResponses', {
          method: 'POST',
          body,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'delete_review_response',
    'Delete your developer response to a customer review',
    {
      responseId: z.string().describe('Customer review response resource ID'),
    },
    async ({ responseId }) => {
      try {
        await client.request(`/v1/customerReviewResponses/${responseId}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text' as const, text: `Deleted review response ${responseId}.` }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
