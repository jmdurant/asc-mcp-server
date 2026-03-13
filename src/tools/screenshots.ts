import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppStoreConnectClient } from '../client.js';
import { formatError } from '../errors.js';
import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * App Store screenshot display types mapped to simulator devices and descriptions.
 * Apple requires specific display sizes — these are the most common required ones.
 */
const DISPLAY_TYPES: Record<string, { description: string; simulatorMatch: string; width: number; height: number }> = {
  'APP_IPHONE_67': {
    description: 'iPhone 6.7" (iPhone 15 Plus, 16 Plus)',
    simulatorMatch: 'iPhone Air',
    width: 1290,
    height: 2796,
  },
  'APP_IPHONE_61': {
    description: 'iPhone 6.1" (iPhone 15, 16)',
    simulatorMatch: 'iPhone 17',
    width: 1179,
    height: 2556,
  },
  'APP_IPHONE_69': {
    description: 'iPhone 6.9" (iPhone 16 Pro Max)',
    simulatorMatch: 'iPhone 17 Pro Max',
    width: 1320,
    height: 2868,
  },
  'APP_IPAD_PRO_3GEN_129': {
    description: 'iPad Pro 12.9" (3rd gen+)',
    simulatorMatch: 'iPad Pro 13-inch (M5)',
    width: 2048,
    height: 2732,
  },
};

function findSimulatorUDID(deviceName: string): string | null {
  try {
    const output = execSync('xcrun simctl list devices available', { encoding: 'utf-8' });
    for (const line of output.split('\n')) {
      if (line.includes(deviceName)) {
        const match = line.match(/\(([A-F0-9-]{36})\)/);
        if (match) return match[1];
      }
    }
  } catch {
    // simctl not available
  }
  return null;
}

export function registerScreenshotTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    'capture_screenshots',
    'Capture App Store screenshots from iOS/iPad simulators. Boots each required simulator size, installs the app, launches it, and waits for you to arrange the screen before capturing. Run multiple times for different screens.',
    {
      appPath: z.string().optional().describe('Path to the .app bundle to install (from a simulator build). If omitted, will build for simulator automatically.'),
      projectPath: z.string().optional().describe('Path to .xcodeproj (required if appPath not provided, to build for simulator)'),
      scheme: z.string().optional().describe('Xcode scheme (required if appPath not provided)'),
      outputDir: z.string().optional().describe('Directory to save screenshots (default: /tmp/asc-screenshots)'),
      displayTypes: z.array(z.string()).optional().describe('Display types to capture (default: all). Options: APP_IPHONE_67, APP_IPHONE_61, APP_IPHONE_69, APP_IPAD_PRO_3GEN_129'),
      screenshotName: z.string().optional().describe('Name prefix for screenshots (default: "screenshot"). Use descriptive names like "home", "player", "settings".'),
      waitForInput: z.boolean().optional().describe('If true (default), waits 30 seconds for you to arrange the app before capturing. Set false for instant capture.'),
    },
    async ({ appPath, projectPath, scheme, outputDir, displayTypes, screenshotName, waitForInput }) => {
      try {
        const outDir = outputDir ?? '/tmp/asc-screenshots';
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

        const prefix = screenshotName ?? 'screenshot';
        const types = displayTypes ?? Object.keys(DISPLAY_TYPES);
        const wait = waitForInput !== false;

        // If no appPath, build for simulator
        let resolvedAppPath = appPath;
        if (!resolvedAppPath) {
          if (!projectPath || !scheme) {
            return {
              content: [{ type: 'text' as const, text: 'Either provide appPath to an existing .app bundle, or provide projectPath and scheme to build for simulator.' }],
              isError: true,
            };
          }

          const derivedDataPath = '/tmp/asc-sim-build';
          const buildCmd = `xcodebuild build -project "${projectPath}" -scheme "${scheme}" -destination "generic/platform=iOS Simulator" -derivedDataPath "${derivedDataPath}" -configuration Release 2>&1`;
          try {
            execSync(buildCmd, { encoding: 'utf-8', timeout: 600_000 });
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `Simulator build failed:\n${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            };
          }

          // Find the .app in derived data
          const findCmd = `find "${derivedDataPath}/Build/Products" -name "*.app" -maxdepth 3 -type d | grep -i Release | head -1`;
          resolvedAppPath = execSync(findCmd, { encoding: 'utf-8' }).trim();
          if (!resolvedAppPath) {
            return {
              content: [{ type: 'text' as const, text: 'Build succeeded but could not find .app bundle in derived data.' }],
              isError: true,
            };
          }
        }

        // Get bundle ID from the app
        let bundleId: string;
        try {
          bundleId = execSync(`/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${resolvedAppPath}/Info.plist"`, { encoding: 'utf-8' }).trim();
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Could not read bundle ID from ${resolvedAppPath}/Info.plist` }],
            isError: true,
          };
        }

        const results: string[] = [];

        for (const displayType of types) {
          const config = DISPLAY_TYPES[displayType];
          if (!config) {
            results.push(`⚠ Unknown display type: ${displayType}`);
            continue;
          }

          const udid = findSimulatorUDID(config.simulatorMatch);
          if (!udid) {
            results.push(`⚠ ${displayType}: No simulator found matching "${config.simulatorMatch}"`);
            continue;
          }

          results.push(`\n--- ${displayType} (${config.description}) ---`);

          // Boot simulator
          try {
            execSync(`xcrun simctl boot ${udid} 2>&1 || true`, { encoding: 'utf-8' });
            results.push(`Booted ${config.simulatorMatch}`);
          } catch {
            results.push(`Simulator ${config.simulatorMatch} may already be booted`);
          }

          // Install app
          try {
            execSync(`xcrun simctl install ${udid} "${resolvedAppPath}"`, { encoding: 'utf-8', timeout: 60_000 });
            results.push(`Installed ${bundleId}`);
          } catch (e) {
            results.push(`Install failed: ${e instanceof Error ? e.message : String(e)}`);
            continue;
          }

          // Launch app
          try {
            execSync(`xcrun simctl launch ${udid} ${bundleId}`, { encoding: 'utf-8', timeout: 30_000 });
            results.push(`Launched app`);
          } catch (e) {
            results.push(`Launch failed: ${e instanceof Error ? e.message : String(e)}`);
          }

          // Wait for the user to arrange the screen
          if (wait) {
            results.push(`Waiting 30 seconds — arrange the app screen now...`);
            execSync('sleep 30');
          } else {
            // Brief pause for app to render
            execSync('sleep 3');
          }

          // Capture screenshot
          const filename = `${prefix}_${displayType}.png`;
          const filepath = join(outDir, filename);
          try {
            execSync(`xcrun simctl io ${udid} screenshot "${filepath}"`, { encoding: 'utf-8', timeout: 30_000 });
            results.push(`Saved: ${filepath}`);
          } catch (e) {
            results.push(`Screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
          }

          // Shutdown simulator to free resources
          try {
            execSync(`xcrun simctl shutdown ${udid} 2>&1 || true`, { encoding: 'utf-8' });
          } catch {
            // ok
          }
        }

        return { content: [{ type: 'text' as const, text: `Screenshot capture complete.\nOutput: ${outDir}\n${results.join('\n')}` }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'list_screenshot_sets',
    'List existing App Store screenshot sets for a version localization',
    {
      localizationId: z.string().describe('App Store version localization ID (from get_version_localizations)'),
    },
    async ({ localizationId }) => {
      try {
        const data = await client.requestAll(
          `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`,
          { 'fields[appScreenshotSets]': 'screenshotDisplayType' }
        );
        const sets = (data as Array<{ id: string; attributes: Record<string, unknown> }>).map(s => ({
          id: s.id,
          ...s.attributes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(sets, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'upload_screenshots',
    'Upload captured screenshots to App Store Connect for a version localization. Reads PNG files from a directory and uploads them to the appropriate screenshot sets.',
    {
      localizationId: z.string().describe('App Store version localization ID (from get_version_localizations)'),
      screenshotDir: z.string().optional().describe('Directory containing screenshots (default: /tmp/asc-screenshots)'),
      displayTypes: z.array(z.string()).optional().describe('Display types to upload (default: all found in directory). Options: APP_IPHONE_67, APP_IPHONE_61, APP_IPHONE_69, APP_IPAD_PRO_3GEN_129'),
    },
    async ({ localizationId, screenshotDir, displayTypes }) => {
      try {
        const dir = screenshotDir ?? '/tmp/asc-screenshots';
        if (!existsSync(dir)) {
          return {
            content: [{ type: 'text' as const, text: `Screenshot directory not found: ${dir}\nRun capture_screenshots first.` }],
            isError: true,
          };
        }

        // Find all screenshot PNGs in directory
        const allFiles = execSync(`ls "${dir}"/*.png 2>/dev/null || true`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
        if (allFiles.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No PNG files found in ${dir}` }],
            isError: true,
          };
        }

        // Group files by display type (filename contains display type)
        const filesByType: Record<string, string[]> = {};
        for (const filepath of allFiles) {
          const filename = filepath.split('/').pop()!;
          for (const dt of Object.keys(DISPLAY_TYPES)) {
            if (filename.includes(dt)) {
              if (!filesByType[dt]) filesByType[dt] = [];
              filesByType[dt].push(filepath);
            }
          }
        }

        const typesToUpload = displayTypes ?? Object.keys(filesByType);
        const results: string[] = [];

        // Get existing screenshot sets
        const existingSets = await client.requestAll(
          `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`,
          { 'fields[appScreenshotSets]': 'screenshotDisplayType' }
        ) as Array<{ id: string; attributes: { screenshotDisplayType: string } }>;

        const setMap = new Map(existingSets.map(s => [s.attributes.screenshotDisplayType, s.id]));

        for (const displayType of typesToUpload) {
          const files = filesByType[displayType];
          if (!files || files.length === 0) {
            results.push(`⚠ ${displayType}: No screenshots found`);
            continue;
          }

          // Create screenshot set if it doesn't exist
          let setId = setMap.get(displayType);
          if (!setId) {
            const setBody = {
              data: {
                type: 'appScreenshotSets',
                attributes: { screenshotDisplayType: displayType },
                relationships: {
                  appStoreVersionLocalization: {
                    data: { type: 'appStoreVersionLocalizations', id: localizationId },
                  },
                },
              },
            };
            const setResult = await client.request<{ data: { id: string } }>(
              '/v1/appScreenshotSets',
              { method: 'POST', body: setBody }
            );
            setId = setResult.data.id;
            results.push(`Created screenshot set for ${displayType} (${setId})`);
          }

          // Upload each screenshot
          for (const filepath of files) {
            const filename = filepath.split('/').pop()!;
            const fileData = readFileSync(filepath);
            const fileSize = statSync(filepath).size;
            const checksum = createHash('md5').update(fileData).digest('hex');

            // 1. Reserve upload slot
            const reserveBody = {
              data: {
                type: 'appScreenshots',
                attributes: {
                  fileName: filename,
                  fileSize: fileSize,
                },
                relationships: {
                  appScreenshotSet: {
                    data: { type: 'appScreenshotSets', id: setId },
                  },
                },
              },
            };

            const reservation = await client.request<{
              data: {
                id: string;
                attributes: {
                  uploadOperations: Array<{
                    method: string;
                    url: string;
                    length: number;
                    offset: number;
                    requestHeaders: Array<{ name: string; value: string }>;
                  }>;
                };
              };
            }>('/v1/appScreenshots', { method: 'POST', body: reserveBody });

            const screenshotId = reservation.data.id;
            const uploadOps = reservation.data.attributes.uploadOperations;

            // 2. Upload binary data via upload operations
            for (const op of uploadOps) {
              const chunk = fileData.subarray(op.offset, op.offset + op.length);
              const headers: Record<string, string> = {};
              for (const h of op.requestHeaders) {
                headers[h.name] = h.value;
              }

              const uploadResponse = await fetch(op.url, {
                method: op.method,
                headers,
                body: chunk,
              });

              if (!uploadResponse.ok) {
                results.push(`✗ ${filename}: Upload chunk failed (${uploadResponse.status})`);
                continue;
              }
            }

            // 3. Commit the upload
            const commitBody = {
              data: {
                type: 'appScreenshots',
                id: screenshotId,
                attributes: {
                  uploaded: true,
                  sourceFileChecksum: { value: checksum },
                },
              },
            };

            await client.request(`/v1/appScreenshots/${screenshotId}`, {
              method: 'PATCH',
              body: commitBody,
            });

            results.push(`✓ ${filename} uploaded to ${displayType}`);
          }
        }

        return { content: [{ type: 'text' as const, text: `Screenshot upload complete.\n\n${results.join('\n')}` }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'list_available_simulators',
    'List available iOS/iPad simulators for screenshot capture, showing which ones match App Store required display sizes',
    {},
    async () => {
      try {
        const output = execSync('xcrun simctl list devices available', { encoding: 'utf-8' });
        const lines: string[] = [];

        lines.push('Required App Store screenshot sizes:\n');
        for (const [type, config] of Object.entries(DISPLAY_TYPES)) {
          const udid = findSimulatorUDID(config.simulatorMatch);
          const status = udid ? `✓ Found (${udid})` : '✗ Not available';
          lines.push(`  ${type}: ${config.description}`);
          lines.push(`    Simulator: ${config.simulatorMatch} — ${status}`);
          lines.push(`    Resolution: ${config.width}x${config.height}\n`);
        }

        // List all available iPhone/iPad sims
        lines.push('\nAll available simulators:');
        for (const line of output.split('\n')) {
          if (line.match(/iPhone|iPad/) && line.includes('(') && !line.includes('unavailable')) {
            lines.push(`  ${line.trim()}`);
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
