import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppStoreConnectClient } from '../client.js';
import type { Config } from '../config.js';
import { AppStoreConnectError, formatError } from '../errors.js';
import { uploadBuildViaAPI } from '../upload.js';

const execFileAsync = promisify(execFile);

export function registerDeployTools(server: McpServer, client: AppStoreConnectClient, config: Config) {
  server.tool(
    'deploy_to_testflight',
    'End-to-end deploy: preflight checks → archive → upload → fill beta info → create testing groups → add builds to groups → submit for external review. One command to go from code to TestFlight.',
    {
      projectPath: z.string().describe('Absolute path to .xcodeproj or .xcworkspace file'),
      scheme: z.string().describe('Xcode scheme name'),
      platformType: z.enum(['ios', 'macos', 'appletvos', 'watchos', 'visionos']).optional().describe('Platform type (default: ios)'),
      description: z.string().optional().describe('Beta app description for TestFlight (auto-generated if not provided)'),
      contactPhone: z.string().optional().describe('Review contact phone with country code (e.g. "+18005551234") — falls back to ASC_CONTACT_PHONE env var'),
      contactEmail: z.string().optional().describe('Review contact email — auto-detected from team if not provided'),
      contactFirstName: z.string().optional().describe('Review contact first name — auto-detected from team if not provided'),
      contactLastName: z.string().optional().describe('Review contact last name — auto-detected from team if not provided'),
      internalGroupName: z.string().optional().describe('Internal testing group name (default: "Internal Testers")'),
      externalGroupName: z.string().optional().describe('External testing group name (default: "External Testers")'),
      skipExternalReview: z.boolean().optional().describe('Skip submitting for external beta review (default: false)'),
      testers: z.array(z.object({
        email: z.string(),
        firstName: z.string(),
        lastName: z.string(),
      })).optional().describe('Testers to add to the external group'),
    },
    async ({ projectPath, scheme, platformType, description, contactPhone, contactEmail, contactFirstName, contactLastName, internalGroupName, externalGroupName, skipExternalReview, testers }) => {
      try {
        const type = platformType ?? 'ios';
        const isWorkspace = projectPath.endsWith('.xcworkspace');
        const projectFlag = isWorkspace ? '-workspace' : '-project';
        const isWatchOS = type === 'watchos';
        const log: string[] = [];
        const warnings: string[] = [];

        const step = (msg: string) => log.push(`\n── ${msg}`);
        const info = (msg: string) => log.push(`   ✓ ${msg}`);
        const warn = (msg: string) => { log.push(`   ⚠ ${msg}`); warnings.push(msg); };

        // ─────────────────────────────────────────────
        // STEP 1: Pre-flight checks
        // ─────────────────────────────────────────────
        step('Step 1: Pre-flight checks');

        const { existsSync } = await import('node:fs');
        if (!existsSync(projectPath)) {
          return formatError(new Error(`Project not found: ${projectPath}`));
        }
        info('Project exists');

        // Check distribution certificate
        const certs = await client.requestAll('/v1/certificates', {
          'filter[certificateType]': 'DISTRIBUTION,IOS_DISTRIBUTION',
          'fields[certificates]': 'certificateType,displayName,expirationDate',
        }) as Array<{ id: string; attributes: { expirationDate: string; displayName: string } }>;
        const validCerts = certs.filter(c => new Date(c.attributes.expirationDate) > new Date());
        if (validCerts.length === 0) {
          return formatError(new Error('No valid distribution certificate found.'));
        }
        info(`Distribution certificate: ${validCerts[0].attributes.displayName}`);

        // Get bundle ID and resolve app
        const { stdout: settingsOut } = await execFileAsync('xcodebuild', [
          projectFlag, projectPath, '-scheme', scheme, '-showBuildSettings',
        ], { maxBuffer: 10 * 1024 * 1024, timeout: 60000 });

        const currentBundleId = settingsOut.match(/(?<![_\w])PRODUCT_BUNDLE_IDENTIFIER = (.+)/)?.[1]?.trim();
        const currentBuildNum = settingsOut.match(/CURRENT_PROJECT_VERSION = (.+)/)?.[1]?.trim();
        if (!currentBundleId) {
          return formatError(new Error('Could not detect PRODUCT_BUNDLE_IDENTIFIER from build settings.'));
        }
        info(`Bundle ID: ${currentBundleId}`);

        // Resolve app in ASC
        const apps = await client.requestAll('/v1/apps', {
          'filter[bundleId]': currentBundleId,
          'fields[apps]': 'bundleId,name',
        }) as Array<{ id: string; attributes: { name: string; bundleId: string } }>;
        if (apps.length === 0) {
          return formatError(new Error(
            `No app found in ASC for bundle ID '${currentBundleId}'. Create it in App Store Connect first.`
          ));
        }
        const appId = apps[0].id;
        const appName = apps[0].attributes.name;
        info(`App: ${appName} (ID: ${appId})`);

        // ─────────────────────────────────────────────
        // STEP 2: Auto-increment build number
        // ─────────────────────────────────────────────
        step('Step 2: Check build number');

        let buildNumberOverride: string | undefined;
        const existingBuilds = await client.requestAll('/v1/builds', {
          'filter[app]': appId,
          'fields[builds]': 'version',
          'sort': '-uploadedDate',
          'limit': '200',
        }) as Array<{ id: string; attributes: { version: string } }>;

        if (existingBuilds.length > 0) {
          const buildNumbers = existingBuilds
            .map(b => parseInt(b.attributes.version, 10))
            .filter(n => !isNaN(n));
          const maxExisting = Math.max(...buildNumbers);
          const currentNum = parseInt(currentBuildNum ?? '0', 10);

          if (!isNaN(maxExisting) && currentNum <= maxExisting) {
            buildNumberOverride = String(maxExisting + 1);
            info(`Auto-incremented build number: ${currentNum} → ${buildNumberOverride}`);
          } else {
            info(`Build number ${currentBuildNum} is new`);
          }
        } else {
          info(`No existing builds — using ${currentBuildNum}`);
        }

        // ─────────────────────────────────────────────
        // STEP 3: Archive
        // ─────────────────────────────────────────────
        step('Step 3: Archive');

        const archive = '/tmp/asc-deploy.xcarchive';
        const exportPath = '/tmp/asc-deploy-export';

        // Clean previous
        const { rmSync, mkdirSync, readdirSync, writeFileSync } = await import('node:fs');
        try { rmSync(archive, { recursive: true }); } catch {}
        try { rmSync(exportPath, { recursive: true }); } catch {}

        const destMap: Record<string, string> = {
          ios: 'generic/platform=iOS',
          macos: 'generic/platform=macOS',
          appletvos: 'generic/platform=tvOS',
          watchos: 'generic/platform=iOS',
          visionos: 'generic/platform=visionOS',
        };
        const dest = destMap[type] ?? 'generic/platform=iOS';

        const archiveArgs = [
          'archive',
          projectFlag, projectPath,
          '-scheme', scheme,
          '-destination', dest,
          '-archivePath', archive,
          '-allowProvisioningUpdates',
          '-authenticationKeyPath', config.keyPath,
          '-authenticationKeyID', config.keyId,
          '-authenticationKeyIssuerID', config.issuerId,
        ];
        if (buildNumberOverride) {
          archiveArgs.push(`CURRENT_PROJECT_VERSION=${buildNumberOverride}`);
          archiveArgs.push(`FLUTTER_BUILD_NUMBER=${buildNumberOverride}`);

          // Update Info.plists in sub-projects (watch apps, widgets, extensions)
          // that may have hardcoded CFBundleVersion not overridden by xcodebuild settings
          try {
            const path = await import('node:path');
            const projectDir = path.dirname(projectPath);
            const searchDirs = [projectDir, path.dirname(projectDir)];
            for (const dir of searchDirs) {
              try {
                const { stdout: plists } = await execFileAsync('find', [
                  dir, '-name', 'Info.plist', '-not', '-path', '*/DerivedData/*',
                  '-not', '-path', '*/Pods/*', '-not', '-path', '*/.build/*',
                  '-not', '-path', '*/build/*', '-maxdepth', '5',
                ], { timeout: 10_000 });
                for (const plist of plists.trim().split('\n').filter(Boolean)) {
                  try {
                    const { stdout: version } = await execFileAsync('plutil', [
                      '-extract', 'CFBundleVersion', 'raw', '-o', '-', plist,
                    ]);
                    if (version.trim() && version.trim() !== buildNumberOverride) {
                      await execFileAsync('plutil', [
                        '-replace', 'CFBundleVersion', '-string', buildNumberOverride, plist,
                      ]);
                    }
                  } catch { /* plist doesn't have CFBundleVersion — skip */ }
                }
              } catch { /* find failed for this dir — skip */ }
            }
          } catch { /* non-fatal — sub-project version sync is best-effort */ }
        }

        // Pre-archive: inject missing privacy usage descriptions to avoid ITMS-90683
        try {
          const pathMod = await import('node:path');
          const { readFileSync: readPlist, writeFileSync: writePlist } = await import('node:fs');
          const pDir = pathMod.dirname(projectPath);

          const privacyDefaults: Record<string, string> = {
            NSBluetoothAlwaysUsageDescription: 'This app may use Bluetooth for device connectivity.',
            NSBluetoothPeripheralUsageDescription: 'This app may use Bluetooth peripherals.',
            NSCalendarsUsageDescription: 'This app may access your calendar.',
            NSCameraUsageDescription: 'This app may use the camera.',
            NSContactsUsageDescription: 'This app may access your contacts.',
            NSFaceIDUsageDescription: 'This app may use Face ID for authentication.',
            NSLocationWhenInUseUsageDescription: 'This app may use your location.',
            NSMicrophoneUsageDescription: 'This app may use the microphone.',
            NSPhotoLibraryUsageDescription: 'This app may access your photo library.',
            NSSpeechRecognitionUsageDescription: 'This app may use speech recognition.',
          };

          const { stdout: appPlists } = await execFileAsync('find', [
            pDir, '-name', 'Info.plist',
            '-not', '-path', '*/DerivedData/*', '-not', '-path', '*/Pods/*',
            '-not', '-path', '*/.build/*', '-not', '-path', '*/build/*',
            '-not', '-path', '*/.dart_tool/*', '-maxdepth', '4',
          ], { timeout: 10_000 });

          for (const plist of appPlists.trim().split('\n').filter(Boolean)) {
            try {
              const content = readPlist(plist, 'utf8');
              if (!content.includes('CFBundlePackageType') || !content.includes('APPL')) continue;

              let modified = false;
              let updated = content;
              for (const [key, defaultValue] of Object.entries(privacyDefaults)) {
                if (!updated.includes(key)) {
                  const insertPoint = updated.lastIndexOf('</dict>');
                  if (insertPoint !== -1) {
                    const indent = updated.includes('\t<key>') ? '\t' : '    ';
                    const entry = `${indent}<key>${key}</key>\n${indent}<string>${defaultValue}</string>\n`;
                    updated = updated.slice(0, insertPoint) + entry + updated.slice(insertPoint);
                    modified = true;
                  }
                }
              }
              // Also inject export compliance key (boolean, not string)
              if (!updated.includes('ITSAppUsesNonExemptEncryption')) {
                const insertPoint = updated.lastIndexOf('</dict>');
                if (insertPoint !== -1) {
                  const indent = updated.includes('\t<key>') ? '\t' : '    ';
                  const entry = `${indent}<key>ITSAppUsesNonExemptEncryption</key>\n${indent}<false/>\n`;
                  updated = updated.slice(0, insertPoint) + entry + updated.slice(insertPoint);
                  modified = true;
                }
              }
              if (modified) {
                writePlist(plist, updated, 'utf8');
                info('Injected missing privacy/compliance keys into Info.plist');
              }
            } catch { /* skip */ }
          }
        } catch { /* non-fatal */ }

        const { stdout: archiveOut, stderr: archiveErr } = await execFileAsync('xcodebuild',
          archiveArgs,
          { maxBuffer: 50 * 1024 * 1024, timeout: 600000 });

        if (archiveErr.includes('ARCHIVE FAILED') || archiveOut.includes('ARCHIVE FAILED')) {
          const errorLines = (archiveOut + archiveErr).split('\n').filter(l => l.includes('error:'));
          return formatError(new Error(`Archive failed:\n${errorLines.join('\n')}`));
        }
        info('Archive succeeded');

        // Extract version info
        const { stdout: sv } = await execFileAsync('plutil', [
          '-extract', 'ApplicationProperties.CFBundleShortVersionString', 'raw', '-o', '-',
          `${archive}/Info.plist`,
        ]);
        const { stdout: bv } = await execFileAsync('plutil', [
          '-extract', 'ApplicationProperties.CFBundleVersion', 'raw', '-o', '-',
          `${archive}/Info.plist`,
        ]);
        const { stdout: bi } = await execFileAsync('plutil', [
          '-extract', 'ApplicationProperties.CFBundleIdentifier', 'raw', '-o', '-',
          `${archive}/Info.plist`,
        ]);
        const bundleShortVersion = sv.trim();
        const bundleVersion = bv.trim();
        const bundleId = bi.trim();
        info(`Version: ${bundleShortVersion} (${bundleVersion})`);

        // Post-archive: sync CFBundleVersion and CFBundleShortVersionString across all embedded bundles
        try {
          const { stdout: archivePlists } = await execFileAsync('find', [
            `${archive}/Products`, '-name', 'Info.plist', '-maxdepth', '8',
          ], { timeout: 10_000 });
          let fixedCount = 0;
          for (const plist of archivePlists.trim().split('\n').filter(Boolean)) {
            try {
              const { stdout: embeddedVer } = await execFileAsync('plutil', [
                '-extract', 'CFBundleVersion', 'raw', '-o', '-', plist,
              ]);
              if (embeddedVer.trim() !== bundleVersion) {
                await execFileAsync('plutil', [
                  '-replace', 'CFBundleVersion', '-string', bundleVersion, plist,
                ]);
                fixedCount++;
              }
            } catch { /* no CFBundleVersion — skip */ }
            try {
              const { stdout: embeddedShort } = await execFileAsync('plutil', [
                '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist,
              ]);
              if (embeddedShort.trim() !== bundleShortVersion) {
                await execFileAsync('plutil', [
                  '-replace', 'CFBundleShortVersionString', '-string', bundleShortVersion, plist,
                ]);
                fixedCount++;
              }
            } catch { /* no CFBundleShortVersionString — skip */ }
          }
          if (fixedCount > 0) {
            info(`Fixed versions in ${fixedCount} embedded bundle(s)`);
          }
        } catch { /* non-fatal */ }

        // ─────────────────────────────────────────────
        // STEP 4: Export
        // ─────────────────────────────────────────────
        step('Step 4: Export');

        // Auto-detect team ID
        const bundleIds = await client.requestAll('/v1/bundleIds', { limit: '1' }) as Array<{ attributes: { seedId: string } }>;
        const teamId = bundleIds[0]?.attributes?.seedId;
        if (!teamId) {
          return formatError(new Error('Could not auto-detect team ID.'));
        }

        const exportPlist = '/tmp/asc-deploy-ExportOptions.plist';
        writeFileSync(exportPlist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>release-testing</string>
    <key>teamID</key>
    <string>${teamId}</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>`);

        mkdirSync(exportPath, { recursive: true });
        const { stdout: exportOut, stderr: exportErr } = await execFileAsync('xcodebuild', [
          '-exportArchive',
          '-archivePath', archive,
          '-exportOptionsPlist', exportPlist,
          '-exportPath', exportPath,
          '-allowProvisioningUpdates',
          '-authenticationKeyPath', config.keyPath,
          '-authenticationKeyID', config.keyId,
          '-authenticationKeyIssuerID', config.issuerId,
        ], { maxBuffer: 50 * 1024 * 1024, timeout: 300000 });

        if (exportErr.includes('EXPORT FAILED') || exportOut.includes('EXPORT FAILED')) {
          const errorLines = (exportOut + exportErr).split('\n').filter(l => l.includes('error:'));
          return formatError(new Error(`Export failed:\n${errorLines.join('\n')}`));
        }

        const files = readdirSync(exportPath);
        const artifact = files.find(f => f.endsWith('.ipa') || f.endsWith('.pkg'));
        if (!artifact) {
          return formatError(new Error(`No .ipa or .pkg found in export: ${files.join(', ')}`));
        }
        info(`Exported: ${artifact}`);

        // ─────────────────────────────────────────────
        // STEP 5: Upload
        // ─────────────────────────────────────────────
        step('Step 5: Upload');

        const artifactPath = `${exportPath}/${artifact}`;
        const uploadResult = await uploadBuildViaAPI(
          client, appId, artifactPath, artifact, type, bundleShortVersion, bundleVersion,
        );
        info('Upload complete');

        // Get the build ID for the just-uploaded build
        // Small delay to let ASC register the build
        await new Promise(resolve => setTimeout(resolve, 5000));
        const newBuilds = await client.requestAll('/v1/builds', {
          'filter[app]': appId,
          'filter[version]': bundleVersion,
          'fields[builds]': 'version,processingState',
          'sort': '-uploadedDate',
          'limit': '1',
        }) as Array<{ id: string; attributes: { version: string; processingState: string } }>;

        if (newBuilds.length === 0) {
          warn('Could not find uploaded build in ASC — groups and review may need manual setup');
        }
        const buildId = newBuilds[0]?.id;

        // ─────────────────────────────────────────────
        // STEP 6: Fill beta app info
        // ─────────────────────────────────────────────
        step('Step 6: Beta app info');

        const phone = contactPhone ?? config.contactPhone;

        // Check current state
        const [localizations, reviewDetails] = await Promise.all([
          client.requestAll(`/v1/apps/${appId}/betaAppLocalizations`, {
            'fields[betaAppLocalizations]': 'description,feedbackEmail,locale',
          }),
          client.request<{ data: { attributes: Record<string, unknown> } }>(
            `/v1/apps/${appId}/betaAppReviewDetail`
          ),
        ]);

        const locs = localizations as Array<{ id: string; attributes: { description?: string; locale?: string } }>;
        const reviewAttrs = reviewDetails.data.attributes;

        // Auto-fill description
        if (locs.length === 0 || !locs.some(l => l.attributes.description)) {
          const desc = description ?? `Beta testing for ${appName}.`;
          if (locs.length > 0) {
            const locId = (locs[0] as { id: string }).id;
            await client.request(`/v1/betaAppLocalizations/${locId}`, {
              method: 'PATCH',
              body: { data: { type: 'betaAppLocalizations', id: locId, attributes: { description: desc } } },
            });
          } else {
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
          info(`Beta description set: "${desc}"`);
        } else {
          info('Beta description already set');
        }

        // Auto-fill review contact
        const reviewUpdates: Record<string, unknown> = {};
        const needsContact = !reviewAttrs.contactEmail || !reviewAttrs.contactFirstName || !reviewAttrs.contactLastName;

        if (needsContact) {
          // Try to get contact info from parameters or team users
          if (contactEmail) reviewUpdates.contactEmail = contactEmail;
          if (contactFirstName) reviewUpdates.contactFirstName = contactFirstName;
          if (contactLastName) reviewUpdates.contactLastName = contactLastName;

          // Fill remaining from team users
          if (!reviewUpdates.contactEmail || !reviewUpdates.contactFirstName || !reviewUpdates.contactLastName) {
            try {
              const users = await client.requestAll('/v1/users', {
                'fields[users]': 'firstName,lastName,username,roles',
                'limit': '10',
              }) as Array<{ attributes: { firstName: string; lastName: string; username: string; roles: string[] } }>;
              const admin = users.find(u =>
                u.attributes.roles?.includes('ACCOUNT_HOLDER') || u.attributes.roles?.includes('ADMIN')
              ) ?? users[0];
              if (admin) {
                if (!reviewAttrs.contactEmail && !reviewUpdates.contactEmail) reviewUpdates.contactEmail = admin.attributes.username;
                if (!reviewAttrs.contactFirstName && !reviewUpdates.contactFirstName) reviewUpdates.contactFirstName = admin.attributes.firstName;
                if (!reviewAttrs.contactLastName && !reviewUpdates.contactLastName) reviewUpdates.contactLastName = admin.attributes.lastName;
              }
            } catch { /* continue */ }
          }
        }

        if (!reviewAttrs.contactPhone && phone) {
          reviewUpdates.contactPhone = phone;
        }

        if (Object.keys(reviewUpdates).length > 0) {
          await client.request(`/v1/betaAppReviewDetails/${appId}`, {
            method: 'PATCH',
            body: { data: { type: 'betaAppReviewDetails', id: appId, attributes: reviewUpdates } },
          });
          info(`Review contact updated: ${Object.keys(reviewUpdates).join(', ')}`);
        } else {
          info('Review contact already set');
        }

        if (!reviewAttrs.contactPhone && !phone) {
          warn('Contact phone missing — external review may fail. Provide contactPhone or set ASC_CONTACT_PHONE env var.');
        }

        // ─────────────────────────────────────────────
        // STEP 7: Create testing groups & add build
        // ─────────────────────────────────────────────
        step('Step 7: Testing groups');

        const intGroupName = internalGroupName ?? 'Internal Testers';
        const extGroupName = externalGroupName ?? 'External Testers';

        // Get existing groups for this app
        const existingGroups = await client.requestAll(`/v1/apps/${appId}/betaGroups`, {
          'fields[betaGroups]': 'name,isInternalGroup',
        }) as Array<{ id: string; attributes: { name: string; isInternalGroup: boolean } }>;

        // Internal group
        let intGroup = existingGroups.find(g => g.attributes.name === intGroupName && g.attributes.isInternalGroup);
        if (!intGroup) {
          const result = await client.request<{ data: { id: string; attributes: { name: string; isInternalGroup: boolean } } }>('/v1/betaGroups', {
            method: 'POST',
            body: {
              data: {
                type: 'betaGroups',
                attributes: { name: intGroupName, isInternalGroup: true, hasAccessToAllBuilds: true },
                relationships: { app: { data: { type: 'apps', id: appId } } },
              },
            },
          });
          intGroup = { id: result.data.id, attributes: result.data.attributes };
          info(`Created internal group: "${intGroupName}"`);
        } else {
          info(`Internal group exists: "${intGroupName}"`);
        }

        // External group
        let extGroup = existingGroups.find(g => g.attributes.name === extGroupName && !g.attributes.isInternalGroup);
        if (!extGroup) {
          const result = await client.request<{ data: { id: string; attributes: { name: string; isInternalGroup: boolean } } }>('/v1/betaGroups', {
            method: 'POST',
            body: {
              data: {
                type: 'betaGroups',
                attributes: { name: extGroupName, isInternalGroup: false, publicLinkEnabled: false },
                relationships: { app: { data: { type: 'apps', id: appId } } },
              },
            },
          });
          extGroup = { id: result.data.id, attributes: result.data.attributes };
          info(`Created external group: "${extGroupName}"`);
        } else {
          info(`External group exists: "${extGroupName}"`);
        }

        // Add build to both groups
        if (buildId) {
          for (const group of [intGroup, extGroup]) {
            try {
              await client.request(`/v1/betaGroups/${group.id}/relationships/builds`, {
                method: 'POST',
                body: { data: [{ type: 'builds', id: buildId }] },
              });
              info(`Added build to "${group.attributes.name}"`);
            } catch (e) {
              if (e instanceof AppStoreConnectError && e.status === 409) {
                info(`Build already in "${group.attributes.name}"`);
              } else {
                warn(`Failed to add build to "${group.attributes.name}": ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
        }

        // Add testers to external group
        if (testers && testers.length > 0 && extGroup) {
          for (const tester of testers) {
            try {
              await client.request('/v1/betaTesters', {
                method: 'POST',
                body: {
                  data: {
                    type: 'betaTesters',
                    attributes: { email: tester.email, firstName: tester.firstName, lastName: tester.lastName },
                    relationships: {
                      betaGroups: { data: [{ type: 'betaGroups', id: extGroup.id }] },
                    },
                  },
                },
              });
              info(`Added tester: ${tester.email}`);
            } catch (e) {
              if (e instanceof AppStoreConnectError && e.status === 409) {
                info(`Tester already exists: ${tester.email}`);
              } else {
                warn(`Failed to add tester ${tester.email}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
        }

        // ─────────────────────────────────────────────
        // STEP 8: Submit for external review
        // ─────────────────────────────────────────────
        if (!skipExternalReview && buildId) {
          step('Step 8: Submit for external beta review');
          try {
            await client.request('/v1/betaAppReviewSubmissions', {
              method: 'POST',
              body: {
                data: {
                  type: 'betaAppReviewSubmissions',
                  relationships: {
                    build: { data: { type: 'builds', id: buildId } },
                  },
                },
              },
            });
            info('Submitted for external beta review');
          } catch (e) {
            if (e instanceof AppStoreConnectError) {
              warn(`External review submission failed: ${e.detail}`);
            } else {
              warn(`External review submission failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        } else if (skipExternalReview) {
          step('Step 8: Skipped external review (skipExternalReview=true)');
        }

        // ─────────────────────────────────────────────
        // Summary
        // ─────────────────────────────────────────────
        const summary = `\n${'═'.repeat(50)}\n` +
          `Deploy complete: ${appName}\n` +
          `Version: ${bundleShortVersion} (${bundleVersion})\n` +
          `Bundle ID: ${bundleId}\n` +
          `Build ID: ${buildId ?? 'unknown'}\n` +
          (warnings.length > 0 ? `\nWarnings (${warnings.length}):\n${warnings.map(w => `  ⚠ ${w}`).join('\n')}\n` : '') +
          `${'═'.repeat(50)}`;

        return {
          content: [{
            type: 'text' as const,
            text: log.join('\n') + summary,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
