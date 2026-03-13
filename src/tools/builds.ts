import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppStoreConnectClient } from '../client.js';
import type { Config } from '../config.js';
import { formatError } from '../errors.js';

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
    'Archive, export, and upload an Xcode project build to App Store Connect. Runs xcodebuild archive, export, and xcrun altool upload.',
    {
      projectPath: z.string().describe('Absolute path to .xcodeproj file'),
      scheme: z.string().describe('Xcode scheme name'),
      destination: z.string().optional().describe('Build destination (default: "generic/platform=iOS")'),
      archivePath: z.string().optional().describe('Where to save the .xcarchive (default: /tmp/asc-build.xcarchive)'),
      exportOptionsPlist: z.string().optional().describe('Path to ExportOptions.plist (will create a default if not provided)'),
      platformType: z.enum(['ios', 'macos', 'appletvos']).optional().describe('Platform type for altool upload (default: ios)'),
    },
    async ({ projectPath, scheme, destination, archivePath, exportOptionsPlist, platformType }) => {
      try {
        const archive = archivePath ?? '/tmp/asc-build.xcarchive';
        const exportPath = '/tmp/asc-build-export';
        const dest = destination ?? 'generic/platform=iOS';
        const type = platformType ?? 'ios';

        // Create default ExportOptions.plist if not provided
        let exportPlist = exportOptionsPlist;
        if (!exportPlist) {
          exportPlist = '/tmp/asc-ExportOptions.plist';
          const { writeFileSync } = await import('node:fs');
          writeFileSync(exportPlist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
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

        // Step 3: Upload
        const { stdout: uploadOut, stderr: uploadErr } = await execFileAsync('xcrun', [
          'altool', '--upload-app',
          '-f', `${exportPath}/${artifact}`,
          '--apiKey', config.keyId,
          '--apiIssuer', config.issuerId,
          '--type', type,
        ], { maxBuffer: 10 * 1024 * 1024, timeout: 600000 });

        const output = uploadOut + uploadErr;
        if (output.includes('Error') || output.includes('error')) {
          return formatError(new Error(`Upload failed:\n${output}`));
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Build uploaded successfully!\nScheme: ${scheme}\nArtifact: ${artifact}\n\n${output}`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
