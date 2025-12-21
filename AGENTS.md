# Emergency Fund Plugin

A Treeline plugin for tracking emergency fund runway based on your actual expenses.

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | Plugin metadata (id: "emergency-fund") |
| `src/index.ts` | Plugin entry point |
| `src/EmergencyFundView.svelte` | Main UI component |
| `package.json` | Dependencies (includes `@treeline-money/plugin-sdk`) |

## Quick Commands

```bash
npm install          # Install dependencies
npm run build        # Build to dist/index.js
npm run dev          # Watch mode
tl plugin install .  # Install locally for testing
```

## Plugin Data

This plugin uses two tables:

```sql
-- Configuration (target months, linked accounts)
CREATE TABLE IF NOT EXISTS sys_plugin_emergency_fund_config (
  id VARCHAR PRIMARY KEY,
  target_months INTEGER DEFAULT 6,
  account_ids VARCHAR,         -- comma-separated account IDs
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)

-- Historical snapshots for tracking progress
CREATE TABLE IF NOT EXISTS sys_plugin_emergency_fund_snapshots (
  id VARCHAR PRIMARY KEY,
  date DATE NOT NULL,
  balance DECIMAL NOT NULL,
  runway_months DECIMAL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

## How It Works

1. User configures target months of runway (e.g., 6 months)
2. User links savings accounts that hold their emergency fund
3. Plugin calculates average monthly expenses from transaction history
4. Shows current runway: balance / average monthly expenses
5. Tracks progress over time with snapshots

## SDK Import

All types are imported from the npm package:

```typescript
import type { Plugin, PluginContext, PluginSDK } from "@treeline-money/plugin-sdk";
```

Views receive `sdk` via props:

```svelte
<script lang="ts">
  import type { PluginSDK } from "@treeline-money/plugin-sdk";

  interface Props {
    sdk: PluginSDK;
  }
  let { sdk }: Props = $props();
</script>
```

## SDK Quick Reference

| Method | What it does |
|--------|--------------|
| `sdk.query(sql)` | Read transactions, accounts, balances |
| `sdk.execute(sql)` | Write to config and snapshots tables |
| `sdk.toast.success/error/info(msg)` | Show notifications |
| `sdk.openView(viewId, props?)` | Navigate to another view |
| `sdk.onDataRefresh(callback)` | React when data changes |
| `sdk.emitDataRefresh()` | Notify other views data changed |
| `sdk.theme.current()` | Get "light" or "dark" |
| `sdk.settings.get/set()` | Persist settings |
| `sdk.currency.format(amount)` | Format as currency |

## Releasing

```bash
./scripts/release.sh 0.1.0   # Tags and pushes, GitHub Action creates release
```

## Full Documentation

See https://github.com/treeline-money/treeline
