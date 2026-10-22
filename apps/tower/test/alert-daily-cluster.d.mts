export function dailyWorkspaceFixture(): Promise<{
  url: string;
  workspaceIds: [string, string];
  close(): void;
}>;
