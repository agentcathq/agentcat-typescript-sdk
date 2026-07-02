// Belt-and-suspenders: the SDK also auto-disables diagnostics in test
// environments, but this guarantees no test run ever ships OTLP diagnostics
// to the live collector regardless of ordering or future detection changes.
// Tests that exercise diagnostics opt back in with DISABLE_DIAGNOSTICS=false
// and a mocked fetch.
process.env.DISABLE_DIAGNOSTICS = "true";
