import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_POOL_CONNECTION_TIMEOUT_MS,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  DEFAULT_POOL_MIN,
  isRetryableDbError,
  readApplicationName,
  readPoolLimits,
  setBotId,
  withDbRetry,
} from "./db.js";

const POOL_ENV = [
  "DATABASE_POOL_MAX",
  "DATABASE_POOL_MIN",
  "DATABASE_POOL_IDLE_TIMEOUT_MS",
  "DATABASE_POOL_CONNECTION_TIMEOUT_MS",
] as const;

const saved = new Map<string, string | undefined>();
for (const name of POOL_ENV) {
  saved.set(name, process.env[name]);
}

afterEach(() => {
  for (const name of POOL_ENV) {
    const value = saved.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("readApplicationName", () => {
  const savedPgAppName = process.env["PGAPPNAME"];
  const savedBotId = process.env["BOT_ID"];

  afterEach(() => {
    if (savedPgAppName === undefined) {
      delete process.env["PGAPPNAME"];
    } else {
      process.env["PGAPPNAME"] = savedPgAppName;
    }
    if (savedBotId === undefined) {
      delete process.env["BOT_ID"];
    } else {
      process.env["BOT_ID"] = savedBotId;
    }
    setBotId(undefined);
  });

  it("uses speculator/<BOT_ID> by default", () => {
    delete process.env["PGAPPNAME"];
    setBotId(undefined);
    process.env["BOT_ID"] = "local";
    assert.equal(readApplicationName(), "speculator/local");
  });

  it("falls back to speculator without BOT_ID", () => {
    delete process.env["PGAPPNAME"];
    delete process.env["BOT_ID"];
    setBotId(undefined);
    assert.equal(readApplicationName(), "speculator");
  });

  it("prefers PGAPPNAME", () => {
    process.env["PGAPPNAME"] = "speculator-paper";
    process.env["BOT_ID"] = "local";
    assert.equal(readApplicationName(), "speculator-paper");
  });
});

describe("readPoolLimits", () => {
  it("uses low defaults when unset", () => {
    for (const name of POOL_ENV) {
      delete process.env[name];
    }
    assert.deepEqual(readPoolLimits(), {
      max: DEFAULT_POOL_MAX,
      min: DEFAULT_POOL_MIN,
      idleTimeoutMillis: DEFAULT_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: DEFAULT_POOL_CONNECTION_TIMEOUT_MS,
    });
  });

  it("reads overrides from env", () => {
    process.env["DATABASE_POOL_MAX"] = "4";
    process.env["DATABASE_POOL_MIN"] = "1";
    process.env["DATABASE_POOL_IDLE_TIMEOUT_MS"] = "2000";
    process.env["DATABASE_POOL_CONNECTION_TIMEOUT_MS"] = "8000";
    assert.deepEqual(readPoolLimits(), {
      max: 4,
      min: 1,
      idleTimeoutMillis: 2000,
      connectionTimeoutMillis: 8000,
    });
  });

  it("rejects max below 1 and min above max", () => {
    process.env["DATABASE_POOL_MAX"] = "0";
    assert.throws(() => readPoolLimits(), /DATABASE_POOL_MAX/);
    process.env["DATABASE_POOL_MAX"] = "1";
    process.env["DATABASE_POOL_MIN"] = "2";
    assert.throws(() => readPoolLimits(), /DATABASE_POOL_MIN/);
  });
});

class CodedError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

describe("isRetryableDbError", () => {
  it("matches pg connect-timeout and connection-loss messages", () => {
    assert.equal(
      isRetryableDbError(new Error("Connection terminated due to connection timeout")),
      true,
    );
    assert.equal(isRetryableDbError(new Error("timeout exceeded when trying to connect")), true);
    assert.equal(isRetryableDbError(new Error("Connection terminated unexpectedly")), true);
  });

  it("matches Postgres and Node connection codes", () => {
    assert.equal(isRetryableDbError(new CodedError("boom", "08006")), true);
    assert.equal(isRetryableDbError(new CodedError("reset", "ECONNRESET")), true);
  });

  it("does not retry syntax or constraint errors", () => {
    assert.equal(isRetryableDbError(new CodedError("syntax", "42601")), false);
    assert.equal(isRetryableDbError(new CodedError("unique", "23505")), false);
    assert.equal(isRetryableDbError(new Error("column does not exist")), false);
    assert.equal(isRetryableDbError("not-an-error"), false);
  });
});

describe("withDbRetry", () => {
  it("retries retryable errors then returns", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await withDbRetry(
      "test",
      () => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.reject(new Error("Connection terminated due to connection timeout"));
        }
        return Promise.resolve(42);
      },
      {
        sleepFn: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );
    assert.equal(result, 42);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [3_000, 6_000]);
  });

  it("does not retry permanent errors", async () => {
    await assert.rejects(
      () => withDbRetry("test", () => Promise.reject(new CodedError("syntax error", "42601"))),
      /syntax error/,
    );
  });
});
