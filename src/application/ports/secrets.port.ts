export interface SecretsPort {
  getSecret(key: string): Promise<string>;
}
