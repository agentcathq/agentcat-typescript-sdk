/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker");
  }
}
