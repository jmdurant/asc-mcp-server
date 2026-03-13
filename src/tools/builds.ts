import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppStoreConnectClient } from '../client.js';
import type { Config } from '../config.js';
import { AppStoreConnectError, formatError } from '../errors.js';
import { uploadBuildViaAPI } from '../upload.js';

const execFileAsync = promisify(execFile);

export function registerBuildTools(server: McpServer, client: AppStoreConnectClient, config: Config) {
  server.tool(
    'list_builds',
    'List builds for an app in App Store Connect with processing status',
    {
      appId: z.string().describe('The app resource ID (from list_apps)'),
      limit: z.number().optional().describe('Max results (default 10)'),
    },
    async ({ appId, limit }) => {
      try {
        const data = await client.requestAll('/v1/builds', {
          'filter[app]': appId,
          'fields[builds]': 'version,uploadedDate,processingState,minOsVersion,buildAudienceType',
          'sort': '-uploadedDate',
          'limit': String(limit ?? 10),
        });
        const builds = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(b => ({
          id: b.id,
          ...b.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(builds, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'upload_build',
    'Archive, export, and upload an Xcode project build to App Store Connect via the Build Upload API. For watchOS: pass the iOS stub scheme (not the watchOS scheme) — the stub embeds the watchOS app and uploads as iOS platform.',
    {
      projectPath: z.string().describe('Absolute path to .xcodeproj file'),
      scheme: z.string().describe('Xcode scheme name. For watchOS, use the iOS stub scheme (e.g. "MyApp-Stub") that embeds the watchOS app.'),
      destination: z.string().optional().describe('Build destination (default: auto-detected from platformType)'),
      archivePath: z.string().optional().describe('Where to save the .xcarchive (default: /tmp/asc-build.xcarchive)'),
      exportOptionsPlist: z.string().optional().describe('Path to ExportOptions.plist (will create a default if not provided)'),
      platformType: z.enum(['ios', 'macos', 'appletvos', 'watchos', 'visionos']).optional().describe('Platform type (default: ios). watchOS uploads via an iOS stub — destination is set to iOS automatically.'),
      appId: z.string().optional().describe('ASC app resource ID (from list_apps). If not provided, auto-detected from bundle ID in the archive.'),
    },
    async ({ projectPath, scheme, destination, archivePath, exportOptionsPlist, platformType, appId }) => {
      try {
        const archive = archivePath ?? '/tmp/asc-build.xcarchive';
        const exportPath = '/tmp/asc-build-export';
        const type = platformType ?? 'ios';

        const isWatchOS = type === 'watchos';

        // Auto-detect destination from platform
        // watchOS uploads via iOS stub, so destination is iOS
        const destMap: Record<string, string> = {
          ios: 'generic/platform=iOS',
          macos: 'generic/platform=macOS',
          appletvos: 'generic/platform=tvOS',
          watchos: 'generic/platform=iOS',
          visionos: 'generic/platform=visionOS',
        };
        const dest = destination ?? destMap[type] ?? 'generic/platform=iOS';

        // Pre-flight: check project exists
        const { existsSync } = await import('node:fs');
        if (!existsSync(projectPath)) {
          return formatError(new Error(`Project not found: ${projectPath}`));
        }

        // Check that we have at least one distribution certificate
        const certs = await client.requestAll('/v1/certificates', {
          'filter[certificateType]': 'DISTRIBUTION,IOS_DISTRIBUTION',
          'fields[certificates]': 'certificateType,displayName,expirationDate',
        }) as Array<{ id: string; attributes: { expirationDate: string } }>;
        if (certs.length === 0) {
          return formatError(new Error(
            'Pre-flight failed: No distribution certificate found.\n' +
            'Create one in Xcode (Settings → Accounts → Manage Certificates) or the developer portal.'
          ));
        }
        const expiredCerts = certs.filter(c => new Date(c.attributes.expirationDate) < new Date());
        if (expiredCerts.length === certs.length) {
          return formatError(new Error(
            'Pre-flight failed: All distribution certificates are expired.\n' +
            'Create a new one in Xcode or the developer portal.'
          ));
        }

        // Create default ExportOptions.plist if not provided
        let exportPlist = exportOptionsPlist;
        if (!exportPlist) {
          const bundleIds = await client.requestAll('/v1/bundleIds', { limit: '1' }) as Array<{ attributes: { seedId: string } }>;
          const teamId = bundleIds[0]?.attributes?.seedId;
          if (!teamId) {
            return formatError(new Error('Could not auto-detect team ID. Register at least one bundle ID first, or provide an ExportOptions.plist.'));
          }

          exportPlist = '/tmp/asc-ExportOptions.plist';
          const { writeFileSync } = await import('node:fs');
          // Use release-testing method — produces a signed IPA without uploading.
          // We handle the upload ourselves via the Build Upload API.
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
        }

        // Step 1: Archive
        const { stdout: archiveOut, stderr: archiveErr } = await execFileAsync('xcodebuild', [
          'archive',
          '-project', projectPath,
          '-scheme', scheme,
          '-destination', dest,
          '-archivePath', archive,
          '-allowProvisioningUpdates',
          '-authenticationKeyPath', config.keyPath,
          '-authenticationKeyID', config.keyId,
          '-authenticationKeyIssuerID', config.issuerId,
        ], { maxBuffer: 50 * 1024 * 1024, timeout: 600000 });

        if (archiveErr.includes('ARCHIVE FAILED') || archiveOut.includes('ARCHIVE FAILED')) {
          const errorLines = (archiveOut + archiveErr).split('\n').filter(l => l.includes('error:'));
          return formatError(new Error(`Archive failed:\n${errorLines.join('\n')}`));
        }

        // Extract version info and bundle ID from the archive
        let bundleShortVersion: string;
        let bundleVersion: string;
        let bundleId: string;
        try {
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
          bundleShortVersion = sv.trim();
          bundleVersion = bv.trim();
          bundleId = bi.trim();
        } catch {
          return formatError(new Error(
            'Failed to extract version info from archive. Ensure the archive was built correctly.'
          ));
        }

        // watchOS post-archive validation
        if (isWatchOS) {
          const appPath = `${archive}/Products/Applications`;
          const { readdirSync: readArchiveDir, existsSync: archiveExists } = await import('node:fs');

          // Find the main .app in the archive
          const appBundles = readArchiveDir(appPath).filter(f => f.endsWith('.app'));
          if (appBundles.length === 0) {
            return formatError(new Error(
              'watchOS upload failed: No .app found in archive.\n' +
              'Make sure the scheme is the iOS stub target (not the watchOS target).'
            ));
          }

          // Check for embedded watchOS app inside Watch/ directory
          const mainApp = appBundles[0];
          const watchDir = `${appPath}/${mainApp}/Watch`;
          if (!archiveExists(watchDir)) {
            return formatError(new Error(
              `watchOS upload failed: No Watch/ directory found in ${mainApp}.\n` +
              'The iOS stub must embed the watchOS app as a dependency.\n' +
              'In project.yml, add the watchOS target as a dependency of the stub target.'
            ));
          }
          const watchApps = readArchiveDir(watchDir).filter(f => f.endsWith('.app'));
          if (watchApps.length === 0) {
            return formatError(new Error(
              `watchOS upload failed: No watchOS .app found in ${mainApp}/Watch/.\n` +
              'Verify the stub target has the watchOS target as a dependency.'
            ));
          }

          // Check version consistency between stub and watchOS app
          try {
            const { stdout: watchVersion } = await execFileAsync('plutil', [
              '-extract', 'CFBundleVersion', 'raw', '-o', '-',
              `${watchDir}/${watchApps[0]}/Info.plist`,
            ]);
            if (watchVersion.trim() !== bundleVersion) {
              // Warning, not a blocker — but log it
              // Apple may issue a warning (90473) but won't reject for this
            }

            // Check for widget extension version mismatch
            const pluginsDir = `${watchDir}/${watchApps[0]}/PlugIns`;
            if (archiveExists(pluginsDir)) {
              const extensions = readArchiveDir(pluginsDir).filter(f => f.endsWith('.appex'));
              for (const ext of extensions) {
                try {
                  const { stdout: extVersion } = await execFileAsync('plutil', [
                    '-extract', 'CFBundleVersion', 'raw', '-o', '-',
                    `${pluginsDir}/${ext}/Info.plist`,
                  ]);
                  if (extVersion.trim() !== bundleVersion) {
                    return formatError(new Error(
                      `Version mismatch: Extension ${ext} has CFBundleVersion ${extVersion.trim()} ` +
                      `but the stub has ${bundleVersion}.\n` +
                      'Update CURRENT_PROJECT_VERSION to match across all targets in project.yml.'
                    ));
                  }
                } catch { /* extension might not have CFBundleVersion — skip */ }
              }
            }
          } catch { /* version extraction failed — continue anyway */ }
        }

        // Step 2: Export
        const { rmSync, mkdirSync } = await import('node:fs');
        try { rmSync(exportPath, { recursive: true }); } catch {}
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

        // Find the IPA or PKG
        const { readdirSync } = await import('node:fs');
        const files = readdirSync(exportPath);
        const artifact = files.find(f => f.endsWith('.ipa') || f.endsWith('.pkg'));
        if (!artifact) {
          return formatError(new Error(`No .ipa or .pkg found in export: ${files.join(', ')}`));
        }

        // Resolve app ID if not provided
        let resolvedAppId = appId;
        if (!resolvedAppId) {
          const apps = await client.requestAll('/v1/apps', {
            'filter[bundleId]': bundleId,
            'fields[apps]': 'bundleId',
          }) as Array<{ id: string }>;
          if (apps.length === 0) {
            return formatError(new Error(
              `No app found in ASC for bundle ID '${bundleId}'.\n` +
              'Create the app in App Store Connect first, or provide the appId parameter.'
            ));
          }
          resolvedAppId = apps[0].id;
        }

        // Step 3: Upload via Build Upload API
        const artifactPath = `${exportPath}/${artifact}`;
        const result = await uploadBuildViaAPI(
          client,
          resolvedAppId,
          artifactPath,
          artifact,
          type,
          bundleShortVersion,
          bundleVersion,
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Build pipeline complete!\nScheme: ${scheme}\nBundle ID: ${bundleId}\nVersion: ${bundleShortVersion} (${bundleVersion})\nArtifact: ${artifact}\n\n${result}`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'preflight',
    'Validate that everything is ready for a build upload: bundle ID registered, app created in ASC, distribution certificate valid, and team ID detectable. Run this before upload_build to catch issues early.',
    {
      bundleId: z.string().describe('The bundle identifier to check (e.g. "com.example.myapp")'),
    },
    async ({ bundleId }) => {
      const issues: string[] = [];
      const ok: string[] = [];

      // 1. Check bundle ID registration
      try {
        const bundleIds = await client.requestAll('/v1/bundleIds', {
          'fields[bundleIds]': 'identifier,name,platform,seedId',
          'limit': '200',
        }) as Array<{ id: string; attributes: { identifier: string; seedId: string; name: string; platform: string } }>;

        const match = bundleIds.find(b => b.attributes.identifier === bundleId);
        if (match) {
          ok.push(`Bundle ID '${bundleId}' registered (resource ID: ${match.id}, platform: ${match.attributes.platform})`);
        } else {
          // Try to register and see what error we get
          try {
            await client.request('/v1/bundleIds', {
              method: 'POST',
              body: { data: { type: 'bundleIds', attributes: { identifier: bundleId, name: bundleId, platform: 'IOS' } } },
            });
            ok.push(`Bundle ID '${bundleId}' was not registered — auto-registered it now`);
          } catch (regError) {
            if (regError instanceof AppStoreConnectError && regError.status === 409) {
              issues.push(
                `Bundle ID '${bundleId}' is NOT on this team and is claimed by another account.\n` +
                `   → Delete from the other account, contact Apple Support, or use a different identifier.`
              );
            } else {
              issues.push(`Bundle ID '${bundleId}' not registered and registration failed: ${regError instanceof Error ? regError.message : String(regError)}`);
            }
          }
        }

        // Team ID
        const teamId = bundleIds[0]?.attributes?.seedId;
        if (teamId) {
          ok.push(`Team ID: ${teamId}`);
        } else {
          issues.push('Could not detect team ID — no bundle IDs registered');
        }
      } catch (error) {
        issues.push(`Failed to check bundle IDs: ${error instanceof Error ? error.message : String(error)}`);
      }

      // 2. Check app exists in ASC
      try {
        const apps = await client.requestAll('/v1/apps', {
          'filter[bundleId]': bundleId,
          'fields[apps]': 'name,bundleId,sku',
        }) as Array<{ id: string; attributes: Record<string, unknown> }>;

        if (apps.length > 0) {
          ok.push(`App exists in ASC (ID: ${apps[0].id}, name: ${(apps[0].attributes as { name: string }).name})`);
        } else {
          issues.push(
            `No app found in ASC for bundle ID '${bundleId}'.\n` +
            `   → Use create_app to create it first (requires a registered bundle ID).`
          );
        }
      } catch (error) {
        issues.push(`Failed to check apps: ${error instanceof Error ? error.message : String(error)}`);
      }

      // 3. Check distribution certificates
      try {
        const certs = await client.requestAll('/v1/certificates', {
          'filter[certificateType]': 'DISTRIBUTION,IOS_DISTRIBUTION',
          'fields[certificates]': 'certificateType,displayName,expirationDate',
        }) as Array<{ id: string; attributes: { displayName: string; expirationDate: string; certificateType: string } }>;

        if (certs.length === 0) {
          issues.push('No distribution certificate found. Create one in Xcode or the developer portal.');
        } else {
          const valid = certs.filter(c => new Date(c.attributes.expirationDate) > new Date());
          if (valid.length > 0) {
            ok.push(`Distribution certificate: ${valid[0].attributes.displayName} (expires ${valid[0].attributes.expirationDate})`);
          } else {
            issues.push('All distribution certificates are expired. Create a new one.');
          }
        }
      } catch (error) {
        issues.push(`Failed to check certificates: ${error instanceof Error ? error.message : String(error)}`);
      }

      // 4. Check agreements
      try {
        await client.request('/v1/apps', { params: { limit: '1' } });
        ok.push('ASC agreements accepted and API functional');
      } catch (error) {
        if (error instanceof AppStoreConnectError && error.status === 403) {
          issues.push('ASC agreements not accepted. Visit App Store Connect to accept pending agreements.');
        }
      }

      const summary = issues.length === 0
        ? `All checks passed! Ready to upload.\n\n${ok.map(s => `  ✓ ${s}`).join('\n')}`
        : `${issues.length} issue(s) found:\n\n${issues.map(s => `  ✗ ${s}`).join('\n\n')}\n\nPassing checks:\n${ok.map(s => `  ✓ ${s}`).join('\n')}`;

      return {
        content: [{ type: 'text' as const, text: summary }],
        isError: issues.length > 0,
      };
    }
  );
}
