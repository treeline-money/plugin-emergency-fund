# Emergency Fund

A [Treeline](https://github.com/treeline-money/treeline) plugin to track your emergency fund runway based on actual spending patterns.

## Features

- **Runway calculation**: See how many months your emergency fund would last based on real expenses
- **Link to Savings Goal**: Optionally link to a goal from the Savings Goals plugin
- **Expense analysis**: View breakdown of spending by category/tag
- **Configurable lookback**: Analyze 3, 6, or 12 months of expense history
- **Calculation methods**: Choose mean, median, or trimmed mean for more accurate estimates
- **Tag exclusions**: Exclude one-time or irregular expenses (like "vacation") from calculations
- **Fund allocations**: Specify which accounts and what portion constitute your emergency fund
- **Historical snapshots**: Track how your runway changes over time

## How It Works

1. **Configure fund sources**: Select accounts that hold your emergency savings (with percentage or fixed allocations)
2. **Set expense accounts**: Choose which accounts to analyze for spending patterns
3. **Exclude anomalies**: Filter out tags that aren't representative of normal monthly expenses
4. **View runway**: See your current runway in months with detailed expense breakdown

## Keyboard Shortcuts

- `s` - Open settings
- `r` - Refresh data
- `v` - View underlying SQL query
- `a` - Add snapshot
- `j` / `k` - Navigate snapshots
- `d` - Delete selected snapshot

## Installation

### From Community Plugins (Recommended)

1. Open Treeline
2. Go to Settings > Plugins > Community Plugins
3. Find "Emergency Fund" and click Install
4. Restart Treeline

### Manual Installation

```bash
tl plugin install https://github.com/treeline-money/plugin-emergency-fund
# Restart Treeline
```

## Development

```bash
git clone https://github.com/treeline-money/plugin-emergency-fund
cd plugin-emergency-fund
npm install
npm run build
tl plugin install .
```

## License

MIT
