import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AppStoreConnectClient } from './client.js';

const PLATFORM_MAP: Record<string, string> = {
  ios: 'IOS',
  macos: 'MAC_OS',
  appletvos: 'TV_OS',
  watchos: 'IOS', // watchOS apps are embedded in iOS IPA
  visionos: 'VISION_OS',
};

interface UploadOperation {
  method: string;
  url: string;
  offset: number;
  length: number;
  partNumber: number;
  requestHeaders: Array<{ name: string; value: string }>;
}

interface BuildUploadResponse {
  data: {
    id: string;
    attributes: {
      state: {
        state: string;
        errors: Array<{ code: string; description: string }>;
        warnings: Array<{ code: string; description: string }>;
      };
    };
  };
}

interface BuildUploadFileResponse {
  data: {
    id: string;
    attributes: {
      uploadOperations: UploadOperation[];
      assetDeliveryState: {
        state: string;
        errors: Array<{ code: string; description: string }>;
      };
    };
  };
}

export function mapPlatform(platformType: string): string {
  return PLATFORM_MAP[platformType] || 'IOS';
}

export async function uploadBuildViaAPI(
  client: AppStoreConnectClient,
  appId: string,
  filePath: string,
  fileName: string,
  platformType: string,
  bundleShortVersion: string,
  bundleVersion: string,
): Promise<string> {
  const platform = mapPlatform(platformType);
  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  // Step 1: Create BuildUpload
  log('Creating build upload...');
  const createResponse = await client.request<BuildUploadResponse>('/v1/buildUploads', {
    method: 'POST',
    body: {
      data: {
        type: 'buildUploads',
        attributes: {
          cfBundleShortVersionString: bundleShortVersion,
          cfBundleVersion: bundleVersion,
          platform,
        },
        relationships: {
          app: {
            data: { type: 'apps', id: appId },
          },
        },
      },
    },
  });

  const buildUploadId = createResponse.data.id;
  log(`Build upload created: ${buildUploadId}`);

  // Step 2: Reserve BuildUploadFile
  const fileSize = statSync(filePath).size;
  const uti = fileName.endsWith('.pkg') ? 'com.apple.pkg' : 'com.apple.ipa';

  log(`Reserving upload for ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);
  const fileResponse = await client.request<BuildUploadFileResponse>('/v1/buildUploadFiles', {
    method: 'POST',
    body: {
      data: {
        type: 'buildUploadFiles',
        attributes: {
          assetType: 'ASSET',
          fileName,
          fileSize,
          uti,
        },
        relationships: {
          buildUpload: {
            data: { type: 'buildUploads', id: buildUploadId },
          },
        },
      },
    },
  });

  const uploadFileId = fileResponse.data.id;
  const operations = fileResponse.data.attributes.uploadOperations;
  log(`Got ${operations.length} upload chunk(s)`);

  // Step 3: Upload binary chunks to pre-signed URLs
  const fileBuffer = await readFile(filePath);

  for (const op of operations) {
    const chunk = fileBuffer.subarray(op.offset, op.offset + op.length);
    const headers: Record<string, string> = {};
    for (const h of op.requestHeaders) {
      headers[h.name] = h.value;
    }

    log(`Uploading part ${op.partNumber}/${operations.length} (${(op.length / 1024 / 1024).toFixed(1)} MB)...`);
    const response = await fetch(op.url, {
      method: op.method,
      headers,
      body: chunk,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Chunk upload failed (part ${op.partNumber}): ${response.status} ${response.statusText}\n${body}`);
    }
  }

  // Step 4: Commit the upload
  log('Committing upload...');
  await client.request(`/v1/buildUploadFiles/${uploadFileId}`, {
    method: 'PATCH',
    body: {
      data: {
        type: 'buildUploadFiles',
        id: uploadFileId,
        attributes: {
          uploaded: true,
        },
      },
    },
  });

  // Step 5: Poll for processing completion
  log('Waiting for processing...');
  let state = 'AWAITING_UPLOAD';
  let attempts = 0;
  const maxAttempts = 60; // 5 minutes at 5s intervals
  let warnings: Array<{ code: string; description: string }> = [];

  while (state !== 'COMPLETE' && state !== 'FAILED' && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    attempts++;

    const status = await client.request<BuildUploadResponse>(`/v1/buildUploads/${buildUploadId}`);
    state = status.data.attributes.state.state;
    warnings = status.data.attributes.state.warnings ?? [];

    if (attempts % 6 === 0) {
      log(`Still processing (${state}, ${attempts * 5}s elapsed)...`);
    }

    if (state === 'FAILED') {
      const errors = status.data.attributes.state.errors
        .map(e => `${e.code}: ${e.description}`)
        .join('\n');
      throw new Error(`Build upload processing failed:\n${errors}\n\nUpload log:\n${logs.join('\n')}`);
    }
  }

  const warningText = warnings.length > 0
    ? `\nWarnings:\n${warnings.map(w => `  - ${w.code}: ${w.description}`).join('\n')}`
    : '';

  if (state !== 'COMPLETE') {
    return `${logs.join('\n')}\n\nBuild upload created (ID: ${buildUploadId}) but still processing after ${maxAttempts * 5}s. State: ${state}\nCheck status in App Store Connect.${warningText}`;
  }

  return `${logs.join('\n')}\n\nBuild uploaded and processed successfully!\nUpload ID: ${buildUploadId}${warningText}`;
}
