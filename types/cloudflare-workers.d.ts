declare module "cloudflare:workers" {
  export const env: Record<string, any>;
}

type D1Database = any;
type Fetcher = { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
