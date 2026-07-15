declare const process: { env: Record<string, string | undefined> };
declare const fetch: (url: URL | string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<unknown>;
declare class Response {}
declare class Buffer extends Uint8Array {
  static from(input: string | ArrayBuffer | ArrayBufferView | number[], encoding?: string): Buffer;
  static alloc(size: number): Buffer;
  static concat(list: Uint8Array[]): Buffer;
  static isBuffer(value: unknown): value is Buffer;
  toString(encoding?: string): string;
  equals(other: Uint8Array): boolean;
  subarray(start?: number, end?: number): Buffer;
  readonly byteLength: number;
}
declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}
declare module "node:crypto" {
  export function createHash(algorithm: string): { update(input: string | Uint8Array): { digest(encoding: "hex"): string } };
  export function createHmac(algorithm: string, key: string | Uint8Array): { update(input: string | Uint8Array): { digest(encoding: "hex" | "base64" | "base64url"): string } };
  export function randomUUID(): string;
  export function randomBytes(size: number): Buffer;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
declare module "@netlify/blobs" {
  export function getStore(name: string): {
    get(key: string, options?: { type?: "json" }): Promise<unknown>;
    set(key: string, value: unknown, options?: unknown): Promise<void>;
    setJSON(key: string, value: unknown, options?: unknown): Promise<void>;
    list?(options?: unknown): Promise<unknown>;
  };
}
declare module "openai" {
  export default class OpenAI {
    constructor(options: { apiKey?: string });
    images: { generate(input: Record<string, unknown>): Promise<unknown> };
  }
}
declare module "zod" {
  export const z: any;
}
declare module "@openai/agents" {
  export class Agent { constructor(input: Record<string, unknown>); }
  export class Runner { run?(agent: unknown, input: string): Promise<unknown>; }
}

declare module "node:test" {
  const test: any;
  export default test;
}
declare module "node:assert/strict" {
  const assert: any;
  export default assert;
}
