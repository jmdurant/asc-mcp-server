export class AppStoreConnectError extends Error {
  constructor(
    public status: number,
    public code: string,
    public title: string,
    public detail: string
  ) {
    super(`${title}: ${detail}`);
    this.name = 'AppStoreConnectError';
  }
}

export function formatError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (error instanceof AppStoreConnectError) {
    return {
      content: [{ type: 'text', text: `App Store Connect API Error (${error.status}): ${error.code}\n${error.detail}` }],
      isError: true
    };
  }
  return {
    content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true
  };
}
