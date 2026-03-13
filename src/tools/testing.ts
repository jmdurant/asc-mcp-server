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
    'get_beta_app_info',
    'Get the beta app description, review contact info, and localization status for an app. Shows what\'s needed for TestFlight external testing.',
    {
      appId: z.string().describe('App resource ID (from list_apps)'),
    },
    async ({ appId }) => {
      try {
        const [localizations, reviewDetails] = await Promise.all([
          client.requestAll(`/v1/apps/${appId}/betaAppLocalizations`, {
            'fields[betaAppLocalizations]': 'description,feedbackEmail,marketingUrl,privacyPolicyUrl,locale',
          }),
          client.request<{ data: { id: string; attributes: Record<string, unknown> } }>(
            `/v1/apps/${appId}/betaAppReviewDetail`
          ),
        ]);

        const locs = (localizations as Array<{ id: string; attributes: Record<string, unknown> }>).map(l => ({
          id: l.id,
          ...l.attributes,
        }));

        const reviewAttrs = reviewDetails.data.attributes as Record<string, unknown>;
        const review = { id: reviewDetails.data.id, ...reviewAttrs };

        const issues: string[] = [];
        if (locs.length === 0) issues.push('No beta app description set (required for external testing)');
        else if (!locs.some((l: Record<string, unknown>) => l.description)) issues.push('Beta app description is empty');
        if (!reviewAttrs.contactEmail) issues.push('Review contact email not set');
        if (!reviewAttrs.contactFirstName) issues.push('Review contact first name not set');
        if (!reviewAttrs.contactLastName) issues.push('Review contact last name not set');
        if (!reviewAttrs.contactPhone) issues.push('Review contact phone not set');

        const status = issues.length === 0 ? 'READY for external beta submission' : `${issues.length} issue(s) to fix before external beta submission`;

        return {
          content: [{
            type: 'text' as const,
            text: `${status}\n${issues.length > 0 ? '\nIssues:\n' + issues.map(i => `  - ${i}`).join('\n') + '\n' : ''}\nLocalizations:\n${JSON.stringify(locs, null, 2)}\n\nReview Contact:\n${JSON.stringify(review, null, 2)}`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'update_beta_app_info',
    'Set or update the beta app description and review contact info needed for TestFlight external testing submission.',
    {
      appId: z.string().describe('App resource ID (from list_apps)'),
      description: z.string().optional().describe('Beta app description shown to testers in TestFlight'),
      feedbackEmail: z.string().optional().describe('Email for tester feedback'),
      locale: z.string().optional().describe('Locale for the description (default en-US)'),
      contactEmail: z.string().optional().describe('Review contact email (only visible to Apple reviewers)'),
      contactFirstName: z.string().optional().describe('Review contact first name'),
      contactLastName: z.string().optional().describe('Review contact last name'),
      contactPhone: z.string().optional().describe('Review contact phone with country code (e.g. "+18005551234")'),
      notes: z.string().optional().describe('Notes for the beta review team'),
      demoAccountRequired: z.boolean().optional().describe('Whether a demo account is needed to review'),
      demoAccountName: z.string().optional().describe('Demo account username'),
      demoAccountPassword: z.string().optional().describe('Demo account password'),
    },
    async ({ appId, description, feedbackEmail, locale, contactEmail, contactFirstName, contactLastName, contactPhone, notes, demoAccountRequired, demoAccountName, demoAccountPassword }) => {
      try {
        const results: string[] = [];
        const loc = locale ?? 'en-US';

        // Update or create beta app localization (description)
        if (description !== undefined || feedbackEmail !== undefined) {
          const existing = await client.requestAll(`/v1/apps/${appId}/betaAppLocalizations`, {
            'fields[betaAppLocalizations]': 'locale',
          }) as Array<{ id: string; attributes: { locale: string } }>;

          const match = existing.find(l => l.attributes.locale === loc);

          const locAttributes: Record<string, string> = {};
          if (description !== undefined) locAttributes.description = description;
          if (feedbackEmail !== undefined) locAttributes.feedbackEmail = feedbackEmail;

          if (match) {
            await client.request(`/v1/betaAppLocalizations/${match.id}`, {
              method: 'PATCH',
              body: {
                data: {
                  type: 'betaAppLocalizations',
                  id: match.id,
                  attributes: locAttributes,
                },
              },
            });
            results.push(`Updated beta app localization (${loc})`);
          } else {
            await client.request('/v1/betaAppLocalizations', {
              method: 'POST',
              body: {
                data: {
                  type: 'betaAppLocalizations',
                  attributes: { locale: loc, ...locAttributes },
                  relationships: {
                    app: { data: { type: 'apps', id: appId } },
                  },
                },
              },
            });
            results.push(`Created beta app localization (${loc})`);
          }
        }

        // Update review contact details
        const reviewAttrs: Record<string, unknown> = {};
        if (contactEmail !== undefined) reviewAttrs.contactEmail = contactEmail;
        if (contactFirstName !== undefined) reviewAttrs.contactFirstName = contactFirstName;
        if (contactLastName !== undefined) reviewAttrs.contactLastName = contactLastName;
        if (contactPhone !== undefined) reviewAttrs.contactPhone = contactPhone;
        if (notes !== undefined) reviewAttrs.notes = notes;
        if (demoAccountRequired !== undefined) reviewAttrs.demoAccountRequired = demoAccountRequired;
        if (demoAccountName !== undefined) reviewAttrs.demoAccountName = demoAccountName;
        if (demoAccountPassword !== undefined) reviewAttrs.demoAccountPassword = demoAccountPassword;

        if (Object.keys(reviewAttrs).length > 0) {
          await client.request(`/v1/betaAppReviewDetails/${appId}`, {
            method: 'PATCH',
            body: {
              data: {
                type: 'betaAppReviewDetails',
                id: appId,
                attributes: reviewAttrs,
              },
            },
          });
          results.push(`Updated beta review contact info (${Object.keys(reviewAttrs).join(', ')})`);
        }

        if (results.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No fields provided to update. Provide at least one of: description, feedbackEmail, contactEmail, contactFirstName, contactLastName, contactPhone, notes.' }],
            isError: true,
          };
        }

        return { content: [{ type: 'text' as const, text: results.join('\n') }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'submit_for_review',
    'Submit a build for TestFlight external testing review. Checks that beta description and review contact are set first. Internal testers do not require review.',
    {
      buildId: z.string().describe('Build resource ID (from list_builds)'),
      appId: z.string().optional().describe('App resource ID — if provided, runs pre-checks for beta description and contact info'),
    },
    async ({ buildId, appId }) => {
      try {
        // Pre-check if appId is provided
        if (appId) {
          const issues: string[] = [];

          const [localizations, reviewDetails] = await Promise.all([
            client.requestAll(`/v1/apps/${appId}/betaAppLocalizations`, {
              'fields[betaAppLocalizations]': 'description,locale',
            }),
            client.request<{ data: { attributes: Record<string, unknown> } }>(
              `/v1/apps/${appId}/betaAppReviewDetail`
            ),
          ]);

          const locs = localizations as Array<{ attributes: { description?: string } }>;
          if (locs.length === 0 || !locs.some(l => l.attributes.description)) {
            issues.push('Beta app description is missing — use update_beta_app_info to set it');
          }

          const attrs = reviewDetails.data.attributes;
          if (!attrs.contactEmail) issues.push('Review contact email not set');
          if (!attrs.contactFirstName) issues.push('Review contact first name not set');
          if (!attrs.contactLastName) issues.push('Review contact last name not set');
          if (!attrs.contactPhone) issues.push('Review contact phone not set');

          if (issues.length > 0) {
            return {
              content: [{
                type: 'text' as const,
                text: `Cannot submit for beta review — ${issues.length} issue(s):\n${issues.map(i => `  - ${i}`).join('\n')}\n\nUse update_beta_app_info to fix these, then retry.`,
              }],
              isError: true,
            };
          }
        }

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
