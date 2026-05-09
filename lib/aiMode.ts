export function isMockAiMode(): boolean {
  return process.env.MOCK_AI === "true";
}
