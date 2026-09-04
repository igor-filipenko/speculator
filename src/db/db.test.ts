import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_POOL_CONNECTION_TIMEOUT_MS,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  DEFAULT_POOL_MIN,
  readPoolLimits,
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
