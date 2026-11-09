export const SECRETS_FILE: string;
export function readSecrets(): Record<string, string>;
export function writeSecret(email: string, secret: string): void;
export function clearSecrets(): void;
