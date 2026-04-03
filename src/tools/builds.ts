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
    'Archive, export, and upload an Xcode project build to App Store Connect via the Build Upload API. Automatically increments the build number if the current one has already been uploaded. For watchOS: pass the iOS stub scheme (not the watchOS scheme) — the stub embeds the watchOS app and uploads as iOS platform.',
    {
      projectPath: z.string().describe('Absolute path to .xcodeproj or .xcworkspace file'),
      scheme: z.string().describe('Xcode scheme name. For watchOS, use the iOS stub scheme (e.g. "MyApp-Stub") that embeds the watchOS app.'),
      destination: z.string().optional().describe('Build destination (default: auto-detected from platformType)'),
      archivePath: z.string().optional().describe('Where to save the .xcarchive (default: /tmp/asc-build.xcarchive)'),
      exportOptionsPlist: z.string().optional().describe('Path to ExportOptions.plist (will create a default if not provided)'),
      platformType: z.enum(['ios', 'macos', 'appletvos', 'watchos', 'visionos']).optional().describe('Platform type (default: ios). watchOS uploads via an iOS stub — destination is set to iOS automatically.'),
      appId: z.string().optional().describe('ASC app resource ID (from list_apps). If not provided, auto-detected from bundle ID in the archive.'),
      autoIncrementBuildNumber: z.boolean().optional().describe('Automatically increment build number if it conflicts with an existing upload (default: true)'),
    },
    async ({ projectPath, scheme, destination, archivePath, exportOptionsPlist, platformType, appId, autoIncrementBuildNumber }) => {
      try {
        const archive = archivePath ?? '/tmp/asc-build.xcarchive';
        const exportPath = '/tmp/asc-build-export';
        const type = platformType ?? 'ios';

        const isWatchOS = type === 'watchos';
        const isWorkspace = projectPath.endsWith('.xcworkspace');
        const projectFlag = isWorkspace ? '-workspace' : '-project';

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

        // Auto-increment build number if needed
        let buildNumberOverride: string | undefined;
        let autoIncrementWarning = '';
        if (autoIncrementBuildNumber !== false) {
          try {
            // Get current build settings from the project
            const { stdout: settingsOut } = await execFileAsync('xcodebuild', [
              projectFlag, projectPath,
              '-scheme', scheme,
              '-showBuildSettings',
            ], { maxBuffer: 10 * 1024 * 1024, timeout: 60000 });

            const currentBuildNum = settingsOut.match(/CURRENT_PROJECT_VERSION = (.+)/)?.[1]?.trim();
            const currentBundleId = settingsOut.match(/(?<![_\w])PRODUCT_BUNDLE_IDENTIFIER = (.+)/)?.[1]?.trim();

            if (!currentBundleId) {
              autoIncrementWarning = 'Auto-increment: could not detect bundle ID from build settings — skipped.';
            } else {
              // Resolve app ID from bundle ID if not provided
              let checkAppId = appId;
              if (!checkAppId) {
                const apps = await client.requestAll('/v1/apps', {
                  'filter[bundleId]': currentBundleId,
                  'fields[apps]': 'bundleId',
                }) as Array<{ id: string }>;
                checkAppId = apps[0]?.id;
              }

              if (!checkAppId) {
                autoIncrementWarning = `Auto-increment: no app found in ASC for bundle ID '${currentBundleId}' — skipped.`;
              } else {
                // Get existing builds sorted by most recent
                const existingBuilds = await client.requestAll('/v1/builds', {
                  'filter[app]': checkAppId,
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
                  }
                }
              }
            }
          } catch (err) {
            autoIncrementWarning = `Auto-increment failed: ${err instanceof Error ? err.message : String(err)} — proceeding with project build number.`;
          }
        }

        // Step 1: Archive
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
        // Override build number for all targets in this archive if auto-incremented
        if (buildNumberOverride) {
          archiveArgs.push(`CURRENT_PROJECT_VERSION=${buildNumberOverride}`);
          // Also set FLUTTER_BUILD_NUMBER for Flutter projects
          archiveArgs.push(`FLUTTER_BUILD_NUMBER=${buildNumberOverride}`);

          // Update Info.plists in sub-projects (watch apps, widgets, extensions)
          // that may have hardcoded CFBundleVersion not overridden by xcodebuild settings
          try {
            const path = await import('node:path');
            const projectDir = path.dirname(projectPath);
            // Search sibling directories and parent for Info.plist files with CFBundleVersion
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
          const projectDir = pathMod.dirname(projectPath);

          // Common privacy keys Apple flags for — with safe default descriptions
          const privacyDefaults: Record<string, string> = {
            NSBluetoothAlwaysUsageDescription: 'This app may use Bluetooth for device connectivity.',
            NSBluetoothPeripheralUsageDescription: 'This app may use Bluetooth peripherals.',
            NSCalendarsUsageDescription: 'This app may access your calendar.',
            NSCameraUsageDescription: 'This app may use the camera.',
            NSContactsUsageDescription: 'This app may access your contacts.',
            NSFaceIDUsageDescription: 'This app may use Face ID for authentication.',
            NSHealthShareUsageDescription: 'This app may read your health data.',
            NSHealthUpdateUsageDescription: 'This app may write health data.',
            NSLocationWhenInUseUsageDescription: 'This app may use your location.',
            NSMicrophoneUsageDescription: 'This app may use the microphone.',
            NSPhotoLibraryUsageDescription: 'This app may access your photo library.',
            NSSiriUsageDescription: 'This app may use Siri and shortcuts.',
            NSSpeechRecognitionUsageDescription: 'This app may use speech recognition.',
          };

          // All four iPad multitasking orientations required by TMS-90474
          const requiredOrientations = [
            'UIInterfaceOrientationPortrait',
            'UIInterfaceOrientationPortraitUpsideDown',
            'UIInterfaceOrientationLandscapeLeft',
            'UIInterfaceOrientationLandscapeRight',
          ];

          // Find the main app Info.plist (look for APPL bundle type)
          const { stdout: appPlists } = await execFileAsync('find', [
            projectDir, '-name', 'Info.plist',
            '-not', '-path', '*/DerivedData/*', '-not', '-path', '*/Pods/*',
            '-not', '-path', '*/.build/*', '-not', '-path', '*/build/*',
            '-not', '-path', '*/.dart_tool/*', '-maxdepth', '4',
          ], { timeout: 10_000 });

          for (const plist of appPlists.trim().split('\n').filter(Boolean)) {
            try {
              const content = readPlist(plist, 'utf8');
              // Only patch app plists (not extensions)
              if (!content.includes('CFBundlePackageType') || !content.includes('APPL')) continue;

              let modified = false;
              let updated = content;
              for (const [key, defaultValue] of Object.entries(privacyDefaults)) {
                if (!updated.includes(key)) {
                  // Insert before the closing </dict>
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
              // Inject iPad multitasking orientations (TMS-90474)
              for (const orientKey of ['UISupportedInterfaceOrientations', 'UISupportedInterfaceOrientations~ipad']) {
                if (!updated.includes(`<key>${orientKey}</key>`)) {
                  const insertPoint = updated.lastIndexOf('</dict>');
                  if (insertPoint !== -1) {
                    const indent = updated.includes('\t<key>') ? '\t' : '    ';
                    const arrayItems = requiredOrientations.map(o => `${indent}${indent}<string>${o}</string>`).join('\n');
                    const entry = `${indent}<key>${orientKey}</key>\n${indent}<array>\n${arrayItems}\n${indent}</array>\n`;
                    updated = updated.slice(0, insertPoint) + entry + updated.slice(insertPoint);
                    modified = true;
                  }
                } else {
                  // Key exists — ensure all four orientations are present
                  for (const orient of requiredOrientations) {
                    if (!updated.includes(orient)) {
                      // Insert the missing orientation into the existing array
                      const keyTag = `<key>${orientKey}</key>`;
                      const keyPos = updated.indexOf(keyTag);
                      if (keyPos !== -1) {
                        const arrayEnd = updated.indexOf('</array>', keyPos);
                        if (arrayEnd !== -1) {
                          const indent = updated.includes('\t<key>') ? '\t' : '    ';
                          const entry = `${indent}${indent}<string>${orient}</string>\n`;
                          updated = updated.slice(0, arrayEnd) + entry + updated.slice(arrayEnd);
                          modified = true;
                        }
                      }
                    }
                  }
                }
              }
              if (modified) {
                writePlist(plist, updated, 'utf8');
              }
            } catch { /* skip unreadable plists */ }
          }
        } catch { /* non-fatal — privacy key injection is best-effort */ }

        const { stdout: archiveOut, stderr: archiveErr } = await execFileAsync('xcodebuild',
          archiveArgs,
          { maxBuffer: 50 * 1024 * 1024, timeout: 600000 });

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

        // Post-archive: sync CFBundleVersion and CFBundleShortVersionString across all embedded bundles
        try {
          const { stdout: archivePlists } = await execFileAsync('find', [
            `${archive}/Products`, '-name', 'Info.plist', '-maxdepth', '8',
          ], { timeout: 10_000 });
          let fixedCount = 0;
          for (const plist of archivePlists.trim().split('\n').filter(Boolean)) {
            try {
              // Sync CFBundleVersion
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
              // Sync CFBundleShortVersionString
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
        } catch { /* non-fatal — version sync in archive is best-effort */ }

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

        const incrementNote = buildNumberOverride
          ? `\nBuild number auto-incremented: ${buildNumberOverride} (was ${bundleVersion} in project)`
          : '';
        const warnNote = autoIncrementWarning ? `\n⚠️ ${autoIncrementWarning}` : '';

        return {
          content: [{
            type: 'text' as const,
            text: `Build pipeline complete!\nScheme: ${scheme}\nBundle ID: ${bundleId}\nVersion: ${bundleShortVersion} (${bundleVersion})${incrementNote}${warnNote}\nArtifact: ${artifact}\n\n${result}`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'preflight',
    'Validate that everything is ready for a build upload: bundle ID registered, app created in ASC, distribution certificate valid, team ID detectable, and export compliance key set. Run this before upload_build to catch issues early.',
    {
      bundleId: z.string().describe('The bundle identifier to check (e.g. "com.example.myapp")'),
      projectPath: z.string().optional().describe('Absolute path to .xcodeproj — if provided, checks Info.plist for ITSAppUsesNonExemptEncryption key'),
    },
    async ({ bundleId, projectPath }) => {
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

      // 5. Check export compliance key in Info.plist
      if (projectPath) {
        try {
          const { existsSync: projExists, readdirSync: readDir, readFileSync } = await import('node:fs');
          const { dirname, join } = await import('node:path');
          const projectDir = dirname(projectPath);

          // Look for Info.plist files in the project directory
          const findPlists = (dir: string): string[] => {
            const results: string[] = [];
            try {
              for (const entry of readDir(dir, { withFileTypes: true })) {
                if (entry.name === 'Info.plist' && entry.isFile()) {
                  results.push(join(dir, entry.name));
                } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'Pods' && entry.name !== 'build' && !entry.name.endsWith('.xcodeproj') && !entry.name.endsWith('.xcworkspace')) {
                  results.push(...findPlists(join(dir, entry.name)));
                }
              }
            } catch { /* skip unreadable dirs */ }
            return results;
          };

          const plists = findPlists(projectDir);
          const missingKey: string[] = [];

          for (const plist of plists) {
            try {
              const content = readFileSync(plist, 'utf8');
              // Only check app plists (not extension plists in PlugIns, etc.)
              if (content.includes('CFBundlePackageType') && content.includes('APPL')) {
                if (!content.includes('ITSAppUsesNonExemptEncryption')) {
                  const relative = plist.replace(projectDir + '/', '');
                  missingKey.push(relative);
                }
              }
            } catch { /* skip unreadable files */ }
          }

          if (missingKey.length > 0) {
            issues.push(
              `Missing ITSAppUsesNonExemptEncryption in Info.plist:\n` +
              missingKey.map(p => `   → ${p}`).join('\n') + '\n' +
              '   Add <key>ITSAppUsesNonExemptEncryption</key><false/> to skip the export compliance prompt.\n' +
              '   Set to <true/> only if your app uses custom (non-Apple) encryption.'
            );
          } else if (plists.length > 0) {
            ok.push('Export compliance: ITSAppUsesNonExemptEncryption set in all app Info.plists');
          }
        } catch {
          // Non-fatal — just skip this check
        }
      }

      // 6. Check common privacy usage descriptions in app Info.plists
      if (projectPath) {
        try {
          const { readdirSync: readDirPriv, readFileSync: readFilePriv } = await import('node:fs');
          const { dirname: dirnamePriv, join: joinPriv } = await import('node:path');
          const projectDirPriv = dirnamePriv(projectPath);

          // Common keys Apple rejects for — only warn if the app links the related framework
          const privacyKeys: Array<{ key: string; label: string }> = [
            { key: 'NSBluetoothAlwaysUsageDescription', label: 'Bluetooth' },
            { key: 'NSBluetoothPeripheralUsageDescription', label: 'Bluetooth Peripheral' },
            { key: 'NSHealthShareUsageDescription', label: 'HealthKit (read)' },
            { key: 'NSHealthUpdateUsageDescription', label: 'HealthKit (write)' },
            { key: 'NSSpeechRecognitionUsageDescription', label: 'Speech Recognition' },
            { key: 'NSHomeKitUsageDescription', label: 'HomeKit' },
            { key: 'NSFaceIDUsageDescription', label: 'Face ID' },
            { key: 'NSLocationWhenInUseUsageDescription', label: 'Location' },
            { key: 'NSCameraUsageDescription', label: 'Camera' },
            { key: 'NSMicrophoneUsageDescription', label: 'Microphone' },
            { key: 'NSPhotoLibraryUsageDescription', label: 'Photo Library' },
            { key: 'NSSiriUsageDescription', label: 'Siri' },
          ];

          const findAppPlists = (dir: string): string[] => {
            const results: string[] = [];
            try {
              for (const entry of readDirPriv(dir, { withFileTypes: true })) {
                if (entry.name === 'Info.plist' && entry.isFile()) {
                  results.push(joinPriv(dir, entry.name));
                } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'Pods' && entry.name !== 'build' && !entry.name.endsWith('.xcodeproj') && !entry.name.endsWith('.xcworkspace')) {
                  results.push(...findAppPlists(joinPriv(dir, entry.name)));
                }
              }
            } catch { /* skip */ }
            return results;
          };

          const appPlists = findAppPlists(projectDirPriv)
            .filter(p => {
              try {
                const c = readFilePriv(p, 'utf8');
                return c.includes('CFBundlePackageType') && c.includes('APPL');
              } catch { return false; }
            });

          if (appPlists.length > 0) {
            // Read the main app plist (first one found)
            const mainContent = readFilePriv(appPlists[0], 'utf8');
            const missing = privacyKeys.filter(pk => !mainContent.includes(pk.key));
            if (missing.length > 0) {
              ok.push(`Privacy usage descriptions: ${privacyKeys.length - missing.length}/${privacyKeys.length} common keys present. Missing: ${missing.map(m => m.label).join(', ')}`);
            } else {
              ok.push(`Privacy usage descriptions: all ${privacyKeys.length} common keys present`);
            }

            // Check that no usage description contains the word "apple" — Apple rejects these
            const appleRegex = /<key>(NS\w*UsageDescription)<\/key>\s*<string>([^<]*\bapple\b[^<]*)<\/string>/gi;
            let appleMatch;
            for (const plist of appPlists) {
              const plistContent = readFilePriv(plist, 'utf8');
              const relative = plist.replace(projectDirPriv + '/', '');
              while ((appleMatch = appleRegex.exec(plistContent)) !== null) {
                issues.push(
                  `Usage description for ${appleMatch[1]} in ${relative} contains the word "apple":\n` +
                  `   "${appleMatch[2]}"\n` +
                  `   → Apple rejects descriptions that reference their brand. Remove or rephrase it.`
                );
              }
            }
          }
        } catch {
          // Non-fatal
        }
      }

      // 7. Check iPad multitasking orientations (TMS-90474)
      if (projectPath) {
        try {
          const { readFileSync: readFileOrient, readdirSync: readDirOrient } = await import('node:fs');
          const { dirname: dirnameOrient, join: joinOrient } = await import('node:path');
          const projectDirOrient = dirnameOrient(projectPath);

          const requiredOrientations = [
            'UIInterfaceOrientationPortrait',
            'UIInterfaceOrientationPortraitUpsideDown',
            'UIInterfaceOrientationLandscapeLeft',
            'UIInterfaceOrientationLandscapeRight',
          ];

          const findAppPlistsOrient = (dir: string): string[] => {
            const results: string[] = [];
            try {
              for (const entry of readDirOrient(dir, { withFileTypes: true })) {
                if (entry.name === 'Info.plist' && entry.isFile()) {
                  results.push(joinOrient(dir, entry.name));
                } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'Pods' && entry.name !== 'build' && !entry.name.endsWith('.xcodeproj') && !entry.name.endsWith('.xcworkspace')) {
                  results.push(...findAppPlistsOrient(joinOrient(dir, entry.name)));
                }
              }
            } catch { /* skip */ }
            return results;
          };

          const orientPlists = findAppPlistsOrient(projectDirOrient)
            .filter(p => {
              try {
                const c = readFileOrient(p, 'utf8');
                return c.includes('CFBundlePackageType') && c.includes('APPL');
              } catch { return false; }
            });

          for (const plist of orientPlists) {
            const content = readFileOrient(plist, 'utf8');
            const relative = plist.replace(projectDirOrient + '/', '');

            for (const orientKey of ['UISupportedInterfaceOrientations', 'UISupportedInterfaceOrientations~ipad']) {
              if (!content.includes(`<key>${orientKey}</key>`)) {
                issues.push(
                  `Missing ${orientKey} in ${relative}.\n` +
                  `   → Required for iPad multitasking. upload_build will auto-inject all four orientations.`
                );
              } else {
                const missing = requiredOrientations.filter(o => !content.includes(o));
                if (missing.length > 0) {
                  issues.push(
                    `${orientKey} in ${relative} is missing orientations: ${missing.join(', ')}.\n` +
                    `   → All four orientations are required for iPad multitasking. upload_build will auto-inject missing ones.`
                  );
                }
              }
            }

            // If both keys pass, report OK once per plist
            const iPhoneOk = content.includes('<key>UISupportedInterfaceOrientations</key>') &&
              requiredOrientations.every(o => content.includes(o));
            const iPadOk = content.includes('<key>UISupportedInterfaceOrientations~ipad</key>') &&
              requiredOrientations.every(o => content.includes(o));
            if (iPhoneOk && iPadOk) {
              ok.push(`iPad multitasking orientations: all four present in ${relative}`);
            }
          }
        } catch {
          // Non-fatal
        }
      }

      // 8. Check app icon asset catalog
      if (projectPath) {
        try {
          const { readdirSync: readDir6, readFileSync: readFile6 } = await import('node:fs');
          const { dirname: dirname6, join: join6 } = await import('node:path');
          const projectDir6 = dirname6(projectPath);

          // Recursively find all AppIcon.appiconset/Contents.json files
          const findAppIcons = (dir: string): string[] => {
            const results: string[] = [];
            try {
              for (const entry of readDir6(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                  if (entry.name === 'AppIcon.appiconset') {
                    const contentsPath = join6(dir, entry.name, 'Contents.json');
                    results.push(contentsPath);
                  } else if (!entry.name.startsWith('.') && entry.name !== 'Pods' && entry.name !== 'build' && entry.name !== 'node_modules' && !entry.name.endsWith('.xcodeproj') && !entry.name.endsWith('.xcworkspace')) {
                    results.push(...findAppIcons(join6(dir, entry.name)));
                  }
                }
              }
            } catch { /* skip unreadable dirs */ }
            return results;
          };

          const iconPaths = findAppIcons(projectDir6);

          if (iconPaths.length === 0) {
            issues.push('No AppIcon asset catalog found');
          } else {
            const missingIcons: string[] = [];
            for (const iconPath of iconPaths) {
              try {
                const contents = JSON.parse(readFile6(iconPath, 'utf8')) as { images?: Array<{ filename?: string; size?: string; scale?: string; idiom?: string }> };
                if (contents.images) {
                  const missing = contents.images.filter(img => !img.filename || img.filename.trim() === '');
                  if (missing.length > 0) {
                    const sizes = missing.map(img => {
                      const parts: string[] = [];
                      if (img.size) parts.push(img.size);
                      if (img.scale) parts.push(`@${img.scale}`);
                      if (img.idiom) parts.push(`(${img.idiom})`);
                      return parts.join(' ') || 'unknown size';
                    });
                    const relative = iconPath.replace(projectDir6 + '/', '');
                    missingIcons.push(`${relative}: missing ${missing.length} icon(s) — ${sizes.join(', ')}`);
                  }
                }
              } catch { /* skip unreadable/invalid JSON */ }
            }

            if (missingIcons.length > 0) {
              issues.push(
                `App icon entries missing filenames:\n` +
                missingIcons.map(m => `   → ${m}`).join('\n')
              );
            } else {
              ok.push(`App icon: all icon entries have filenames (${iconPaths.length} asset catalog(s) found)`);
            }
          }
        } catch {
          // Non-fatal — just skip this check
        }
      }

      // 9. Check build number consistency and ASC build number
      if (projectPath) {
        try {
          const { readFileSync: readFileVer } = await import('node:fs');
          const { dirname: dirnameVer } = await import('node:path');
          const projectDirVer = dirnameVer(projectPath);

          // Find all Info.plists with CFBundleVersion
          const { stdout: versionPlists } = await execFileAsync('find', [
            projectDirVer, '-name', 'Info.plist',
            '-not', '-path', '*/DerivedData/*', '-not', '-path', '*/Pods/*',
            '-not', '-path', '*/.build/*', '-not', '-path', '*/build/*',
            '-not', '-path', '*/.dart_tool/*', '-maxdepth', '5',
          ], { timeout: 10_000 });

          const versionMap: Array<{ file: string; version: string }> = [];
          for (const plist of versionPlists.trim().split('\n').filter(Boolean)) {
            try {
              const { stdout: ver } = await execFileAsync('plutil', [
                '-extract', 'CFBundleVersion', 'raw', '-o', '-', plist,
              ]);
              const relative = plist.replace(projectDirVer + '/', '');
              versionMap.push({ file: relative, version: ver.trim() });
            } catch { /* no CFBundleVersion — skip */ }
          }

          if (versionMap.length > 1) {
            const versions = new Set(versionMap.map(v => v.version));
            if (versions.size > 1) {
              const details = versionMap.map(v => `   ${v.file}: ${v.version}`).join('\n');
              issues.push(
                `CFBundleVersion mismatch across targets — Apple will reject the upload:\n${details}\n` +
                '   → All targets (app, watch, widgets, extensions) must have the same CFBundleVersion.'
              );
            } else {
              ok.push(`Build version consistency: all ${versionMap.length} targets at version ${versionMap[0].version}`);
            }
          }

          // Check against ASC to see if build number needs incrementing
          try {
            const apps = await client.requestAll('/v1/apps', {
              'filter[bundleId]': bundleId,
              'fields[apps]': 'bundleId',
            }) as Array<{ id: string }>;
            if (apps.length > 0) {
              const existingBuilds = await client.requestAll('/v1/builds', {
                'filter[app]': apps[0].id,
                'fields[builds]': 'version',
                'sort': '-uploadedDate',
                'limit': '200',
              }) as Array<{ id: string; attributes: { version: string } }>;
              if (existingBuilds.length > 0) {
                const maxBuild = Math.max(...existingBuilds.map(b => parseInt(b.attributes.version, 10)).filter(n => !isNaN(n)));
                const localVersion = versionMap[0]?.version;
                const localNum = parseInt(localVersion ?? '0', 10);
                if (!isNaN(maxBuild)) {
                  if (localNum <= maxBuild) {
                    issues.push(
                      `Build number ${localVersion} already uploaded to ASC (max: ${maxBuild}).\n` +
                      `   → upload_build will auto-increment to ${maxBuild + 1}, but you can also update manually.`
                    );
                  } else {
                    ok.push(`Build number ${localVersion} is new (ASC max: ${maxBuild})`);
                  }
                }
              } else {
                ok.push(`No existing builds in ASC — build number ${versionMap[0]?.version ?? 'unknown'} is fine`);
              }
            }
          } catch { /* non-fatal — ASC check is best-effort in preflight */ }
        } catch {
          // Non-fatal
        }
      }

      // 10. Check that CFBundleVersion uses $(CURRENT_PROJECT_VERSION) build setting variable
      // XcodeGen and other project generators often hardcode the version, which prevents
      // xcodebuild build setting overrides (including auto-increment) from taking effect.
      if (projectPath) {
        try {
          const { readdirSync: readDirBV, readFileSync: readFileBV } = await import('node:fs');
          const { dirname: dirnameBV, join: joinBV } = await import('node:path');
          const projectDirBV = dirnameBV(projectPath);

          const findAppPlistsBV = (dir: string): string[] => {
            const results: string[] = [];
            try {
              for (const entry of readDirBV(dir, { withFileTypes: true })) {
                if (entry.name === 'Info.plist' && entry.isFile()) {
                  results.push(joinBV(dir, entry.name));
                } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'Pods' && entry.name !== 'build' && entry.name !== 'DerivedData' && !entry.name.endsWith('.xcodeproj') && !entry.name.endsWith('.xcworkspace')) {
                  results.push(...findAppPlistsBV(joinBV(dir, entry.name)));
                }
              }
            } catch { /* skip */ }
            return results;
          };

          const bvPlists = findAppPlistsBV(projectDirBV);
          const hardcodedBV: string[] = [];

          for (const plist of bvPlists) {
            try {
              const content = readFileBV(plist, 'utf8');
              // Only check app/extension plists that have CFBundleVersion
              if (!content.includes('CFBundleVersion')) continue;

              // Check if CFBundleVersion uses the build setting variable
              const bvMatch = content.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/);
              if (bvMatch) {
                const value = bvMatch[1];
                if (value !== '$(CURRENT_PROJECT_VERSION)' && !value.includes('CURRENT_PROJECT_VERSION')) {
                  const relative = plist.replace(projectDirBV + '/', '');
                  hardcodedBV.push(`${relative}: CFBundleVersion = "${value}"`);
                }
              }
            } catch { /* skip unreadable */ }
          }

          if (hardcodedBV.length > 0) {
            issues.push(
              `CFBundleVersion is hardcoded instead of using $(CURRENT_PROJECT_VERSION):\n` +
              hardcodedBV.map(p => `   → ${p}`).join('\n') + '\n' +
              '   This prevents build number auto-increment from working via xcodebuild overrides.\n' +
              '   Fix: set CFBundleVersion to $(CURRENT_PROJECT_VERSION) in your Info.plist (or project.yml plist template).'
            );
          } else if (bvPlists.length > 0) {
            ok.push('CFBundleVersion uses $(CURRENT_PROJECT_VERSION) build setting variable');
          }
        } catch {
          // Non-fatal
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
