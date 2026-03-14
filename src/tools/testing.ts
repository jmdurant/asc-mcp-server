import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppStoreConnectClient } from '../client.js';
import type { Config } from '../config.js';
import { AppStoreConnectError, formatError } from '../errors.js';

export function registerTestingTools(server: McpServer, client: AppStoreConnectClient, config: Config) {
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
        // Check if tester already exists
        const existing = await client.requestAll('/v1/betaTesters', {
          'filter[email]': email,
          'filter[betaGroups]': betaGroupId,
          'fields[betaTesters]': 'email,firstName,lastName',
          'limit': '1',
        }) as Array<{ id: string; attributes: Record<string, unknown> }>;

        if (existing.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `Tester ${email} is already in this beta group.`,
            }],
          };
        }

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
        if (error instanceof AppStoreConnectError && error.status === 409) {
          return {
            content: [{
              type: 'text' as const,
              text: `Tester ${email} already exists. They may already be in this group or added at the account level.`,
            }],
          };
        }
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
              ...((isInternalGroup ?? false) ? { hasAccessToAllBuilds: true } : {}),
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
    'remove_tester',
    'Remove a beta tester from a TestFlight group',
    {
      betaGroupId: z.string().describe('Beta group resource ID'),
      testerId: z.string().describe('Beta tester resource ID (from list_testers)'),
    },
    async ({ betaGroupId, testerId }) => {
      try {
        await client.request(
          `/v1/betaGroups/${betaGroupId}/relationships/betaTesters`,
          {
            method: 'DELETE',
            body: {
              data: [{ type: 'betaTesters', id: testerId }],
            },
          }
        );
        return { content: [{ type: 'text' as const, text: `Tester ${testerId} removed from group ${betaGroupId}.` }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'list_beta_groups',
    'List TestFlight beta testing groups for an app',
    {
      appId: z.string().describe('App resource ID (from list_apps)'),
    },
    async ({ appId }) => {
      try {
        const data = await client.requestAll(
          `/v1/apps/${appId}/betaGroups`,
          {
            'fields[betaGroups]': 'name,isInternalGroup,publicLinkEnabled,publicLink,hasAccessToAllBuilds',
          }
        );
        const groups = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(g => ({
          id: g.id,
          ...g.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(groups, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'list_beta_feedback',
    'List beta build info: What\'s New text, build state, and localization details. Note: tester screenshot/text feedback is only available in the App Store Connect web UI.',
    {
      buildId: z.string().describe('Build resource ID (from list_builds)'),
    },
    async ({ buildId }) => {
      try {
        const sections: string[] = [];

        // 1. Build localizations (What's New text)
        try {
          const localizations = await client.requestAll(
            `/v1/builds/${buildId}/betaBuildLocalizations`,
            { 'fields[betaBuildLocalizations]': 'locale,whatsNew' }
          ) as Array<{ id: string; attributes: Record<string, unknown> }>;

          const locs = localizations.map(l => ({ id: l.id, ...l.attributes }));
          sections.push(`Build Localizations:\n${JSON.stringify(locs, null, 2)}`);
        } catch { /* non-fatal */ }

        // 2. Build beta detail (internal/external state)
        try {
          const detail = await client.request<{ data: { id: string; attributes: Record<string, unknown> } }>(
            `/v1/builds/${buildId}/buildBetaDetail`,
            { params: { 'fields[buildBetaDetails]': 'autoNotifyEnabled,externalBuildState,internalBuildState' } }
          );
          if (detail?.data) {
            sections.push(`Build Beta Detail:\n${JSON.stringify({ id: detail.data.id, ...detail.data.attributes }, null, 2)}`);
          }
        } catch { /* non-fatal */ }

        sections.push(
          'Note: Tester screenshot/text feedback is not available via the API.\n' +
          'View it at: https://appstoreconnect.apple.com → My Apps → TestFlight → Feedback'
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Build ${buildId} info:\n\n${sections.join('\n\n')}`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'update_beta_build_localization',
    'Set or update the "What\'s New" text shown to testers in TestFlight for a specific build',
    {
      buildId: z.string().describe('Build resource ID (from list_builds)'),
      whatsNew: z.string().describe('What\'s new text for testers'),
      locale: z.string().optional().describe('Locale code (default "en-US")'),
    },
    async ({ buildId, whatsNew, locale }) => {
      try {
        const loc = locale ?? 'en-US';

        // Check if localization already exists
        const existing = await client.requestAll(
          `/v1/builds/${buildId}/betaBuildLocalizations`,
          { 'fields[betaBuildLocalizations]': 'locale' }
        ) as Array<{ id: string; attributes: { locale: string } }>;

        const match = existing.find(l => l.attributes.locale === loc);

        if (match) {
          const result = await client.request<{ data: { id: string; attributes: Record<string, unknown> } }>(
            `/v1/betaBuildLocalizations/${match.id}`,
            {
              method: 'PATCH',
              body: {
                data: {
                  type: 'betaBuildLocalizations',
                  id: match.id,
                  attributes: { whatsNew },
                },
              },
            }
          );
          return { content: [{ type: 'text' as const, text: `Updated "What's New" for ${loc}.\n${JSON.stringify({ id: result.data.id, ...result.data.attributes }, null, 2)}` }] };
        } else {
          const result = await client.request<{ data: { id: string; attributes: Record<string, unknown> } }>(
            '/v1/betaBuildLocalizations',
            {
              method: 'POST',
              body: {
                data: {
                  type: 'betaBuildLocalizations',
                  attributes: { locale: loc, whatsNew },
                  relationships: {
                    build: { data: { type: 'builds', id: buildId } },
                  },
                },
              },
            }
          );
          return { content: [{ type: 'text' as const, text: `Created "What's New" for ${loc}.\n${JSON.stringify({ id: result.data.id, ...result.data.attributes }, null, 2)}` }] };
        }
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
    'Submit a build for TestFlight external testing review. Auto-fills missing beta description and review contact info from the API when possible. Only prompts for phone number if truly missing. Internal testers do not require review.',
    {
      buildId: z.string().describe('Build resource ID (from list_builds)'),
      appId: z.string().optional().describe('App resource ID — if provided, auto-fills missing beta info before submitting'),
      contactPhone: z.string().optional().describe('Contact phone with country code (e.g. "+18005551234") — falls back to ASC_CONTACT_PHONE env var if not provided'),
      description: z.string().optional().describe('Beta app description — auto-generates from app name if not provided'),
    },
    async ({ buildId, appId, contactPhone, description }) => {
      try {
        // Fall back to config phone if not provided as parameter
        const phone = contactPhone ?? config.contactPhone;

        if (appId) {
          const autoFilled: string[] = [];

          // Fetch current state
          const [localizations, reviewDetails] = await Promise.all([
            client.requestAll(`/v1/apps/${appId}/betaAppLocalizations`, {
              'fields[betaAppLocalizations]': 'description,locale',
            }),
            client.request<{ data: { attributes: Record<string, unknown> } }>(
              `/v1/apps/${appId}/betaAppReviewDetail`
            ),
          ]);

          const locs = localizations as Array<{ id: string; attributes: { description?: string; locale?: string } }>;
          const reviewAttrs = reviewDetails.data.attributes;

          // Auto-fill beta description if missing
          if (locs.length === 0 || !locs.some(l => l.attributes.description)) {
            // Get app name for a default description
            let appName = 'this app';
            try {
              const appData = await client.request<{ data: { attributes: { name: string } } }>(
                `/v1/apps/${appId}`,
                { params: { 'fields[apps]': 'name' } }
              );
              appName = appData.data.attributes.name;
            } catch { /* use default */ }

            const desc = description ?? `Beta testing for ${appName}.`;

            if (locs.length > 0 && locs[0].attributes.locale) {
              // Update existing localization
              const locId = (locs[0] as { id: string }).id;
              await client.request(`/v1/betaAppLocalizations/${locId}`, {
                method: 'PATCH',
                body: { data: { type: 'betaAppLocalizations', id: locId, attributes: { description: desc } } },
              });
            } else {
              // Create new localization
              await client.request('/v1/betaAppLocalizations', {
                method: 'POST',
                body: {
                  data: {
                    type: 'betaAppLocalizations',
                    attributes: { locale: 'en-US', description: desc },
                    relationships: { app: { data: { type: 'apps', id: appId } } },
                  },
                },
              });
            }
            autoFilled.push(`Beta description: "${desc}"`);
          }

          // Auto-fill review contact from team users if missing
          const needsContact = !reviewAttrs.contactEmail || !reviewAttrs.contactFirstName || !reviewAttrs.contactLastName;
          const needsPhone = !reviewAttrs.contactPhone;

          if (needsContact || (needsPhone && phone)) {
            const updates: Record<string, unknown> = {};

            if (needsContact) {
              // Fetch team users to auto-populate contact info
              try {
                const users = await client.requestAll('/v1/users', {
                  'fields[users]': 'firstName,lastName,username,roles',
                  'limit': '10',
                }) as Array<{ attributes: { firstName: string; lastName: string; username: string; roles: string[] } }>;

                // Prefer account holder or admin
                const admin = users.find(u =>
                  u.attributes.roles?.includes('ACCOUNT_HOLDER') ||
                  u.attributes.roles?.includes('ADMIN')
                ) ?? users[0];

                if (admin) {
                  if (!reviewAttrs.contactEmail) {
                    updates.contactEmail = admin.attributes.username;
                    autoFilled.push(`Contact email: ${admin.attributes.username} (from team)`);
                  }
                  if (!reviewAttrs.contactFirstName) {
                    updates.contactFirstName = admin.attributes.firstName;
                    autoFilled.push(`Contact first name: ${admin.attributes.firstName}`);
                  }
                  if (!reviewAttrs.contactLastName) {
                    updates.contactLastName = admin.attributes.lastName;
                    autoFilled.push(`Contact last name: ${admin.attributes.lastName}`);
                  }
                }
              } catch { /* users endpoint may fail, continue */ }
            }

            if (needsPhone && phone) {
              updates.contactPhone = phone;
              autoFilled.push(`Contact phone: ${phone}${!contactPhone ? ' (from config)' : ''}`);
            }

            if (Object.keys(updates).length > 0) {
              await client.request(`/v1/betaAppReviewDetails/${appId}`, {
                method: 'PATCH',
                body: { data: { type: 'betaAppReviewDetails', id: appId, attributes: updates } },
              });
            }
          }

          // Final check — is phone still missing?
          if (needsPhone && !phone) {
            return {
              content: [{
                type: 'text' as const,
                text: `Almost ready — auto-filled: ${autoFilled.join(', ') || 'nothing needed'}\n\n` +
                  `But contact phone number is required and can't be auto-detected.\n` +
                  `Either re-run with contactPhone parameter (e.g. "+18005551234"), or add ASC_CONTACT_PHONE to your MCP server env config.`,
              }],
              isError: true,
            };
          }

          if (autoFilled.length > 0) {
            // Log what was auto-filled (will be included in response)
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
        const result = await client.request<{ data: { attributes: Record<string, unknown> } }>(
          '/v1/betaAppReviewSubmissions',
          { method: 'POST', body }
        );

        const prefix = appId ? 'Auto-filled missing beta info and submitted.\n\n' : '';
        return { content: [{ type: 'text' as const, text: `${prefix}${JSON.stringify(result, null, 2)}` }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
