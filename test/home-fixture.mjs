import os from 'node:os';
import assert from 'node:assert/strict';
assert.ok(process.env.P9_TEST_HOME);
os.homedir = () => process.env.P9_TEST_HOME;
