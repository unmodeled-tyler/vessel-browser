export function isPremiumStatus(status: string | undefined): boolean {
  return status === "active" || status === "trialing";
}
